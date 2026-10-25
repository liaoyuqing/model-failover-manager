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
import { existsSync, readdirSync } from 'node:fs'
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
 * 进程内唯一的 shim 状态槽。放在 globalThis 而不是模块作用域：插件重载会重新
 * import 本模块（新的模块实例），但监听端口和 prototype 补丁属于进程本身 ——
 * 共用一个槽就能做到「重载只换实现、不重建服务器」，避免既有 keep-alive 连接
 * 被掐断后客户端撞 ECONNRESET。
 */
const STATE_KEY = '__mfQoderShim'

/** 停服宽限：先停止监听，既有连接自然收尾；超过这个时间再强拆，避免端口长期被占。 */
const STOP_GRACE_MS = 2000

/**
 * 造一份实现：持有一轮装载的 pending 表与计数，负责
 * （1）把 ask 截成明文 OpenAI 请求，（2）处理 bili 压缩后送回来的请求。
 *
 * @param context.port 本机监听端口（只用于拼 origin）
 * @param context.wasmPath qoder-wasm.js 绝对路径（回传给 /status）
 * @param context.original 未被替换的 QoderEncryptedInfer#prepareInfer
 * @param context.logger Cordis logger
 * @returns 实现对象 { origin, stats, prepare, handle }
 */
function createImpl(context) {
  const origin = 'http://127.0.0.1:' + context.port
  const original = context.original
  const pending = new Map()
  const stats = {
    enabled: true,
    installed: true,
    port: context.port,
    wasmPath: context.wasmPath,
    intercepted: 0,
    forwarded: 0,
    compacted: 0,
    fallback: 0,
    lastError: null,
    lastAt: null,
  }

  const sweep = () => {
    const now = Date.now()
    for (const [rid, entry] of pending) {
      if (now - entry.at > PENDING_TTL_MS || pending.size > PENDING_MAX) pending.delete(rid)
    }
  }

  /** 用原始 prepareInfer 加密，并用 node:https 直连上游（绕开 bili，避免被二次改写），SSE 原样穿回。 */
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

  /**
   * 顶掉 QoderEncryptedInfer#prepareInfer：正常的 qoder 上游请求被换成指向本机 shim
   * 的明文 OpenAI 请求（路径以 /chat/completions 结尾，bili 才认）。任何异常都退回原实现。
   */
  const prepare = (self, ask) => {
    let rid = null
    try {
      const body = askToOpenAiBody(ask)
      if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error('empty messages')
      rid = randomUUID()
      pending.set(rid, { self, ask, at: Date.now(), used: 0, sentMessages: body.messages.length, sentChars: JSON.stringify(body.messages).length })
      sweep()
      stats.intercepted += 1
      return {
        // rid 放在路径里而不是 query：中继层可能改写或剥离查询串，路径段更稳。
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

  /** 接住 bili 压缩后的明文请求：重建 ask → 重新加密 → 直连上游。 */
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
      // 不删条目：adapter 遇到 409 duplicate_request / 排队后会**原样重发**同一个请求，
      // 那时 rid 必须还能命中，否则重试会变成 410。条目只由 TTL 与容量淘汰。
      if (entry !== undefined) entry.used += 1
      if (entry === undefined) {
        stats.fallback += 1
        res.writeHead(410, { 'content-type': 'application/json' })
        res.end('{"error":{"type":"qoder_shim_rid_expired"}}')
        return
      }
      let body = null
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { body = null }
      const messages = body !== null && Array.isArray(body.messages) ? body.messages : null
      if (messages !== null && (messages.length !== entry.sentMessages || JSON.stringify(messages).length !== entry.sentChars)) {
        stats.compacted += 1
      }
      const nextAsk = body === null ? null : applyCompressedBody(entry.ask, body)
      let real = null
      try {
        real = original.call(entry.self, nextAsk === null ? entry.ask : nextAsk)
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

  return { origin, stats, prepare, handle }
}

/**
 * 启动 qoder 压缩 shim：替换 QoderEncryptedInfer#prepareInfer，并监听一个本机端口
 * 承接 bili 压缩后的明文请求。同端口重复调用视为热替换：服务器与补丁保持不动，
 * 只把请求处理换成新实现，因此改造 shim 代码后重载插件即可生效，且不会打断连接。
 *
 * @param options.logger Cordis logger
 * @param options.port 本机监听端口（127.0.0.1）
 * @param options.wasmPath 可选，qoder-wasm.js 绝对路径
 * @returns 句柄：{ status(), stop() }；stop 是幂等的 async
 */
export async function startQoderShim(options) {
  const logger = options === undefined ? undefined : options.logger
  const port = Number.isInteger(options.port) && options.port > 0 && options.port < 65536 ? options.port : 47001
  const wasmPath = resolveQoderWasmPath(options.wasmPath)
  const info = (text) => {
    if (logger !== undefined && typeof logger.info === 'function') logger.info(text)
  }
  /** 装不上时的空手柄：只回报原因，不打断 qoder 的正常使用。 */
  const inert = (reason) => {
    const stats = {
      enabled: false,
      installed: false,
      port,
      wasmPath: wasmPath === null ? null : wasmPath,
      intercepted: 0,
      forwarded: 0,
      compacted: 0,
      fallback: 0,
      lastError: reason,
      lastAt: null,
    }
    return { status: () => ({ ...stats }), stop: () => {} }
  }
  if (wasmPath === null) return inert('qoder-wasm.js 未找到（可用 qoderShimWasmPath 指定绝对路径）')

  const wasm = await import(pathToFileURL(wasmPath).href)
  const QoderEncryptedInfer = wasm.QoderEncryptedInfer
  if (typeof QoderEncryptedInfer !== 'function' || typeof QoderEncryptedInfer.prototype.prepareInfer !== 'function') {
    return inert('qoder-wasm.js 里没有 QoderEncryptedInfer#prepareInfer（版本不兼容）')
  }

  const proto = QoderEncryptedInfer.prototype
  const previous = globalThis[STATE_KEY]
  const original = previous !== undefined ? previous.original : proto.prepareInfer
  const impl = createImpl({ port, wasmPath, original, logger })

  // 同端口热替换：监听与补丁都不动，只换实现指针 —— 连接不重建，客户端不会撞 ECONNRESET。
  if (previous !== undefined && previous.port === port) {
    previous.impl = impl
    info('[model-failover] qoder 压缩 shim 已热替换实现（继续复用 127.0.0.1:' + port + '）')
    return { status: () => ({ ...impl.stats }), stop: previous.stop }
  }
  if (previous !== undefined) await previous.stop()

  const patched = function mfQoderShimDispatch(ask) {
    const state = globalThis[STATE_KEY]
    if (state === undefined) return original.call(this, ask)
    return state.impl.prepare(this, ask)
  }
  proto.prepareInfer = patched

  // 分发到「当前实现」，这样热替换后新代码立即生效。
  const server = http.createServer((req, res) => {
    const state = globalThis[STATE_KEY]
    const current = state === undefined ? impl : state.impl
    current.handle(req, res)
  })

  let stopped = false
  /** 退场：还原 prototype、停止监听。幂等；既有连接给 STOP_GRACE_MS 自然收尾再强拆。 */
  const stop = async () => {
    if (stopped) return
    stopped = true
    try { if (proto.prepareInfer === patched) proto.prepareInfer = original } catch { /* 还原失败不影响进程退出 */ }
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
  globalThis[STATE_KEY] = { port, wasmPath, proto, original, patched, impl, server, stop }
  info('[model-failover] qoder 压缩 shim 已监听 127.0.0.1:' + port + '（明文经 bili 压缩后再加密发往上游）')

  return { status: () => ({ ...impl.stats }), stop }
}
