/**
 * model-failover-manager v2 — Host 端插件。
 *
 * 功能：
 * 1. 路由分组 CRUD（模型带 priority，数值越小越优先）
 * 2. 会话绑定分组：agent/request waterfall 按分组优先级路由每个请求的模型
 * 3. 所有重试耗尽（agent/request-error）后标记失败，自动切到组内下一个可用模型
 * 4. 会话成功完成一轮后重置该模型失败状态；失败名单按天自动过期
 * 5. 设置项 dialogMode：composer 模型选择是否使用左右分区弹窗
 * 6. HTTP API 供 Client UI 使用
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

  /** agentId -> groupId（会话绑定的路由分组） */
  const sessionGroups = new Map()
  /** agentId -> { provider, model }（最近一次实际路由到的模型） */
  const lastRouted = new Map()
  /** agentId -> turn（该轮出现过彻底失败） */
  const errorTurns = new Map()

  function readJson(path, fallback) {
    try { if (!existsSync(path)) return fallback; return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
  }
  function writeJson(path, data) { writeFileSync(path, JSON.stringify(data, null, 2), 'utf8') }

  /** @type {{ id: string; name: string; enabled: boolean; models: { provider: string; model: string; priority: number }[] }[]} */
  let groups = readJson(groupsFile, [])
  /** @type {{ key: string; day: string; count: number; provider: string; model: string }[]} */
  let failedList = readJson(failedFile, [])
  /** 界面偏好：dialogMode=true 时 composer 模型选择改为左右分区弹窗 */
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

  /** 组内第一个未失败模型 */
  function firstAvailableInGroup(groupId) {
    for (const m of sortedModels(groupId)) {
      if (!isFailed(m.provider, m.model)) return { provider: m.provider, model: m.model }
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
        if (!isFailed(cand.provider, cand.model)) return { provider: cand.provider, model: cand.model }
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
        out.push({ provider: m.provider, model: m.model, priority: m.priority ?? 99, failed: isFailed(m.provider, m.model) })
      }
    }
    return out
  }

  /* ============ 每请求按分组优先级路由 ============ */
  const disposeRequest = ctx.on('agent/request', async ({ agent }, next) => {
    const proposed = await next()
    if (disposed || !agent) return proposed
    const id = String(agent.id)
    const groupId = sessionGroups.get(id)
    if (!groupId) {
      lastRouted.set(id, { provider: proposed.provider, model: proposed.model })
      return proposed
    }
    const pick = firstAvailableInGroup(groupId)
    if (!pick) {
      lastRouted.set(id, { provider: proposed.provider, model: proposed.model })
      return proposed
    }
    lastRouted.set(id, pick)
    if (pick.provider === proposed.provider && pick.model === proposed.model) return proposed
    ctx.logger.info(`[model-failover] 会话 ${id} 按分组 ${groupId} 路由 → ${pick.provider}/${pick.model}`)
    return { ...proposed, provider: pick.provider, model: pick.model, reasoningEffort: undefined }
  })

  /* ============ 重试全部耗尽后：标记失败 + 预选下一模型 ============ */
  const disposeError = ctx.on('agent/request-error', async ({ agent, turn, failure }, next) => {
    if (disposed || !agent) return next()
    const id = String(agent.id)
    const routed = lastRouted.get(id)
    let provider; let model
    try {
      const sel = agent.session.getSnapshot()?.modelSelection
      provider = routed?.provider ?? sel?.provider
      model = routed?.model ?? sel?.model
    } catch { return next() }
    if (!provider || !model) return next()

    markFailed(provider, model)
    errorTurns.set(id, turn)
    ctx.logger.warn(`[model-failover] ${provider}/${model} 彻底失败（${failure?.code ?? 'unknown'}），已标记为当日失败`)

    const groupId = sessionGroups.get(id)
    const nextModel = groupId ? firstAvailableInGroup(groupId) : findFailover(provider, model)
    if (nextModel && !(nextModel.provider === provider && nextModel.model === model)) {
      lastRouted.set(id, nextModel)
      try {
        agent.session.append('model/selection', { provider: nextModel.provider, model: nextModel.model })
        ctx.logger.info(`[model-failover] 切换至 ${nextModel.provider}/${nextModel.model}`)
      } catch (e) {
        ctx.logger.warn(`[model-failover] 写入模型选择失败: ${e?.message || e}`)
      }
    }
    return next()
  })

  /* ============ 一轮成功完成 → 重置该模型失败状态 ============ */
  const disposeStop = ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (disposed || !agent) return
    const id = String(agent.id)
    if (errorTurns.get(id) === turn) return
    const routed = lastRouted.get(id)
    if (!routed) return
    if (isFailed(routed.provider, routed.model)) {
      resetFailed(routed.provider, routed.model)
      ctx.logger.info(`[model-failover] ${routed.provider}/${routed.model} 本轮成功，已重置失败状态`)
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
    return (list || []).map(m => ({
      provider: String(m.provider ?? m.providerId ?? ''),
      model: String(m.model ?? m.modelId ?? ''),
      priority: m.priority !== undefined && m.priority !== null && m.priority !== '' ? Number(m.priority) : 99,
    })).filter(m => m.provider && m.model)
  }

  const handleApi = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (path === `${API_PATH}/status` && req.method === 'GET') {
      sendJson(res, 200, {
        groups: groups.map(g => ({
          id: g.id, name: g.name, enabled: g.enabled,
          models: g.models.map(m => ({ provider: m.provider, model: m.model, priority: m.priority ?? 99, failed: isFailed(m.provider, m.model) })),
        })),
        failed: failedList.filter(f => f.day === todayKey()).map(f => ({ provider: f.provider, model: f.model, count: f.count })),
        allModels: getAllModels(),
        sessionGroups: [...sessionGroups.entries()].map(([sessionId, groupId]) => ({ sessionId, groupId })),
        lastRouted: [...lastRouted.entries()].map(([sessionId, m]) => ({ sessionId, provider: m.provider, model: m.model })),
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
        // 允许先建空分组：模型可稍后从模型列表快捷添加
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
      for (const [sid, gid] of [...sessionGroups]) if (gid === id) sessionGroups.delete(sid)
      sendJson(res, 200, { ok: true }); return
    }

    if (path === `${API_PATH}/session-group` && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) { sendJson(res, 400, { ok: false, error: 'sessionId 必填' }); return }
      sendJson(res, 200, { sessionId, groupId: sessionGroups.get(sessionId) ?? null })
      return
    }

    if (path === `${API_PATH}/session-group` && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (!body.sessionId) { sendJson(res, 400, { ok: false, error: 'sessionId 必填' }); return }
        if (body.groupId) {
          if (!groups.find(g => g.id === body.groupId)) { sendJson(res, 400, { ok: false, error: '分组不存在' }); return }
          sessionGroups.set(body.sessionId, body.groupId)
          const pick = firstAvailableInGroup(body.groupId)
          if (pick) {
            lastRouted.set(body.sessionId, pick)
            const agent = findAgent(ctx, body.sessionId)
            if (agent?.session) {
              try {
                agent.session.append('model/selection', { provider: pick.provider, model: pick.model })
              } catch (e) { ctx.logger.warn(`[model-failover] 绑定分组写入选择失败: ${e?.message || e}`) }
            }
          }
          sendJson(res, 200, { ok: true, sessionId: body.sessionId, groupId: body.groupId, model: pick })
        } else {
          sessionGroups.delete(body.sessionId)
          sendJson(res, 200, { ok: true, sessionId: body.sessionId, groupId: null })
        }
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

  /** 在已注册的 agent 中按 id 找一个（用于绑定分组时立即写选择） */
  function findAgent(context, agentId) {
    try {
      const agentsService = context.get('agents')
      const list = agentsService?.list?.() ?? []
      for (const item of list) {
        const candidate = item?.agent ?? item
        if (candidate && String(candidate.id) === String(agentId)) return candidate
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

  ctx.logger.info('[model-failover-manager v2] mounted')

  /* ==================== 清理 ==================== */
  ctx.effect(() => () => {
    disposed = true
    disposeRequest()
    disposeError()
    disposeStop()
    if (routeDisposer) routeDisposer()
  }, 'model-failover-manager: unmount')
}