/**
 * model-failover-manager v22 — Host 端插件。（临时 bili 探针路由 + 进程内诊断）
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
 *   followup 必须**推迟到微任务**再投递：它会同步唤醒驱动器并在同一个调用栈里
 *   再发一次 `agent/status(running)`。若直接在 idle 边沿的回调里同步调用，那次
 *   running 边沿就发生在外层 idle dispatch **还没走完**的时候；排在后面的监听器
 *   （api/session-controller）随后才转发这次 idle，GUI 收到的最后一条是「空闲」，
 *   会话明明在跑却显示空闲，直到刷新重新拉取 list 基线才恢复。
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
 * 池是按 provider 字符串存账号的持久表，渠道退役后账号仍留在表里，因此「池里
 * 有这个 provider 的账号」不等于「这个 provider 归 Our Free Model 管」；
 * config.ofmHandoffExcludeProviders（默认 codearts）排除这类 provider。
 *
 * billion-context 压缩旁路（compactionGuard）：
 * billion-context（bili）的原生通道只改写**它认得的模型端点**——/chat/completions、
 * /v1/messages、/completions、/responses、/conversations、Gemini 的 /models/<name>:<method>。
 * qoder / qodercn 的推理走 WASM 加密的
 * POST /algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1，正文由 WASM 加密、
 * Authorization 是 WASM 生成的 COSY 签名，bili 既认不出这个路径、也解析不了密文。
 * 于是这类 provider 的请求**永远**绕过压缩代理，而 bili 一旦生效就会关掉宿主自带的
 * compaction-basic——两件事叠加的后果是：这些会话**没有任何上下文压缩**，历史只涨
 * 不降，bili 的压缩工具也不在请求里，最终在上下文上限处硬失败。
 *
 * 本插件不试图替 bili 压缩（没有 qoder 的加密器，做不到），而是按 codearts 那套
 * 「先分辨成因、再决定动作」的做法处理：
 * - config.uncompressedProviders（默认 ['qoder','qodercn']）声明这类 provider；
 * - config.compactionGuard（默认 true）在 bili 压缩生效时把它们**降为兜底候选**：
 *   分组里有压缩代理看得见的模型时优先用那些，全组都不可压缩时才退回它们
 *   （不至于让只配了 qoder 的分组变成无模型可用）；
 * - 失败时把结论写进 /status.compressionGuard，并给一行可执行的「修法」。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
// 明文进 bili、密文出上游的 shim（见 qoder-compress-shim.mjs 顶部）。
// 用带构建号的动态 import：改 shim 后重载插件即可换上新代码（ESM 按 URL 缓存），
// 而监听端口与 prototype 补丁由 shim 的 globalThis 槽跨重载保持。
const QODER_SHIM_MODULE = './qoder-compress-shim.mjs'
/** shim 构建号：每次改动 qoder-compress-shim.mjs 就把它 +1，否则 ESM 仍用缓存的旧模块。 */
const QODER_SHIM_BUILD = '32'
/** shim 只换得掉这两家的加密端点（QoderEncryptedInfer#prepareInfer 的使用者）。 */
const QODER_SHIM_PROVIDERS = new Set(['qoder', 'qodercn'])

export const name = 'model-failover-manager'
export const inject = ['timer']

const DATA_DIR_DEFAULT = 'model-failover-manager'
const API_PATH = '/api/model-failover'

/**
 * 当前宿主文件名，取自 import.meta.url。
 *
 * ESM 模块按路径缓存：改了文件内容但沿用旧文件名时，Loader 会继续用缓存里的旧模块
 * （本插件历史上因此反复升文件名）。把实际加载的文件名回传给 /status，排障时一眼就能
 * 确认新代码到底生效没有。
 */
const PLUGIN_FILE = (() => {
  try { return new URL(import.meta.url).pathname.split('/').pop() ?? null } catch { return null }
})()
/**
 * 模型端点注定绕过 billion-context 压缩代理的 provider（见文件头「压缩旁路」）。
 *
 * qoder / qodercn 用的是 WASM 加密端点，bili 的模型端点白名单里没有它，
 * bili 也不能解析密文正文；这两条链路在 DSH 的原生通道里拿不到任何压缩。
 */
const DEFAULT_UNCOMPRESSED_PROVIDERS = ['qoder', 'qodercn']
/**
 * billion-context 用它宣告「bili 现在就是唯一的压缩器」。
 *
 * bili-compaction-gate 读同一个全局量来决定是否把宿主的 compaction-basic 关掉；
 * 本插件读它比去问 bili 的 HTTP 状态更可靠（不依赖端口、鉴权与网络）。
 */
const BILI_COMPACTION_VERDICT_KEY = '__BILI_DSH_COMPACTION_VERDICT__'

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
 * 不走 Our Free Model 同模型换号的 provider，默认只有 codearts。
 *
 * 为什么需要名单：Our Free Model 的账号池是**按 provider 字符串**存账号的持久
 * 表（channel-pack 的 state.json），某个渠道从该插件退役后，它的账号条目仍留
 * 在表里。只看「池里有这个 provider 的账号」就当作它的模型，会把别的插件的
 * 失败误判成「换号重试」：冷却一个本次请求根本没用到的账号，并且挡掉了本该
 * 发生的分组路由。
 *
 * codearts 就是这种情形：供应商由 dsh-codearts 提供，账号也由它自己的账号池
 * （.codearts-accounts.json）管理；Our Free Model 2.5.9 已没有该渠道，但池里
 * 留着历史账号，于是 429 soft_rate 被当成换号处理（failureLog 的
 * outcome=account-handoff）。
 *
 * 为什么用配置而不是「查该 provider 是否由 Our Free Model 注册」：池没有暴露
 * provider 归属的接口，渠道清单又随 Our Free Model 版本变化，写死一份「它的
 * 渠道」名单同样会过期。想把某个 provider 交回换号流程，把它从这份名单里去掉
 * 即可；空数组表示不排除任何 provider。
 */
const DEFAULT_OFM_HANDOFF_EXCLUDE_PROVIDERS = ['codearts']

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
  // 不走 Our Free Model 换号的 provider（见 DEFAULT_OFM_HANDOFF_EXCLUDE_PROVIDERS）。
  // 非法值回退默认名单：名单只决定「先换号还是先换模型」，配错不该让插件起不来，
  // 但也不能因为一个手写的错值把 codearts 重新卷回换号流程。
  const ofmExcludeRaw = config.ofmHandoffExcludeProviders
  const ofmExcludeValid = Array.isArray(ofmExcludeRaw) && ofmExcludeRaw.every(v => typeof v === 'string' && v.trim())
  const ofmExcludeList = ofmExcludeValid ? ofmExcludeRaw.map(v => v.trim()) : DEFAULT_OFM_HANDOFF_EXCLUDE_PROVIDERS
  if (ofmExcludeRaw !== undefined && !ofmExcludeValid) {
    ctx.logger.warn(`[model-failover] config.ofmHandoffExcludeProviders=${JSON.stringify(ofmExcludeRaw)} 非法（需字符串数组），回退 ${JSON.stringify(DEFAULT_OFM_HANDOFF_EXCLUDE_PROVIDERS)}`)
  }
  const ofmHandoffExcludedProviders = new Set(ofmExcludeList)
  /** 每个被排除的 provider 只提示一次，避免每次失败都刷一行日志 */
  const ofmHandoffExcludedWarned = new Set()

  // 绕过压缩代理的 provider（见文件头「压缩旁路」）。非法值回退默认名单：
  // 它只决定「谁被降为兜底候选」，配错不该让插件起不来。
  const uncompressedRaw = config.uncompressedProviders
  const uncompressedValid = Array.isArray(uncompressedRaw) && uncompressedRaw.every(v => typeof v === 'string' && v.trim())
  const uncompressedList = uncompressedValid ? uncompressedRaw.map(v => v.trim()) : DEFAULT_UNCOMPRESSED_PROVIDERS
  if (uncompressedRaw !== undefined && !uncompressedValid) {
    ctx.logger.warn(`[model-failover] config.uncompressedProviders=${JSON.stringify(uncompressedRaw)} 非法（需字符串数组），回退 ${JSON.stringify(DEFAULT_UNCOMPRESSED_PROVIDERS)}`)
  }
  const uncompressedProviders = new Set(uncompressedList)
  /** 压缩旁路守卫：关掉后这些 provider 仍按原优先级参与路由 */
  const compactionGuardRaw = config.compactionGuard
  const compactionGuard = typeof compactionGuardRaw === 'boolean' ? compactionGuardRaw : true
  if (compactionGuardRaw !== undefined && typeof compactionGuardRaw !== 'boolean') {
    ctx.logger.warn(`[model-failover] config.compactionGuard=${JSON.stringify(compactionGuardRaw)} 非法（需布尔值），回退 true`)
  }
  /** 每个被降级的 provider 只提示一次，避免每次挑选候选都刷日志 */
  const uncompressedWarned = new Set()

  // qoder 压缩 shim：把 WASM 加密请求换成明文 OpenAI 请求，先经 bili 压缩，
  // 再由本机转发层重新加密发往上游（见 qoder-compress-shim.mjs）。默认关闭：
  // 它依赖 dsh-codearts-auth 的内部模块，装不上时只告警、不影响其它功能。
  const qoderShimRaw = config.qoderShim
  const qoderShimEnabled = typeof qoderShimRaw === 'boolean' ? qoderShimRaw : false
  if (qoderShimRaw !== undefined && typeof qoderShimRaw !== 'boolean') {
    ctx.logger.warn(`[model-failover] config.qoderShim=${JSON.stringify(qoderShimRaw)} 非法（需布尔值），回退 false`)
  }
  const qoderShimPortRaw = config.qoderShimPort
  const qoderShimPort = Number.isInteger(qoderShimPortRaw) && qoderShimPortRaw > 0 && qoderShimPortRaw < 65536 ? qoderShimPortRaw : 47001
  if (qoderShimPortRaw !== undefined && qoderShimPort !== qoderShimPortRaw) {
    ctx.logger.warn(`[model-failover] config.qoderShimPort=${JSON.stringify(qoderShimPortRaw)} 非法（需 1..65535 整数），回退 47001`)
  }
  const qoderShimWasmPath = typeof config.qoderShimWasmPath === 'string' && config.qoderShimWasmPath.trim() ? config.qoderShimWasmPath.trim() : undefined

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
  // 压缩 shim 的句柄：声明在这里，因为「压缩旁路守卫」的路由判断要读它（见 qoderShimCovers）
  let qoderShimHandle = null

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
   * 从候选条目里挑一个可路由的：优先压缩代理看得见的 provider，都不可压缩时才退回。
   *
   * 为什么不直接把这类 provider 判成「不可路由」：分组可能只配了它们，那等于把用户
   * 锁在无模型可用的状态。降级 + 兜底更安全——全组都不可压缩时仍会选中它们，
   * 想主动用它们的用户把 config.compactionGuard 关掉即可恢复原优先级。
   *
   * @param {Array<{provider: string, model: string, effort?: string}>} models - 已排好序的候选条目。
   * @returns {{provider: string, model: string, effort?: string}|null} 选中的候选。
   */
  function pickCandidate(models) {
    let fallback = null
    for (const m of models) {
      if (!routable(m)) continue
      if (!compressionGapOf(m.provider)) return candidateOf(m)
      if (!fallback) fallback = candidateOf(m)
    }
    return fallback
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

  /** 组内第一个可路由模型（未失败、在窗内、未过期；优先压缩代理看得见的） */
  function firstAvailableInGroup(groupId) {
    return pickCandidate(sortedModels(groupId))
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

  /** 组内除 exclude 外的下一个可路由模型（按优先级顺序；优先压缩代理看得见的） */
  function nextInGroup(groupId, exclude) {
    return pickCandidate(sortedModels(groupId)
      .filter(m => !(m.provider === exclude.provider && m.model === exclude.model)))
  }

  /**
   * 无会话绑定时，从当前模型所属分组里找优先级不低于它的可路由模型。
   *
   * 在第一处包含当前模型的分组上就给出结论（哪怕结论是没有候选），
   * 与旧行为一致：不跨组兜底，避免用户把一个模型放进多个组时被换到无关链路。
   */
  function findFailover(currentProvider, currentModel) {
    for (const group of groups) {
      if (!group.enabled) continue
      const self = group.models.find(m => m.provider === currentProvider && m.model === currentModel)
      if (!self) continue
      const limit = self.priority ?? 99
      return pickCandidate(sortedModels(group.id).filter((cand) => {
        if (cand.provider === currentProvider && cand.model === currentModel) return false
        return (cand.priority ?? 99) <= limit
      }))
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

  /* ============ 状态序列诊断（排障用，环形缓冲） ============ */
  //
  // 「会话在跑，GUI 却显示空闲」这类问题的判定点是**事件到达顺序**，而不是任一
  // 时刻的状态值：agent/status 与转发给 GUI 的 api-session/status 都在同一调用栈里
  // 同步发出，一旦有人在 agent/status 回调里同步唤醒驱动器，两个边沿就会嵌套，
  // 读侧看到的最后一条可能是过期的那条。这里把两条事件的到达顺序按序号记下来，
  // 经 GET /api/model-failover/debug/status-log 取回，用于事后核对。
  const STATUS_LOG_LIMIT = 200
  const statusLog = []
  let statusSeq = 0

  /**
   * 记录一条状态事件。
   * @param {string} kind - 'agent/status' 或 'api-session/status'。
   * @param {string} sessionId - 会话 id。
   * @param {boolean|null} running - 该事件表达的运行态；null 表示不适用。
   * @param {Record<string, unknown>} [extra] - 附加字段（如嵌套深度）。
   */
  function logStatus(kind, sessionId, running, extra) {
    statusSeq += 1
    const entry = { seq: statusSeq, at: Date.now(), kind, sessionId, running }
    if (extra) Object.assign(entry, extra)
    statusLog.push(entry)
    if (statusLog.length > STATUS_LOG_LIMIT) statusLog.splice(0, statusLog.length - STATUS_LOG_LIMIT)
    return statusSeq
  }

  /**
   * 按调用顺序列出 `agent/status` 的监听器与归属插件。
   *
   * Cordis 分发按注册顺序逐条同步调用，所以这里的下标就是实际执行顺序。
   * 只读探测 `ctx.events._hooks`：该字段是 vendor 内部结构，取不到时返回 null 而不报错。
   * @returns {Array<{ index: number, owner: string, prepend: boolean }>|null} 监听器顺序；探测失败为 null。
   */
  function describeStatusListeners() {
    try {
      const hooks = ctx.events?._hooks?.['agent/status']
      if (!Array.isArray(hooks)) return null
      return hooks.map((hook, index) => ({
        index,
        owner: hook?.ctx?.fiber?.name ?? null,
        prepend: hook?.prepend === true,
      }))
    } catch {
      return null
    }
  }

  // GUI 转发侧：把宿主真正发给客户端的顺序也记下来，才能判断读侧最后收到什么。
  const disposeApiStatus = ctx.on('api-session/status', (sessionId, running) => {
    if (disposed) return
    logStatus('api-session/status', String(sessionId), running === true)
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
    const sessionId = String(agent.session.id)
    logStatus('agent/status', sessionId, status === 'running')
    if (status === 'idle') {
      // 失败切换后等的就是这个时刻：驱动器已经收尾，followup 才会开新一轮。
      // 必须是异步投递，不能在本回调里直接 followup——理由见文件头。
      scheduleContinuation(sessionId)
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
    // 名单里的 provider 由别的插件提供：池里可能还留着它的历史账号，但换号语义
    // 不成立（冷却的是本次请求没用到的账号，还挡掉了本该发生的分组路由）。
    if (ofmHandoffExcludedProviders.has(provider)) {
      if (!ofmHandoffExcludedWarned.has(provider)) {
        ofmHandoffExcludedWarned.add(provider)
        ctx.logger.info(`[model-failover] ${provider} 不在 Our Free Model 换号范围（config.ofmHandoffExcludeProviders），失败直接走分组路由`)
      }
      return null
    }
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

  /* ============ dsh-codearts：签名被中间层拒绝时的诊断 ============ */
  //
  // 症状：dsh-codearts 回 429 soft_rate「codearts 当前没有可用账号（全部被禁用
  // 或冷却中），请稍后重试」，但账号与积分都正常。
  //
  // 这不是账号问题，而是**上游拒绝**披了这层外衣。实测链路（session
  // 6de50bf5，2026-10-25）：
  //   1. dsh-codearts 发送 CodeArts APIG SDK-HMAC-SHA256 签名的请求；
  //   2. billion-context 的本地代理（bili）判定「签名覆盖请求体，任何改写
  //      （上下文压缩）都会让上游 401 APIG.0301」，而它**没有重签凭据**，
  //      于是直接拒绝转发，回 403 signed_request_requires_resign /
  //      bili_resign_unavailable；
  //   3. dsh-codearts 的 classify() 把 403 归为 session_dead，对两个账号都
  //      pool.disable()；池随之挑不出号；
  //   4. 下一次请求 pool.pick() 返回 undefined，一个上游请求都不发，回那句 429。
  //
  // 所以那句 429 的真实含义是「池里挑不出号」，成因有两种，处置完全不同：
  //   A. 账号被签名的中间层拒过（status 里有 bili_resign_unavailable 细节）
  //      → 重启本插件救不了，必须给 bili 重签凭据或让该链路免压缩；
  //   B. 其它原因（上游偶发 401/403、凭据解析失败）
  //      → 重启承载 dsh-codearts 的 Loader 条目即可重建池。
  // 本节按状态接口里的细节分辨这两种，并在日志与 /status 里给出可执行的下一步。

  /** provider id：dsh-codearts 自己导出的 CODEARTS_PROVIDER */
  const CODEARTS_PROVIDER_ID = 'codearts'
  /**
   * 「池里挑不出号」的那句固定文案。
   *
   * 只有这一句才说明「一个上游请求都没发出去」；其它 codearts 错误是真实的模型级
   * 失败，必须继续走分组路由。
   */
  const CODEARTS_POOL_EMPTY = /codearts\s*当前没有可用账号（全部被禁用或冷却中）/
  /** 两次自救之间的最短间隔：重启是重操作，且失败会重复触发 */
  const CODEARTS_REVIVE_COOLDOWN_MS = 30_000
  /** 重启后等 dsh-codearts 适配器重新注册的上限；它的 apply 会走一次模型发现 */
  const CODEARTS_READY_TIMEOUT_MS = 20_000
  let lastCodeartsReviveAt = 0
  /** 最近一次 codearts 自救的结论，随 /status 回传 */
  let lastCodeartsDiagnosis = null

  /**
   * 这个 provider 是不是 codearts。
   *
   * 只看 provider 名，不匹配错误文案：真实成因（签名中间层、401、429）各不相同，
   * 但都落在同一个 provider 上。
   */
  function isCodeartsFailure(provider, failure) {
    if (provider === CODEARTS_PROVIDER_ID) return true
    return String(failure?.provider ?? '') === CODEARTS_PROVIDER_ID
  }

  /**
   * 问 dsh-codearts 的状态接口：池里每个账号现在是什么状态、为什么。
   *
   * 只在确认为 codearts 失败后调用，用于把「429 没有可用账号」翻译成真正的原因。
   *
   * @returns {Promise<{reachable: boolean, slots: Array<{id: string, state: string, detail?: string}>, blockedBySignature: boolean}>}
   */
  async function readCodeartsPoolState() {
    const out = { reachable: false, slots: [], blockedBySignature: false }
    try {
      const res = await fetch('http://127.0.0.1:3080/api/codearts/status', { headers: { accept: 'application/json' } })
      if (!res.ok) return out
      const body = await res.json()
      out.reachable = true
      out.slots = Array.isArray(body?.usage?.slots) ? body.usage.slots : []
      out.blockedBySignature = out.slots.some(s => String(s?.detail ?? '').includes('bili_resign_unavailable'))
    } catch { /* 状态接口不可达时按未知处理 */ }
    return out
  }

  /**
   * 重启承载 dsh-codearts 的 Loader 条目，让它的账号池回到干净状态。
   *
   * 为什么走 Loader 条目而不是直接改它的池：池实例在 apply() 闭包里，既没有导出
   * 也没有服务；唯一能让「disabled 已被置位」的池消失的办法就是让那个插件实例
   * 重新创建。entry.fiber.restart() 是「卸载 + 用同一份配置重新加载」，不写配置。
   *
   * @returns {Promise<boolean>} 是否真的重启并等到了适配器回来
   */
  async function reviveCodeartsPool() {
    const now = Date.now()
    if (now - lastCodeartsReviveAt < CODEARTS_REVIVE_COOLDOWN_MS) return false
    let loader
    try { loader = ctx.get('loader') } catch { /* 下面统一处理 */ }
    if (!loader || typeof loader.entries !== 'function') {
      ctx.logger.warn('[model-failover] 取不到 loader 服务，无法重建 codearts 账号池（请重启宿主）')
      return false
    }
    let target
    try {
      for (const entry of loader.entries()) {
        const entryName = String(entry?.options?.name ?? '')
        if (!entryName.includes('dsh-codearts')) continue
        if (!entry.fiber || entry.fiber.uid === null) continue
        target = entry
        break
      }
    } catch (e) {
      ctx.logger.warn(`[model-failover] 枚举 loader 条目失败：${e?.message || e}`)
      return false
    }
    if (!target) {
      ctx.logger.warn('[model-failover] 没找到运行中的 dsh-codearts 条目，无法重建账号池')
      return false
    }
    lastCodeartsReviveAt = now
    try {
      await target.fiber.restart()
    } catch (e) {
      ctx.logger.warn(`[model-failover] 重启 dsh-codearts 失败：${e?.message || e}（请重启宿主）`)
      return false
    }
    // 重新 apply 后适配器才重新注册（它的 apply 里是 shim.ready.then(...) 异步挂载）
    return await waitForCodeartsProvider()
  }

  /**
   * 等 dsh-codearts 的 provider 重新出现在 llm 注册表里。
   *
   * @returns {Promise<boolean>} 超时前是否看到该 provider
   */
  async function waitForCodeartsProvider() {
    const deadline = Date.now() + CODEARTS_READY_TIMEOUT_MS
    for (;;) {
      try {
        const llm = ctx.get('llm')
        const providers = llm?.listProviders?.() ?? []
        if (providers.some(p => String(p?.id) === CODEARTS_PROVIDER_ID)) return true
      } catch { /* 重启窗口内服务可能短暂不可读，继续等 */ }
      if (Date.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  /**
   * 只读诊断：codearts 目前的池状态与自救可行性（`/status` 的 `codeartsSelfHeal`）。
   *
   * @returns {Promise<object>} 现场快照，供界面与排障读取
   */
  async function describeCodeartsSelfHeal() {
    const state = await readCodeartsPoolState()
    const remaining = CODEARTS_REVIVE_COOLDOWN_MS - (Date.now() - lastCodeartsReviveAt)
    let loaderAvailable = false
    let entryId = null
    try {
      const loader = ctx.get('loader')
      if (loader && typeof loader.entries === 'function') {
        loaderAvailable = true
        for (const entry of loader.entries()) {
          if (!String(entry?.options?.name ?? '').includes('dsh-codearts')) continue
          if (!entry.fiber || entry.fiber.uid === null) continue
          entryId = String(entry.options?.id ?? '')
          break
        }
      }
    } catch { /* 保持默认值 */ }
    return {
      loaderAvailable,
      entryId,
      cooldownRemainingMs: remaining > 0 ? remaining : 0,
      poolReachable: state.reachable,
      // bili（billion-context 的本地代理）在没拿到重签凭据时会拒绝转发带 body
      // 签名的请求；这是「池里挑不出号」最常见的成因，且重启救不了。
      blockedBySignature: state.blockedBySignature,
      slots: state.slots.map(s => ({ id: s.id, state: s.state, detail: s.detail ? String(s.detail).slice(0, 200) : undefined })),
      lastDiagnosis: lastCodeartsDiagnosis,
    }
  }

  /**
   * codearts 失败后的处置：先分辨成因，再决定能否自救。
   *
   * @param {string} provider - 失败请求用的 provider。
   * @param {string} model - 失败请求用的模型。
   * @param {{code?: string, status?: number, message?: string}} failure - 宿主给出的失败事实。
   * @returns {Promise<'retry'|'signature-blocked'|'revived'|'unrecoverable'>}
   */
  async function handleCodeartsFailure(provider, model, failure) {
    // 只接管「池里挑不出号」这一类：正常的模型级失败（额度用完、TPM 超限、模型下线）
    // 仍然要落给下面的分组路由，否则 codearts 就再也不会切模型了。
    const poolEmpty = CODEARTS_POOL_EMPTY.test(String(failure?.message ?? ''))
    const state = await readCodeartsPoolState()
    const disabled = state.slots.filter(s => s.state === 'disabled').length
    const cooling = state.slots.filter(s => s.state === 'cooling').length
    if (!poolEmpty && !state.blockedBySignature) return 'fallthrough'

    // A. 签名中间层拒绝：重启没有任何用，账号凭据和池都是被「拒转发」连带污染的
    if (state.blockedBySignature) {
      lastCodeartsDiagnosis = {
        at: Date.now(), kind: 'signature-blocked', disabled, cooling,
        hint: 'billion-context 未拿到 CodeArts 重签凭据，拒绝转发带 body 签名的请求（403 signed_request_requires_resign）。'
          + '需要给它一个可用凭据（DSH credentials 里的 codearts 账号，或 config resign.sdk-hmac-sha256.credentialRef / BILI_CODEARTS_REF），'
          + '或让这条链路免压缩（resign.sdk-hmac-sha256.passthrough=true / BILI_RESIGN_PASSTHROUGH=1）。重启插件无效。',
      }
      ctx.logger.error(`[model-failover] ${provider}/${model} 失败不是账号问题：billion-context（bili）拒绝转发 CodeArts 签名请求（缺重签凭据），${disabled} 个账号因此被标成 disabled。`)
      ctx.logger.error('[model-failover] 修法：在 ~/.config/billion-context/billion-context.json 加 providers.<codearts 路由>.resign["sdk-hmac-sha256"] = { credentialRef | passthrough:true }，或设 BILI_CODEARTS_REF / BILI_RESIGN_PASSTHROUGH=1，然后重启 bili。')
      return 'signature-blocked'
    }

    // B. 池里确实没有可用号，但没有签名证据：重启条目重建池，成功后同一步重试
    if (disabled > 0 || cooling > 0 || state.slots.length === 0) {
      const revived = await reviveCodeartsPool()
      lastCodeartsDiagnosis = {
        at: Date.now(), kind: revived ? 'revived' : 'revive-failed', disabled, cooling,
        hint: revived ? '已重启 dsh-codearts 重建账号池。' : '重启 dsh-codearts 未成功，请手动重启宿主。',
      }
      if (revived) return 'retry'
      return 'unrecoverable'
    }

    lastCodeartsDiagnosis = { at: Date.now(), kind: 'unknown', disabled, cooling, hint: '池状态里没有停用/冷却记录，失败原因见 failure.message。' }
    return 'unrecoverable'
  }

  /* ==================== 压缩旁路守卫（billion-context） ==================== */
  //
  // bili 在 DSH 里是**唯一的压缩器**：它一旦生效，bili-compaction-gate 就把宿主的
  // compaction-basic 置为 disabled。而 bili 的原生通道只改写它认得的模型端点，
  // qoder/qodercn 的 WASM 加密端点不在名单里——两件事叠加，这些会话既没有 bili 压缩、
  // 也没有宿主自带压缩，历史只涨不降，bili 的压缩工具也不在请求里。
  // 本插件没有 qoder 的加密器，替 bili 解析密文做不到；能做的是别让这种会话悄悄跑、
  // 别让路由把用户往没有压缩的链路上推，并把修法说清楚。

  /** bili 是否正作为唯一压缩器生效（与 bili-compaction-gate 读同一个全局量） */
  function biliCompactionActive() {
    try { return globalThis[BILI_COMPACTION_VERDICT_KEY] === 'active' } catch { return false }
  }

  /**
   * 该 provider 此刻是否存在「压缩旁路」：配置声明它绕过压缩代理，且 bili 确实在压缩。
   *
   * 两者缺一都不算：bili 没生效时宿主自带 compaction 还在跑，这些 provider 照常有压缩；
   * 守卫关掉时也不拦。
   *
   * @param {string} provider - provider id。
   * @returns {{provider: string}|null} 命中时给出描述，否则 null。
   */
  function compressionGapOf(provider) {
    if (!compactionGuard) return null
    const id = String(provider ?? '')
    if (!uncompressedProviders.has(id)) return null
    if (!biliCompactionActive()) return null
    // shim 已经把这家的请求改成明文 OpenAI 送进 bili，压缩照常发生，不再算旁路。
    if (qoderShimCovers(id)) return null
    return { provider: id }
  }

  /**
   * 压缩 shim 此刻是否接管了该 provider（见 qoder-compress-shim.mjs：它换掉
   * QoderEncryptedInfer#prepareInfer，把加密请求改成明文 OpenAI 先过 bili）。
   *
   * @param {string} provider - provider id。
   * @returns {boolean} 已接管则为 true。
   */
  function qoderShimCovers(provider) {
    if (!QODER_SHIM_PROVIDERS.has(provider)) return false
    if (qoderShimHandle === null) return false
    try {
      const st = qoderShimHandle.status()
      return st !== null && st.installed === true
    } catch {
      return false
    }
  }

  /** 最近一次压缩旁路的失败结论，随 /status 回传 */
  let lastCompressionDiagnosis = null

  /**
   * 压缩旁路失败留痕：只诊断，不改切换路径。
   *
   * 只留痕、不改路径：换到哪个模型仍由分组路由决定，而路由本身已经优先避开这类
   * provider（见 pickCandidate）；日志按 provider 只报第一次，避免每轮失败都刷屏。
   *
   * @param {string} provider - 失败请求用的 provider。
   * @param {string|null} model - 失败请求用的模型。
   * @param {{code?: string, message?: string}} failure - 宿主给出的失败事实。
   * @returns {object|null} 写入 /status 的诊断条目；未命中旁路时为 null。
   */
  function noteCompressionGap(provider, model, failure) {
    const gap = compressionGapOf(provider)
    if (!gap) return null
    if (!uncompressedWarned.has(gap.provider)) {
      uncompressedWarned.add(gap.provider)
      ctx.logger.warn(`[model-failover] ${gap.provider} 的模型端点不在 billion-context 的端点白名单里（WASM 加密端点），它的会话没有上下文压缩：已把 ${gap.provider} 降为分组里的兜底候选。`)
      ctx.logger.error(`[model-failover] ${gap.provider} 的请求又一次失败，而它的会话没有上下文压缩（bili 认不出它的加密端点）。`)
      ctx.logger.error('[model-failover] 修法：把会话切到压缩代理看得见的模型，或设 config.compactionGuard=false 接受无压缩；bili 解析不了该 provider 的密文正文，所以它拿不到 bili 压缩。')
    }
    lastCompressionDiagnosis = {
      at: Date.now(),
      provider: gap.provider,
      model: model ?? null,
      code: failure?.code ? String(failure.code) : null,
      hint: `billion-context（bili）现在是唯一的压缩器，但它的端点白名单里没有 ${gap.provider} 的 WASM 加密端点（/algo/api/v2/...），请求被原样直发、不压缩。`
        + '修法（三选一）：① 把会话切到压缩代理看得见的模型（走 /chat/completions 或 /v1/messages 的 provider）；'
        + `② 继续用 ${gap.provider} 但接受没有压缩：config.compactionGuard=false；`
        + '③ 需要压缩时让该链路走 bili 的证书 MITM 车道（bili qoder），并确认它的协议被支持。',
    }
    return lastCompressionDiagnosis
  }

  /**
   * 只读诊断：压缩旁路守卫此刻的现场（`/status` 的 `compressionGuard`）。
   *
   * @returns {object} 守卫开关、bili 状态、被降级的模型与正跑在无压缩链路上的会话。
   */
  function describeCompressionGuard() {
    const downgradedModels = []
    for (const g of groups) {
      if (!g.enabled) continue
      for (const m of g.models) {
        if (!compressionGapOf(m.provider)) continue
        downgradedModels.push({ groupId: g.id, provider: m.provider, model: m.model })
      }
    }
    const degradedSessions = []
    for (const [sessionId, m] of overrides.entries()) {
      if (!compressionGapOf(m.provider)) continue
      degradedSessions.push({ sessionId, provider: m.provider, model: m.model })
    }
    return {
      enabled: compactionGuard,
      biliActive: biliCompactionActive(),
      uncompressedProviders: [...uncompressedProviders],
      // 已被压缩 shim 改道、因此不算旁路的 provider（此时路由不会再降级它们）
      shimCovered: [...QODER_SHIM_PROVIDERS].filter((id) => uncompressedProviders.has(id) && qoderShimCovers(id)),
      downgradedModels: downgradedModels.slice(0, 50),
      degradedSessions,
      lastDiagnosis: lastCompressionDiagnosis,
    }
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
        // 该 provider 的请求不经过压缩代理（无上下文压缩），排障时一眼可见
        ...(extra?.uncompressed === true ? { uncompressed: true } : {}),
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

    // dsh-codearts 的失败要分开看：那句「429 没有可用账号」既可能是上游偶发 401/403
    // 把账号停用（重启条目即可），也可能是 billion-context 拒绝转发签名请求
    // （重启无效，必须给 bili 重签凭据）。必须在换号/标记失败之前处理——否则会把
    // 一次可自愈的池状态写成「模型当日失败」，或者对注定失败的链路反复重试。
    if (isCodeartsFailure(provider, failure)) {
      const verdict = await handleCodeartsFailure(provider, model, failure)
      noteFailure(agent, provider, failure, `codearts-${verdict}`, {
        model,
        detail: lastCodeartsDiagnosis?.hint ?? null,
      })
      // 只有「重建账号池成功」才值得同一步重试；selection 没变，retry 是安全的。
      if (verdict === 'retry') return { kind: 'retry' }
      // fallthrough：不是「池挑不出号」，继续走下面的换号 / 分组路由。
      if (verdict !== 'fallthrough') {
        // 签名中间层拦截 / 无法自救：重试与换模型都没有意义，直接交给宿主报错。
        return action
      }
    }

    // 压缩旁路：bili 是唯一压缩器时，qoder 这类 provider 的会话没有任何压缩。
    // 这里只诊断、不截断流程——换到哪个模型交给下面的分组路由，而路由本身已经
    // 优先避开这类 provider（pickCandidate）；沿用着它们的会话才会走到这里。
    const compressionGap = noteCompressionGap(provider, model, failure)

    // Our Free Model 的模型：不论错误类型，一律先试换账号重试。
    // 换的是同一 provider/model 背后的凭据，selection 没变，所以同一步 retry 安全。
    // 哪些 provider 算「Our Free Model 的」由 config.ofmHandoffExcludeProviders 判定：
    // 名单内（默认 codearts）直接落到下面的分组路由。
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
      noteFailure(agent, provider, failure, 'no-target', { model, detail: why, uncompressed: compressionGap !== null })
      return action
    }
    if (inherited?.inherited) {
      ctx.logger.info(`[model-failover] 子代理 ${id} 按继承的分组 ${binding.groupId}（来自 ${inherited.viaSessionId}）切换`)
    }

    const ok = await applyActiveModel(agent, target)
    noteFailure(agent, provider, failure, ok ? 'switched' : 'switch-failed', {
      model, detail: `→ ${target.provider}/${target.model}${ok ? '' : '（切换失败）'}`,
      uncompressed: compressionGap !== null,
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
   * 所以在 agent 回到 idle 后再投递，且要**再等一个微任务**：那时 followup 会正常
   * 通过 wakeDriver 开新一轮，新一轮的 pre-step 读到的正是我们刚 select 的模型，
   * 而这次唤醒产生的 running 边沿也不会嵌进 idle 的 dispatch 里。
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
    // 已经空闲（异常路径下可能直接是 idle）：立刻安排投递。
    if (agent.status === 'idle') scheduleContinuation(id)
  }

  /**
   * 把一次待续跑的投递推到微任务，等当前 agent/status dispatch 全部结束后再执行。
   *
   * `followup` 会在同一调用栈里同步走 wakeDriver → setPhase(running) →
   * emit agent/status(running)。如果在 agent/status(idle) 的回调里直接调用，
   * 这次 running 边沿就嵌在外层 idle dispatch 内部：排在后面的监听器
   * （api/session-controller）随后才把 idle 转发给 GUI，GUI 收到的最后一条是
   * 「空闲」，于是会话在跑却显示空闲，直到刷新重新拉 list 基线。
   * 推到微任务后，两个边沿按真实发生顺序串行发出，读侧不会再收到过期的那条。
   *
   * @param {string} sessionId - 待续跑的会话。
   */
  function scheduleContinuation(sessionId) {
    // 没有待续跑就什么都不做：idle 边沿每轮都会来一次，无条件记录会把日志淹掉。
    if (!pendingContinuations.has(sessionId)) return
    logStatus('continuation/scheduled', sessionId, null)
    queueMicrotask(() => {
      if (disposed) return
      deliverContinuation(sessionId)
    })
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
    logStatus('continuation/delivered', sessionId, null)
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
        ofmHandoffExcludeProviders: [...ofmHandoffExcludedProviders],
        // 压缩旁路现场：bili 生效时哪些模型注定拿不到压缩、哪些会话正跑在这种链路上
        compressionGuard: describeCompressionGuard(),
        // 实际加载的宿主文件名（确认改完的代码有没有生效）
        pluginFile: PLUGIN_FILE,
        // qoder 压缩 shim：截获 prepareInfer 的明文请求 + 经 bili 转发回来的压缩结果
        qoderShim: describeQoderShim(),
        // codearts 自救是否具备执行条件：loader 可见 + 找得到运行中的条目。
        // 这两项缺一就先在这里暴露出来，而不是等真失败时才发现救不了。
        codeartsSelfHeal: await describeCodeartsSelfHeal(),
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

    if (path === `${API_PATH}/debug/status-log` && req.method === 'GET') {
      const limitRaw = Number(url.searchParams.get('limit'))
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, STATUS_LOG_LIMIT) : 80
      const sessionFilter = url.searchParams.get('sessionId')
      const rows = sessionFilter ? statusLog.filter(e => e.sessionId === sessionFilter) : statusLog
      sendJson(res, 200, {
        total: statusSeq,
        pendingContinuations: [...pendingContinuations.keys()],
        entries: rows.slice(-limit),
        listeners: describeStatusListeners(),
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

  /* ==================== qoder 压缩 shim ==================== */
  //
  // 把 QoderEncryptedInfer#prepareInfer 换成「返回明文 OpenAI 请求，指向本机 shim」，
  // 于是这次请求的路径以 /chat/completions 结尾、又是会话内发起的，bili 的原生通道
  // 会照常压缩并转发回来；shim 收到压缩后的 messages，再调原始 prepareInfer 加密发上游。
  // 响应方向不翻译：上游 SSE 原样穿回 adapter。
  /** /status 用；shim 还没起来时也要能说明原因 */
  function describeQoderShim() {
    if (qoderShimHandle !== null) return { enabled: true, ...qoderShimHandle.status() }
    return { enabled: false, installed: false, port: qoderShimPort, reason: qoderShimEnabled ? '启动中或启动失败（见日志）' : 'config qoderShim=false' }
  }
  if (qoderShimEnabled) {
    void (async () => {
      try {
        const shimModule = await import(QODER_SHIM_MODULE + '?v=' + QODER_SHIM_BUILD)
        qoderShimHandle = await shimModule.startQoderShim({ logger: ctx.logger, port: qoderShimPort, wasmPath: qoderShimWasmPath })
        const st = qoderShimHandle.status()
        if (st.installed && st.enabled) {
          ctx.logger.info(`[model-failover] qoder 压缩 shim 就绪：127.0.0.1:${st.port} 已接管 prepareInfer（明文经 bili 压缩后再加密发往上游）`)
        } else {
          ctx.logger.warn(`[model-failover] qoder 压缩 shim 未接管：${st.lastError ?? '未知原因'}（qoder 模型仍按未压缩直发）`)
        }
      } catch (err) {
        ctx.logger.warn(`[model-failover] qoder 压缩 shim 启动失败：${err && err.message ? err.message : String(err)}`)
      }
    })()
  }

  // 挂载即体检：配置里本来就有的压缩旁路模型，不必等它失败一次才让人知道。
  //
  // bili 的原生通道可能在本插件之后才 apply（判定量是它 apply 时置位的），所以「此刻
  // 不算压缩」时再复查几拍——不把插件装载顺序误报成配置问题，也不无条件延迟。
  const noticeCompressionGaps = () => {
    const guard = describeCompressionGuard()
    if (!guard.enabled) return true
    if (!guard.biliActive) return false
    if (guard.downgradedModels.length === 0) return true
    const gapProviders = [...new Set(guard.downgradedModels.map(m => m.provider))]
    ctx.logger.warn(`[model-failover] billion-context 正在压缩，但配置里有 ${guard.downgradedModels.length} 个模型的端点它认不出、拿不到压缩（${gapProviders.join('/')}）：这些模型只作分组里的兜底候选。`)
    return true
  }
  if (!noticeCompressionGaps()) {
    void (async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 500))
        if (disposed) return
        if (noticeCompressionGaps()) return
      }
    })()
  }

  ctx.logger.info('[model-failover-manager v32] mounted (agent.model.select routing + microtask auto continuation + compression guard + qoder compress shim)')

  /* ==================== 清理 ==================== */
  ctx.effect(() => () => {
    disposed = true
    disposeCreated()
    disposeStatus()
    disposeApiStatus()
    disposeSessionEvent()
    disposeError()
    disposeStop()
    if (qoderShimHandle) qoderShimHandle.stop()
    if (routeDisposer) routeDisposer()
  }, 'model-failover-manager: unmount')
}
