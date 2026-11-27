/**
 * dsh-subagent-prune — Host 半：持久化「已删除的子代理」，并在工具面上让会话查不到它们。
 *
 * 背景：子代理目录（subagentCatalog）是父会话日志里只增不减的 subagent/catalog 事件投影，宿主没有删除
 * 入口；会话日志又由内核的写锁保护，改不动。因此「删除」在这三层实现：
 *   1. 浏览器半（client.js）：会话面板的「子智能体」分栏里不再列出这些子代理；
 *   2. 工具面（本文件）：会话里的模型再调 list_agents 时结果里不再有这些条目，再调 send_message 指向
 *      它们时被拒绝——模型看到的目录与「已删除」一致；
 *   3. 停止：删除时中断被删子代理及其子树的当前执行，别让它在列表外继续跑。
 * 删除可逆：state.json 记着被删的子代理 id，「恢复」即把它移出这个集合。
 *
 * 同源接口：
 *   GET  /dsh-subagent-prune/api/state                 全部父会话的删除集合
 *   POST /dsh-subagent-prune/api/set    {sessionId, childIds, hidden}  增/减删除项
 *   POST /dsh-subagent-prune/api/reset  {sessionId}    清掉一个父会话的删除集合
 *   POST /dsh-subagent-prune/api/reset-all             清掉全部
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-subagent-prune'
export const inject = []

/** 路由前缀；浏览器半按同一前缀取数。 */
const UI_PATH = '/dsh-subagent-prune'
/** 请求体上限，超过即拒绝。 */
const MAX_BODY_BYTES = 64 * 1024
/** 冷启动时 webServer 可能尚未挂载，注册重试的间隔与次数。 */
const ROUTE_RETRY_MS = 200
const ROUTE_RETRY_LIMIT = 50
/** 落盘格式版本，供以后的迁移判断。 */
const STATE_VERSION = 2
/** 列出子代理树的工具名。 */
const LIST_AGENTS_TOOL = 'list_agents'
/** 给子代理发消息的工具名。 */
const SEND_MESSAGE_TOOL = 'send_message'
/** 让子代理停手的工具名。 */
const INTERRUPT_AGENT_TOOL = 'interrupt_agent'
/** 以别的子代理为目标、参数里带目标名的工具。 */
const TARGETED_TOOLS = new Set([SEND_MESSAGE_TOOL, INTERRUPT_AGENT_TOOL])

const HOME_DIR = process.env['DSH_HOME'] || join(homedir(), '.dsh')
const DATA_DIR = join(HOME_DIR, 'dsh-subagent-prune')
const STATE_FILE = join(DATA_DIR, 'state.json')

/** 空状态。 */
function emptyState() {
  return { version: STATE_VERSION, sessions: {} }
}

/**
 * 读取落盘状态；文件缺失或不可解析时退回空状态（插件不该因为脏文件而挂掉）。
 * @returns {{version:number, sessions:Record<string,string[]>}}
 */
function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return emptyState()
    const sessions = parsed.sessions
    const out = emptyState()
    if (sessions !== null && typeof sessions === 'object') {
      for (const [sessionId, ids] of Object.entries(sessions)) {
        if (!Array.isArray(ids)) continue
        const clean = ids.filter(id => typeof id === 'string' && id.length > 0)
        if (clean.length > 0) out.sessions[sessionId] = [...new Set(clean)]
      }
    }
    return out
  } catch (error) {
    return emptyState()
  }
}

/** 原子落盘（同目录临时文件 + rename）。 */
function saveState(state) {
  mkdirSync(DATA_DIR, { recursive: true })
  const temporary = `${STATE_FILE}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporary, STATE_FILE)
}

/** 读取 JSON 请求体；超限或非法 JSON 抛错。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${String((error && error.message) || error)}`))
      }
    })
    req.on('error', (error) => { reject(error) })
  })
}

/** 统一 JSON 响应：只设 content-type，不钉 content-length（gzip 会改写 body 长度）。 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** 一个父会话的删除集合（去重后的数组）。 */
function deletedOf(state, sessionId) {
  const ids = state.sessions[sessionId]
  return Array.isArray(ids) ? ids : []
}

/**
 * 插件主体：挂载同源接口，并在工具面上执行删除。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 */
export function apply(ctx) {
  let disposed = false
  let state = readState()

  /** 被删除的子代理 id 全集；子代理 id 全局唯一，所以跨会话取并集不会误伤同名代理。 */
  const deletedIds = () => {
    const ids = new Set()
    for (const list of Object.values(state.sessions)) {
      for (const id of list) ids.add(id)
    }
    return ids
  }

  /**
   * 某棵子代理树里被删除的条目：自身在删除集合里，或它的某个祖先在删除集合里。
   * 返回 id 集合（发消息时按它拒绝）与名字集合（list_agents 按它过滤）。
   * @param {object} caller - 调用工具的 Agent。
   * @param {AbortSignal|undefined} signal - 取消信号。
   * @returns {Promise<{ids:Set<string>, names:Set<string>}>} 空的集合表示无可过滤项。
   */
  async function deletedTree(caller, signal) {
    const base = deletedIds()
    const empty = { ids: new Set(), names: new Set() }
    if (base.size === 0) return empty
    const subagents = ctx.get('subagents')
    if (subagents === undefined) return { ids: base, names: new Set() }
    let root
    try {
      root = subagents.rootOf(caller)
    } catch (error) {
      return { ids: base, names: new Set() }
    }
    let entries
    try {
      entries = await subagents.listDescendants(root.id, signal)
    } catch (error) {
      return { ids: base, names: new Set() }
    }
    const byId = new Map()
    for (const entry of entries) byId.set(entry.id, entry)
    const verdicts = new Map()
    /**
     * 一个条目是否被删除：自身在删除集合里，或它的某个祖先在删除集合里。
     * @param {string} id - 条目的子代理 id。
     * @param {Set<string>} seen - 本次递归已访问的 id，避免异常目录造成环。
     * @returns {boolean} 是否应从结果里摘掉。
     */
    const isDeleted = (id, seen) => {
      const cached = verdicts.get(id)
      if (cached !== undefined) return cached
      if (seen.has(id)) return false
      seen.add(id)
      const entry = byId.get(id)
      let deleted = base.has(id)
      if (!deleted && entry !== undefined && entry.parentId !== root.id) {
        deleted = isDeleted(entry.parentId, seen)
      }
      verdicts.set(id, deleted)
      return deleted
    }
    const ids = new Set(base)
    const names = new Set()
    for (const entry of entries) {
      if (!isDeleted(entry.id, new Set())) continue
      ids.add(entry.id)
      names.add(entry.path ?? entry.id)
    }
    return { ids, names }
  }

  /**
   * list_agents 的结果里摘掉已删除的条目（含被删子代理的子树）。
   * @param {object} exec - 本次工具调用。
   * @param {object} result - 工具返回的规范化结果。
   * @param {() => Promise<object>} next - 后续瀑布。
   * @returns {Promise<object>} 替换后的决定。
   */
  async function filterListAgents(exec, result, next) {
    const decision = await next()
    if (exec.name !== LIST_AGENTS_TOOL) return decision
    if (decision.kind !== 'accept') return decision
    if (result.isError) return decision
    const value = result.value
    if (value === null || typeof value !== 'object') return decision
    const rows = value.agents
    if (!Array.isArray(rows)) return decision
    const caller = exec.agent
    if (caller === undefined) return decision
    const tree = await deletedTree(caller, exec.signal)
    if (tree.names.size === 0) return decision
    const removed = (row) => row !== null
      && typeof row === 'object'
      && typeof row.name === 'string'
      && tree.names.has(row.name)
    const filtered = rows.filter(row => !removed(row))
    if (filtered.length === rows.length) return decision
    // 容量里的运行数也按被摘掉的行扣掉，免得模型看到「容量 12 个在跑」却只列得出三行。
    const removedRunning = rows.filter(row => removed(row) && row.status === 'running').length
    const running = typeof value.running === 'number'
      ? Math.max(0, value.running - removedRunning)
      : value.running
    return { kind: 'accept', value: { ...value, running, agents: filtered } }
  }

  /**
   * 拒绝指向已删除子代理的调用：send_message 与 interrupt_agent 的目标参数都是 agent 名。
   * @param {object} exec - 本次工具调用。
   * @param {() => Promise<object>} next - 后续瀑布。
   * @returns {Promise<object>} 允许或拒绝的决定。
   */
  async function denyDeletedTargets(exec, next) {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    if (!TARGETED_TOOLS.has(exec.name)) return decision
    const args = exec.arguments
    const target = args !== null && typeof args === 'object' ? args.agent : undefined
    if (typeof target !== 'string' || target === '') return decision
    const caller = exec.agent
    if (caller === undefined) return decision
    const subagents = ctx.get('subagents')
    if (subagents === undefined) return decision
    const tree = await deletedTree(caller, exec.signal)
    if (tree.ids.size === 0) return decision
    // 名字就是被删条目在树里的路径时直接拒绝：resolveName 把不含 '/' 的文本当 Session id，
    // 只靠解析结果会漏掉这种情况。
    if (tree.names.has(target)) {
      return {
        kind: 'deny',
        reason: `agent ${JSON.stringify(target)} was deleted from this subagent tree; use list_agents to see the remaining agents`,
      }
    }
    let resolved
    try {
      resolved = await subagents.resolveName(caller, target, exec.signal)
    } catch (error) {
      return decision
    }
    if (!tree.ids.has(resolved)) return decision
    return {
      kind: 'deny',
      reason: `agent ${JSON.stringify(target)} was deleted from this subagent tree; use list_agents to see the remaining agents`,
    }
  }

  ctx.on('tools/pre-execute', denyDeletedTargets)
  ctx.on('tools/post-execute', filterListAgents)

  /**
   * 中断被删子代理及其子树的当前执行——删除是「让它停下来」，不是「让它在列表外继续跑」。
   * @param {string} parentSessionId - 被删子代理的父会话。
   * @param {string[]} childIds - 被删的子代理 id。
   * @returns {Promise<void>} 中断结束。
   */
  async function stopDeletedSubtree(parentSessionId, childIds) {
    const subagents = ctx.get('subagents')
    if (subagents === undefined) return
    const targets = new Set(childIds)
    try {
      const entries = await subagents.listDescendants(parentSessionId, undefined)
      const byId = new Map()
      for (const entry of entries) byId.set(entry.id, entry)
      /**
       * 一个条目是否落在某个被删条目之下。
       * @param {string} id - 条目的子代理 id。
       * @param {Set<string>} seen - 本次递归已访问的 id。
       * @returns {boolean} 是否在被删子树里。
       */
      const underDeleted = (id, seen) => {
        if (seen.has(id)) return false
        seen.add(id)
        const entry = byId.get(id)
        if (entry === undefined) return false
        if (targets.has(entry.parentId)) return true
        return underDeleted(entry.parentId, seen)
      }
      for (const entry of entries) {
        if (underDeleted(entry.id, new Set())) targets.add(entry.id)
      }
    } catch (error) {
      ctx.logger.warn(`dsh-subagent-prune: 读取子代理目录失败（${String((error && error.message) || error)}），只中断被删的条目`)
    }
    for (const id of targets) {
      try {
        subagents.interrupt(id, { kind: 'user' })
      } catch (error) {
        ctx.logger.warn(`dsh-subagent-prune: 中断子代理 ${id} 失败（${String((error && error.message) || error)}）`)
      }
    }
  }

  const handleRoute = async (req, res) => {
    let path = '/'
    try {
      path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch (error) {
      path = '/'
    }
    if (!path.startsWith(`${UI_PATH}/api/`)) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    const sub = path.slice(`${UI_PATH}/api/`.length)
    try {
      if (sub === 'state') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        sendJson(res, 200, { ok: true, version: STATE_VERSION, sessions: state.sessions })
        return
      }
      if (sub === 'set') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') {
          sendJson(res, 400, { ok: false, error: 'sessionId 必须是非空字符串' })
          return
        }
        const childIds = Array.isArray(body.childIds)
          ? body.childIds.filter(id => typeof id === 'string' && id.length > 0)
          : []
        if (childIds.length === 0) {
          sendJson(res, 400, { ok: false, error: 'childIds 必须是非空字符串数组' })
          return
        }
        const hidden = body.hidden !== false
        const current = new Set(deletedOf(state, sessionId))
        for (const id of childIds) {
          if (hidden) current.add(id)
          else current.delete(id)
        }
        if (current.size === 0) delete state.sessions[sessionId]
        else state.sessions[sessionId] = [...current]
        saveState(state)
        if (hidden) await stopDeletedSubtree(sessionId, childIds)
        sendJson(res, 200, { ok: true, sessions: state.sessions })
        return
      }
      if (sub === 'reset') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') {
          sendJson(res, 400, { ok: false, error: 'sessionId 必须是非空字符串' })
          return
        }
        delete state.sessions[sessionId]
        saveState(state)
        sendJson(res, 200, { ok: true, sessions: state.sessions })
        return
      }
      if (sub === 'reset-all') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        state = emptyState()
        saveState(state)
        sendJson(res, 200, { ok: true, sessions: state.sessions })
        return
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
    }
  }

  // 冷启动时补丁层可能先于 webServer 挂载；注册报错时轮询重试。
  let routeDisposer = null
  let routeRetries = 0
  const tryRegister = (webServer) => {
    if (disposed || routeDisposer !== null) return
    try {
      const exact = webServer.register({ kind: 'exact', path: `${UI_PATH}/api/state`, handler: handleRoute })
      const prefix = webServer.register({ kind: 'prefix', path: UI_PATH, handler: handleRoute })
      routeDisposer = () => { exact(); prefix() }
      ctx.logger.info(`dsh-subagent-prune: 接口已挂载在 ${UI_PATH}`)
    } catch (error) {
      routeDisposer = null
      ctx.logger.warn(`dsh-subagent-prune: 路由注册暂不可用（${String((error && error.message) || error)}），稍后重试`)
    }
  }
  ctx.inject(['webServer'], (scope) => {
    tryRegister(scope.webServer)
    if (routeDisposer === null && !disposed) {
      const stopRetry = ctx.interval(() => {
        routeRetries += 1
        tryRegister(scope.webServer)
        if (routeDisposer !== null || disposed || routeRetries >= ROUTE_RETRY_LIMIT) stopRetry()
      }, ROUTE_RETRY_MS)
      scope.effect(() => stopRetry, 'dsh-subagent-prune: 路由注册重试')
    }
  })

  ctx.effect(() => () => {
    disposed = true
    if (routeDisposer !== null) {
      const dispose = routeDisposer
      routeDisposer = null
      try { dispose() } catch (error) {
        // 卸载期的路由移除失败只会留下一段死路由，不值得抛出打断其它清理。
        ctx.logger.warn(`dsh-subagent-prune: 路由移除失败（${String((error && error.message) || error)}）`)
      }
    }
  }, 'dsh-subagent-prune: 路由清理')
}
