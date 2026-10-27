/**
 * qoder 压缩旁路 shim —— 让 qoder/qodercn 的 WASM 加密端点也能吃到
 * billion-context（bili）的压缩。
 *
 * 背景：bili 只压缩它认得的协议路径（/chat/completions、/v1/messages…）。
 * qoder 真实推理走 /algo/api/v2/.../agent_chat_generation，请求体被 WASM 加密、
 * Authorization 是 COSY 签名，bili 既认不出路径、也无法解析请求体，只能原样直发，
 * 于是这些会话拿不到任何压缩。
 *
 * 做法（把「加密」这一步挪到压缩之后）：
 *   1. 截住 adapter 的 QoderEncryptedInfer#prepareInfer（明文 ask 在这里，加密器也在这里）；
 *   2. 不返回加密请求，而返回一个**明文 OpenAI 请求**，指向本机 shim，路径以
 *      /chat/completions 结尾 —— bili 会认它、压缩它，再转发回本机 shim；
 *   3. shim 拿压缩后的 messages 重建 ask，用**真正的** prepareInfer 加密，
 *      直接发往 qoder 上游（绕开 bili，避免二次改写）；
 *   4. 上游的 qoder SSE 原样穿回 adapter —— 响应方向不需要任何翻译。
 *
 * 因此只有请求方向变了：明文进 bili，密文出进程。任何一步出问题都退回原行为，
 * 不会让 qoder 彻底不可用。
 */

const PENDING_TTL_MS = 120_000
const PENDING_MAX = 256

/**
 * 认领注入口时的固定 label。
 *
 * 注入口（pack.js 里的 `globalThis.__mfQoderEncryptor = QoderEncryptedInfer`）要等
 * dsh-our-free-model 的 pack 真正 apply 之后才存在，而本插件的 apply 可能更早 ——
 * 宿主冷启动就是这个顺序。一次性读取会把「还没到」误判成「没有」，于是 shim 一直
 * 不接管、qoder 全量上下文直发。所以认领要可重试。
 */
const ADOPT_LABEL = 'pack:__mfQoderEncryptor'
/** 认领重试：1.5s 一拍，最多 400 拍（约 10 分钟），够 cover 宿主冷启动与手动重载。 */
const ADOPT_INTERVAL_MS = 1500
const ADOPT_MAX_TICKS = 400

/**
 * 把 adapter 的 ask 折成 OpenAI chat body（交给 bili 压缩的形状）。
 *
 * ask.history 本身就是 OpenAI 形状的 messages（role/content/tool_calls/tool_call_id），
 * 所以这里只做「加 system + 改字段名」，不做语义转换。
 *
 * @param ask QoderEncryptedInfer.prepareInfer 的入参
 * @returns 可以交给 bili 的 OpenAI 请求体
 */
export function askToOpenAiBody(ask) {
  const messages = []
  if (typeof ask.systemText === 'string' && ask.systemText.length > 0) {
    messages.push({ role: 'system', content: ask.systemText })
  }
  for (const m of Array.isArray(ask.history) ? ask.history : []) {
    if (m === null || typeof m !== 'object') continue
    const msg = { role: m.role, content: m.content }
    if (m.tool_calls !== undefined) msg.tool_calls = m.tool_calls
    if (m.tool_call_id !== undefined) msg.tool_call_id = m.tool_call_id
    messages.push(msg)
  }
  const body = { model: ask.modelKey, stream: true, messages }
  if (Array.isArray(ask.tools) && ask.tools.length > 0) body.tools = ask.tools
  if (ask.maxTokens !== undefined) body.max_tokens = ask.maxTokens
  if (ask.reasoningEffort !== undefined) body.reasoning_effort = ask.reasoningEffort
  return body
}

/**
 * 用压缩后的 OpenAI body 重建 ask：只替换 messages/tools/maxTokens 三项，
 * 其余（modelKey、isReasoning、isVl、displayName、business、contextWindow…）
 * 沿用原 ask —— 那些是协议字段，压缩不该动。
 *
 * @param ask 原 ask
 * @param body shim 收到的（可能已被压缩的）OpenAI body
 * @returns 新 ask；形状不合法时返回 null，调用方应退回原 ask
 */
export function applyCompressedBody(ask, body) {
  if (body === null || typeof body !== 'object') return null
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null
  let systemText = ask.systemText
  const history = []
  for (const m of body.messages) {
    if (m === null || typeof m !== 'object') return null
    if (typeof m.role !== 'string') return null
    if (m.role === 'system') {
      if (typeof m.content === 'string') systemText = m.content
      continue
    }
    const item = { role: m.role, content: m.content }
    if (m.tool_calls !== undefined) item.tool_calls = m.tool_calls
    if (m.tool_call_id !== undefined) item.tool_call_id = m.tool_call_id
    history.push(item)
  }
  if (history.length === 0) return null
  const next = { ...ask, systemText, history }
  if (Array.isArray(body.tools) && body.tools.length > 0) next.tools = body.tools
  if (typeof body.max_tokens === 'number' && body.max_tokens > 0) next.maxTokens = body.max_tokens
  return next
}

import http from 'node:http'
import https from 'node:https'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 找出 dsh-codearts-auth 的 qoder-wasm.js：优先配置，其次从当前 home 下的
 * profiles/<name>/node_modules 里找。找不到就返回 null（调用方据此禁用 shim）。
 *
 * @param explicit 显式配置的绝对路径
 * @returns qoder-wasm.js 的绝对路径，或 null
 */
export function resolveQoderWasmPath(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0 && existsSync(explicit)) return explicit
  // <home>/plugins/model-failover-manager → <home>/profiles/<name>/node_modules/...
  for (let dir = HERE, i = 0; i < 5 && dir.length > 3; i += 1, dir = dirname(dir)) {
    const profiles = join(dir, 'profiles')
    if (!existsSync(profiles)) continue
    let entries = []
    try { entries = readdirSync(profiles, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = join(profiles, entry.name, 'node_modules', 'dsh-codearts-auth', 'lib', 'qoder-wasm.js')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}



/**
 * 进程级状态槽。放 globalThis 而不是模块作用域：插件重载会重新 import 本模块，
 * 但监听端口、补丁和计数都属于进程本身，必须跨重载存活。
 */
const STATE_KEY = '__mfQoderShim'

/**
 * 取一条消息的正文文本（字符串或分段数组都摊平成字符串）。
 *
 * @param message 一条 OpenAI message
 * @returns 正文字符串
 */
function contentOf(message) {
  const c = message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
  return ''
}

/**
 * 6 位哈希，只用于判断两条正文是否相同（不是安全用途）。
 *
 * @param text 正文
 * @returns 十六进制哈希
 */
function hashOf(text) {
  let h = 0
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

/**
 * 逐条比对发出去的正文与回来的正文，给出人可读的差异摘要。
 *
 * @param before prepare 阶段留存的 { role, len, hash } 列表
 * @param after 回来后解析出的 messages
 * @returns 差异条目数组
 */
function diffMessages(before, after) {
  if (!Array.isArray(before)) return []
  const out = []
  const max = Math.max(before.length, after.length)
  for (let i = 0; i < max; i += 1) {
    const b = before[i]
    const a = after[i]
    const text = contentOf(a)
    if (b === undefined) {
      out.push({ index: i, kind: 'added', role: a?.role ?? null, len: text.length, peek: text.slice(0, 160) })
      continue
    }
    if (a === undefined) {
      out.push({ index: i, kind: 'removed', role: b.role, len: b.len })
      continue
    }
    if (hashOf(text) === b.hash) continue
    out.push({
      index: i, kind: text.length > b.len ? 'grown' : 'shrunk', role: a?.role ?? b.role,
      beforeLen: b.len, afterLen: text.length, delta: text.length - b.len,
      // 变长时给尾部（通常追加在末尾），变短时给头部（通常是摘要替换）
      peek: text.length > b.len ? text.slice(-160) : text.slice(0, 160),
    })
  }
  return out
}

/**
 * 一组消息的正文净长度（只算 content，不算 JSON 字段名与工具定义）。
 *
 * 用它而不是 JSON 长度：bili 会在正文之外添加字段或指令，JSON 长度会变长，
 * 但那不是压缩。只有正文真的变短、或条数变少，才说明上下文被压缩了。
 *
 * @param messages OpenAI messages 数组
 * @returns 正文字符数
 */
function contentCharsOf(messages) {
  if (!Array.isArray(messages)) return 0
  return messages.reduce((sum, m) => {
    const c = m?.content
    if (typeof c === 'string') return sum + c.length
    if (Array.isArray(c)) return sum + c.reduce((k, part) => k + (typeof part?.text === 'string' ? part.text.length : 0), 0)
    return sum
  }, 0)
}


/** 停服宽限：先停止监听，既有连接自然收尾；超时再强拆，避免端口长期被占。 */
/**
 * 在 dsh-our-free-model 的打包产物里补回「暴露加密器」那一行。
 *
 * 那个插件把 qoder 的加密器内联进 vendor/channel-pack/pack.js 且不导出，外部插件
 * 拿不到它 —— 没有它就无法把「先压缩再加密」接进来。pack.js 里有一行把这个类挂到
 * globalThis.__mfQoderEncryptor；该插件的自更新会用官方发布包整份替换 pack.js，
 * 那一行随之消失，压缩链路就静默退回直发。
 *
 * 所以每次装载都检查一次：钩子不在就补上。补的是**别人的包**，因此只在确实缺失、
 * 且能唯一定位类定义末尾时动手；结果写进 /status 的 qoderShim.hookRepair。
 *
 * @param packPath pack.js 的绝对路径
 * @returns {{state: string, detail: string}} state 取 ok / repaired / skipped / failed
 */
function ensurePackHook(packPath) {
  const HOOK_MARK = '__mfQoderEncryptor'
  let text
  try {
    text = readFileSync(packPath, 'utf8')
  } catch (err) {
    return { state: 'skipped', detail: '读不到 pack.js：' + (err && err.code ? err.code : String(err)) }
  }
  if (text.includes(HOOK_MARK)) {
    // 钩子还在，但引用名可能随上游重命名而失效；只提示，不改。
    const refsClass = new RegExp('globalThis\\.' + HOOK_MARK + '\\s*=\\s*QoderEncryptedInfer\\b').test(text)
    return refsClass
      ? { state: 'ok', detail: '注入口已在' }
      : { state: 'stale', detail: '注入口在，但已不指向 QoderEncryptedInfer（上游可能重命名了类）' }
  }
  const lines = text.split('\n')
  // 类定义行必须唯一，找不到就不动它 —— 这是别人的包，宁可报告也不猜。
  const declIndexes = []
  for (let i = 0; i < lines.length; i += 1) {
    if (/^var QoderEncryptedInfer = class\b/.test(lines[i])) declIndexes.push(i)
  }
  if (declIndexes.length !== 1) {
    return { state: 'skipped', detail: '类定义行数为 ' + declIndexes.length + '（无法唯一定位）' }
  }
  let endIndex = -1
  for (let i = declIndexes[0]; i < lines.length; i += 1) {
    if (lines[i] === '};') { endIndex = i; break }
  }
  if (endIndex < 0) return { state: 'skipped', detail: '找不到类体结束的 };' }
  const hook = [
    '',
    '// ── model-failover-manager 注入口（本地补丁，不是上游代码）──────',
    '// 本 pack 内联了 qoder 的加密器却只当模块局部变量用，外部插件拿不到它，',
    '// 也就无法把「先压缩再加密」接进来。这里挂到进程级槽一次；没人读它时不影响功能。',
    'try {',
    '  globalThis.' + HOOK_MARK + ' = QoderEncryptedInfer;',
    '} catch { /* 只读环境，忽略 */ }',
  ].join('\n')
  lines.splice(endIndex + 1, 0, hook)
  try {
    writeFileSync(packPath, lines.join('\n'), 'utf8')
  } catch (err) {
    return { state: 'failed', detail: '写入失败：' + (err && err.message ? err.message.slice(0, 80) : String(err)) }
  }
  return { state: 'repaired', detail: '已补回注入口，从下一次宿主启动起生效' }
}

/**
 * 找出所有 dsh-our-free-model 的 pack.js 拷贝。
 *
 * ⚠️ 只找 <home>/plugins/dsh-our-free-model 是不够的：profile 把该插件作为
 * `github:` 依赖装进 `<home>/profiles/<name>/node_modules`，宿主真正 import 的是
 * 那一份。2026-10-27 实测：plugins/ 那份带着注入口、profiles/web 那份没有，
 * 于是本函数报告「注入口已在」而运行中的加密器根本没被暴露，压缩静默失效。
 *
 * 两份都可能是「正在加载的那份」，所以全部返回、全部核对。
 *
 * @returns {{path: string, scope: string}[]} pack.js 绝对路径列表（可能为空）
 */
function resolvePackPaths() {
  const found = []
  const seen = new Set()
  const push = (path, scope) => {
    if (!existsSync(path)) return
    let real = path
    try { real = realpathSync(path) } catch { /* 用原路径 */ }
    if (seen.has(real)) return
    seen.add(real)
    found.push({ path: real, scope })
  }
  for (let dir = HERE, i = 0; i < 5 && dir.length > 3; i += 1, dir = dirname(dir)) {
    push(join(dir, 'plugins', 'dsh-our-free-model', 'vendor', 'channel-pack', 'pack.js'), 'plugins')
    const profiles = join(dir, 'profiles')
    if (!existsSync(profiles)) continue
    let entries = []
    try { entries = readdirSync(profiles, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      push(join(profiles, entry.name, 'node_modules', 'dsh-our-free-model', 'vendor', 'channel-pack', 'pack.js'), 'profile:' + entry.name)
    }
  }
  return found
}
const STOP_GRACE_MS = 2000

/**
 * 找出「运行时真正在用的」QoderEncryptedInfer。
 *
 * ⚠️ 不能只 patch 磁盘上的 dsh-codearts-auth/lib/qoder-wasm.js：
 * dsh-our-free-model 把整个 qoder adapter + wasm 源码**内联打包**进了自己的
 * vendor/channel-pack/pack.js，并在那里注册 qoder / qodercn。运行时真正在跑的
 * QoderEncryptedInfer 是 pack.js 里那份拷贝 —— 实测给独立包打补丁后，真实请求
 * 照发加密端点（tap 抓到），而补丁计数始终为 0。
 *
 * 所以这里从 llm 注册表拿**已注册的 adapter 实例**，直接补它的原型；再退回磁盘模块
 * 兜底（有些装机方式下 qoder 不由 our-free-model 接管）。
 *
 * @param ctx Cordis 上下文
 * @param wasmPath 磁盘上的 qoder-wasm.js 绝对路径（可为 null）
 * @returns 目标列表与诊断说明
 */
async function collectTargets(ctx, wasmPath) {
  const targets = []
  const notes = []
  const seen = new Set()
  const push = (label, holder) => {
    if (holder === null || holder === undefined || seen.has(holder)) return
    let original
    try { original = holder.prepareInfer } catch (err) { notes.push(label + ' 读取 prepareInfer 失败：' + (err && err.message ? err.message.slice(0, 60) : String(err))); return }
    if (typeof original !== 'function') return
    seen.add(holder)
    targets.push({ label, holder, original })
  }

  // 磁盘上的独立包（有些装机方式下 qoder 不由 our-free-model 接管）。
  if (typeof wasmPath === 'string' && wasmPath.length > 0) {
    let real = wasmPath
    try { real = realpathSync(wasmPath) } catch { real = wasmPath }
    const urls = new Set([
      pathToFileURL(real).href,
      pathToFileURL(real.replace(/^[A-Z]:/, (m) => m.toLowerCase())).href,
    ])
    for (const url of urls) {
      try {
        const mod = await import(url)
        const Cls = mod.QoderEncryptedInfer
        // label 必须唯一：盘符大小写会分裂成两个 ESM 实例（实测 Node 22/Windows），
        // 两者尾部 40 字符完全相同，用尾部当 label 会让第二个被当成第一个而漏打补丁。
        if (typeof Cls === 'function') push('wasm:' + url, Cls.prototype)
      } catch (err) {
        notes.push('载入失败 ' + url.slice(-40) + ' :: ' + (err && err.code ? err.code : String(err)))
      }
    }
  }

  // 优先：宿主进程里由 dsh-our-free-model 暴露出来的加密器（见 pack.js 的注入口）。
  // 这是唯一能拿到「内联打包那份」的方式：它是模块局部变量，不导出、也不在对象图上。
  try {
    const exposed = globalThis.__mfQoderEncryptor
    if (typeof exposed === 'function' && exposed.prototype !== undefined) {
      push('pack:__mfQoderEncryptor', exposed.prototype)
    } else if (exposed !== undefined) {
      notes.push('globalThis.__mfQoderEncryptor 存在但不是类（' + typeof exposed + '）')
    }
  } catch (err) {
    notes.push('读取 __mfQoderEncryptor 失败：' + (err && err.message ? err.message.slice(0, 60) : String(err)))
  }

  // 注册表里的实际 adapter：只用来装「传送门」——见 installPortals。
  const adapters = []
  let registry = null
  try { registry = ctx?.get?.('llm')?.adapters ?? null } catch { registry = null }
  for (const id of ['qoder', 'qodercn']) {
    let reg = null
    try { reg = registry === null ? null : registry.get?.(id) } catch { reg = null }
    const adapter = reg === null || reg === undefined ? null : (reg.adapter ?? reg)
    if (adapter === null) { notes.push('注册表里没有 ' + id + ' adapter'); continue }
    adapters.push({ id, adapter })
  }

  return { targets, notes, adapters }
}
/**
 * 造一份实现：持有一轮装载的 pending 表，负责把 ask 截成明文 OpenAI 请求，
 * 以及处理 bili 压缩后送回来的请求。stats 由调用方传入（跨重载共享）。
 *
 * @param context.port 本机监听端口
 * @param context.stats 共享计数对象
 * @returns 实现对象 { origin, prepare, handle }
 */
function createImpl(context) {
  const origin = 'http://127.0.0.1:' + context.port
  const stats = context.stats
  // 热替换时沿用上一轮的 pending 表：在途请求的 rid 是上一轮 prepare 注册的，
  // 换一张空表会让它们全部命中 410。
  const pending = context.pending instanceof Map ? context.pending : new Map()

  const sweep = () => {
    const now = Date.now()
    for (const [rid, entry] of pending) {
      if (now - entry.at > PENDING_TTL_MS || pending.size > PENDING_MAX) pending.delete(rid)
    }
  }

  /** 用该实例自己的原始 prepareInfer 加密，node:https 直连上游，SSE 原样穿回。 */
  const forward = (real, res) => {
    const target = new URL(real.url)
    const transport = target.protocol === 'https:' ? https : http
    const headers = {}
    for (const [k, v] of Object.entries(real.headers === undefined || real.headers === null ? {} : real.headers)) headers[k] = v
    headers['content-length'] = Buffer.byteLength(real.body, 'utf8')
    const upstream = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers,
    }, (up) => {
      res.writeHead(up.statusCode === undefined ? 502 : up.statusCode, up.headers)
      up.pipe(res)
      up.on('error', () => res.destroy())
    })
    upstream.on('error', (err) => {
      stats.lastError = '上游失败：' + (err && err.message ? err.message : String(err))
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'qoder_shim_upstream', message: stats.lastError } }))
      } else {
        res.destroy()
      }
    })
    res.on('close', () => upstream.destroy())
    upstream.end(real.body)
  }

  /** 把一次 ask 换成指向本机 shim 的明文 OpenAI 请求。 */
  const prepare = (self, ask, original) => {
    let rid = null
    try {
      const body = askToOpenAiBody(ask)
      if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error('empty messages')
      rid = randomUUID()
      pending.set(rid, {
        self, ask, original, at: Date.now(), used: 0,
        sentMessages: body.messages.length,
        sentChars: JSON.stringify(body.messages).length,
        sentContent: contentCharsOf(body.messages),
        // 留存发出去的正文指纹，供 handle 逐条比对（只留哈希与长度，省内存）
        sentList: body.messages.map((m) => ({ role: m?.role, len: contentOf(m).length, hash: hashOf(contentOf(m)) })),
      })
      sweep()
      stats.intercepted += 1
      // bili 是否把它的压缩工具放进了这次请求 —— 这是「压缩链路真的接上了」的直接证据，
      // 因为 bili 不会给不经它转发的请求注入任何工具。
      try {
        const names = Array.isArray(body.tools) ? body.tools.map((t) => String(t?.function?.name ?? t?.name ?? '')) : []
        stats.lastPreparedTools = names.slice(0, 12)
        stats.lastPreparedBiliTools = names.filter((n) => /bili/i.test(n))
        stats.lastPreparedSystemChars = contentOf(body.messages[0]).length
      } catch { /* 诊断字段，失败不影响转发 */ }
      return {
        url: origin + '/qoder/' + rid + '/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    } catch (err) {
      if (rid !== null) pending.delete(rid)
      stats.fallback += 1
      stats.lastError = 'prepareInfer 直通：' + (err && err.message ? err.message : String(err))
      return original.call(self, ask)
    }
  }

  /** 接住 bili 压缩后的明文请求：重建 ask → 用同一实例重新加密 → 直连上游。 */
  const handle = (req, res) => {
    const url = new URL(req.url === undefined ? '/' : req.url, origin)
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":{"type":"qoder_shim_not_found"}}')
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const segments = url.pathname.split('/')
      const fromPath = segments.length >= 3 ? segments[segments.length - 3] : ''
      const rid = fromPath !== '' ? fromPath : url.searchParams.get('rid')
      const entry = rid === null ? undefined : pending.get(rid)
      if (entry === undefined) {
        stats.fallback += 1
        res.writeHead(410, { 'content-type': 'application/json' })
        res.end('{"error":{"type":"qoder_shim_rid_expired"}}')
        return
      }
      // 不删条目：adapter 遇到 409 duplicate_request / 排队后会原样重发，rid 必须还能命中。
      entry.used += 1
      let body = null
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { body = null }
      const messages = body !== null && Array.isArray(body.messages) ? body.messages : null
      const gotChars = messages === null ? 0 : JSON.stringify(messages).length
      const gotCount = messages === null ? 0 : messages.length
      const gotContent = contentCharsOf(messages)
      // 「压缩过」= bili 真的改写了 messages。留一份可核对的样本，否则看不出
      // 是压缩接上了，还是 bili 只是原样透传。
      const changed = messages !== null && (gotCount !== entry.sentMessages || gotChars !== entry.sentChars)
      const shrank = gotContent < entry.sentContent
      if (changed) stats.compacted += 1
      // 两种「改动」要分开计：bili 注入系统提示也会让 messages 变，那不是压缩。
      // 只有正文真的变短（folded）才说明上下文被压下来了。
      if (shrank) stats.folded += 1
      stats.lastExchange = {
        rid,
        at: Date.now(),
        changed,
        beforeCount: entry.sentMessages,
        afterCount: gotCount,
        beforeChars: entry.sentChars,
        afterChars: gotChars,
        // 正文长度与条数才是压缩的证据；JSON 长度变长通常意味着 bili 加了别的东西。
        beforeContent: entry.sentContent,
        afterContent: gotContent,
        contentShrank: gotContent < entry.sentContent,
        // 逐条比对：哪几条被改、怎么改的。bili 只在正文里加东西时 JSON 长度会变长，
        // 但条数与正文长度不变 —— 那不是压缩，看 diff 就能分辨。
        diff: messages === null ? [] : diffMessages(entry.sentList, messages).slice(0, 8),
      }
      // 诊断环：只留最近几次交换的规模与结果。lastExchange 只保留最后一条，
      // 而一次探针会打出多次重试，单看最后一条无法判断「大请求到底进没进来」。
      if (!Array.isArray(stats.recentExchanges)) stats.recentExchanges = []
      stats.recentExchanges.push({
        at: Date.now(),
        rid,
        beforeCount: entry.sentMessages,
        afterCount: gotCount,
        beforeContent: entry.sentContent,
        afterContent: gotContent,
        shrank,
        msgs: entry.sentMessages,
      })
      if (stats.recentExchanges.length > 6) stats.recentExchanges.splice(0, stats.recentExchanges.length - 6)
      const nextAsk = body === null ? null : applyCompressedBody(entry.ask, body)
      let real = null
      try {
        real = entry.original.call(entry.self, nextAsk === null ? entry.ask : nextAsk)
      } catch (err) {
        stats.fallback += 1
        stats.lastError = '重新加密失败：' + (err && err.message ? err.message : String(err))
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'qoder_shim_encrypt', message: stats.lastError } }))
        return
      }
      stats.forwarded += 1
      stats.lastAt = Date.now()
      forward(real, res)
    })
  }

  return { origin, prepare, handle, pending }
}


/**
 * 给已注册的 adapter 实例换掉 fetchImpl：这是唯一不依赖「拿到加密器类」的接缝。
 *
 * dsh-our-free-model 把 qoder adapter + wasm 内联进 pack.js，加密器类是模块局部变量
 * 且对象图被 Cordis 访问守卫包住，拿不到原型。但 adapter.sendEncrypted 最终调用
 * `this.fetchImpl(url, init)` —— 换成我们自己的即可在**加密之后**接管请求。
 *
 * 代价：拿到的是**当前请求的最终 URL**，body 已是被上游协议要求的样子，所以这条路
 * 只用来**观测**（例如确认请求到底走向 shim 还是直连加密端点），不参与压缩。
 *
 * @param adapters collectTargets 找到的 adapter 列表
 * @param stats 共享计数
 * @returns 卸载函数数组
 */
function installPortals(adapters, stats) {
  const restores = []
  for (const item of adapters) {
    const adapter = item.adapter
    let current
    try { current = adapter.fetchImpl } catch { continue }
    if (current === undefined || current === null || current.__mfPortal === true) continue
    const original = current
    const portal = async function mfQoderShimPortal(url, init) {
      stats.seenRequests += 1
      stats.lastRequestUrl = String(url).slice(0, 100)
      return original.call(this, url, init)
    }
    portal.__mfPortal = true
    try {
      adapter.fetchImpl = portal
      restores.push(() => { try { adapter.fetchImpl = original } catch { /* 卸载期忽略 */ } })
      stats.portals = (stats.portals === undefined ? 0 : stats.portals) + 1
    } catch { /* 只读实例，跳过 */ }
  }
  return restores
}

/**
 * 启动 qoder 压缩 shim。同端口重复调用是热替换：服务器与计数保持不动，只把请求
 * 处理换成新实现，所以改完 shim 代码重载插件即可生效，也不会打断既有连接。
 *
 * @param options.ctx Cordis 上下文（用于从 llm 注册表取真实 adapter 类）
 * @param options.logger Cordis logger
 * @param options.port 本机监听端口（127.0.0.1）
 * @param options.wasmPath 可选，磁盘上的 qoder-wasm.js 绝对路径
 * @returns 句柄：{ status(), stop() }；stop 是幂等的 async
 */
export async function startQoderShim(options) {
  const opts = options === undefined ? {} : options
  const ctx = opts.ctx
  const logger = opts.logger
  const port = Number.isInteger(opts.port) && opts.port > 0 && opts.port < 65536 ? opts.port : 47001
  const wasmPath = resolveQoderWasmPath(opts.wasmPath)
  const info = (text) => { if (logger !== undefined && logger !== null && typeof logger.info === 'function') logger.info(text) }

  const inert = (reason) => {
    const stats = {
      enabled: false, installed: false, port,
      wasmPath: wasmPath === null ? null : wasmPath,
      intercepted: 0, forwarded: 0, compacted: 0, folded: 0, fallback: 0,
      lastError: reason, lastAt: null, targets: [], seenRequests: 0, portals: 0,
      hookRepair,
    }
    return { status: () => ({ ...stats }), stop: () => {} }
  }

  // 内联打包那份加密器只能靠 pack.js 里的注入口拿到。那个包会被它自己的自更新
  // 整份替换，钩子随之消失，所以每次装载都核对一次并在缺失时补回去。
  //
  // 磁盘上可能同时存在多份 pack.js（plugins/ 的开发副本 + profiles/<name>/node_modules
  // 的实际安装副本），宿主只 import 其中一份，所以全部核对：任何一份缺注入口，
  // 都可能在下次宿主重启后才轮到它生效。
  const hookChecks = []
  {
    const packs = resolvePackPaths()
    if (packs.length === 0) {
      hookChecks.push({ scope: '-', state: 'skipped', detail: '没找到 dsh-our-free-model/vendor/channel-pack/pack.js' })
    } else {
      for (const p of packs) {
        const result = ensurePackHook(p.path)
        hookChecks.push({ scope: p.scope, path: p.path, ...result })
      }
    }
  }
  /** 取最严重的状态作为对外结论：repaired/failed 优先于 ok，ok 优先于 skipped。 */
  const worst = (() => {
    const rank = { failed: 5, 'pending-restart': 4, repaired: 3, stale: 2, skipped: 1, ok: 0 }
    let pick = hookChecks[0]
    for (const c of hookChecks) {
      if ((rank[c.state] ?? 0) > (rank[pick.state] ?? 0)) pick = c
    }
    return pick
  })()
  const hookRepair = {
    state: hookChecks.length === 1 ? hookChecks[0].state : worst.state,
    detail: hookChecks.map((c) => c.scope + ': ' + c.detail).join('；'),
    copies: hookChecks.map((c) => ({ scope: c.scope, state: c.state })),
  }
  /**
   * 注入口写进文件，不等于当前进程已经执行过它：宿主启动时 import 过 pack.js，
   * 内存里那份模块是**改动前**求值的，globalThis 上仍是 undefined。2026-10-26 的
   * 事故就是这样：文件里的钩子被 profile 重装整份换掉，而 /status 只核对文件、
   * 报「ok」，于是静默失效。所以这里必须再问一次进程自己拿没拿到那个类。
   */
  /**
   * 读一次进程里的注入口对象。
   *
   * 注入口由 dsh-our-free-model 的 pack 在 **它自己 apply 的时候**写入，而本插件可能
   * 更早 apply（宿主冷启动就是这个顺序）。所以「读不到」有两种完全不同的含义：
   * 还没到，或者永远不会有。这里只回答「现在有没有」，由调用方决定要不要等。
   *
   * @returns 暴露出来的类，或 null
   */
  const readLiveEncryptor = () => {
    try {
      const value = globalThis.__mfQoderEncryptor
      return typeof value === 'function' && value.prototype !== undefined ? value : null
    } catch { return null }
  }
  /** 注入口还有可能在未来出现（文件里有、只是 pack 还没 apply）。 */
  const hookPossible = hookChecks.some((c) => c.state === 'ok' || c.state === 'repaired' || c.state === 'stale')

  const collected = await collectTargets(ctx, wasmPath)
  if (collected.targets.length === 0 && !hookPossible) {
    return inert('找不到可打补丁的 QoderEncryptedInfer' + (collected.notes.length > 0 ? '：' + collected.notes.join('; ') : ''))
  }

  const previous = globalThis[STATE_KEY]
  const stats = previous !== undefined && previous.stats !== undefined
    ? previous.stats
    : {
        enabled: true, installed: true, port, wasmPath,
        intercepted: 0, forwarded: 0, compacted: 0, folded: 0, fallback: 0,
        lastError: null, lastAt: null, targets: [], seenRequests: 0, portals: 0,
      }
  if (typeof stats.folded !== 'number') stats.folded = 0
  // 上表中没有的计数字段（新增字段时旧 stats 对象会缺）补零，避免 /status 出现 undefined。
  for (const key of ['intercepted', 'forwarded', 'compacted', 'seenRequests', 'portals']) {
    if (typeof stats[key] !== 'number') stats[key] = 0
  }
  stats.enabled = true
  stats.installed = true
  stats.port = port
  stats.wasmPath = wasmPath
  stats.targets = collected.targets.map((t) => t.label)
  stats.notes = collected.notes
  stats.hookRepair = hookRepair
  // 沿用上一轮的 pending：在途请求的 rid 属于上一轮的 prepare。
  const impl = createImpl({ port, stats, pending: previous !== undefined && previous.impl !== undefined ? previous.impl.pending : null })

  /**
   * 装 dispatcher（幂等）。dispatcher 不随重载更换：它只读全局状态槽，重载时换掉
   * 槽里的 impl 就生效，因此 stop() 能可靠还原，也不会层层套娃。
   */
  const ensureDispatcher = (entry) => {
    if (entry.fn === undefined) {
      entry.fn = function mfQoderShimDispatch(ask) {
        const state = globalThis[STATE_KEY]
        if (state === undefined) return entry.box.original.call(this, ask)
        return state.impl.prepare(this, ask, entry.box.original)
      }
    }
    if (entry.holder.prepareInfer !== entry.fn) entry.holder.prepareInfer = entry.fn
  }

  const patched = previous !== undefined && Array.isArray(previous.patched) ? previous.patched : []

  /**
   * 把一个目标挂上 dispatcher。重复调用安全：同一个 label 只保留一条记录。
   *
   * @param label 唯一标识这个 holder（见 collectTargets 的 label 约定）
   * @param holder 承载 prepareInfer 的原型对象
   * @param original 别人实现的 prepareInfer
   */
  const patchTarget = (label, holder, original) => {
    const existing = patched.find((p) => p.label === label)
    if (existing === undefined) {
      const entry = { label, holder, box: { original }, fn: undefined }
      ensureDispatcher(entry)
      patched.push(entry)
      return
    }
    existing.holder = holder
    // ⚠️ 重载时 holder.prepareInfer 已经是本模块装的 dispatcher，把它当「原始实现」
    // 会让 handle 里的重新加密再次走进 dispatcher —— 请求自己转发给自己，计数暴涨
    // 且最终 502。只有拿到的确实是别人实现的函数时才更新 box.original。
    if (original !== existing.fn) existing.box.original = original
    ensureDispatcher(existing)
  }
  for (const t of collected.targets) patchTarget(t.label, t.holder, t.original)

  /**
   * 认领运行时真正在用的加密器（pack.js 内联那份），成功即打上补丁。
   *
   * pack 的 apply 与「本插件 apply」没有顺序保证：宿主冷启动时本插件先 apply，
   * 那时注入口还不存在。所以这里既做首次尝试，也作为重试定时器的回调 —— 只在
   * 还没认领到的时候继续试，认领成功后不再消耗任何资源。
   *
   * @returns 本次是否认领成功（此前已认领也算成功）
   */
  const adoptRuntimeEncryptor = () => {
    if (stats.effective === true) return true
    const Cls = readLiveEncryptor()
    if (Cls === null) return false
    patchTarget(ADOPT_LABEL, Cls.prototype, Cls.prototype.prepareInfer)
    const labels = new Set(patched.map((p) => p.label))
    stats.targets = [...labels]
    stats.effective = true
    stats.adoptedAt = new Date().toISOString()
    stats.notes = collected.notes
    info('[model-failover] qoder 压缩 shim 已认领运行时加密器（pack:__mfQoderEncryptor），此后 qoder 请求走「明文进 bili → 压缩 → 再加密发上游」')
    return true
  }
  adoptRuntimeEncryptor()
  if (stats.effective !== true) {
    stats.effective = false
    stats.notes = [
      ...collected.notes,
      '还没认领到运行时加密器（globalThis.__mfQoderEncryptor 为空）：dsh-our-free-model 的 pack 尚未 apply，本 shim 会继续重试认领',
    ]
  }

  // 无论有没有打到类，都给真实 adapter 装传送门（诊断 + 覆盖率证明）。
  const portals = installPortals(collected.adapters, stats)

  /**
   * 认领定时器跨重载共用一份：热替换只换回调，不叠加定时器。
   *
   * 只在「注入口有可能出现、但此刻还没有」时启动；认领成功或插件卸载即自我注销。
   * unref 让它不拖住进程退出。
   */
  const retry = previous !== undefined && previous.retry !== undefined
    ? previous.retry
    : { fn: null, timer: null, ticks: 0 }
  retry.fn = adoptRuntimeEncryptor
  stats.adoptTicks = retry.ticks
  if (stats.effective !== true && hookPossible && retry.timer === null && typeof setInterval === 'function') {
    retry.timer = setInterval(() => {
      retry.ticks += 1
      stats.adoptTicks = retry.ticks
      const slot = globalThis[STATE_KEY]
      if (slot === undefined || retry.fn === null || retry.ticks > ADOPT_MAX_TICKS) {
        clearInterval(retry.timer)
        retry.timer = null
        return
      }
      // 只换 impl 的话，这里可能仍是旧模块的回调；旧的也能用（认领逻辑与模块版本无关）
      if (retry.fn()) {
        clearInterval(retry.timer)
        retry.timer = null
      }
    }, ADOPT_INTERVAL_MS)
    if (typeof retry.timer.unref === 'function') retry.timer.unref()
  }

  if (previous !== undefined && previous.port === port && previous.server !== undefined) {
    previous.impl = impl
    previous.patched = patched
    previous.retry = retry
    info('[model-failover] qoder 压缩 shim 已热替换实现（继续复用 127.0.0.1:' + port + '，覆盖 ' + patched.length + ' 个目标）')
    return { status: () => ({ ...stats, liveSeen: readLiveEncryptor() !== null }), stop: previous.stop }
  }
  if (previous !== undefined) await previous.stop()

  const server = http.createServer((req, res) => {
    const state = globalThis[STATE_KEY]
    const current = state === undefined ? impl : state.impl
    current.handle(req, res)
  })

  let stopped = false
  /** 退场：把 dispatcher 换回原始实现、停止监听。幂等。 */
  const stop = async () => {
    if (stopped) return
    stopped = true
    if (retry.timer !== null) {
      try { clearInterval(retry.timer) } catch { /* 已停 */ }
      retry.timer = null
    }
    for (const p of patched) {
      try { if (p.holder !== undefined && p.holder.prepareInfer === p.fn) p.holder.prepareInfer = p.box.original } catch { /* 还原失败不影响进程退出 */ }
    }
    for (const restore of portals) { try { restore() } catch { /* 同上 */ } }
    try {
      const state = globalThis[STATE_KEY]
      if (state !== undefined && state.stop === stop) delete globalThis[STATE_KEY]
    } catch { /* 同上 */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { server.closeAllConnections?.() } catch { /* 老 Node 没有这个方法 */ }
        resolve()
      }, STOP_GRACE_MS)
      try {
        server.close(() => { clearTimeout(timer); resolve() })
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  await new Promise((done) => { server.listen(port, '127.0.0.1', done) })
  globalThis[STATE_KEY] = { port, wasmPath, stats, impl, patched, portals, retry, server, stop }
  info('[model-failover] qoder 压缩 shim 已监听 127.0.0.1:' + port + '（明文经 bili 压缩后再加密发往上游；覆盖 ' + patched.length + ' 个目标：' + stats.targets.join(', ') + '）')

  /**
   * 句柄。status() 里的 liveSeen 是**实时**读的：stats.effective 只在认领那一刻写一次，
   * 而注入口可能在本插件 apply 之后才由 pack 写好，两者不一致时 liveSeen 能说明到底是
   * 「进程里没有」还是「有但没认领」。
   */
  return { status: () => ({ ...stats, liveSeen: readLiveEncryptor() !== null }), stop }
}
