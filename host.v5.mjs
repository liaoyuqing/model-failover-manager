/**
 * model-failover-manager v5 — Host 端插件。
 *
 * 绑定模式（每会话一个绑定，二选一）：
 * - failover（故障兜底）：会话继续用当前手动选择的模型；仅当某模型在所有
 *   重试耗尽后彻底失败时，才从绑定分组里挑下一个可用模型，作为会话级切换。
 * - route（分组路由）：绑定即把会话模型切到组内优先级最高的可用模型；
 *   彻底失败后切到组内下一个。会话后续请求都用这个模型，直到再次切换。
 *
 * 关键约束：切换只走 sessionController.selectModel（durable 的 model/selection
 * 事件 + selection.current 缓存），绝不在 agent/request 里逐请求改写——
 * prepareRequest 位于重试循环内部，逐请求改写会造成同一步内换来换去。
 * 失败切换后当前轮照常报错结束，下一轮起用新模型。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'model-failover-manager'
export const inject = ['timer']

const DATA_DIR_DEFAULT = 'model-failover-manager'
const API_PATH = '/api/model-failover'

function failKey(provider, model) { return `${provider}/${model}` }
function todayKey() { return new Date().toISOString().slice(0, 10) }

export function apply(ctx, config = {}) {
  const dataDir = typeof config.dataDir === 'string' && config.dataDir.trim()
    ? config.dataDir
    : join(process.env['DSH_HOME'] || join(homedir(), '.dsh'), DATA_DIR_DEFAULT)
  try { mkdirSync(dataDir, { recursive: true }) } catch {}

  const groupsFile = join(dataDir, 'groups.json')
  const failedFile = join(dataDir, 'failed.json')
  const settingsFile = join(dataDir, 'settings.json')

  /** sessionId（agent.session.id）-> { groupId, mode: 'failover' | 'route' } */
  const sessionBindings = new Map()
  /** sessionId -> turn（该轮出现过彻底失败，成功轮才允许重置失败状态） */
  const errorTurns = new Map()

  function readJson(path, fallback) {
    try { if (!existsSync(path)) return fallback; return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
  }
  function writeJson(path, data) { writeFileSync(path, JSON.stringify(data, null, 2), 'utf8') }

  /** @type {{ id: string; name: string; enabled: boolean; models: { provider: string; model: string; priority: number; effort?: string }[] }[]} */
  let groups = readJson(groupsFile, [])
  /** @type {{ key: string; day: string; count: number; provider: string; model: string }[]} */
  let failedList = readJson(failedFile, [])
  let settings = Object.assign({ dialogMode: false }, readJson(settingsFile, {}))
  let disposed = false

  function saveGroups() { writeJson(groupsFile, groups) }
  function saveFailed() { writeJson(failedFile, failedList) }
  function saveSettings() { writeJson(settingsFile, settings) }

  function isFailed(provider, model) {
    const k = failKey(provider, model); const d = todayKey()
    return failedList.some(f => f.key === k && f.day === d)
  }

  function markFailed(provider, model) {
    const k = failKey(provider, model); const d = todayKey()
    const idx = failedList.findIndex(f => f.key === k && f.day === d)
    if (idx >= 0) failedList[idx].count = (failedList[idx].count || 1) + 1
    else failedList.push({ key: k, day: d, count: 1, provider, model })
    failedList = failedList.filter(f => f.day === d)
    saveFailed()
  }

  function resetFailed(provider, model) {
    failedList = failedList.filter(f => !(f.provider === provider && f.model === model && f.day === todayKey()))
    saveFailed()
  }

  function resetAllFailed() {
    const d = todayKey(); failedList = failedList.filter(f => f.day !== d); saveFailed()
  }

  /** 组内模型按 priority 升序（同优先级保持登记顺序） */
  function sortedModels(groupId) {
    const g = groups.find(x => x.id === groupId)
    if (!g) return []
    return g.models
      .map((m, i) => ({ ...m, _i: i }))
      .toSorted((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || a._i - b._i)
  }

  /** 组内第一个未失败模型（携带分组配置的思考强度） */
  function firstAvailableInGroup(groupId) {
    for (const m of sortedModels(groupId)) {
      if (!isFailed(m.provider, m.model)) return { provider: m.provider, model: m.model, effort: m.effort ?? null }
    }
    return null
  }

  /** 组内除 exclude 外的下一个未失败模型（按优先级顺序） */
  function nextInGroup(groupId, exclude) {
    for (const cand of sortedModels(groupId)) {
      if (cand.provider === exclude.provider && cand.model === exclude.model) continue
      if (!isFailed(cand.provider, cand.model)) return { provider: cand.provider, model: cand.model, effort: cand.effort ?? null }
    }
    return null
  }

  /** 无会话绑定时，从当前模型所属分组里找优先级不低于它的可用模型 */
  function findFailover(currentProvider, currentModel) {
    for (const group of groups) {
      if (!group.enabled) continue
      const self = group.models.find(m => m.provider === currentProvider && m.model === currentModel)
      if (!self) continue
      const limit = self.priority ?? 99
      for (const cand of sortedModels(group.id)) {
        if (cand.provider === currentProvider && cand.model === currentModel) continue
        if ((cand.priority ?? 99) > limit) continue
        if (!isFailed(cand.provider, cand.model)) return { provider: cand.provider, model: cand.model, effort: cand.effort ?? null }
      }
      return null
    }
    return null
  }

  function getAllModels() {
    const seen = new Set(); const out = []
    for (const g of groups) {
      if (!g.enabled) continue
      for (const m of g.models) {
        const k = failKey(m.provider, m.model)
        if (seen.has(k)) continue
        seen.add(k)
        out.push({ provider: m.provider, model: m.model, priority: m.priority ?? 99, effort: m.effort ?? null, failed: isFailed(m.provider, m.model) })
      }
    }
    return out
  }

  /**
   * 会话级模型切换的唯一入口：sessionController.selectModel。
   * 它校验目录、写 durable 的 model/selection 事件、更新 selection.current，
   * UI 与下一轮请求自然一致；绝不逐请求改写。
   */
  async function switchSessionModel(agent, target) {
    const controller = ctx.get('sessionController')
    if (!controller) {
      ctx.logger.warn('[model-failover] sessionController 不可用，无法切换模型')
      return false
    }
    try {
      await controller.selectModel({
        sessionId: agent.session.id,
        provider: target.provider,
        model: target.model,
        ...(target.effort ? { reasoningEffort: target.effort } : {}),
      })
      ctx.logger.info(`[model-failover] 会话 ${String(agent.session.id)} 切换至 ${target.provider}/${target.model}${target.effort ? ' (effort=' + target.effort + ')' : ''}`)
      return true
    } catch (e) {
      ctx.logger.warn(`[model-failover] 切换 ${target.provider}/${target.model} 失败: ${e?.message || e}`)
      return false
    }
  }

  /* ============ 重试全部耗尽后：标记失败 + 会话级切换 ============ */
  const disposeError = ctx.on('agent/request-error', async ({ agent, turn, failure }, next) => {
    if (disposed || !agent || !agent.session) return next()
    const id = String(agent.session.id)
    // 实际发起请求用的模型：以最后记录的请求头为准
    let provider; let model
    try {
      const header = agent.session.requestHeader()
      provider = header?.config?.provider
      model = header?.config?.model
    } catch { return next() }
    if (!provider || !model) return next()

    markFailed(provider, model)
    errorTurns.set(id, turn)
    ctx.logger.warn(`[model-failover] ${provider}/${model} 彻底失败（${failure?.code ?? 'unknown'}），已标记为当日失败`)

    const binding = sessionBindings.get(id)
    const group = binding ? groups.find(g => g.id === binding.groupId && g.enabled) : undefined
    const failed = { provider, model }
    const target = group ? nextInGroup(group.id, failed) : findFailover(provider, model)
    if (!target) {
      ctx.logger.info(`[model-failover] ${provider}/${model} 失败后无可用备用模型（${group ? '绑定分组内全部失败' : '未绑定或分组外'}）`)
      return next()
    }
    // 当前轮照常以错误结束；切换是会话级的，下一轮起生效——不在本次请求里换模型。
    await switchSessionModel(agent, target)
    return next()
  })

  /* ============ 一轮成功完成 → 重置该模型失败状态 ============ */
  const disposeStop = ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (disposed || !agent || !agent.session) return
    const id = String(agent.session.id)
    if (errorTurns.get(id) === turn) return
    let provider; let model
    try {
      const header = agent.session.requestHeader()
      provider = header?.config?.provider
      model = header?.config?.model
    } catch { return }
    if (!provider || !model) return
    if (isFailed(provider, model)) {
      resetFailed(provider, model)
      ctx.logger.info(`[model-failover] ${provider}/${model} 本轮成功，已重置失败状态`)
    }
  })

  /* ==================== HTTP API ==================== */
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (chunk) => { size += chunk.length; if (size > 128 * 1024) { reject(new Error('body too large')); req.destroy(); return } chunks.push(chunk) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
  function sendJson(res, status, body) {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  function normalizeModels(list) {
    return (list || []).map(m => {
      const entry = {
        provider: String(m.provider ?? m.providerId ?? ''),
        model: String(m.model ?? m.modelId ?? ''),
        priority: m.priority !== undefined && m.priority !== null && m.priority !== '' ? Number(m.priority) : 99,
      }
      // 思考强度（reasoning effort）：空/未定义 = 跟随模型默认；否则存字符串 id
      if (m.effort !== undefined && m.effort !== null && m.effort !== '') entry.effort = String(m.effort)
      return entry
    }).filter(m => m.provider && m.model)
  }

  const handleApi = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (path === `${API_PATH}/status` && req.method === 'GET') {
      sendJson(res, 200, {
        groups: groups.map(g => ({
          id: g.id, name: g.name, enabled: g.enabled,
          models: g.models.map(m => ({ provider: m.provider, model: m.model, priority: m.priority ?? 99, effort: m.effort ?? null, failed: isFailed(m.provider, m.model) })),
        })),
        failed: failedList.filter(f => f.day === todayKey()).map(f => ({ provider: f.provider, model: f.model, count: f.count })),
        allModels: getAllModels(),
        sessionGroups: [...sessionBindings.entries()].map(([sessionId, b]) => ({ sessionId, groupId: b.groupId, mode: b.mode })),
        settings,
      })
      return
    }

    if (path === `${API_PATH}/settings` && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (typeof body.dialogMode === 'boolean') settings.dialogMode = body.dialogMode
        saveSettings()
        sendJson(res, 200, { ok: true, settings })
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e) }) }
      return
    }

    if (path === `${API_PATH}/groups` && req.method === 'GET') { sendJson(res, 200, { groups }); return }

    if (path === `${API_PATH}/groups` && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const models = normalizeModels(body.models)
        // 允许先建空分组：模型可稍后从模型列表的 ＋ 快捷加入
        if (!body.name) { sendJson(res, 400, { ok: false, error: 'name 必填' }); return }
        const group = { id: body.id || randomUUID(), name: String(body.name), enabled: body.enabled !== false, models }
        groups.push(group); saveGroups(); sendJson(res, 200, { ok: true, group })
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e) }) }
      return
    }

    if (path === `${API_PATH}/groups` && req.method === 'PUT') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (!body.id) { sendJson(res, 400, { ok: false, error: 'id 必填' }); return }
        const g = groups.find(x => x.id === body.id)
        if (!g) { sendJson(res, 404, { ok: false, error: '分组不存在' }); return }
        if (body.name !== undefined) g.name = String(body.name)
        if (body.enabled !== undefined) g.enabled = body.enabled !== false
        if (body.models !== undefined) g.models = normalizeModels(body.models)
        saveGroups(); sendJson(res, 200, { ok: true, group: g })
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e) }) }
      return
    }

    const dm = path.match(new RegExp(`^${API_PATH}/groups/([^/]+)$`))
    if (dm && req.method === 'DELETE') {
      const id = decodeURIComponent(dm[1])
      const idx = groups.findIndex(g => g.id === id)
      if (idx < 0) { sendJson(res, 404, { ok: false, error: '分组不存在' }); return }
      groups.splice(idx, 1); saveGroups()
      for (const [sid, b] of [...sessionBindings]) if (b.groupId === id) sessionBindings.delete(sid)
      sendJson(res, 200, { ok: true }); return
    }

    /* ----- 会话绑定分组（mode: 'failover' | 'route'） ----- */
    if (path === `${API_PATH}/session-group` && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) { sendJson(res, 400, { ok: false, error: 'sessionId 必填' }); return }
      const b = sessionBindings.get(sessionId)
      sendJson(res, 200, { sessionId, groupId: b?.groupId ?? null, mode: b?.mode ?? null })
      return
    }

    if (path === `${API_PATH}/session-group` && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (!body.sessionId) { sendJson(res, 400, { ok: false, error: 'sessionId 必填' }); return }
        if (!body.groupId) {
          sessionBindings.delete(body.sessionId)
          sendJson(res, 200, { ok: true, sessionId: body.sessionId, groupId: null })
          return
        }
        const group = groups.find(g => g.id === body.groupId)
        if (!group) { sendJson(res, 400, { ok: false, error: '分组不存在' }); return }
        const mode = body.mode === 'failover' ? 'failover' : 'route'
        sessionBindings.set(body.sessionId, { groupId: body.groupId, mode })
        let picked = null
        if (mode === 'route') {
          // 分组路由：立即把会话模型切到组内最高优先级的可用模型（会话级，一次切换）
          picked = firstAvailableInGroup(body.groupId)
          if (picked) {
            const agent = findAgent(ctx, body.sessionId)
            if (agent?.session) await switchSessionModel(agent, picked)
            else ctx.logger.warn('[model-failover] 绑定分组时会话未激活，模型将在下一轮请求错误兜底时选择')
          } else {
            ctx.logger.warn(`[model-failover] 分组 ${body.groupId} 内无可用模型（全部当日失败）`)
          }
        }
        sendJson(res, 200, { ok: true, sessionId: body.sessionId, groupId: body.groupId, mode, model: picked })
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e) }) }
      return
    }

    if (path === `${API_PATH}/failed/reset` && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (body.provider && body.model) resetFailed(body.provider, body.model)
        else resetAllFailed()
        sendJson(res, 200, { ok: true })
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e) }) }
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found: ' + path })
  }

  /** 在已注册的 agent 中按会话 id 找一个（绑定分组时立即写选择用） */
  function findAgent(context, sessionId) {
    try {
      const agentsService = context.get('agents')
      const list = agentsService?.list?.() ?? []
      for (const item of list) {
        const candidate = item?.agent ?? item
        if (candidate && (String(candidate.id) === String(sessionId) || String(candidate.session?.id) === String(sessionId))) return candidate
      }
    } catch { /* agents 服务不可用时不阻塞绑定 */ }
    return undefined
  }

  /* ==================== 路由注册 ==================== */
  let routeDisposer = null
  function tryRegister(ws) {
    if (disposed) return false
    try { routeDisposer = ws.register({ kind: 'prefix', path: API_PATH, handler: handleApi }); return true } catch { return false }
  }

  ctx.inject(['webServer'], (scope) => {
    if (!tryRegister(scope.webServer)) {
      ctx.logger.warn('[model-failover] API 路由被占用，稍后重试')
      let retries = 0
      const stop = ctx.interval(() => {
        retries++
        if (tryRegister(scope.webServer)) { ctx.logger.info(`[model-failover] API 已挂载（重试 ${retries} 次）`); stop() }
        if (retries >= 50) { stop(); ctx.logger.error('[model-failover] API 路由放弃注册') }
      }, 200)
      scope.effect(() => stop, 'model-failover: route retry')
    }
  })

  ctx.logger.info('[model-failover-manager v5] mounted (session-level switching via selectModel)')

  /* ==================== 清理 ==================== */
  ctx.effect(() => () => {
    disposed = true
    disposeError()
    disposeStop()
    if (routeDisposer) routeDisposer()
  }, 'model-failover-manager: unmount')
}