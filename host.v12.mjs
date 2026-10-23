/**
 * model-failover-manager v12 — Host 端插件。
 *
 * 绑定模式（每会话一个绑定，二选一）：
 * - route（分组路由）：绑定即把会话模型切到组内优先级最高的可用模型。
 * - failover（故障兜底）：会话继续用当前手动选择的模型。
 * 两种模式下，某模型在所有重试耗尽后彻底失败时，都会把会话模型切到组内下一个可用模型，
 * 并在下一轮自动续跑。
 *
 * ## 模型选择的唯一通道：agent.model.select()
 *
 * 新版宿主在**步骤准备（pre-step）**时就把本步的 selection（provider/model/effort）
 * 固定下来，整个步骤（含所有重试）只用它。`agent/request` 已废弃，**不允许**再改
 * provider/model，也不允许增删改 reasoningEffort——改了宿主直接抛
 * `agent/request proposed "..." after step preparation fixed "..."`，整轮崩溃。
 *
 * 因此本插件：
 * - 绝不注册 agent/request。切换模型只调 `agent.model.select()`：它写一条 durable
 *   model/selection 事件，从**下一个步骤**起生效。
 * - 路由健康检查挂在 `agent/status` 的 running 边沿——驱动器刚启动、尚未进入
 *   pre-step，此时 `select()` 写入的正是本轮第一步要读的 selection。
 * - 失败切换挂在 `agent/request-error`：`await next()` 让内层重试策略先表态，
 *   都放弃后才接手。此时当前步骤的 selection 已冻结、改不动，所以选好新模型后
 *   **排队一条续跑消息**（followup），让失败的一轮结束、下一轮带着新模型接着跑。
 *
 * 子代理（智能体团队）：
 * - 宿主 createAgent 已把父会话请求头的 provider/model/effort 复制成子代理的
 *   AgentOptions（packages/subagent/subagent/src/child-agent.ts 的
 *   parentAgentOptionsForDelegation），「默认继承路由」是宿主原生行为，本插件
 *   **不写任何选择**去覆盖它：子代理既不被塞默认分组，也不被拽回组内第一名。
 * - 分组绑定沿 session.header.parentSession 继承（见 effectiveBinding）。
 * - 子代理会话里的换模型/换分组同样走 agent.model.select()，不需要
 *   sessionController.selectModel（它对 origin==='subagent' 一律硬拒绝），
 *   也不需要 agent/request 覆写。
 *
 * Our Free Model 同模型换账号（accountPool）：
 * 由 Our Free Model 注册的模型失败时，若同模型还有别的账号可用，先换账号重试，
 * 这发生在分组路由之前——换的是同一个 provider/model 背后的凭据，不换会话模型，
 * selection 没变，因此返回 { kind: 'retry' } 是安全的。
 * 没有 Our Free Model 插件时 ctx.get('accountPool') 为 undefined，静默跳过。
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
/**
 * 北京时间（Asia/Shanghai，UTC+8）的日期部件；可传偏移后的时刻。
 *
 * 插件所有“当日/截止日/时段”口径统一走这里，**与宿主机器的时区、TZ、LANG
 * 环境变量无关**：以前用 `new Date().toISOString().slice(0,10)`（UTC）与
 * `getFullYear/getHours`（机器本地），二者在东八区晚 20:00 后会分叉——UTC 已
 * 是次日，导致“当日失败”的模型在早上 8 点前失效、上午 8 点前失败又只活 1 小时。
 *
 * 用 Intl 的 formatToParts 而非 `new Date().getHours()`：显式指定 timeZone 才
 * 能保证换机器/改时区后仍是北京时间；`hourCycle:'h23'` 避免 ICU 输出 24 点。
 */
function beijingParts(atMs) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
  const out = {}
  for (const p of fmt.formatToParts(atMs === undefined ? new Date() : new Date(atMs))) {
    if (p.type !== 'literal' && p.type !== 'timeZoneName' && p.type !== 'dayPeriod') out[p.type] = Number(p.value)
  }
  return out
}
/** 北京时间的 YYYY-MM-DD */
function beijingDayKey() {
  const p = beijingParts()
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}
/** 北京时间的当前小时 0..23 */
function beijingHour() { return beijingParts().hour }

/**
 * 「当日失败」的日界线小时（北京时间），默认 8 点。
 *
 * 为什么挪到早上 8 点而不是零点：上游额度多按 UTC+8 自然日在 00:00 结算，
 * 深夜失败（额度耗尽、账号全受限）在零点一过就被放行，但那时用户已经睡了
 * ——放行毫无意义，只是让模型在凌晨低谷里被反复重试。挪到 8 点后，一个使
 * 用夜里的失败会一直挡到早上，正好交给用户醒来时决定换谁。
 *
 * 这不是「让惩罚时长恒定」：无论日界线在 8 点还是 0 点，失败时刻距下次重置
 * 都从几分钟到近 24 小时不等（8 点口径下 08:01 失败挡 23.98h、次日 07:54
 * 失败只挡 0.1h）。
 *
 * 改这个值只需改 cordis.yml，Loader 会带新 config 重新 apply，无需重启。
 */
const DEFAULT_FAIL_RESET_HOUR = 8

/**
 * 「当日」= 北京时间以 failResetHour 为日界线的日期。
 *
 * 实现：先减去 failResetHour 小时，再按北京时间取日期。Asia/Shanghai 无
 * 夏令时，减固定小时数不会跨 DST 跳变，因此结果恰是「日界线平移后的日期」；
 * 用 `Date.UTC` 拼时间戳会引入本机时区误差，故不这么做。
 * 失败标记、当日计数、`/status` 的当日过滤都用它；截止日 `until` 仍按自然日。
 */
function failDayKey(failResetHour) {
  const p = beijingParts(Date.now() - failResetHour * 3600_000)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

export function apply(ctx, config = {}) {
  const dataDir = typeof config.dataDir === 'string' && config.dataDir.trim()
    ? config.dataDir
    : join(process.env['DSH_HOME'] || join(homedir(), '.dsh'), DATA_DIR_DEFAULT)
  try { mkdirSync(dataDir, { recursive: true }) } catch {}

  // 「当日失败」日界线小时（北京时间）：缺省 8 点。非法值回退默认值——
  // 这个值只影响重置时刻，配错不该让插件起不来。
  const failResetHourRaw = config.failResetHour
  const failResetHour = (typeof failResetHourRaw === 'number' && Number.isInteger(failResetHourRaw) && failResetHourRaw >= 0 && failResetHourRaw <= 23)
    ? failResetHourRaw
    : DEFAULT_FAIL_RESET_HOUR
  if (failResetHourRaw !== undefined && failResetHour === DEFAULT_FAIL_RESET_HOUR && failResetHourRaw !== DEFAULT_FAIL_RESET_HOUR) {
    ctx.logger.warn(`[model-failover] config.failResetHour=${JSON.stringify(failResetHourRaw)} 非法（需 0..23 整数），回退 ${DEFAULT_FAIL_RESET_HOUR}`)
  }
  /** 「当日」键：以 failResetHour 为日界线、按北京时间取日期 */
  const todayKey = () => failDayKey(failResetHour)

  const groupsFile = join(dataDir, 'groups.json')
  const failedFile = join(dataDir, 'failed.json')
  const settingsFile = join(dataDir, 'settings.json')
  const bindingsFile = join(dataDir, 'session-bindings.json')

  /**
   * 会话级「本插件已接管」的生效模型：sessionId -> { provider, model, effort? }。
   *
   * 只在两处写入：绑定 route 分组时、失败切换时。
   * 用户手动选择模型会让本插件交还控制权（见 session/event 监听），
   * 因此这里存在即代表“本插件当前负责这个会话的模型”。
   *
   * 不落盘：它是运行时接管状态。重启后由持久化的绑定重新接管即可，
   * 落盘反而可能把用户后来手选的模型锁死。
   */
  const overrides = new Map()
  /**
   * sessionId -> { provider, model, effort? }：该会话最近一次 model/selection 事件里的模型。
   *
   * 包括用户手选的（那时 overrides 会被删掉）和本插件自己切的。用来回答
   * 「这个会话此刻打算用哪个模型」——sessionController 的选择不落在 agent.options
   * 上（packages/api/session-controller/src/agent.ts 的 selectForNextRequest 只写
   * 会话事件 + 自己的 selection 映射），所以每轮重路由必须自己记一份。
   */
  const lastPicked = new Map()
  /** sessionId -> { groupId, mode: 'failover' | 'route' }；落盘，重启后继续生效 */
  const sessionBindings = new Map()
  /** sessionId -> turn（该轮出现过彻底失败，成功轮才允许重置失败状态） */
  const errorTurns = new Map()
  /**
   * Our Free Model 换号冷却时长。
   *
   * 失败后给该账号+模型写一个冷却标记，适配器下次选号就会跳过它。
   * 时长要覆盖同一次 agent-loop 里可能连续发生的几次重跑；太短会在重跑前
   * 就过期又选回同一个账号，太长会让用户想用回原账号时要等。60s 是折中。
   */
  const FREE_MODEL_ACCOUNT_COOLDOWN_MS = 60_000

  function readJson(path, fallback) {
    try { if (!existsSync(path)) return fallback; return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
  }
  function writeJson(path, data) { writeFileSync(path, JSON.stringify(data, null, 2), 'utf8') }

  /** @type {{ id: string; name: string; enabled: boolean; models: { provider: string; model: string; priority: number; effort?: string }[] }[]} */
  let groups = readJson(groupsFile, [])

  // 迁移：磁盘上旧的 { from, to } 单时段 → windows 数组，避免老配置在升级后失效
  ;(() => {
    const hourOk = (v) => Number.isInteger(v) && v >= 0 && v <= 23
    let changed = false
    for (const g of groups) {
      for (const m of g.models || []) {
        if (Array.isArray(m.windows)) continue
        const from = Number(m.from); const to = Number(m.to)
        if (!hourOk(from) || !hourOk(to)) { delete m.from; delete m.to; changed = true; continue }
        m.windows = [{ from, to }]
        delete m.from; delete m.to
        changed = true
      }
    }
    if (changed) writeJson(groupsFile, groups)
  })()
  /** @type {{ key: string; day: string; count: number; provider: string; model: string }[]} */
  let failedList = readJson(failedFile, [])
  let settings = Object.assign({ dialogMode: false }, readJson(settingsFile, {}))
  let disposed = false

  function saveGroups() { writeJson(groupsFile, groups) }
  function saveFailed() { writeJson(failedFile, failedList) }
  function saveSettings() { writeJson(settingsFile, settings) }

  /**
   * 默认分组：新会话（startup / clear）自动沿用，免得每个新会话都重选一次。
   * 存 { groupId, mode } 或 { groupId: null }（显式选择「不绑定」）。
   * 与 sessionBindings 分开：后者是「某个会话当前绑了什么」，这里是「新建会话默认用什么」。
   */
  let defaultBinding = null
  const defaultFile = join(dataDir, 'default-binding.json')

  try {
    const saved = readJson(defaultFile, null)
    if (saved === null) {
      // 没有记录 = 用户从未选过，保持「不接管」，不给新会话硬塞一个分组
    } else if (!saved.groupId) {
      defaultBinding = { groupId: null }
    } else if (groups.some(g => g.id === saved.groupId)) {
      // 分组已被删除则丢弃默认值，避免新会话绑到空分组
      defaultBinding = { groupId: saved.groupId, mode: saved.mode === 'route' ? 'route' : 'failover' }
    }
  } catch (e) { ctx.logger.warn(`[model-failover] 读取默认分组失败：${e?.message || e}`) }

  function saveDefault() { writeJson(defaultFile, defaultBinding) }

  // 启动即恢复绑定：用户重启 DSH 后分组依旧生效，体验与模型选择一致
  try {
    const saved = readJson(bindingsFile, [])
    if (Array.isArray(saved)) {
      for (const b of saved) {
        const id = b && typeof b.sessionId === 'string' ? b.sessionId : ''
        if (!id || typeof b.groupId !== 'string') continue
        // 分组可能已被删除；丢弃失效绑定，不把会话卡在空分组上
        if (!groups.some(g => g.id === b.groupId)) continue
        sessionBindings.set(id, { groupId: b.groupId, mode: b.mode === 'route' ? 'route' : 'failover', explicit: b.explicit === true })
      }
      if (sessionBindings.size > 0) ctx.logger.info(`[model-failover] 已从 ${bindingsFile} 恢复 ${sessionBindings.size} 个会话分组绑定`)
    }
  } catch (e) { ctx.logger.warn(`[model-failover] 读取会话分组绑定失败：${e?.message || e}`) }

  function saveBindings() {
    const rows = [...sessionBindings].map(([sessionId, b]) => ({
      sessionId, groupId: b.groupId, mode: b.mode, ...(b.explicit === true ? { explicit: true } : {}),
    }))
    writeJson(bindingsFile, rows)
  }

  function isFailed(provider, model) {
    const k = failKey(provider, model); const d = todayKey()
    return failedList.some(f => f.key === k && f.day === d)
  }

  function markFailed(provider, model, failure) {
    const k = failKey(provider, model); const d = todayKey()
    const idx = failedList.findIndex(f => f.key === k && f.day === d)
    const now = Date.now()
    const code = failure?.code ? String(failure.code).slice(0, 32) : null
    const reason = failure?.message ? String(failure.message).slice(0, 400) : null
    if (idx >= 0) {
      const cur = failedList[idx]
      cur.count = (cur.count || 1) + 1
      // 只更新原因本身；count 与上次失败时间分开记，便于看“最近一次”与累计次数
      if (code) cur.code = code
      if (reason) cur.reason = reason
      cur.at = now
    } else {
      failedList.push({ key: k, day: d, count: 1, provider, model, code, reason, at: now })
    }
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

  function candidateOf(m) {
    return { provider: m.provider, model: m.model, ...(m.effort ? { effort: m.effort } : {}) }
  }

  /**
   * 该条目此刻是否参与路由：未失败 + 在时间窗内 + 未过期。
   *
   * 时间窗 from/to 为 0..23 的整点、两端包含；from > to 表示跨午夜窗口
   * （如 22–6 = 22:00 到次日 6:59）；任一缺省 = 全天。
   * 截止日 until 为 YYYY-MM-DD，北京时间当天超过它即失效（当天仍有效）。
   * from/to 的小时按**北京时间**解释。
   *
   * 只在“挑选”时过滤：正在使用的模型过窗后不主动切走，等它失败时
   * 自然会被排除出候选——避免到点就抖动换模型。
   */
  function routable(m) {
    if (m.disabled === true) return false
    if (isFailed(m.provider, m.model)) return false
    if (m.until && beijingDayKey() > String(m.until)) return false
    if (Array.isArray(m.windows) && m.windows.length > 0) {
      const h = beijingHour()
      const hit = m.windows.some(w => {
        const from = Number(w.from); const to = Number(w.to)
        if (!Number.isInteger(from) || !Number.isInteger(to)) return false
        // 两端包含：from<=to 为同日区间；from>to 为跨午夜（如 22–6）
        return from <= to ? (h >= from && h <= to) : (h >= from || h <= to)
      })
      if (!hit) return false
    }
    return true
  }

  /** 组内第一个可路由模型（未失败、在窗内、未过期；携带分组配置的思考强度） */
  function firstAvailableInGroup(groupId) {
    for (const m of sortedModels(groupId)) {
      if (routable(m)) return candidateOf(m)
    }
    return null
  }

  /** 组内该 provider/model 的条目；不在组内或组不存在时返回 null */
  function groupMember(groupId, provider, model) {
    if (!provider || !model) return null
    const entry = groups.find(g => g.id === groupId)
    if (!entry) return null
    return (entry.models || []).find(m => m.provider === provider && m.model === model) ?? null
  }

  /**
   * 会话此刻打算用的模型（下一次 pre-step 会读到的那个）。
   *
   * 首选 `agent.model.current()`：那是宿主的权威来源——它把 durable 的
   * model/selection 投影（pending ?? lastUsed）与 AgentOptions 合在一起，
   * 重启后依然正确。旧版只能读 agent.options 加一份本插件内存里的
   * lastPicked，重启就丢。
   *
   * 后两级是本插件自己的覆盖与最近一次选择事件，作为 agent.model 不可用时的兜底。
   */
  function currentModelOf(agent, id) {
    try {
      const live = agent?.model?.current?.()
      if (live?.provider && live?.model) return { provider: live.provider, model: live.model }
    } catch { /* agent.model 不可用时退回下面几级 */ }
    const held = overrides.get(id)
    if (held) return { provider: held.provider, model: held.model }
    const picked = lastPicked.get(id)
    if (picked) return { provider: picked.provider, model: picked.model }
    if (agent.options?.provider && agent.options?.model) {
      return { provider: agent.options.provider, model: agent.options.model }
    }
    return null
  }

  /** 组内除 exclude 外的下一个可路由模型（按优先级顺序） */
  function nextInGroup(groupId, exclude) {
    for (const m of sortedModels(groupId)) {
      if (m.provider === exclude.provider && m.model === exclude.model) continue
      if (routable(m)) return candidateOf(m)
    }
    return null
  }

  /** 无会话绑定时，从当前模型所属分组里找优先级不低于它的可路由模型 */
  function findFailover(currentProvider, currentModel) {
    for (const group of groups) {
      if (!group.enabled) continue
      const self = group.models.find(m => m.provider === currentProvider && m.model === currentModel)
      if (!self) continue
      const limit = self.priority ?? 99
      for (const cand of sortedModels(group.id)) {
        if (cand.provider === currentProvider && cand.model === currentModel) continue
        if ((cand.priority ?? 99) > limit) continue
        if (routable(cand)) return candidateOf(cand)
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

  /** 按会话 id 取活着的 session（用 agents 注册表；取不到就返回 undefined）。 */
  function sessionOf(sessionId) {
    try {
      const agentsService = ctx.get('agents')
      const agent = agentsService?.get?.(sessionId)
      return agent?.session
    } catch { return undefined }
  }

  /** 子代理会话：origin === 'subagent'（fork 出来的会话也带 parentSession，但不是这个 origin） */
  function isSubagentSession(session) {
    return session?.header?.origin === 'subagent'
  }

  /**
   * 会话的有效绑定：普通会话只看自己；子代理沿 parentSession 继承父会话的。
   *
   * 子代理**忽略自己那条绑定**。它多半是历史 bug 写上去的：宿主给子代理派发的
   * agent/created 来源同样是 'startup'，旧版 applyDefaultBinding 因此给每个子
   * 代理都写了一条「默认分组」，把整条继承链挡在深度 0——子代理一律跑默认组，
   * 永远到不了父会话。
   *
   * 向上查找按 id 查绑定表，不要求父会话此刻还活着：子代理的父会话结束后，绑定
   * 表里那条记录仍是权威值；顺着 live session 一层层走反而会中途断掉。
   *
   * 只在子代理上向上走。fork 出来的分支会话也带 parentSession，但那是用户主动
   * 开的新对话，仍按普通会话处理（有自己绑定用自己，没有就是没有）。
   */
  function effectiveBinding(session) {
    const id = String(session.id)
    if (!isSubagentSession(session)) {
      const own = sessionBindings.get(id)
      return own ? { binding: own, viaSessionId: id, inherited: false } : undefined
    }
    // 用户显式为子代理选过分组（explicit）就用它自己那条；历史 bug 自动写上的
    // 默认分组没有该标记，继续忽略并继承父会话——否则子代理又被钉死。
    const own = sessionBindings.get(id)
    if (own?.explicit === true) return { binding: own, viaSessionId: id, inherited: false }
    let cur = session
    const seen = new Set([id])
    for (let depth = 0; depth < 16; depth++) {
      const parentId = cur?.header?.parentSession
      if (parentId === undefined) break
      const pid = String(parentId)
      if (seen.has(pid)) break
      seen.add(pid)
      const parentBinding = sessionBindings.get(pid)
      if (parentBinding) return { binding: parentBinding, viaSessionId: pid, inherited: true }
      cur = sessionOf(parentId)
    }
    return undefined
  }

  /**
   * 新建会话（startup / clear）套用默认分组。
   *
   * 只在这两种来源上生效：resume（重开旧会话）与 compact 保持原样——
   * 它们代表「回到既有会话」，不该被默认值改写用户以前的选择。
   *
   * 子代理必须排除：宿主给子代理派发的 agent/created 来源同样是 'startup'
   * （packages/core/agent-loop/src/index.ts 的 createAgent 硬编码），若不排除，
   * 每个子代理都会被写上一条「默认分组」绑定，既挡住它继承父会话的分组，
   * 又把它钉死在默认组里第一个可路由的模型上。
   */
  async function applyDefaultBinding(session, source) {
    if (isSubagentSession(session)) return
    if (!defaultBinding || !defaultBinding.groupId) return
    if (source !== 'startup' && source !== 'clear') return
    const id = String(session.id)
    if (sessionBindings.has(id)) return // 该会话已有自己的绑定，尊重它
    if (!groups.some(g => g.id === defaultBinding.groupId && g.enabled)) return
    const mode = defaultBinding.mode === 'route' ? 'route' : 'failover'
    sessionBindings.set(id, { groupId: defaultBinding.groupId, mode })
    saveBindings()
    ctx.logger.info(`[model-failover] 新会话 ${id} 套用默认分组 ${defaultBinding.groupId}（${mode}）`)
    if (mode === 'route') await adoptRoute(session)
  }

  /**
   * 让绑定为 route 的会话立即被本插件接管。
   * 重启后 overrides 是空的，靠这条在会话创建时补上接管，
   * 免得用户重启后要等到下一次请求才看到分组生效。
   *
   * 子代理不接管：它的模型选项由宿主在创建时从父会话的 requestHeader 继承而来
   * （packages/subagent/subagent/src/child-agent.ts 的 resolveChildAgentOptions），
   * 这里再挑一次会把它从父会话当前实际生效的模型上拽走。
   */
  async function adoptRoute(session) {
    if (isSubagentSession(session)) return
    const own = sessionBindings.get(String(session.id))
    if (!own || own.mode !== 'route') return
    if (overrides.has(String(session.id))) return
    const agent = findAgent(ctx, session.id)
    if (!agent?.session) return
    const pick = firstAvailableInGroup(own.groupId)
    if (!pick) return
    await applyActiveModel(agent, pick)
  }

  /**
   * 会话级模型切换的唯一入口：`agent.model.select()`。
   *
   * 宿主在 pre-step 读 `agent.model.current()` 固定本步 selection，`agent/request`
   * 已废弃且**改 provider/model 会直接抛错让整轮崩掉**。所以切换只有一条路：
   * 写一条 durable model/selection（select 内部完成），从下一个步骤生效。
   *
   * 子代理同样走这里。sessionController.selectModel 对 origin==='subagent'
   * 一律硬拒绝（packages/api/session-controller/src/agent.ts 的
   * hasApiSessionSubagentOwner，文案 "owned by subagent routing"），
   * 而 agent.model 是 Agent 自己的，没有那个限制。
   *
   * @returns {Promise<boolean>} 是否已写入（用于失败日志的 switched/switch-failed）
   */
  async function applyActiveModel(agent, target) {
    const id = String(agent.session.id)
    const model = agent?.model
    if (typeof model?.select !== 'function') {
      ctx.logger.warn(`[model-failover] 会话 ${id} 的 agent.model 不可用，无法切换模型`)
      return false
    }
    // 空 effort 必须**删掉**该键：铺 reasoningEffort: undefined 会被 session 的
    // JSON 守卫拒绝；而沿用上一个模型的 effort 可能不被目标模型支持
    // （prepareCall 抛 UNSUPPORTED_REASONING_EFFORT）。
    const selection = { provider: target.provider, model: target.model }
    if (target.effort) selection.reasoningEffort = target.effort
    try {
      model.select(selection)
    } catch (e) {
      ctx.logger.warn(`[model-failover] 切换 ${target.provider}/${target.model} 失败: ${e?.message || e}`)
      return false
    }
    overrides.set(id, target)
    ctx.logger.info(`[model-failover] ${isSubagentSession(agent.session) ? '子代理' : '会话'} ${id} 切换至 ${target.provider}/${target.model}${target.effort ? ' (effort=' + target.effort + ')' : ''}`)
    return true
  }

  /**
   * 失败切换后的续跑消息：让失败的一轮收尾，下一轮带着新 select 的模型继续。
   *
   * 为什么必须换轮而不是同一步 retry：宿主在 pre-step 就把本步 selection 冻结，
   * agent/request 已废弃、改模型直接抛错。所以只能结束本轮，让下一轮重新 pre-step。
   *
   * source 用 `model-failover` 这个自有 kind（MessageSourceMap 是可合并扩展的，
   * 消费方对未知 kind 会自然落空），而不是伪装成 `user`——用户没发过这句话。
   * @param {string} fromProvider - 失败请求实际用的 provider。
   * @param {string} fromModel - 失败请求实际用的 model。
   * @param {{provider: string, model: string}} target - 即将生效的新模型。
   * @returns {{id: string, role: 'user', content: {type: 'text', text: string}[], source: object}}
   */
  function createContinuationMessage(fromProvider, fromModel, target) {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: `[model-failover] ${fromProvider}/${fromModel} failed and every retry was exhausted. `
          + `The session continues on ${target.provider}/${target.model}. `
          + 'Continue the interrupted work from the current session state; do not repeat completed steps.',
      }],
      source: {
        kind: 'model-failover',
        form: 'notice',
        summary: `${fromProvider}/${fromModel} → ${target.provider}/${target.model}`.slice(0, 120),
      },
    }
  }

  /* ============ 会话创建：默认分组 + 持久化绑定在会话一出现时就生效 ============ */
  const disposeCreated = ctx.on('agent/created', async ({ agent, source }) => {
    if (disposed || !agent?.session) return
    try {
      await applyDefaultBinding(agent.session, source)
      await adoptRoute(agent.session)
    } catch (e) {
      ctx.logger.warn(`[model-failover] 会话 ${agent.session.id} 接管分组失败：${e?.message || e}`)
    }
  })

  /* ============ 每轮开始：在 pre-step 冻结 selection 之前重新路由 ============ */
  //
  // 时机是这里全部的关键。宿主 preStep 的第一步就是 `this.model.current()`
  // 取本步 selection，整个步骤（含全部重试）都用它；`agent/request` 已废弃，
  // 在那里改 provider/model 会被宿主直接判错并让整轮崩掉。所以切换必须发生在
  // preStep **之前**。
  //
  // `agent/status` 的 running 边沿正是那个窗口：wakeDriver 同步 setPhase(running)
  // → emit agent/status → kick() → turn() → preStep。因此在这里 select() 写入的
  // selection 就是本轮第一步要读的值。
  //
  // 判定内容与旧版一致：每次发消息都看一次「这个会话此刻要用的模型还能不能用」——
  //  · 仍可用 → 保留，什么都不做（不覆盖用户手选的模型，也不无脑把 route 会话
  //    拽回组内第一名——绑定时已经切过一次，这里只做健康检查）；
  //  · 不可用 → 换到组内此刻第一个可用模型。三种形态都算：被标记当日失败、
  //    超出北京时间时段、过了截止日；不在分组里的模型只有「失败」一种判据。
  //
  // 子代理在这里**不做任何选择**：宿主的 createAgent 已把父会话请求头里的
  // provider/model/effort 复制成子代理的 AgentOptions（默认继承路由），
  // 再插一手只会把它从父会话当前实际生效的模型上拽走。只有它继承了分组、
  // 且当前模型此刻确实不可路由时才换（见健康检查里的 sameRoute 分支）。
  const disposeStatus = ctx.on('agent/status', ({ agent, status }) => {
    if (disposed || !agent?.session) return
    if (status === 'idle') {
      // 失败切换后等的就是这个时刻：驱动器已经收尾，followup 才会开新一轮。
      deliverContinuation(String(agent.session.id))
      return
    }
    if (status !== 'running') return
    void rerouteForNewTurn(agent).catch((e) => {
      ctx.logger.warn(`[model-failover] 会话 ${agent?.session?.id} 重新路由失败：${e?.message || e}`)
    })
  })

  /**
   * 新一輪开始时对该会话做一次路由健康检查；只在当前模型不可用时切换。
   * @param {any} agent - 即将进入 pre-step 的 Agent。
   */
  async function rerouteForNewTurn(agent) {
    const id = String(agent.session.id)
    const binding = effectiveBinding(agent.session)
    if (!binding) return
    const group = groups.find(g => g.id === binding.binding.groupId && g.enabled)
    if (!group) return
    const cur = currentModelOf(agent, id)
    if (cur) {
      const member = groupMember(group.id, cur.provider, cur.model)
      const usable = member ? routable(member) : !isFailed(cur.provider, cur.model)
      if (usable) return
    } else if (binding.binding.mode !== 'route') {
      // 读不到当前模型（理论上只在异常路径）：路由模式交给分组，兜底模式不插手
      return
    }
    const pick = firstAvailableInGroup(group.id)
    if (!pick) return
    const ok = await applyActiveModel(agent, pick)
    if (!ok) return
    ctx.logger.info(`[model-failover] 会话 ${id} 新一轮检查：${cur ? `${cur.provider}/${cur.model} 此刻不可用` : '当前模型未知'} → ${pick.provider}/${pick.model}`)
  }

  /* ============ 子代理继承：默认什么都不做，只在继承的分组里当前模型不可用时才换 ============ */
  //
  // 「默认继承路由」= 本插件对子代理**不写任何选择**，因为宿主已经做了：
  // createAgent 把父会话请求头的 provider/model/effort 复制成子代理的 AgentOptions
  // （packages/subagent/subagent/src/child-agent.ts 的
  // parentAgentOptionsForDelegation），子代理天然跑父会话当前实际在用的模型。
  //
  // 上面两处已经把这个前提做对了：
  //  · applyDefaultBinding 对 origin==='subagent' 直接 return —— 子代理不会被塞
  //    一条「默认分组」绑定（旧 bug：宿主给子代理派发的 agent/created 来源同样是
  //    'startup'，于是每个子代理都被写上默认分组，既挡住继承又把自己钉死在组内第一名）。
  //  · adoptRoute 同样跳过子代理 —— 不在创建时把它从父会话的模型上拽走。
  //
  // rerouteForNewTurn 对子代理只做健康检查：它继承来的模型若在组内仍可路由就保留
  // （所以父会话切到组内第 3 个时，子代理不会又被打回第 1 个）；只有它此刻
  // 不可路由（失败/过时段/过截止日）时才按组内优先级换一个。

  /* ============ 用户手动选择模型 → 交还控制权，避免覆盖用户意图 ============ */
  const disposeSessionEvent = ctx.on('session/event', (session, event) => {
    if (disposed || event.type !== 'model/selection') return
    const d = event.data
    if (!d?.provider || !d?.model) return
    const id = String(session.id)
    lastPicked.set(id, { provider: d.provider, model: d.model, ...(d.reasoningEffort ? { effort: d.reasoningEffort } : {}) })
    const cur = overrides.get(id)
    // 与自己刚写入的一致 → 是本插件的切换，保留覆盖；否则是用户手选，交还控制权。
    if (cur && cur.provider === d.provider && cur.model === d.model) return
    overrides.delete(id)
  })

  /* ============ Our Free Model：同模型换账号优先于分组路由 ============ */
  //
  // accountPool 由 dsh-our-free-model 的渠道包注册（pack.js: ctx.provide('accountPool', pool)），
  // 未安装该插件时 ctx.get 返回 undefined，整段静默跳过。
  //
  // 不论失败原因是什么（402 额度、429 限流、5xx、超时都一样），只要该模型
  // 还有别的可用账号就先换账号重试一轮。账号总数是天然的循环上界。
  //
  // 只写入池的「冷却标记」这一件事：把刚失败的账号+模型写一个短冷却，
  // 适配器下次选号就会跳过它。绝不改凭据、绝不动账号本身的其他字段。
  //
  // 为什么必须写冷却标记而不是用排除集合：见 handoffToFreeModelAccount 顶部的排障结论。
  //

  /**
   * Our Free Model 的模型失败后，让「该模型的下一次选号」跳过刚失败的账号。
   *
   * 关键机制（排障结论，2026-10-08）：换号**必须**落成池级冷却标记
   * （`updateModelRateLimit`），否则等于没换。
   *
   * 适配器的选号入口 `pickBuddyCredential`（pack.js）每次调用都新建一个
   * 空的 `tried` 集合，只看 `listAccountsByProvider(...).filter(a => a.enabled)`
   * 再按 `modelRateLimits[modelId]` 是否过期过滤。旧实现用一个**本插件私有**
   * 的 `handed` 集合调 `getAvailableAccount`，拿到账号后返回 `{kind:'retry'}`；
   * 但适配器重跑时**看不到**那个集合，重新选号仍按池默认排序拿回刚失败的
   * 账号（非限流失败不留标记，它仍排最前）——日志里"改由账号 X 重试"是假的，
   * 账号从未真正换过。
   *
   * 现在直接把刚失败的账号写一个短冷却标记，适配器下次选号就会跳过它，
   * 选到下一个账号。标记由池的 `sweepExpiredRateLimits` 到期清理，无需回滚。
   *
   * @returns {Promise<string|null>} 交回的账号 id；null 表示交给分组路由。
   */
  async function handoffToFreeModelAccount(provider, model, failure) {
    const pool = ctx.get('accountPool')
    if (!pool) return null

    let allAccounts
    try {
      allAccounts = pool.listAccountsByProvider(provider)
    } catch (e) {
      ctx.logger.warn(`[model-failover] 读取 ${provider} 账号列表失败：${e?.message || e}`)
      return null
    }
    // 该模型当前可用的账号数（停用、以及已对该模型限流的都不算）
    const now = Date.now()
    const usable = allAccounts.filter(a => {
      if (a.enabled === false) return false
      const resetAt = a.modelRateLimits && a.modelRateLimits[model]
      return !resetAt || now >= resetAt
    }).length
    // 只有一个可用账号时没有「换号」可言，不必浪费一轮重试
    if (usable < 2) return null

    // 池当前会选中的账号：`getAvailableAccount` 按存储顺序返回第一个
    // 「enabled + 该模型无未过期冷却标记 + 凭据能解析」的账号。刚失败的账号
    // 凭据刚用过必可解析，若失败类别未留冷却标记，返回的就是它（适配器刚
    // 选的也是它）。因此这里冷却它 = 冷却刚失败的账号。
    let next
    try {
      next = await pool.getAvailableAccount(provider, model)
    } catch (e) {
      ctx.logger.warn(`[model-failover] 获取 ${provider} 的可用账号失败：${e?.message || e}`)
      return null
    }
    if (!next || !next.entry?.id) return null

    // 限流类失败（429 / RATE_LIMIT 等）：适配器自己已经写了冷却标记并换号重试，
    // 池里刚失败的账号已被排除，`getAvailableAccount` 拿到的已是下一个账号。
    // 此时再冷却会锁住一个本来可用的账号，故只交回账号 id 触发重跑。
    if (isRateLimitLike(failure)) {
      ctx.logger.info(`[model-failover] ${provider}/${model} 限流类失败（${failure?.code ?? 'unknown'}），适配器已自行冷却并换号，返回重试`)
      return next.entry.id
    }

    // 非限流失败：给刚失败的账号写一个短冷却标记，让适配器下次选号跳过它。
    // 这是唯一能让换号真正生效的机制（见函数顶部的排障说明）。
    try {
      await pool.updateModelRateLimit(next.entry.id, model, now + FREE_MODEL_ACCOUNT_COOLDOWN_MS)
    } catch (e) {
      ctx.logger.warn(`[model-failover] 写入 ${provider} 账号 ${next.entry.id} 冷却标记失败：${e?.message || e}`)
      return null
    }
    ctx.logger.info(`[model-failover] ${provider}/${model} 失败，已冷却账号 ${next.entry.id} ${Math.round(FREE_MODEL_ACCOUNT_COOLDOWN_MS / 1000)}s，换号重试（该模型 ${usable}/${allAccounts.length} 个账号可用）`)
    return next.entry.id
  }

  /** 限流类失败：适配器自己会写冷却标记并换号，无需本插件再冷却账号 */
  function isRateLimitLike(failure) {
    if (!failure) return false
    if (failure.status === 429) return true
    const code = String(failure.code || '')
    return /RATE|LIMIT|THROTTLE/i.test(code)
  }

  /* ============ 失败处理诊断：记录最近若干条判定结果，供 /status 查看 ============ */
  // 排障用：某次失败到底走没走到本插件、为什么没切换，只看日志容易漏，这里留一份
  // 环形记录（最多 20 条）。outcome 取值：inner-retry / no-request-header /
  // provider-or-model-unknown / account-handoff / no-target / switched / error:<msg>
  const failureLog = []
  function noteFailure(agent, provider, failure, outcome, extra) {
    try {
      failureLog.push({
        at: Date.now(),
        sessionId: agent?.session ? String(agent.session.id) : null,
        provider: provider ?? null,
        model: extra?.model ?? null,
        code: failure?.code ?? null,
        outcome,
        detail: extra?.detail ?? (failure?.message ? String(failure.message).slice(0, 160) : null),
      })
      if (failureLog.length > 20) failureLog.shift()
    } catch { /* 诊断记录绝不影响主流程 */ }
  }

  /* ============ 所有重试耗尽后：标记失败 + 切换 + 同一轮续跑 ============ */
  //
  // 组合语义（prepend 到最外层 + 先 await next()）：
  // 1) 先让内层策略表态——内置 llm-retry 与 llm-error-retry 想重试就返回
  //    {kind:'retry'}，我们原样透传，绝不抢它们的重试机会；
  // 2) 轮到自己时才说明“所有重试已耗尽”：标记失败、按分组 select 下一个模型、
  //    排队一条续跑消息让下一轮用它继续。
  // prepend 的原因：llm-error-retry 命中规则且预算耗尽时会直接 return undefined
  // 而不调 next()（短路整条链），只有成为最外层才能兜住那种情况。
  //
  // 为什么不再返回 {kind:'retry'}：retry 仍在**同一步**重跑，而这一步的 selection
  // 在 pre-step 就冻结了（agent/request 已废弃，改它直接抛错）。所以必须让本轮
  // 收尾、由下一轮重新 pre-step 才能读到新 select 的模型。followup 排队一条
  // next-turn 消息正是这个作用，且它是 durable 的（agent/inbox/spliced）。
  const disposeError = ctx.on('agent/request-error', async ({ agent, turn, provider: eventProvider, failure }, next) => {
    // 内层先决定：任何重试策略表态重试，就尊重它（这才是“重试都完成之后”）
    const action = await next()
    if (action?.kind === 'retry') { noteFailure(agent, eventProvider, failure, 'inner-retry'); return action }
    if (disposed || !agent || !agent.session) return action

    const id = String(agent.session.id)
    // provider 优先取事件自带的（就是这次请求实际用的），model 只能从请求头取。
    // 原先两者都只读 requestHeader()，头缺失/滞后时会静默不处理——既不标记也不切换。
    let provider; let model
    const active = overrides.get(id)
    try {
      const header = agent.session.requestHeader()
      provider = eventProvider ?? active?.provider ?? header?.config?.provider
      model = active?.model ?? header?.config?.model
    } catch {
      noteFailure(agent, eventProvider, failure, 'no-request-header')
      return action
    }
    if (!provider || !model) {
      noteFailure(agent, eventProvider, failure, 'provider-or-model-unknown')
      return action
    }

    // Our Free Model 的模型：不论错误类型，一律先试换账号重试。
    // 换的是同一 provider/model 背后的凭据，selection 没变，所以同一步 retry 安全。
    const handedTo = await handoffToFreeModelAccount(provider, model, failure)
    if (handedTo) {
      noteFailure(agent, provider, failure, 'account-handoff', { model, detail: '账号 ' + handedTo })
      return { kind: 'retry' }
    }

    markFailed(provider, model, failure)
    errorTurns.set(id, turn)
    ctx.logger.warn(`[model-failover] ${provider}/${model} 彻底失败（${failure?.code ?? 'unknown'}），已标记为当日失败`)

    // 绑定：先看自己，子代理沿 parentSession 继承父会话的分组
    const inherited = effectiveBinding(agent.session)
    const binding = inherited?.binding
    const group = binding ? groups.find(g => g.id === binding.groupId && g.enabled) : undefined
    const target = group ? nextInGroup(group.id, { provider, model }) : findFailover(provider, model)
    if (!target) {
      const why = binding
        ? (group ? '分组内无其它可路由模型（全部当日失败/不在时段/已过期）' : '绑定的分组已停用或不存在')
        : '该会话未绑定分组，且该模型不在任何启用分组内'
      ctx.logger.info(`[model-failover] ${provider}/${model} 失败后不切换：${why}`)
      noteFailure(agent, provider, failure, 'no-target', { model, detail: why })
      return action
    }
    if (inherited?.inherited) {
      ctx.logger.info(`[model-failover] 子代理 ${id} 按继承的分组 ${binding.groupId}（来自 ${inherited.viaSessionId}）切换`)
    }

    const ok = await applyActiveModel(agent, target)
    noteFailure(agent, provider, failure, ok ? 'switched' : 'switch-failed', {
      model, detail: `→ ${target.provider}/${target.model}${ok ? '' : '（切换失败）'}`,
    })
    if (!ok) return action
    // 已经 select 了新模型，但本步 selection 已冻结：等本轮收尾后排队续跑。
    // 不返回 retry：让这一轮以错误收尾，续跑消息开下一轮。
    queueContinuation(agent, provider, model, target)
    return action
  }, { prepend: true })

  /**
   * 待续跑的会话：sessionId -> { provider, model, target }。
   *
   * 为什么不能直接 followup：agent/request-error 运行在失败步骤收尾阶段，此刻
   * 驱动器仍在跑；紧随其后的 turn 走 throwError → kick() 的 catch 退出，
   * 那里**不会**再处理 inbox（只有 wakeRequested 分支才会）。排队中的消息会被
   * 搁浅到下一次有人给它发消息为止——那就不是「自动续跑」了。
   *
   * 所以在 agent 回到 idle 后再投递：那时 followup 会正常通过 wakeDriver 开新一轮，
   * 新一轮的 pre-step 读到的正是我们刚 select 的模型。
   */
  const pendingContinuations = new Map()

  /**
   * 记下一次待续跑，并在 agent 空闲时投递。
   * @param {any} agent - 失败的 Agent。
   * @param {string} fromProvider - 失败请求实际用的 provider。
   * @param {string} fromModel - 失败请求实际用的模型。
   * @param {{provider: string, model: string}} target - 已 select 的新模型。
   */
  function queueContinuation(agent, fromProvider, fromModel, target) {
    const id = String(agent.session.id)
    pendingContinuations.set(id, { agent, fromProvider, fromModel, target })
    ctx.logger.info(`[model-failover] ${fromProvider}/${fromModel} → ${target.provider}/${target.model}，等待本轮收尾后自动续跑`)
    // 已经空闲（异常路径下可能直接是 idle）：立刻投递。
    if (agent.status === 'idle') deliverContinuation(id)
  }

  /**
   * 投递一条待续跑消息；只在 agent 空闲时执行，失败即放弃并留日志。
   * @param {string} sessionId - 待续跑的会话。
   */
  function deliverContinuation(sessionId) {
    const pending = pendingContinuations.get(sessionId)
    if (!pending) return
    pendingContinuations.delete(sessionId)
    if (disposed) return
    try {
      pending.agent.followup(createContinuationMessage(pending.fromProvider, pending.fromModel, pending.target))
      ctx.logger.info(`[model-failover] ${sessionId} 已排队续跑（${pending.target.provider}/${pending.target.model}）`)
    } catch (e) {
      ctx.logger.warn(`[model-failover] ${sessionId} 排队续跑失败：${e?.message || e}`)
    }
  }

  /* ============ 一轮成功完成 → 重置该模型失败状态 ============ */
  const disposeStop = ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (disposed || !agent || !agent.session) return
    const id = String(agent.session.id)
    if (errorTurns.get(id) === turn) return
    let provider; let model
    const active = overrides.get(id)
    try {
      const header = agent.session.requestHeader()
      provider = active?.provider ?? header?.config?.provider
      model = active?.model ?? header?.config?.model
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
      // 路由时段：可多段。每段 0..23 整点、两端包含；from>to 表示跨午夜。
      // 空数组 = 全天参与。旧的 { from, to } 单时段数据自动迁移成一段。
      // ⚠️ Number(null) === 0 且 Number.isInteger(0) 为真，直接把 /status 回传的
      // null 当小时用会把模型写成「只有 0 点可用」。必须先挡掉 null/undefined/''。
      const hourOf = (v) => {
        if (v === null || v === undefined || v === '') return null
        const n = Number(v)
        return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null
      }
      let windows = []
      if (Array.isArray(m.windows)) {
        windows = m.windows
          .map(w => ({ from: hourOf(w.from), to: hourOf(w.to) }))
          .filter(w => w.from !== null && w.to !== null)
      }
      // 旧的 { from, to } 单时段字段
      if (windows.length === 0) {
        const from = hourOf(m.from); const to = hourOf(m.to)
        if (from !== null && to !== null) windows = [{ from, to }]
      }
      if (windows.length > 0) entry.windows = windows.slice(0, 12)
      // 截止日 YYYY-MM-DD：北京时间当天超过它即不再参与路由；空 = 不过期
      if (typeof m.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.until)) entry.until = m.until
      // 禁用：用户显式把这个模型挡在路由之外，与「当日失败」互不覆盖——
      // 失败是运行时结论（到点自动过期、成功一轮自动恢复），禁用是用户决定（只由用户解除）。
      if (m.disabled === true) entry.disabled = true
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
          models: g.models.map(m => ({ provider: m.provider, model: m.model, priority: m.priority ?? 99, effort: m.effort ?? null, windows: m.windows ?? null, from: m.from ?? null, to: m.to ?? null, until: m.until ?? null, disabled: m.disabled === true, failed: isFailed(m.provider, m.model) })),
        })),
        failed: failedList.filter(f => f.day === todayKey()).map(f => ({ provider: f.provider, model: f.model, count: f.count, code: f.code ?? null, reason: f.reason ?? null, at: f.at ?? null })),
        allModels: getAllModels(),
        sessionGroups: [...sessionBindings.entries()].map(([sessionId, b]) => ({ sessionId, groupId: b.groupId, mode: b.mode })),
        defaultBinding: defaultBinding ? { groupId: defaultBinding.groupId, mode: defaultBinding.groupId ? defaultBinding.mode : null } : null,
        activeModels: [...overrides.entries()].map(([sessionId, m]) => ({ sessionId, provider: m.provider, model: m.model, effort: m.effort ?? null })),
        settings,
        failResetHour,
        failureLog: failureLog.slice(-10).reverse(),
      })
      return
    }

    if (path === `${API_PATH}/debug/sessions` && req.method === 'GET') {
      const agentsService = ctx.get('agents')
      const live = agentsService?.list?.() ?? []
      sendJson(res, 200, {
        liveAgents: live.map(a => ({
          id: String(a.id),
          origin: a.session?.header?.origin ?? null,
          parentSession: a.session?.header?.parentSession ? String(a.session.header.parentSession) : null,
          provider: a.options?.provider ?? null,
          model: a.options?.model ?? null,
          override: overrides.has(String(a.id)) ? overrides.get(String(a.id)) : null,
          ownBinding: sessionBindings.get(String(a.id)) ?? null,
          effectiveBinding: (() => {
            const eff = effectiveBinding(a.session)
            return eff ? { groupId: eff.binding.groupId, mode: eff.binding.mode, viaSessionId: eff.viaSessionId, inherited: eff.inherited } : null
          })(),
          headerKeys: Object.keys(a.session?.header ?? {}),
        })),
        bindingsCount: sessionBindings.size,
        overridesCount: overrides.size,
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
      for (const [sid, b] of [...sessionBindings]) {
        if (b.groupId !== id) continue
        sessionBindings.delete(sid)
        overrides.delete(sid)
      }
      saveBindings()
      if (defaultBinding && defaultBinding.groupId === id) { defaultBinding = { groupId: null }; saveDefault() }
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
          // 解绑即交还控制权：不再接管该会话的模型
          sessionBindings.delete(body.sessionId)
          overrides.delete(String(body.sessionId))
          saveBindings()
          // 用户在某个会话里做成的选择同时成为新会话的默认值
          // （解绑也是一次选择：之后新建的会话不再自动接管）
          if (body.asDefault !== false) { defaultBinding = { groupId: null }; saveDefault() }
          sendJson(res, 200, { ok: true, sessionId: body.sessionId, groupId: null })
          return
        }
        const group = groups.find(g => g.id === body.groupId)
        if (!group) { sendJson(res, 400, { ok: false, error: '分组不存在' }); return }
        const mode = body.mode === 'failover' ? 'failover' : 'route'
        const boundSession = (findAgent(ctx, body.sessionId) ?? {}).session
        const subagent = isSubagentSession(boundSession)
        // explicit：用户亲自给这个会话选的分组。子代理继承父会话分组是默认行为，
        // 只有带这个标记的绑定才盖过继承（见 effectiveBinding）。
        sessionBindings.set(body.sessionId, { groupId: body.groupId, mode, explicit: true })
        saveBindings()
        // 子代理不参与「新会话默认分组」：它的生效分组本来就是继承来的
        if (body.asDefault !== false && !subagent) { defaultBinding = { groupId: body.groupId, mode }; saveDefault() }
        let picked = null
        if (mode === 'route') {
          // 分组路由：立即把会话模型切到组内最高优先级的可用模型
          picked = firstAvailableInGroup(body.groupId)
          const agent = findAgent(ctx, body.sessionId)
          if (picked && agent?.session) await applyActiveModel(agent, picked)
          else if (picked) overrides.set(String(body.sessionId), picked)
          else ctx.logger.warn(`[model-failover] 分组 ${body.groupId} 内无可用模型（全部当日失败）`)
        } else {
          // 故障兜底：不接管当前模型，交由用户手选
          overrides.delete(String(body.sessionId))
        }
        sendJson(res, 200, { ok: true, sessionId: body.sessionId, groupId: body.groupId, mode, model: picked })
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e) }) }
      return
    }

    /* ----- 单个会话的有效分组与当前模型（含子代理继承结果） ----- */
    if (path === `${API_PATH}/session-info` && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) { sendJson(res, 400, { ok: false, error: 'sessionId 必填' }); return }
      const agent = findAgent(ctx, sessionId)
      const session = agent?.session
      const own = sessionBindings.get(sessionId) ?? null
      const eff = session ? effectiveBinding(session) : null
      sendJson(res, 200, {
        ok: true,
        sessionId,
        live: !!session,
        isSubagent: isSubagentSession(session),
        origin: session?.header?.origin ?? null,
        parentSession: session?.header?.parentSession ? String(session.header.parentSession) : null,
        ownBinding: own,
        effectiveBinding: eff
          ? { groupId: eff.binding.groupId, mode: eff.binding.mode, viaSessionId: eff.viaSessionId, inherited: eff.inherited }
          : null,
        override: overrides.get(sessionId) ?? null,
        currentModel: agent ? currentModelOf(agent, String(sessionId)) : null,
        agentModel: agent ? { provider: agent.options?.provider ?? null, model: agent.options?.model ?? null } : null,
      })
      return
    }

    /* ----- 直接为某个会话选定模型（子代理会话走不了 sessionController） ----- */
    if (path === `${API_PATH}/session-model` && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (!body.sessionId || !body.provider || !body.model) {
          sendJson(res, 400, { ok: false, error: 'sessionId / provider / model 必填' }); return
        }
        const agent = findAgent(ctx, body.sessionId)
        if (!agent?.session) { sendJson(res, 409, { ok: false, error: '会话当前不活跃，无法直接设置模型' }); return }
        const target = { provider: String(body.provider), model: String(body.model) }
        if (body.reasoningEffort) target.effort = String(body.reasoningEffort)
        const ok = await applyActiveModel(agent, target)
        sendJson(res, 200, {
          ok,
          sessionId: body.sessionId,
          model: { provider: target.provider, model: target.model, effort: target.effort ?? null },
        })
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e) }) }
      return
    }

    if (path === `${API_PATH}/default-group` && req.method === 'GET') {
      sendJson(res, 200, {
        defaultBinding: defaultBinding ? { groupId: defaultBinding.groupId, mode: defaultBinding.groupId ? defaultBinding.mode : null } : null,
      })
      return
    }

    if (path === `${API_PATH}/default-group` && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (!body.groupId) {
          // 显式「新会话不使用分组」
          defaultBinding = { groupId: null }
        } else {
          const group = groups.find(g => g.id === body.groupId)
          if (!group) { sendJson(res, 400, { ok: false, error: '分组不存在' }); return }
          defaultBinding = { groupId: body.groupId, mode: body.mode === 'failover' ? 'failover' : 'route' }
        }
        saveDefault()
        sendJson(res, 200, { ok: true, defaultBinding })
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e) }) }
      return
    }

    /* ----- 手动把某个模型标成当日失败（与自动失败同一份数据，走同一套恢复路径） ----- */
    if (path === `${API_PATH}/failed/mark` && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (!body.provider || !body.model) { sendJson(res, 400, { ok: false, error: 'provider / model 必填' }); return }
        markFailed(String(body.provider), String(body.model), {
          code: 'MANUAL',
          message: '由用户在路由分组里手动标记为失败',
        })
        sendJson(res, 200, { ok: true, provider: body.provider, model: body.model })
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e) }) }
      return
    }

    /* ----- 禁用/启用某个模型参与路由（写进分组条目的 disabled 字段） ----- */
    if (path === `${API_PATH}/groups/model-disabled` && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (!body.provider || !body.model) { sendJson(res, 400, { ok: false, error: 'provider / model 必填' }); return }
        const want = body.disabled !== false
        let touched = 0
        for (const g of groups) {
          for (const m of g.models || []) {
            if (m.provider !== body.provider || m.model !== body.model) continue
            if (want) m.disabled = true
            else delete m.disabled
            touched++
          }
        }
        if (touched === 0) { sendJson(res, 404, { ok: false, error: '该模型不在任何分组里' }); return }
        saveGroups()
        sendJson(res, 200, { ok: true, provider: body.provider, model: body.model, disabled: want, groups: touched })
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

  ctx.logger.info('[model-failover-manager v12] mounted (agent.model.select routing + next-turn auto continuation)')

  /* ==================== 清理 ==================== */
  ctx.effect(() => () => {
    disposed = true
    disposeCreated()
    disposeStatus()
    disposeSessionEvent()
    disposeError()
    disposeStop()
    if (routeDisposer) routeDisposer()
  }, 'model-failover-manager: unmount')
}
