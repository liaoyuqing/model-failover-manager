/**
 * model-failover-manager — Host 端插件。（分组路由 + 故障兜底 + 并发闸门 + 数据看板）
 *
 * 宿主半只有一个文件 host.mjs；版本号记在 HOST_VERSION 常量与 cordis.patch.yml 的
 * 注释里，不再靠文件名区分。
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
import { pathToFileURL } from 'node:url'
// 明文进 bili、密文出上游的 shim（见 qoder-compress-shim.mjs 顶部）。
// 用带构建号的动态 import：改 shim 后重载插件即可换上新代码（ESM 按 URL 缓存），
// 而监听端口与 prototype 补丁由 shim 的 globalThis 槽跨重载保持。
const QODER_SHIM_MODULE = './qoder-compress-shim.mjs'
/** shim 构建号：每次改动 qoder-compress-shim.mjs 就把它 +1，否则 ESM 仍用缓存的旧模块。 */
const QODER_SHIM_BUILD = '63'
/** shim 只换得掉这两家的加密端点（QoderEncryptedInfer#prepareInfer 的使用者）。 */
const QODER_SHIM_PROVIDERS = new Set(['qoder', 'qodercn'])

export const name = 'model-failover-manager'
export const inject = ['timer']

const DATA_DIR_DEFAULT = 'model-failover-manager'
const API_PATH = '/api/model-failover'

/**
 * 当前宿主文件名，取自 import.meta.url。
 *
 * 早期为了绕开 ESM 模块按路径缓存（同文件名改内容会命中旧模块）而反复升版本号
 * 文件名；本 profile 没有装 hmr 插件，插件只在启动时导入一次，重启必然重新
 * import，那个顾虑不成立。宿主半现在固定叫 host.mjs。/status 仍回传实际加载的
 * 文件名，排障时一眼就能确认新代码到底生效没有。
 */
const PLUGIN_FILE = (() => {
  try { return new URL(import.meta.url).pathname.split('/').pop() ?? null } catch { return null }
})()
/**
 * 代码版本，仅用于日志与 `/status` 对账，不参与任何逻辑。
 *
 * 改功能时手工改这一行：没换文件名以后，「跑的是哪版」只能靠它回答。
 */
const HOST_VERSION = 'v86'
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
/**
 * 免费渠道推荐：装上就能多几条免费模型的三个插件。
 *
 * 这里只放不随文案漂移的事实（包名、安装 spec、代表它的 provider 正则）。介绍文案与
 * GitHub 地址在 client.js 的 FREE_CHANNEL_COPY（加渠道要两边一起改）；provider 是否在线
 * 由 llm 注册表现场查询，「装没装」由 pluginManager.listBundles() 现场查询——这两件都不写死。
 */
const FREE_CHANNELS = [
  { id: 'codearts', pkg: 'dsh-codearts', spec: 'dsh-codearts', providers: /^codearts/i },
  { id: 'workbuddy', pkg: 'dsh-connect-workbuddy', spec: 'dsh-connect-workbuddy', providers: /^workbuddy/i },
  {
    id: 'our-free-model',
    pkg: 'dsh-our-free-model',
    spec: 'github:Ebony-Vinyl/dsh-our-free-model',
    // Our Free Model 按渠道各注册一个 provider（qoder、trae、cline…），没有统一前缀，
    // 所以逐个点名；新增渠道时这里要一起加，否则界面只显示一部分已接入渠道。
    providers: /^(qoder|qodercn|trae|cline|lobster|loomy|raccoon|minimax|zcode|gemini|eac|our-free)/i,
  },
]

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

  // 默认并发上限：模型没有单独配置并发时用它；0 = 不限。
  // 默认不限是刻意的——绝大多数 provider 自己会排队，凭据池也有自己的上限；
  // 强制给个数字反而会让用户在不知情的情况下被限速。
  // 单个模型的覆盖存在 $DSH_HOME/model-failover-manager/model-concurrency.json。
  //
  // config 里的是**出厂值**：界面上的「默认并发」存在 settings.json 的
  // defaultConcurrency 键，用户改过就以界面为准（见下面 settings 加载处）；
  // 界面里留空 = 清掉那条覆盖，回落到这里的 config 值。
  const configDefaultConcurrencyRaw = config.defaultConcurrency
  const configDefaultConcurrency = Number.isInteger(configDefaultConcurrencyRaw) && configDefaultConcurrencyRaw >= 0 ? configDefaultConcurrencyRaw : 0
  if (configDefaultConcurrencyRaw !== undefined && configDefaultConcurrency !== configDefaultConcurrencyRaw) {
    ctx.logger.warn(`[model-failover] config.defaultConcurrency=${JSON.stringify(configDefaultConcurrencyRaw)} 非法（需 >=0 的整数，0 为不限），回退 0`)
  }
  /** 生效的默认并发上限：随 settings.defaultConcurrency 变化，未覆盖时等于 config 的出厂值 */
  let defaultConcurrency = configDefaultConcurrency

  // 「整组模型都满」时等槽位释放的上限。
  //
  // 模型自己的槽满了并不会等：闸门立刻把这次调用判成 CAPACITY_TIMEOUT，让失败路径按
  // 「临时换组内其它模型」接手（见 acquireSlot）。只有路由把整组都挑了一遍、连兜底候选
  // 都满时，才退化成等槽位——那一刻没有可换的目标，等待是唯一能推进的动作。
  // 0 = 无限等（只用于确认上游一定会放行的部署）。
  //
  // 为什么必须有上限：闸门挂在 llm/stream，那里改不了 provider/model（selection 在
  // pre-step 已冻结），所以它能做的只有「报错让路由接手」和「等」。无限等会让用户看到
  // 界面卡住却没有任何切换，正是这个插件要消除的体验。
  const concurrencyQueueTimeoutRaw = config.concurrencyQueueTimeoutMs
  const concurrencyQueueTimeoutMs = Number.isInteger(concurrencyQueueTimeoutRaw) && concurrencyQueueTimeoutRaw >= 0
    ? concurrencyQueueTimeoutRaw
    : 180_000
  if (concurrencyQueueTimeoutRaw !== undefined && concurrencyQueueTimeoutMs !== concurrencyQueueTimeoutRaw) {
    ctx.logger.warn(`[model-failover] config.concurrencyQueueTimeoutMs=${JSON.stringify(concurrencyQueueTimeoutRaw)} 非法（需 >=0 的整数，0 为不限），回退 180000`)
  }

  // 并发临时切换的回切保护：换到别的模型后，至少待这么久才允许因为「原模型空闲了」切回去。
  // 没有这个下限时，两个模型交替占满会让会话每轮都来回切一次。0 = 当轮即可回切。
  const capacitySwitchRevertRaw = config.capacitySwitchRevertMs
  const capacitySwitchRevertMs = Number.isInteger(capacitySwitchRevertRaw) && capacitySwitchRevertRaw >= 0
    ? capacitySwitchRevertRaw
    : 30_000
  if (capacitySwitchRevertRaw !== undefined && capacitySwitchRevertMs !== capacitySwitchRevertRaw) {
    ctx.logger.warn(`[model-failover] config.capacitySwitchRevertMs=${JSON.stringify(capacitySwitchRevertRaw)} 非法（需 >=0 的整数），回退 30000`)
  }

  /** 「当日」键：以 failResetHour 为日界线、按北京时间取日期 */
  const todayKey = () => failDayKey(failResetHour)

  const groupsFile = join(dataDir, 'groups.json')
  const failedFile = join(dataDir, 'failed.json')
  const settingsFile = join(dataDir, 'settings.json')
  const bindingsFile = join(dataDir, 'session-bindings.json')
  const modelConcurrencyFile = join(dataDir, 'model-concurrency.json')

  /**
   * 按模型的并发上限覆盖：`"provider/model" -> 正整数`。
   *
   * 并发是模型的属性，不是「某个分组里的一句话」：同一个模型出现在多个分组
   * （甚至多个会话绑不同分组）时，它连的是同一个上游账号池，上限必须统一。
   * 所以这张表独立于 groups 持久化，路由条目不参与它的判定。
   *
   * 没有键 = 跟随 `config.defaultConcurrency`（默认 0，不限）。
   */
  let modelConcurrency = new Map()

  function modelConcKey(provider, model) { return `${provider}/${model}` }

  try {
    const saved = readJson(modelConcurrencyFile, {})
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [k, v] of Object.entries(saved)) {
        if (typeof v === 'number' && Number.isInteger(v) && v > 0) modelConcurrency.set(k, v)
      }
    }
  } catch (e) { ctx.logger.warn(`[model-failover] 读取按模型并发配置失败：${e?.message || e}`) }

  function saveModelConcurrency() {
    writeJson(modelConcurrencyFile, Object.fromEntries(modelConcurrency))
  }

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

  // 迁移：分组条目上的 concurrency 搬到按模型的全局表。
  // 旧版本把并发存在分组条目上，同一模型出现在多个分组时口径会漂移；
  // 新版本以模型为准。已有配置原样保留，只在全局表还没有该模型时才写入。
  ;(() => {
    let groupsChanged = false
    let concChanged = false
    for (const g of groups) {
      for (const m of g.models || []) {
        if (!('concurrency' in m)) continue
        const n = Number(m.concurrency)
        const key = modelConcKey(m.provider, m.model)
        if (Number.isInteger(n) && n > 0 && !modelConcurrency.has(key)) {
          modelConcurrency.set(key, n)
          concChanged = true
        }
        delete m.concurrency
        groupsChanged = true
      }
    }
    if (concChanged) saveModelConcurrency()
    if (groupsChanged) writeJson(groupsFile, groups)
  })()
  /** @type {{ key: string; day: string; count: number; provider: string; model: string }[]} */
  let failedList = readJson(failedFile, [])
  // dialogMode：模型选择用左右分区弹窗（true）还是紧凑下拉（false）。
  // 出厂为 true：模型多的时候只有弹窗装得下提供商分栏与「路由分组 / 数据看板 /
  // 失败模型」页签，下拉一屏只够列十几个模型。用户在设置里关掉后写进
  // settings.json，此后以存下的值为准，不再回落到这里的出厂值。
  //
  // metricsSort：数据看板上次使用的排序（{ key, dir } 或 null = 默认序）。
  // 存在 settings.json 里而不是浏览器 localStorage：同一台宿主的多个浏览器
  // 与刷新后的页面都看到同一份排序，换机器也不会各记一套。
  let settings = Object.assign({ dialogMode: true, metricsSort: null, defaultConcurrency: null }, readJson(settingsFile, {}))

  /**
   * 看板排序列的合法键。与 client.js 的 metricsSortValue 一一对应；
   * 加列时两边一起改，否则旧值会因为「认不出」被静默丢掉。
   */
  const METRICS_SORT_KEYS = new Set(['model', 'rate', 'ttft', 'tps', 'tokens', 'conc', 'status'])

  /**
   * 校验并规整一个看板排序值。
   *
   * 落盘的是用户上次点表头的结果，坏值不该让插件起不来：认不出的键或方向一律
   * 当成「没有排序」（null），页面回到默认序，用户再点一次就好。
   *
   * @param {unknown} raw - settings.json 或请求体里的原始值。
   * @returns {{key: string, dir: 'asc'|'desc'}|null} 规整后的排序，或 null。
   */
  function normalizeMetricsSort(raw) {
    if (raw === null || raw === undefined) return null
    if (typeof raw !== 'object' || Array.isArray(raw)) return null
    const key = typeof raw.key === 'string' ? raw.key : ''
    if (!METRICS_SORT_KEYS.has(key)) return null
    return { key, dir: raw.dir === 'desc' ? 'desc' : 'asc' }
  }

  settings.metricsSort = normalizeMetricsSort(settings.metricsSort)

  /**
   * 界面上的「默认并发」：settings.defaultConcurrency 是**用户覆盖值**，
   * null 表示没覆盖过、跟随 config 的出厂值。0 是合法值（不限），所以不能用
   * truthy 判断区分「没设」和「设成不限」。
   *
   * 坏值不该让插件起不来：认不出就当成没覆盖，记一条告警并清掉。
   */
  if (Number.isInteger(settings.defaultConcurrency) && settings.defaultConcurrency >= 0) {
    defaultConcurrency = settings.defaultConcurrency
  } else if (settings.defaultConcurrency !== null) {
    ctx.logger.warn(`[model-failover] settings.defaultConcurrency=${JSON.stringify(settings.defaultConcurrency)} 非法（需 >=0 的整数或 null），按未覆盖处理，跟随 config 的 ${configDefaultConcurrency}`)
    settings.defaultConcurrency = null
  }
  let disposed = false
  // 压缩 shim 的句柄：声明在这里，因为「压缩旁路守卫」的路由判断要读它（见 qoderShimCovers）
  let qoderShimHandle = null
  /** 一次性诊断：shim 装载时 llm 注册表长什么样 */
  let shimRegistryProbe = null
  /** shim 启动异常（详情进 /status，方便不翻日志） */
  let shimStartError = null

  /* ==================== 并发闸门与速度采样 ==================== */
  //
  // 两个诉求合成一套数据：① 路由里的模型要能配并发数（`concurrency` 字段）；
  // ② 数据看板要能看首字延迟和 token 输出速度。
  //
  // 并发闸门挂在 `llm/stream`（waterfall，宿主每次模型调用都会经过）：
  // 进流前占一个槽，流出完/出错释放。占不到槽时**立刻**把这次调用判成 CAPACITY_TIMEOUT，
  // 交给失败路径临时换到组内其它模型：闸门自己改不了 provider/model（selection 在
  // pre-step 已冻结），报错是它唯一能推动切换的动作。
  //
  // 速度采样同样在 `llm/stream` 里做，但只用流上的时间戳与事件算：
  //  · 首字延迟（TTFT）= 第一个 text/reasoning/tool-call delta 到达的时刻 - 请求发出时刻
  //  · 输出速度 = 输出 token 数 /（流结束 - 首字），单位 token/s
  // 这里只做**可观测量**的统计，不解析模型内容，也不写会话日志（模型不可见）。

  /** provider/model -> 正在占用中的并发数 */
  const inflightByModel = new Map()
  /** 等槽位释放的订阅者（只有「整组都满」那条路会用到），按 provider/model 分组保证 FIFO */
  const waitingByModel = new Map()

  /**
   * 该模型生效的并发上限。
   *
   * 以 `modelConcurrency` 里按模型记的覆盖为准（见该表的注释：并发是模型属性，
   * 不随分组变化），没有覆盖时回退 `config.defaultConcurrency`（默认 0 = 不限）。
   *
   * @param {string} provider - provider id。
   * @param {string} model - model id。
   * @returns {number} 上限；0 表示不限。
   */
  function concurrencyLimitOf(provider, model) {
    return modelConcurrency.get(modelConcKey(provider, model)) ?? defaultConcurrency
  }

  /**
   * 实时速度的字符→token 换算：1 token ≈ 4 字符。
   *
   * 实时读数拿不到真实 token 数——适配器把 `usage` 放在流的末尾，看到它的时候
   * 请求已经结束了。所以只有在跑的这段时间里按字符估；请求一结束，看板就改用
   * 流末尾那份精确 usage 算出来的历史值。估到一位小数已经够用，这个数本来
   * 就是给人看「这条链路现在跑得多快」，不参与任何计费。
   */
  const CHARS_PER_TOKEN = 4

  /** 排队等槽位超时后交给路由的失败码；不在宿主的默认可重试码表里，因此不会原地重试 */
  const CAPACITY_TIMEOUT_CODE = 'CAPACITY_TIMEOUT'

  /**
   * 占用一个并发槽；满了**立刻**失败，不排队。
   *
   * 为什么不在闸门里等：闸门挂在 `llm/stream`，那里改不了 provider/model（selection 在
   * pre-step 已冻结），闸门唯一能推动切换的动作就是把这次调用判成失败，让宿主走
   * agent/request-error → 本插件的分组路由接手。旁边往往就有空闲模型，让用户盯着一个
   * 不动的会话等槽位，正是这个插件要消除的体验。
   *
   * 「整组模型都满、路由无处可换」不在这里等，由 routeAfterModelFailure 用
   * `awaitSlotFree` 接手——只有那里才知道「一个可换的目标都没有」。
   *
   * 无论 `limit` 是多少都会计数 `inflightByModel`：`limit` 只决定满了之后放行还是判失败，
   * 不决定要不要统计。看板要给「没配上限」的模型显示当前并发数，靠的就是这条计数。
   *
   * @param {string} key - `provider/model`。
   * @param {number} limit - 上限，0 = 不限（永远占得到，但仍占槽计数）。
   * @returns {() => void} 释放函数；重复调用安全。
   * @throws 槽位已满时抛 `{ code: CAPACITY_TIMEOUT_CODE }`。
   */
  function acquireSlot(key, limit) {
    /**
     * 占一个槽位，返回释放函数。
     *
     * 占与释放是配对的，所以两条路径（有上限、无上限）共用这里：上限只决定
     * 「满了怎么办」（判失败还是直接放行），不决定「要不要计数」。
     *
     * @returns {() => void} 释放函数；重复调用安全。
     */
    const takeSlot = () => {
      inflightByModel.set(key, (inflightByModel.get(key) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const now = (inflightByModel.get(key) ?? 1) - 1
        if (now <= 0) inflightByModel.delete(key)
        else inflightByModel.set(key, now)
        // 唤醒一个等槽位的人（只有「整组都满」那条路会挂在这里）。唤醒只告诉他
        // 「有人释放了」，槽位可能立刻被别的请求抢走，所以他要自己再看一次。
        const waiters = waitingByModel.get(key)
        if (waiters !== undefined && waiters.length > 0) {
          const next = waiters.shift()
          if (waiters.length === 0) waitingByModel.delete(key)
          next()
        }
      }
    }
    // 不限上限（limit=0）：照常计数，也不占槽就放行。计数与上限是两件事——
    // 看板的「当前并发」问的是「此刻几个请求正在跑」，没配上限的模型一样在跑，
    // 提前返回空释放会让这些行永远显示 0（用户以为链路没在用）。
    if (limit <= 0) return takeSlot()
    const inflight = inflightByModel.get(key) ?? 0
    if (inflight < limit) return takeSlot()
    // 满了：不占槽、不入队，直接把这次调用判成失败，让分组路由换组内其它模型。
    const err = new Error(`${key} 的并发已满（${inflight}/${limit}），立刻换组内其它模型`)
    err.code = CAPACITY_TIMEOUT_CODE
    throw err
  }

  /**
   * 该模型此刻有没有空槽位（不排队就占得到）。
   *
   * 「并发冷却中」也算没有：冷却记录说的是「它刚刚满了」，路由不该把一个刚报满的模型
   * 当空闲模型用。
   *
   * @param {string} provider - provider id。
   * @param {string} model - model id。
   * @returns {boolean} 现在就能占到槽位则为 true。
   */
  function hasFreeSlot(provider, model) {
    if (capacityCooldownOf(provider, model) !== null) return false
    const limit = concurrencyLimitOf(provider, model)
    if (limit <= 0) return true
    return (inflightByModel.get(failKey(provider, model)) ?? 0) < limit
  }

  /**
   * 等某个模型的槽位释放——只用在「整组模型都满、无处可换」这一条路上。
   *
   * 模型自己的槽满了不会在这里等（闸门立刻失败，交给路由换模型）；只有路由把整组都挑
   * 了一遍、连兜底候选都满时，等待才是唯一能推进的动作——不等就只剩把这一轮判失败。
   *
   * @param {string} key - `provider/model`。
   * @param {number} limit - 该模型的上限；0 = 不限（永远有空位）。
   * @param {number} timeoutMs - 最多等多久；0 = 无限等。
   * @returns {Promise<boolean>} true = 现在就有空位或等到了；false = 超时。
   */
  async function awaitSlotFree(key, limit, timeoutMs) {
    if (limit <= 0) return true
    if ((inflightByModel.get(key) ?? 0) < limit) return true
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null
    for (;;) {
      const remaining = deadline === null ? null : deadline - Date.now()
      if (remaining !== null && remaining <= 0) return false
      const woken = await new Promise((resolve) => {
        const waiters = waitingByModel.get(key) ?? []
        // settle 保证「唤醒 / 超时」只有第一个生效，且都把自己从队列摘掉。
        let settled = false
        let timer = null
        const detach = () => {
          const rest = (waitingByModel.get(key) ?? []).filter(w => w !== wake)
          if (rest.length === 0) waitingByModel.delete(key)
          else waitingByModel.set(key, rest)
        }
        const finish = (value) => {
          if (settled) return
          settled = true
          detach()
          if (timer !== null) clearTimeout(timer)
          resolve(value)
        }
        const wake = () => finish(true)
        waiters.push(wake)
        waitingByModel.set(key, waiters)
        if (remaining !== null) timer = setTimeout(() => finish(false), remaining)
      })
      if (!woken) return false
      // 唤醒只说明有人释放了，槽位可能已被同组别的请求抢走，所以要重新看一次。
      if ((inflightByModel.get(key) ?? 0) < limit) return true
    }
  }

  /* ---- 并发冷却：临时把某个模型挡在路由之外，到期自动恢复 ---- */
  //
  // 与 failedList（当日失败）刻意分开：并发打满是**暂时的**，账号池几十秒后就放行，
  // 写进当日失败会让这个模型一整天不参与路由。这里只记一个到期时刻：
  //  · routable() 期间不选它（等价于「临时换到组内其它模型」）；
  //  · 到期后它自动回到候选，无需用户点「恢复」。
  // 每条记录还带上「因为什么」与「谁把它换走的」，看板与失败页可直接展示。
  /** modelKey -> { until: number, at: number, reason: string } */
  const capacityCooldowns = new Map()

  /** 并发冷却时长：默认 30s，够覆盖一次账号池放行；`config.capacityCooldownMs` 可调。 */
  const capacityCooldownMsRaw = config.capacityCooldownMs
  const capacityCooldownMs = Number.isInteger(capacityCooldownMsRaw) && capacityCooldownMsRaw >= 0
    ? capacityCooldownMsRaw
    : 30_000
  if (capacityCooldownMsRaw !== undefined && capacityCooldownMs !== capacityCooldownMsRaw) {
    ctx.logger.warn(`[model-failover] config.capacityCooldownMs=${JSON.stringify(capacityCooldownMsRaw)} 非法（需 >=0 的整数），回退 30000`)
  }

  /**
   * 该模型此刻是否因并发被临时挡在路由之外。
   * @param {string} provider - provider id。
   * @param {string} model - model id。
   * @returns {{until: number, at: number, reason: string}|null} 冷却记录；未冷却为 null。
   */
  function capacityCooldownOf(provider, model) {
    if (capacityCooldownMs <= 0) return null
    const entry = capacityCooldowns.get(failKey(provider, model))
    if (!entry) return null
    if (Date.now() >= entry.until) { capacityCooldowns.delete(failKey(provider, model)); return null }
    return entry
  }

  /**
   * 记一次并发冷却：该模型从现在起 `capacityCooldownMs` 内不参与路由挑选。
   *
   * @param {string} provider - provider id。
   * @param {string} model - model id。
   * @param {string} reason - 人类可读原因（账号池 capped / 排队超时 …）。
   * @returns {void}
   */
  function markCapacity(provider, model, reason) {
    if (capacityCooldownMs <= 0) return
    const now = Date.now()
    capacityCooldowns.set(failKey(provider, model), {
      until: now + capacityCooldownMs,
      at: now,
      reason: String(reason).slice(0, 200),
    })
  }

  /**
   * 这个失败是不是「并发/容量」类，而不是模型真的坏了。
   *
   * 两类都算：闸门自己的排队超时，以及 codearts 账号池全部打满时那句 429 soft_rate
   * （「当前没有可用账号」其实是并发满，账号本身没坏）。
   *
   * @param {{code?: string, status?: number, message?: string}|undefined} failure - 宿主给出的失败事实。
   * @returns {boolean} 命中则为 true。
   */
  function isCapacityFailure(failure) {
    if (!failure) return false
    if (String(failure.code ?? '') === CAPACITY_TIMEOUT_CODE) return true
    const message = String(failure.message ?? '')
    if (/当前没有可用账号/.test(message)) return true
    return false
  }

  /**
   * 上游用来表达「这条请求本身有问题」的机器码。
   *
   * 各家名字不一样：宿主会给出 CONTEXT_WINDOW_EXCEEDED / INVALID_ARGS，而上游可能
   * 直接把自己的码透传上来（例如 loomy 的 INVALID_REQUEST 配 400 与「内容太长了，
   * 请精简输入或开启新对话」）。它们指向同一件事，处置也必须是同一件：换模型——
   * 而不是换账号重试（同一个上限），也不是把模型停用一整天（换个请求它还能用）。
   */
  const REQUEST_REJECTED_CODES = new Set([
    'CONTEXT_WINDOW_EXCEEDED',
    'INVALID_ARGS',
    'INVALID_REQUEST',
    'CONTEXT_LENGTH_EXCEEDED',
    'MAX_TOKENS_EXCEEDED',
    'CONTENT_TOO_LONG',
  ])

  /**
   * 这个失败是不是「这条请求本身有问题」，换账号/原地重试都不会改变结果。
   *
   * 典型是上游按参数拒绝：输入超过模型上下文上限、请求体不合法、模型不支持该模态。
   * 这类失败的唯一有效处置是**换一个模型**（更大的上下文窗口、支持该模态的模型），
   * 所以本插件必须把它交给分组路由，并且跳过「换账号重试」——同一个模型换个账号，
   * 上限还是那个上限，重试只会白等。
   *
   * 判据取机器码与上游文案两条，任一命中即算：
   *  · 宿主规范化码与上游参数类码：见 REQUEST_REJECTED_CODES；
   *  · 上游文案：context/length 超限、prompt is too long、input too long、
   *    中文的「超过模型上限」与「内容太长了，请精简输入或开启新对话」，
   *    以及 adapter 把 400 归成 `client` 时附带的那句「按参数拒绝」。
   *
   * 判据要收在「这条请求超限/不合法」上：普通 400（请求体写坏、上游网关拒绝）
   * 仍按当日失败处理，否则一个真坏掉的模型会被无限换着重试。
   *
   * @param {{code?: string, status?: number, message?: string}|undefined} failure - 宿主给出的失败事实。
   * @returns {boolean} 命中则为 true。
   */
  function isRequestRejectedFailure(failure) {
    if (!failure) return false
    const code = String(failure.code ?? '').toUpperCase()
    if (REQUEST_REJECTED_CODES.has(code)) return true
    const message = String(failure.message ?? '')
    if (/prompt is too long|input (?:is )?too long|context[ _-](?:length|window)/i.test(message)) return true
    if (/maximum context length|exceed(?:s|ed|ing)? .{0,20}(?:context|token)/i.test(message)) return true
    // 「本次输入加上历史对话超过了模型上限」这类只有中文的上游文案
    if (/超过(?:了)?模型(?:的)?上限|输入.{0,6}超.{0,4}上限/.test(message)) return true
    // 上游把上下文超限说成「内容太长了」：换号与原地重试都无效，只能换窗口更大的模型
    if (/内容太[长多]|对话.{0,8}太[长多]|请精简(?:输入|上下文)|开启新对话/.test(message)) return true
    // 被上游按参数拒绝：与网络/账号/额度无关，换号无效
    if (/被上游按参数拒绝|该请求被上游(?:按参数)?拒绝/.test(message)) return true
    return false
  }

  /* ---- 临时换模型：谁被换走过、从哪个模型换走 ---- */
  //
  // sessionId -> { provider, model, at }：记录会话**原先用的**模型。并发恢复后由
  // rerouteForNewTurn 按 capacitySwitchRevertMs 的保护期切回去，让「临时切换」真的
  // 是临时的，而不是换走就再也回不来。
  const capacitySwitches = new Map()

  /**
   * 本轮里因「请求被拒」被跳过的模型：sessionId -> Set<`provider/model`>。
   *
   * 请求被拒（输入超限/参数不合法）不属于模型坏掉，所以**不写当日失败**；但没有这份
   * 名单，下一条续跑会按优先级又选回同一个模型，再烧一次上游请求——用户看到的就是
   * 「报错了，又回到同一个模型，再报同样的错」。切到新模型的那一轮会清空。
   *
   * 只在内存里：它描述的是「这一轮试过谁」，重启后重新开始筛选是正确行为。
   */
  const rejectedBySession = new Map()


  /**
   * 速度采样缓冲：provider/model -> 启动以来的全部调用样本（按时间先后）。
   *
   * **不设条数上限**。上限会让「最近 200 条」悄悄变成统计口径：窗口筛得早一点、
   * 或者模型一天跑上万次，看板上的成功率和 token 合计就只是最后一段的和，而不是
   * 所选区间的和。单条样本几十字节，按条数砍掉的是用户要看的历史。
   */
  const speedSamples = new Map()

  /**
   * 采样落盘文件。缓冲区是内存态的，重启即清空；看板要跨重启保留，
   * 所以每次记样本后整体覆写一份到 dataDir（不写增量日志，也就不会留下半截文件）。
   */
  const metricsFile = join(dataDir, 'metrics.json')

  /**
   * 正在跑的请求：`provider/model` -> 这批请求的实时读数。
   *
   * 为什么不像 speedSamples 那样等流结束再记：多并发总速度问的是「此刻这个模型
   * 一共在吐多少 token/s」，只有在跑的时候才有意义。等结束再算，看板上的数就变成
   * 上一批请求的墓碑——进行中的个数已经是 0，速度却还挂在那儿。
   *
   * 每个值都是可变对象：流每吐一个 delta 就有人原地改它，读接口只做求和。
   * 不进 metrics.json——重启后没有任何流在跑，这份表本来就该是空的。
   */
  const liveRequests = new Map()

  /**
   * 一次调用的实时读数。`text` 记这次调用吐出的字符数（含 reasoning 与工具参数
   * 增量），两个时间戳决定它属于哪个采样区间。
   */
  const liveOf = (key) => {
    let list = liveRequests.get(key)
    if (list === undefined) { list = []; liveRequests.set(key, list) }
    return list
  }

  /** 落盘防抖：一次会话里连续几十次调用不必每次同步写盘 */
  let metricsFlushTimer = null
  const METRICS_FLUSH_DELAY_MS = 1500

  function flushMetrics() {
    if (metricsFlushTimer !== null) { clearTimeout(metricsFlushTimer); metricsFlushTimer = null }
    try {
      /** @type {Record<string, any[]>} */
      const out = {}
      for (const [key, list] of speedSamples) out[key] = list
      // 样本不设上限，这份文件会一直长；不缩进，省掉每行两个空格
      writeFileSync(metricsFile, JSON.stringify(out), 'utf8')
    } catch { /* 采样落盘失败只影响看板历史，绝不影响主流程 */ }
  }

  function scheduleMetricsFlush() {
    if (metricsFlushTimer !== null) return
    metricsFlushTimer = setTimeout(flushMetrics, METRICS_FLUSH_DELAY_MS)
    // 别让一次挂起的落盘把进程钉住
    if (typeof metricsFlushTimer?.unref === 'function') metricsFlushTimer.unref()
  }

  // 启动时读回历史样本；样本字段随版本增补（如 inTokens），
  // 老样本缺字段时按 null 处理——不拿 0 冒充，否则看板会把「没记」显示成「用了 0」。
  try {
    const saved = readJson(metricsFile, null)
    if (saved && typeof saved === 'object') {
      for (const [key, list] of Object.entries(saved)) {
        if (!Array.isArray(list)) continue
        const clean = list.filter(s => s && typeof s.at === 'number')
        if (clean.length > 0) speedSamples.set(key, clean)
      }
    }
  } catch { /* 损坏的采样文件当作没有历史，不让插件起不来 */ }

  /**
   * 从失败事实里取出能给人看的文案。
   *
   * 上游的 `failure.message` 未必是字符串：宿主把非 Error 的抛出值归一化成
   * `HarnessError(String(value), 'UNKNOWN')`，于是 message 可能就是字符串
   * `"[object Object]"`。把它原样显示在看板上等于什么都没说，所以只接受
   * 真正的文本；非字符串的 message 一律当成没有文案，只留错误码。
   *
   * @param {{message?: unknown}|undefined} failure - 宿主给出的失败事实。
   * @returns {string|null} 可读文案（截断到 400 字），没有则 null。
   */
  function failureTextOf(failure) {
    const message = failure?.message
    if (typeof message !== 'string') return null
    const text = message.trim()
    if (text === '' || text === '[object Object]') return null
    return text.slice(0, 400)
  }

  /**
   * 记一条速度样本。
   *
   * 只追加、不裁剪：样本是看板统计的原始数据，条数上限会把「所选区间」偷换成
   * 「最近 N 条」。内存占用按调用次数线性增长，单条几十字节，正常量级可忽略。
   *
   * @param {string} key - `provider/model`。
   * @param {{ttftMs: number|null, inTokens: number|null, outTokens: number|null, cacheReadTokens: number|null, cacheWriteTokens: number|null, speedTps: number|null, waitMs: number, ok: boolean, errorCode: string|null, errorMessage: string|null, at: number}} sample - 一次调用的观测值。
   * @returns {void}
   */
  function recordSpeedSample(key, sample) {
    const list = speedSamples.get(key) ?? []
    list.push(sample)
    speedSamples.set(key, list)
    scheduleMetricsFlush()
  }

  /**
   * 汇总某模型的看板数据：成功率、首字延迟、输出速度、排队等待的分位数，以及 token 用量。
   * @param {string} key - `provider/model`。
   * @param {{since?: number, until?: number}} [window] - 采样时间窗（毫秒时间戳，两端包含）；
   *   省略则统计全部样本。日期筛选由这里做，而不是交给界面：分位数与合计都要按
   *   「所选区间」算。缓冲区不设条数上限，所以这里的统计就是全量历史。
   * @returns {{samples: number, okSamples: number, ttftP50: number|null, ttftP90: number|null, tpsP50: number|null, tpsP90: number|null, waitP50: number|null, inTokens: number, outTokens: number, cacheReadTokens: number, cacheWriteTokens: number, tokenSamples: number, lifetimeInTokens: number, lifetimeOutTokens: number, lifetimeCacheReadTokens: number, lifetimeCacheWriteTokens: number, lifetimeTokenSamples: number, lastAt: number|null, lastErrorCode: string|null}} 汇总值。
   */
  function speedStatsOf(key, window) {
    const all = speedSamples.get(key) ?? []
    const list = window === undefined
      ? all
      : all.filter(s => (window.since === undefined || s.at >= window.since)
        && (window.until === undefined || s.at <= window.until))
    const numbers = (pick) => list.map(pick).filter(v => typeof v === 'number')
    const ttfts = numbers(s => s.ttftMs)
    const tpss = numbers(s => s.speedTps)
    const waits = numbers(s => s.waitMs)
    // token 用量按区间求和：适配器没报 usage 的调用不计入（老样本也没有该字段），
    // 所以另外给出「有多少条样本带 token 数」，界面据此说明覆盖范围。
    const inTok = numbers(s => s.inTokens)
    const outTok = numbers(s => s.outTokens)
    const cacheRead = numbers(s => s.cacheReadTokens)
    const cacheWrite = numbers(s => s.cacheWriteTokens)
    // tokenSamples 计入任一 token 字段，避免「只报了缓存命中」的调用被算作没用量
    const tokenSamples = list.filter(s =>
      typeof s.inTokens === 'number' || typeof s.outTokens === 'number'
        || typeof s.cacheReadTokens === 'number' || typeof s.cacheWriteTokens === 'number').length
    // 历史（全量）token 用量：不随日期筛选变化。看板上它是大字主值——用户要的是
    // 「这个模型一共用掉多少 token」，区间内用量只作副行参考。分母用全部样本，
    // 所以这里单独再算一遍，不能复用区间内的聚合。
    const lifetimeIn = all.map(s => s.inTokens).filter(v => typeof v === 'number').reduce((a, b) => a + b, 0)
    const lifetimeOut = all.map(s => s.outTokens).filter(v => typeof v === 'number').reduce((a, b) => a + b, 0)
    const lifetimeCacheRead = all.map(s => s.cacheReadTokens).filter(v => typeof v === 'number').reduce((a, b) => a + b, 0)
    const lifetimeCacheWrite = all.map(s => s.cacheWriteTokens).filter(v => typeof v === 'number').reduce((a, b) => a + b, 0)
    const lifetimeTokenSamples = all.filter(s =>
      typeof s.inTokens === 'number' || typeof s.outTokens === 'number'
        || typeof s.cacheReadTokens === 'number' || typeof s.cacheWriteTokens === 'number').length
    const pick = (arr, q) => {
      if (arr.length === 0) return null
      const sorted = [...arr].sort((a, b) => a - b)
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))
      return Math.round(sorted[idx] * 10) / 10
    }
    let lastErrorCode = null
    let lastErrorMessage = null
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].ok !== true && list[i].errorCode) {
        lastErrorCode = list[i].errorCode
        // 文案也跟着最近一次失败走：只有码没有文案时，鼠标放上去也看不到
        // 「上游到底说了什么」。
        lastErrorMessage = typeof list[i].errorMessage === 'string' && list[i].errorMessage !== ''
          ? list[i].errorMessage
          : null
        break
      }
    }
    return {
      samples: list.length,
      okSamples: list.filter(s => s.ok === true).length,
      ttftP50: pick(ttfts, 0.5),
      ttftP90: pick(ttfts, 0.9),
      tpsP50: pick(tpss, 0.5),
      tpsP90: pick(tpss, 0.9),
      waitP50: pick(waits, 0.5),
      inTokens: inTok.reduce((a, b) => a + b, 0),
      outTokens: outTok.reduce((a, b) => a + b, 0),
      // 缓存命中的输入量（billed input 的组成部分），与区间内的 inTokens 并排给出，
      // 界面才能把「实际烧掉的输入」算全，而不是只显示未命中缓存的那部分。
      cacheReadTokens: cacheRead.reduce((a, b) => a + b, 0),
      cacheWriteTokens: cacheWrite.reduce((a, b) => a + b, 0),
      tokenSamples,
      lifetimeInTokens: lifetimeIn,
      lifetimeOutTokens: lifetimeOut,
      lifetimeCacheReadTokens: lifetimeCacheRead,
      lifetimeCacheWriteTokens: lifetimeCacheWrite,
      lifetimeTokenSamples,
      lastAt: list.length === 0 ? null : list[list.length - 1].at,
      lastErrorCode,
      lastErrorMessage,
    }
  }

  /**
   * 包一层 `llm/stream`：并发闸门 + 速度采样。
   *
   * 只在 `next()` 产出的流上做统计；自己**绝不**改写 chunk，也不缓存正文。
   * 唯一的例外是槽位已满：此时**不调用** next()，直接吐一个 `finish(error)`，把这次
   * 调用判成 CAPACITY_TIMEOUT 失败——宿主随后会走 agent/request-error，本插件在那里
   * 按「临时换到组内其它模型」接手。这是 llm/stream 里唯一能推动切换的方式：
   * selection 在 pre-step 已经冻结，闸门自己改不了 provider/model。
   *
   * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options - 本次调用参数。
   * @param {() => AsyncIterable<any>} next - 下游适配器的流。
   * @returns {AsyncIterable<any>} 原样透传的 chunk 流。
   */
  async function* guardedStream(options, next) {
    const provider = String(options?.provider ?? '')
    const model = String(options?.model ?? '')
    const key = `${provider}/${model}`
    const limit = concurrencyLimitOf(provider, model)
    const startedAt = Date.now()
    let release
    try {
      release = acquireSlot(key, limit)
    } catch (err) {
      // 到这里只可能是「槽位已满」：不占槽、不生成，记一次失败样本，再把这次调用判成
      // CAPACITY_TIMEOUT——宿主会走 agent/request-error，本插件在那里换模型。
      if (err?.code !== CAPACITY_TIMEOUT_CODE) throw err
      recordSpeedSample(key, {
        ttftMs: null, inTokens: null, outTokens: null, speedTps: null,
        cacheReadTokens: null, cacheWriteTokens: null,
        waitMs: Date.now() - startedAt, ok: false, errorCode: CAPACITY_TIMEOUT_CODE, errorMessage: null, at: Date.now(),
      })
      yield { type: 'finish', reason: { kind: 'error', failure: { message: err.message, code: CAPACITY_TIMEOUT_CODE } } }
      return
    }
    const waitMs = Date.now() - startedAt
    const generatingStart = Date.now()
    // 实时读数：这条流每吐一个增量就原地更新，看板据此算「多并发总速度」。
    // 与下面结束时的 recordSpeedSample 是两件事——那份是历史样本，这份是此刻。
    const live = { chars: 0, firstByteAt: null }
    liveOf(key).push(live)
    let firstTokenAt = null
    let usageOut = null
    let usageIn = null
    let usageCacheRead = null
    let usageCacheWrite = null
    let failureCode = null
    let failureMessage = null
    let settledOk = false
    try {
      for await (const chunk of next()) {
        if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta' || chunk?.type === 'tool-call-delta') {
          // 第一段增量是「开始出字」的时刻，之后的字符数都从这一刻起算速率
          if (live.firstByteAt === null) live.firstByteAt = Date.now()
          if (chunk.type === 'text-delta') live.chars += chunk.text.length
          else if (chunk.type === 'reasoning-delta') live.chars += chunk.text.length
          else live.chars += typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta.length : 0
          if (firstTokenAt === null) firstTokenAt = Date.now()
        }
        // 一次调用可能吐多条 usage（增量或最后一次汇总），取最后一条为准
        if (chunk?.type === 'usage' && typeof chunk.usage?.outputTokens === 'number') usageOut = chunk.usage.outputTokens
        if (chunk?.type === 'usage' && typeof chunk.usage?.inputTokens === 'number') usageIn = chunk.usage.inputTokens
        // 缓存命中的 token 是**输入**的一部分：DSH 的 usage 把它们拆成
        // cacheReadTokens / cacheWriteTokens 单独报（billed input = 三者之和，
        // 见 packages/llm/llm/src/types.ts 的 TokenUsage 注释）。只看 inputTokens
        // 会把命中缓存的那部分整段丢掉，看板的大字因此低估输入量。
        if (chunk?.type === 'usage' && typeof chunk.usage?.cacheReadTokens === 'number') usageCacheRead = chunk.usage.cacheReadTokens
        if (chunk?.type === 'usage' && typeof chunk.usage?.cacheWriteTokens === 'number') usageCacheWrite = chunk.usage.cacheWriteTokens
        if (chunk?.type === 'finish') {
          const kind = chunk.reason?.kind
          settledOk = kind !== 'error' && kind !== 'aborted'
          if (!settledOk && chunk.reason?.failure?.code) failureCode = String(chunk.reason.failure.code)
          // 完整报错文案：错误码只说「哪一类错」，排查要靠文案（上游说了什么、
          // 请求被哪一环拒了）。截断到 400 字，与当日失败记录同口径。
          if (!settledOk) failureMessage = failureTextOf(chunk.reason?.failure)
        }
        yield chunk
      }
    } finally {
      release()
      // 从在跑清单里摘掉：实时速度问的是「此刻」，这条流已经不在此刻了。
      // 不管正常结束、失败还是取消都摘——否则调用方能一直看到一个不动的数。
      const liveList = liveRequests.get(key)
      if (liveList !== undefined) {
        const idx = liveList.indexOf(live)
        if (idx >= 0) liveList.splice(idx, 1)
        if (liveList.length === 0) liveRequests.delete(key)
      }
      const endedAt = Date.now()
      // 输出 token 只认适配器报的 usage：没有 usage 时宁可在看板上留空，
      // 也不拿字符数估算冒充精确值。
      const ttftMs = firstTokenAt === null ? null : firstTokenAt - generatingStart
      const generatingMs = firstTokenAt === null ? 0 : endedAt - firstTokenAt
      const speedTps = usageOut !== null && generatingMs > 0
        ? Math.round((usageOut / (generatingMs / 1000)) * 10) / 10
        : null
      recordSpeedSample(key, {
        ttftMs,
        inTokens: usageIn,
        outTokens: usageOut,
        cacheReadTokens: usageCacheRead,
        cacheWriteTokens: usageCacheWrite,
        speedTps,
        waitMs,
        ok: settledOk,
        errorCode: settledOk ? null : (failureCode ?? 'STREAM_ABORTED'),
        errorMessage: settledOk ? null : failureMessage,
        at: endedAt,
      })
    }
  }

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
    const reason = failureTextOf(failure)
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
    // 并发已满的候选只在没有任何空闲候选时才用：它不像失败/禁用那样「不可用」，
    // 只是要排队，所以留作兜底而不是直接排除（否则全组都满时会误报无可用模型）。
    let busyFallback = null
    for (const m of models) {
      if (!routable(m)) continue
      const key = `${m.provider}/${m.model}`
      // 并发冷却期内的模型直接跳过：它刚刚打满过，换到组内其它模型正是用户要的
      // 「触发到并发时临时切换」。冷却到期后自动回到候选，不需要人工恢复。
      if (capacityCooldownOf(m.provider, m.model) !== null) {
        if (busyFallback === null) busyFallback = candidateOf(m)
        continue
      }
      const limit = concurrencyLimitOf(m.provider, m.model)
      if (limit > 0 && (inflightByModel.get(key) ?? 0) >= limit) {
        if (busyFallback === null) busyFallback = candidateOf(m)
        continue
      }
      if (!compressionGapOf(m.provider)) return candidateOf(m)
      if (!fallback) fallback = candidateOf(m)
    }
    return fallback ?? busyFallback
  }

  /**
   * 一个模型当前活跃请求的合计速度（token/s）。
   *
   * 口径是「活跃并发区间内的合计」：把此刻还在跑、并且已经吐出过增量的请求放进
   * **同一段**时间里看——区间起点取它们中间最早吐首字的那一刻，终点是读取时刻。
   * 区间内的总输出字符 ÷ 区间时长，就是这个模型这段时间的合计速度。
   *
   * 为什么不是「各请求自己的速率相加」：同一次并发的几个请求起始时刻不同，各自
   * 除以自己的时长会把刚起步的请求算得虚高、把跑了很久的请求算成它的历史平均，
   * 加起来的数既不是此刻的吞吐，也不随并发口径可比。用同一个区间作分母，读数是
   * 「这段时间这台模型一共产出多快」：几个请求一起跑时自然大于单个请求，也随
   * 请求结束自然回落。
   *
   * 只算已经产出过增量的请求：还在等首字的请求既不贡献字符，也不该把区间起点
   * 拉前——否则它的等待时长会把整段读数稀释掉。
   *
   * 字符到 token 的换算按 1 token ≈ CHARS_PER_TOKEN 个字符估——实时读数拿不到
   * 真实 token 数（usage 在流末尾才到），宁可用一个公开的粗估，也不把字符数
   * 当成 token 数报出去。
   *
   * @param {string} key - `provider/model`。
   * @param {number} now - 读取时刻（毫秒）。
   * @returns {number|null} 总速度（tok/s，保留一位小数）；没有在跑的请求时为 null。
   */
  function liveSpeedOf(key, now) {
    const list = liveRequests.get(key)
    if (list === undefined || list.length === 0) return null
    let chars = 0
    let from = null
    for (const live of list) {
      if (live.chars <= 0 || live.firstByteAt === null) continue
      chars += live.chars
      if (from === null || live.firstByteAt < from) from = live.firstByteAt
    }
    if (chars <= 0 || from === null) return null
    const spanMs = now - from
    if (spanMs <= 0) return null
    return Math.round((chars / CHARS_PER_TOKEN / (spanMs / 1000)) * 10) / 10
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
  function nextInGroup(groupId, exclude, alsoSkip) {
    return pickCandidate(sortedModels(groupId).filter((m) => {
      if (m.provider === exclude.provider && m.model === exclude.model) return false
      // alsoSkip：本轮已因「请求被拒」跳过的模型（它们没被标记当日失败，只能靠这里排除）
      if (alsoSkip !== undefined && alsoSkip.has(failKey(m.provider, m.model))) return false
      return true
    }))
  }

  /**
   * 失败后选下一个模型：绑定了分组就在组内选，否则按「同组、优先级不高于当前」兜底。
   *
   * @param {{id: string}|undefined} group - 会话绑定的启用分组；undefined 表示未绑定。
   * @param {{provider: string, model: string}} exclude - 刚失败的那个模型。
   * @param {Set<string>|undefined} alsoSkip - 本轮已因请求被拒跳过的 `provider/model`。
   * @returns {{provider: string, model: string, effort?: string}|null} 选中的目标。
   */
  function pickNext(group, exclude, alsoSkip) {
    if (group !== undefined) return nextInGroup(group.id, exclude, alsoSkip)
    const fallback = findFailover(exclude.provider, exclude.model)
    if (fallback === null || alsoSkip === undefined) return fallback
    return alsoSkip.has(failKey(fallback.provider, fallback.model)) ? null : fallback
  }

  /**
   * 无会话绑定时，从当前模型所属分组里找可路由的替代模型。
   *
   * 两轮扫描，都是为了「报错就一定要有去处」：
   *  1. 先找**优先级不差于当前模型**的候选（`priority` 数字越小越优先）；
   *  2. 一个都挑不出来时放宽到整组——宁可降级，也不要因为「更优的候选恰好都在
   *     当日失败/时段外/已过期」而原地不动，那正是「报错了却不自动路由」。
   *
   * 同一个模型可能同时属于多个分组，所以第一轮不因「某个分组挑不出候选」就收手：
   * 「第一处命中即返回」的旧行为让排在前面那个分组成了隐形上限。
   */
  function findFailover(currentProvider, currentModel) {
    const isSelf = (cand) => cand.provider === currentProvider && cand.model === currentModel
    const holdsCurrent = (group) => group.models.some(m => m.provider === currentProvider && m.model === currentModel)
    for (const group of groups) {
      if (!group.enabled || !holdsCurrent(group)) continue
      const self = group.models.find(m => m.provider === currentProvider && m.model === currentModel)
      const limit = self?.priority ?? 99
      const preferred = pickCandidate(sortedModels(group.id).filter((cand) => !isSelf(cand) && (cand.priority ?? 99) <= limit))
      if (preferred) return preferred
    }
    for (const group of groups) {
      if (!group.enabled || !holdsCurrent(group)) continue
      const relaxed = pickCandidate(sortedModels(group.id).filter((cand) => !isSelf(cand)))
      if (relaxed) return relaxed
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

  /* ============ 并发闸门 + 速度采样：挂在 llm/stream 上 ============ */
  //
  // waterfall 语义：必须 `next()` 才能拿到下游适配器的流；这里不改写任何 chunk，
  // 只在外层计时、并在流结束后释放并发槽。
  const disposeLlmStream = ctx.on('llm/stream', (options, next) => guardedStream(options, next))

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
   *
   * 两种情况：
   *  1. 常规健康检查——当前模型被标记当日失败 / 出了时段 / 过了截止日 → 换组内下一个；
   *  2. 并发回切——上次是因为并发满被临时换走的，等原模型空闲且过了保护期就换回去。
   *     「临时切换」必须真的临时：没有这一步，用户会因为一次瞬时并发永远停在备用模型上。
   *
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
      // 并发冷却中的模型不算「可用」：这正是「触发到并发时临时切换到组内其它模型」。
      const capacityBlocked = capacityCooldownOf(cur.provider, cur.model) !== null
      const usable = !capacityBlocked && (member ? routable(member) : !isFailed(cur.provider, cur.model))
      if (usable) {
        await revertCapacitySwitchIfDue(agent, id, group, cur)
        return
      }
    } else if (binding.binding.mode !== 'route') {
      // 读不到当前模型（理论上只在异常路径）：路由模式交给分组，兜底模式不插手
      return
    }
    const pick = firstAvailableInGroup(group.id)
    if (!pick) return
    const ok = await applyActiveModel(agent, pick)
    if (!ok) return
    const why = cur && capacityCooldownOf(cur.provider, cur.model) !== null
      ? `${cur.provider}/${cur.model} 并发已满（临时冷却中）`
      : `${cur.provider}/${cur.model} 此刻不可用`
    ctx.logger.info(`[model-failover] 会话 ${id} 新一轮检查：${cur ? why : '当前模型未知'} → ${pick.provider}/${pick.model}`)
  }

  /**
   * 如果这个会话上次是被并发临时换走的，且原模型此刻空闲、保护期已过，就切回去。
   *
   * 保护期的意义：两个模型交替打满时，没有它会让会话每轮来回抖一次。
   * 只在「原模型仍在同一分组内且可路由」时回切——分组被改过或原模型已失败就不勉强。
   *
   * @param {any} agent - 该会话的 Agent。
   * @param {string} id - 会话 id。
   * @param {{id: string}} group - 会话当前的绑定分组。
   * @param {{provider: string, model: string}} cur - 该会话此刻用的模型。
   * @returns {Promise<void>} 无返回值；回切失败只记诊断，不影响本轮。
   */
  async function revertCapacitySwitchIfDue(agent, id, group, cur) {
    const prev = capacitySwitches.get(id)
    if (!prev) return
    // 已经不在备用模型上了（用户手选 / 又被换过）→ 这条记录过期，清掉。
    if (prev.provider === cur.provider && prev.model === cur.model) return
    if (Date.now() - prev.at < capacitySwitchRevertMs) return
    capacitySwitches.delete(id)
    if (capacityCooldownOf(prev.provider, prev.model) !== null) return
    const target = groupMember(group.id, prev.provider, prev.model)
    if (!target || !routable(target)) return
    const limit = concurrencyLimitOf(prev.provider, prev.model)
    if (limit > 0 && (inflightByModel.get(failKey(prev.provider, prev.model)) ?? 0) >= limit) return
    const ok = await applyActiveModel(agent, candidateOf(target))
    if (ok) ctx.logger.info(`[model-failover] 会话 ${id} 并发已恢复，切回 ${prev.provider}/${prev.model}`)
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
   * 免费渠道推荐现场：每个渠道装没装、装的哪版、此刻有哪些 provider 在线。
   *
   * 「装没装」只认 pluginManager.listBundles()：它读的是当前 profile 的依赖，
   * 与「模型列表里有没有它的模型」是两件事——有的包装了但没登录，provider 就不在。
   * 服务取不到时 installed 返回 null（界面显示「未检测」），而不是谎报「未安装」。
   *
   * @returns {Promise<{managerAvailable: boolean, channels: {id: string, pkg: string, spec: string, installed: boolean|null, version: string|null, providers: string[]}[]}>} 现场快照
   */
  async function describeFreeChannels() {
    /** @type {Map<string, string>} */
    const installed = new Map()
    let managerAvailable = false
    try {
      const manager = ctx.get('pluginManager')
      if (manager && typeof manager.listBundles === 'function') {
        managerAvailable = true
        for (const bundle of (await manager.listBundles()) ?? []) {
          const name = String(bundle?.name ?? '')
          // installed 才是「当前 profile 依赖里声明了它」；目录里可装但没装的条目也会出现在
          // listBundles 里，只看名字会把「市场里有」误判成「已经装了」。
          if (name && bundle?.installed !== false) installed.set(name, String(bundle?.version ?? ''))
        }
      }
    } catch { /* 服务不可用时保持空表，界面按「未检测」展示 */ }
    /** @type {string[]} */
    let providerIds = []
    try {
      providerIds = (ctx.get('llm')?.listProviders?.() ?? []).map(p => String(p?.id ?? '')).filter(Boolean)
    } catch { /* 只读诊断：注册表读不到就当没有在线渠道 */ }
    return {
      managerAvailable,
      channels: FREE_CHANNELS.map(c => ({
        id: c.id,
        pkg: c.pkg,
        spec: c.spec,
        installed: managerAvailable ? installed.has(c.pkg) : null,
        version: installed.get(c.pkg) ?? null,
        providers: providerIds.filter(id => c.providers.test(id)),
      })),
    }
  }

  /**
   * 从推荐表里安装一个渠道，走的是插件市场同一个引擎（pluginManager.installBundle）。
   *
   * 装包可能要执行安装脚本，那一步必须由用户批准；这里不代批，只把待批准项原样抛回界面，
   * 否则一键安装就成了「绕过审批执行构建脚本」的入口。
   *
   * @param {string} id - 推荐表的渠道 id。
   * @returns {Promise<{ok: boolean, message: string, pendingBuilds?: string[]}>} 安装结论（可直接展示）
   */
  async function installFreeChannel(id) {
    const channel = FREE_CHANNELS.find(c => c.id === id)
    if (!channel) return { ok: false, message: `推荐表里没有这个渠道：${id}` }
    let manager
    try { manager = ctx.get('pluginManager') } catch { /* 下面统一处理 */ }
    if (!manager || typeof manager.installBundle !== 'function') {
      return { ok: false, message: `当前宿主没有插件管理服务，无法一键安装；请手动安装 ${channel.spec}` }
    }
    let result
    try {
      result = await manager.installBundle(channel.spec)
    } catch (e) {
      return { ok: false, message: `安装 ${channel.pkg} 失败：${e?.message || e}` }
    }
    const pending = Array.isArray(result?.pendingBuilds) ? result.pendingBuilds.map(String) : []
    if (pending.length > 0) {
      return { ok: false, pendingBuilds: pending, message: `${channel.pkg} 需要先批准执行构建脚本：${pending.join('、')}` }
    }
    return { ok: true, message: `已安装 ${channel.pkg}；热加载完成后它的模型会出现在模型列表里。` }
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
    // capped = 账号没坏，只是并发打满了（每个账号 active 已达 max）。它和 disabled/cooling
    // 有本质区别：**重启账号池不会多出一个号，只会把正在跑的请求全部打断**。所以 capped
    // 绝不能进重建分支，必须落到分组路由——这正是「模型报错却没有正确路由」的成因：
    // 旧判定只数 disabled/cooling，capped 全都不计，于是走完 B 段的所有条件都不成立，
    // 掉进最后的 'unknown' → 'unrecoverable'，外层据此直接 return action，一次都不切模型。
    const capped = state.slots.filter(s => s.state === 'capped').length
    if (!poolEmpty && !state.blockedBySignature) return 'fallthrough'
    // 池里一个能用的号都没有，但全部只是并发打满：换模型，别重启。
    if (capped > 0 && disabled === 0 && cooling === 0) {
      lastCodeartsDiagnosis = {
        at: Date.now(), kind: 'capped', disabled, cooling, capped,
        hint: `${capped} 个账号并发已满（active 达到 max），不是账号故障；重启账号池只会打断在跑的请求，因此改为切换到分组里的其它模型。`,
      }
      ctx.logger.warn(`[model-failover] ${provider}/${model} 的 429 是并发打满（${capped} 个账号 capped），不重启账号池，改走分组路由`)
      return 'fallthrough'
    }

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
        at: Date.now(), kind: revived ? 'revived' : 'revive-failed', disabled, cooling, capped,
        hint: revived ? '已重启 dsh-codearts 重建账号池。' : '重启 dsh-codearts 未成功，请手动重启宿主。',
      }
      if (revived) return 'retry'
      return 'unrecoverable'
    }

    // C. 走到这里说明池里既没有停用/冷却、也挑不出号——不再当成「不可恢复」直接放弃，
    //    而是交给分组路由。旧版返回 'unrecoverable' 会让外层 return action，一次都不换模型，
    //    用户看到的就是「选了路由，但模型报错没有正确路由」。
    lastCodeartsDiagnosis = {
      at: Date.now(), kind: 'fallthrough-unknown', disabled, cooling, capped,
      hint: '池状态里没有停用/冷却/并发满的记录，无法自愈；已交给分组路由切换模型。',
    }
    return 'fallthrough'
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
   * 判据是 shim 的 `effective`（真的接管了运行时在用的加密器），不是 `installed`
   * （只是把补丁挂上了）。磁盘上 dsh-codearts-auth 那份 qoder-wasm.js 在本部署里不被
   * 加载，给它打补丁不改变任何请求；只有 pack.js 暴露的那份才算数。按 installed 判
   * 会让守卫在「补丁挂上了但一个请求都没经过它」时宣布正常，2026-10-26 就是这样静默
   * 失效的。
   *
   * @param {string} provider - provider id。
   * @returns {boolean} 已接管则为 true。
   */
  function qoderShimCovers(provider) {
    if (!QODER_SHIM_PROVIDERS.has(provider)) return false
    if (qoderShimHandle === null) return false
    try {
      const st = qoderShimHandle.status()
      return st !== null && st.effective === true
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
      // shim 挂上了补丁但还没接管运行时（多半是注入口写进文件后宿主没重启）
      shimPending: [...QODER_SHIM_PROVIDERS].filter((id) => uncompressedProviders.has(id) && !qoderShimCovers(id)),
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
        detail: extra?.detail ?? failureTextOf(failure)?.slice(0, 160) ?? null,
        // 该 provider 的请求不经过压缩代理（无上下文压缩），排障时一眼可见
        ...(extra?.uncompressed === true ? { uncompressed: true } : {}),
      })
      if (failureLog.length > 20) failureLog.shift()
    } catch { /* 诊断记录绝不影响主流程 */ }
  }

  /* ============ 失败后的共同处置：标记失败 → 换下一个模型 → 排队续跑 ============ */
  //
  // 两个入口共用这一段，语义必须一致：agent/request-error（流已经开起来、随后以
  // error/aborted 结束）与 agent/error（请求还没起来就抛出，见文件后面的监听器）。
  // 一次失败被两条入口各处置一次，会话就会连跳两个模型。
  //
  // 调用方负责先解析出 provider/model，并处理「与本次请求有关」的分支：
  // codearts 账号池自愈、Our Free Model 的换账号重试。
  //
  // @param {any} agent - 失败的 Agent。
  // @param {string} provider - 这次失败实际用的 provider。
  // @param {string} model - 这次失败实际用的 model。
  // @param {any} failure - 结构化失败（{code, message}）。
  // @param {number|undefined} turn - 本轮序号；写进 errorTurns 供 turn-stopping 判别。
  // @param {object|null} compressionGap - noteCompressionGap 的结果，只用于诊断标注。
  // @param {{id: string, revision: number}|null} [goalRef] - 调用方在进入本函数前抓下的 goal ref；
  //   省略时在本函数内读。agent/error 那条入口必须在 await 之前抓（见下面的监听器）。
  // @returns {Promise<string>} 处置结果：switched / capacity-switched / rejected-switched / switch-failed / no-target / all-capacity。
  async function routeAfterModelFailure(agent, provider, model, failure, turn, compressionGap, goalRef = null) {
    const id = String(agent.session.id)
    // 并发/容量类失败：模型没坏，只是这一刻排不上。处置方式与「真失败」完全不同——
    // 绝不 markFailed（那会让它一整天不参与路由），只记一个短冷却，然后临时换到
    // 组内其它模型，原模型空闲后由 rerouteForNewTurn 切回来。
    //
    // 这条分支就是用户报的「触发到模型并发时，临时切换到路由中其他模型」。
    const capacityFailure = isCapacityFailure(failure)
    if (capacityFailure) {
      markCapacity(provider, model, failure?.message ?? CAPACITY_TIMEOUT_CODE)
      ctx.logger.warn(`[model-failover] ${provider}/${model} 并发已满（${failure?.code ?? 'unknown'}），临时冷却 ${Math.round(capacityCooldownMs / 1000)}s 并切换到组内其它模型`)
    }
    // 请求本身被拒（输入超过上下文上限、参数不合法、模态不支持…）：
    // 换账号没用、原地重试也没用，唯一有效的是换模型。
    const requestRejected = isRequestRejectedFailure(failure)
    if (requestRejected) {
      ctx.logger.warn(`[model-failover] ${provider}/${model} 的失败是请求被拒（${failure?.code ?? 'unknown'}），换号无意义，直接换模型`)
    }
    // 请求被拒不写当日失败：这个模型换个请求还能用，停用一整天是错的。
    // 但它必须参与「别的模型为何被跳过」的判断，所以只记 errorTurns 并继续切模型。
    if (!capacityFailure && !requestRejected) {
      markFailed(provider, model, failure)
      ctx.logger.warn(`[model-failover] ${provider}/${model} 彻底失败（${failure?.code ?? 'unknown'}），已标记为当日失败`)
    }
    // 本轮的终局失败由这里处置完毕：agent/error 入口靠它认出同一次失败，不再重复路由。
    if (turn !== undefined) errorTurns.set(id, turn)
    // 这一轮里已经因为「请求被拒」被淘汰的模型：请求被拒不写当日失败（模型本身没坏），
    // 所以下一条续跑必须靠这份名单把它排除掉，否则同一个超限模型会被反复选中，
    // 每次都要白烧一次上游请求。切到新模型后清空，下一轮重新开始。
    if (requestRejected) {
      const tried = rejectedBySession.get(id) ?? new Set()
      tried.add(failKey(provider, model))
      rejectedBySession.set(id, tried)
    }
    const rejectedNow = rejectedBySession.get(id)

    // 绑定：先看自己，子代理沿 parentSession 继承父会话的分组
    const inherited = effectiveBinding(agent.session)
    const binding = inherited?.binding
    const group = binding ? groups.find(g => g.id === binding.groupId && g.enabled) : undefined
    const target = pickNext(group, { provider, model }, rejectedNow)
    if (!target) {
      const why = binding
        ? (group ? '分组内无其它可路由模型（全部当日失败/不在时段/已过期/本轮已因请求被拒跳过）' : '绑定的分组已停用或不存在')
        : '该会话未绑定分组，且该模型不在任何启用分组内'
      ctx.logger.info(`[model-failover] ${provider}/${model} 失败后不切换：${why}`)
      noteFailure(agent, provider, failure, 'no-target', { model, detail: why, uncompressed: compressionGap !== null })
      return 'no-target'
    }
    // 连兜底候选都占不到槽位：换过去也是同一个满池，只会在两个模型之间来回抖。
    // 此时没有可换的目标，唯一能推进的动作是**等槽位释放**——等到就照常切过去续跑，
    // 等不到（超过 concurrencyQueueTimeoutMs）才把这一轮判失败。
    //
    // 这不等同于「排队」：模型自己满时闸门是立刻失败的（见 acquireSlot），只有
    // 「整组都满」这一条路才会等，因为那一刻除了等没有别的选择。
    if (capacityFailure && !hasFreeSlot(target.provider, target.model)) {
      const key = failKey(target.provider, target.model)
      const limit = concurrencyLimitOf(target.provider, target.model)
      const budget = concurrencyQueueTimeoutMs > 0 ? `${Math.round(concurrencyQueueTimeoutMs / 1000)}s` : '不限'
      ctx.logger.warn(`[model-failover] ${provider}/${model} 并发已满，组内 ${target.provider}/${target.model} 也满，等槽位释放（最多 ${budget}）`)
      const freed = await awaitSlotFree(key, limit, concurrencyQueueTimeoutMs)
      if (disposed || !freed) {
        const why = freed ? '插件已卸载，放弃这次切换' : `组内模型全部并发已满，等 ${budget} 仍没有槽位`
        ctx.logger.warn(`[model-failover] ${provider}/${model} ${why}`)
        noteFailure(agent, provider, failure, 'all-capacity', { model, detail: why })
        return 'all-capacity'
      }
      // 刚等到空位说明这个模型已经不满了，它当时记下的冷却对现在已过时；留着会让
      // 下一轮 rerouteForNewTurn 立刻又把它换走，等于白等。
      capacityCooldowns.delete(key)
    }
    if (inherited?.inherited) {
      ctx.logger.info(`[model-failover] 子代理 ${id} 按继承的分组 ${binding.groupId}（来自 ${inherited.viaSessionId}）切换`)
    }

    const ok = await applyActiveModel(agent, target)
    // 并发切换要记住「原来用的是什么」，rerouteForNewTurn 才能在执行期过后切回去。
    if (ok && capacityFailure) capacitySwitches.set(id, { provider, model, at: Date.now() })
    // 切成功就清空本轮的被拒名单：已经离开那个模型了，下一轮从干净的候选集开始。
    // 不清会让名单无限增长，也会在用户换分组/换模型后挡住本来可用的模型。
    if (ok) rejectedBySession.delete(id)
    const outcome = ok
      ? (capacityFailure ? 'capacity-switched' : requestRejected ? 'rejected-switched' : 'switched')
      : 'switch-failed'
    noteFailure(agent, provider, failure, outcome, {
      model, detail: `→ ${target.provider}/${target.model}${ok ? '' : '（切换失败）'}`,
      uncompressed: compressionGap !== null,
    })
    if (!ok) return 'switch-failed'
    // 已经 select 了新模型，但本步 selection 已冻结：等本轮收尾后排队续跑。
    // goalRef 有值时优先用它：调用方是在 await 之前抓的，那才是切换前的真实状态；
    // agent/error 那条入口与 goal-round-driver 在同一个 emit 里，晚读会读到已 disarm 的 goal。
    queueContinuation(agent, provider, model, target, goalRef ?? goalRevivalOf(agent))
    return outcome
  }

  /**
   * 把 `agent/error` 携带的错误收敛成 {code, message}；不是 LLM 层失败时返回 null。
   *
   * 只认 LLM 层的错误：工具执行失败、宿主自身的配置错误（no provider/model）不是
   * 模型链路问题，把它们标成「模型当日失败」是错的。取消（ABORTED）也不换——
   * 那是用户按了停止。
   *
   * @param {unknown} error - agent/error 的 payload.error（原样）。
   * @returns {{code: string, message: string}|null} 结构化失败；不该路由时为 null。
   */
  function llmFailureOf(error) {
    const message = typeof error?.message === 'string' ? error.message : ''
    const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : null
    // name 是 LlmError 自己设的；兜底再认一次 pi-ai 的原话，防止错误被包装过一层
    const isLlmError = error?.name === 'LlmError' && code !== null
    if (!isLlmError && !/has no configured model/i.test(message)) return null
    if (code === 'ABORTED') return null
    const failure = error?.failure
    if (failure !== null && typeof failure === 'object' && typeof failure.code === 'string') {
      return { code: failure.code, message: typeof failure.message === 'string' ? failure.message : message }
    }
    return { code: code ?? 'UNKNOWN', message }
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
    //
    // 内层不表态时 next() 返回 undefined，这有两种含义，处置必须区分：
    //  · 内层确实处理完了、只是没有「重试」这个动作 → 轮到我们接手；
    //  · 内层**短路**了整条链（不调 next() 就返回）→ 我们根本不会被调用到。
    // 第二种是「配置了路由却报错不自动路由」最常见的成因：任何 prepend 在更外层、
    // 又不肯放行的监听器（典型是重试插件「预算耗尽就抛出去」）都会把本插件整条跳过。
    // 所以这里不靠「自己最外层」这个前提：本插件同时守着 agent/error 那条入口，
    // 那边对「同一个 turn 尚未处置过」的失败一定会补一次路由（见 disposeAgentError）。
    const action = await next()
    if (action?.kind === 'retry') { noteFailure(agent, eventProvider, failure, 'inner-retry'); return action }
    if (disposed || !agent || !agent.session) return action

    const id = String(agent.session.id)
    // 本轮已经由本监听器处置（换了模型 / 决定不换）时，agent/error 会带着同一个 turn
    // 再来一次：那是 agent.ts 收尾时新建的 LlmError，不是新一次失败。记下 turn 就是
    // 为了让 agent/error 那条入口认出它并跳过，避免一次失败连跳两个模型。
    const endTurn = () => { errorTurns.set(id, turn); return action }
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
      // 不记 errorTurns：这条分支什么都没处置，同一个 turn 的 agent/error 入口还要再试一次
      // （它用 currentModelOf 反查，比请求头可靠）。记了就等于把唯一能路由它的入口挡掉。
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
        return endTurn()
      }
    }

    // 压缩旁路：bili 是唯一压缩器时，qoder 这类 provider 的会话没有任何压缩。
    // 这里只诊断、不截断流程——换到哪个模型交给下面的分组路由，而路由本身已经
    // 优先避开这类 provider（pickCandidate）；沿用着它们的会话才会走到这里。
    const compressionGap = noteCompressionGap(provider, model, failure)
    // 这两类失败各自的处置（markCapacity / markFailed 的豁免）已经收敛进
    // routeAfterModelFailure，这里只需要它们来决定要不要走换号分支。
    const capacityFailure = isCapacityFailure(failure)
    const requestRejected = isRequestRejectedFailure(failure)

    // Our Free Model 的模型：不论错误类型，一律先试换账号重试。
    // 换的是同一 provider/model 背后的凭据，selection 没变，所以同一步 retry 安全。
    // 哪些 provider 算「Our Free Model 的」由 config.ofmHandoffExcludeProviders 判定：
    // 名单内（默认 codearts）直接落到下面的分组路由。
    //
    // 并发类失败不换号：账号池打满时换号拿到的还是同一个池，换模型才有意义。
    // 请求被拒也不换号：模型上限/参数问题与凭据无关，换号只会白等一轮。
    const handedTo = (capacityFailure || requestRejected)
      ? null
      : await handoffToFreeModelAccount(provider, model, failure)
    if (handedTo) {
      noteFailure(agent, provider, failure, 'account-handoff', { model, detail: '账号 ' + handedTo })
      return { kind: 'retry' }
    }

    // 标记失败 → 换下一个模型 → 排队续跑；与 agent/error 那条入口共用同一段。
    await routeAfterModelFailure(agent, provider, model, failure, turn, compressionGap)
    // 已经 select 了新模型（切换成功时），但本步 selection 已冻结：等本轮收尾后排队续跑。
    // 不返回 retry：让这一轮以错误收尾，续跑消息开下一轮。
    return endTurn()
  }, { prepend: true })

  // 同一段处置的第二条入口：请求还没起来就抛出的失败（UNKNOWN_MODEL / INVALID_CONFIG /
  // stream 同步抛错 / 工具批处理失败）不会进 agent/request-error——那条 waterfall 只在
  // live finish 是 error/aborted 时才触发——只在 agent/error 上可见。
  // 用户报的 `pi-ai provider "codearts" has no configured model "glm-5.3-flash"`
  // （prepareCall 同步抛，code UNKNOWN_MODEL）走的就是这一条：两条入口都接住，
  // 「所有报错都路由」才成立。
  //
  // 与 request-error 的区别（决定了这里只能从 agent 反查 provider/model）：
  // agent/error 不带 provider/model，payload 只有 { agent, turn, step, error }；
  // 而且它是 emit（fire-and-forget），不是在失败步骤里 await 的——所以这里的
  // routeAfterModelFailure 可能在 turn/end 之后才跑完，续跑要等 agent/status 变 idle
  // 才发得出去（scheduleContinuation 负责那次投递）。
  // prepend：goal-round-driver 也监听 agent/error，并在自己的监听器里同步 disarm 活跃 goal。
  // 必须抢在它前面，才能在任何 await 之前读到 armed 状态的 goal ref（goalRevivalOf 只认 armed），
  // 否则每一次「请求还没发出去」的切换都会把用户的目标留成「已暂停的目标」。
  const disposeAgentError = ctx.on('agent/error', async ({ agent, turn, error }) => {
    if (disposed || !agent || !agent.session) return
    // 第一个 await 之前就抓：同一个 emit 里 goal-round-driver 会把它 disarm 掉。
    const goalRef = goalRevivalOf(agent)
    // agent/error 上的错误种类很杂（工具失败、宿主内部错误…），只接模型链路的。
    const failure = llmFailureOf(error)
    if (!failure) return
    const id = String(agent.session.id)
    // 本轮的失败如果已经在 request-error 里处置过（errorTurns 记的是同一个 turn），
    // 这里再路由一次就会连跳两个模型：直接跳过。
    if (errorTurns.get(id) === turn) return
    // 从当前选用反查这次请求实际用的 provider/model：agent/error 不携带它们。
    const current = currentModelOf(agent, id)
    if (!current?.provider || !current?.model) {
      noteFailure(agent, current?.provider ?? 'unknown', failure, 'provider-or-model-unknown', { model: current?.model })
      return
    }
    ctx.logger.warn(`[model-failover] ${current.provider}/${current.model} 请求未能发出（${failure.code}：${failure.message}），按模型失败路由`)
    const compressionGap = noteCompressionGap(current.provider, current.model, failure)
    await routeAfterModelFailure(agent, current.provider, current.model, failure, turn, compressionGap, goalRef)
  }, { prepend: true })

  /**
   * 读出该会话此刻的 goal（若有），供并发/失败切换后恢复它的自动续跑授权。
   *
   * 为什么需要记：goal-round-driver 监听 `agent/error`，**任何** agent 错误都会让它
   * `ctx.goals.disarm(agent)`；而本插件切换模型的代价正是「让本轮以错误收尾」，
   * 所以每次 failover 都会顺手把活跃 goal 的 activation 从 armed 改成 disarmed。
   * 界面把 active+disarmed 显示成「已暂停的目标」——用户看到的就是「重新路由时
   * 目标被暂停了」。这是本插件造成的副作用，必须在续跑时把它恢复。
   *
   * 只记 armed 的活跃 goal：paused/blocked/complete 是用户或模型自己的决定，
   * 本插件绝不越权复活。revision 一并记下，恢复时用它做 CAS，避免把期间被用户
   * 改过（edit/resume/complete）的目标按旧 ref 写回去。
   *
   * @param {any} agent - 即将收尾的 Agent。
   * @returns {{id: string, revision: number}|null} 需要恢复的 goal ref；没有则 null。
   */
  function goalRevivalOf(agent) {
    try {
      const goals = ctx.get('goals')
      const view = goals?.get?.(agent)
      if (!view || view.phase !== 'active' || view.activation !== 'armed') return null
      return { id: String(view.id), revision: Number(view.revision) }
    } catch { /* 未安装 goal 插件或服务不可读时静默跳过 */ }
    return null
  }

  /**
   * 把被 failover 顺手 disarmed 的 goal 重新 arm。
   *
   * `resume()` 对 active 且已 armed 的目标会抛 GOAL_INVALID_TRANSITION，因此先读
   * 现场：已经 armed 就什么都不做；只有 active+disarmed 才 resume。revision 不匹配
   * （期间被用户 edit / resume / complete 过）同样放弃——那是别人的决定，不该被
   * 一次模型切换覆盖。
   *
   * @param {any} agent - 该会话的 Agent。
   * @param {{id: string, revision: number}|null} ref - 切换前记下的 goal ref。
   * @returns {boolean} 是否真的恢复了自动续跑授权。
   */
  function reviveGoalAfterSwitch(agent, ref) {
    if (!ref) return false
    try {
      const goals = ctx.get('goals')
      if (!goals?.resume) return false
      const view = goals.get?.(agent)
      if (!view || String(view.id) !== ref.id) return false
      // 已经恢复（或被用户恢复）过了
      if (view.phase === 'active' && view.activation === 'armed') return false
      if (view.phase !== 'active') return false
      if (Number(view.revision) !== ref.revision) return false
      goals.resume(agent, { id: ref.id, revision: ref.revision })
      ctx.logger.info(`[model-failover] 会话 ${agent?.session?.id} 的 goal ${ref.id} 已随切换恢复自动续跑`)
      return true
    } catch (e) {
      // 恢复 goal 是附带的善意行为：失败只记日志，绝不能挡住续跑本身。
      ctx.logger.warn(`[model-failover] 恢复 goal 自动续跑失败：${e?.message || e}`)
      return false
    }
  }

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
   * 待续跑的兜底闹钟：sessionId -> timer。
   *
   * 正常路径是 `agent/status` 的 idle 边沿（见 scheduleContinuation）。但那条边沿不是
   * 保证：驱动器在 turn/end 之后走的是 throwError 分支时不会再回到 idle，插件也可能
   * 在这中间被卸载重载——消息就会永远躺在 pendingContinuations 里，用户看到的是
   * 「模型换了，然后就没有然后了」。兜底只看一件事：到点还挂着、且 agent 确实空闲，
   * 就补投一次；还在跑就不动它（那条边沿迟早会来，抢跑只会把消息排在运行中的轮次后面）。
   */
  const CONTINUATION_FAILSAFE_MS = 30_000
  const continuationTimers = new Map()

  /**
   * 给一次待续跑装上兜底闹钟（同一个会话只装一个）。
   *
   * 闹钟只负责「到点还没投递就再试一次」，不是一次性判定：投递失败（agent 还在跑、
   * followup 抛错）时消息必须**留在** pendingContinuations 里再挂一次闹钟，否则
   * 用户看到的就是「模型换了，然后就没有然后了」——那次续跑就此丢失。
   *
   * @param {string} sessionId - 待续跑的会话。
   * @returns {void}
   */
  function armContinuationFailsafe(sessionId) {
    if (continuationTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      continuationTimers.delete(sessionId)
      if (disposed) return
      const pending = pendingContinuations.get(sessionId)
      if (!pending) return
      if (pending.agent?.status !== 'idle') {
        // 还在跑：那条 idle 边沿迟早会来，重新挂上闹钟，别让这次续跑就此消失。
        armContinuationFailsafe(sessionId)
        return
      }
      ctx.logger.warn(`[model-failover] ${sessionId} 的续跑等了 ${CONTINUATION_FAILSAFE_MS / 1000}s 还没等到 idle 边沿，补投一次`)
      deliverContinuation(sessionId)
    }, CONTINUATION_FAILSAFE_MS)
    // 闹钟不该拖住进程退出
    if (typeof timer?.unref === 'function') timer.unref()
    continuationTimers.set(sessionId, timer)
  }

  /**
   * 撤掉兜底闹钟（已投递、或该续跑已被丢弃）。
   * @param {string} sessionId - 待续跑的会话。
   * @returns {void}
   */
  function clearContinuationFailsafe(sessionId) {
    const timer = continuationTimers.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    continuationTimers.delete(sessionId)
  }

  /**
   * 记下一次待续跑，并在 agent 空闲时投递。
   * @param {any} agent - 失败的 Agent。
   * @param {string} fromProvider - 失败请求实际用的 provider。
   * @param {string} fromModel - 失败请求实际用的模型。
   * @param {{provider: string, model: string}} target - 已 select 的新模型。
   * @param {{id: string, revision: number}|null} goalRevival - 切换前被 disarm 的 goal（见 goalRevivalOf）。
   */
  function queueContinuation(agent, fromProvider, fromModel, target, goalRevival = null) {
    const id = String(agent.session.id)
    pendingContinuations.set(id, { agent, fromProvider, fromModel, target, goalRevival })
    armContinuationFailsafe(id)
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
   * 投递一条待续跑消息；只在 agent 空闲时执行。
   *
   * 投递失败（followup 抛错）时**保留**待续跑条目并重新挂上兜底闹钟：续跑消息是
   * 「模型换了之后让会话接着干」的唯一载体，丢掉它等于这次切换只剩半截（模型换了，
   * 会话却停在原地）。原来的实现是先 delete 再投递，followup 一抛错这条续跑就永久
   * 消失了——状态日志里只会看到 scheduled 而没有 delivered。
   *
   * @param {string} sessionId - 待续跑的会话。
   * @returns {void}
   */
  function deliverContinuation(sessionId) {
    const pending = pendingContinuations.get(sessionId)
    if (!pending) return
    if (disposed) {
      pendingContinuations.delete(sessionId)
      clearContinuationFailsafe(sessionId)
      // 卸载时丢掉也必须留痕：状态日志里只有 scheduled 没有 delivered，
      // 排查「模型换了却没续跑」时才看得出是断在这里。
      logStatus('continuation/dropped', sessionId, null)
      return
    }
    // 先恢复 goal 再投递：goal-round-driver 在 agent 回到 idle 时，如果发现本轮的
    // 预留消息还在队列里且 goal 仍 armed，会主动 pause 它。所以必须在 followup 之前
    // 把 activation 恢复回来，否则用户会看到目标被这次切换「暂停」。
    reviveGoalAfterSwitch(pending.agent, pending.goalRevival)
    try {
      pending.agent.followup(createContinuationMessage(pending.fromProvider, pending.fromModel, pending.target))
      pendingContinuations.delete(sessionId)
      clearContinuationFailsafe(sessionId)
      logStatus('continuation/delivered', sessionId, null)
      ctx.logger.info(`[model-failover] ${sessionId} 已排队续跑（${pending.target.provider}/${pending.target.model}）`)
    } catch (e) {
      // 投递失败：条目留在原地，兜底闹钟重新挂上，等下一个窗口再试。
      armContinuationFailsafe(sessionId)
      logStatus('continuation/failed', sessionId, null, { error: String(e?.message || e) })
      ctx.logger.warn(`[model-failover] ${sessionId} 排队续跑失败：${e?.message || e}；已保留待续跑，稍后重试`)
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

  /* ==================== 一键测速 ==================== */
  //
  // 「一键测速」对选中的模型各发一次最小请求（一句 user 文本、maxTokens 很小），
  // 用真实往返测首字延迟与输出速度。为什么走 `ctx.llm.stream` 而不是自己拼 HTTP：
  // 只有走同一条链路，provider 适配器（鉴权、选号、并发闸门）与 `llm/stream` 上的
  // 采样才与真实会话一致，测出来的数才可比；否则测的是另一条路径。
  //
  // 不传 sessionId、也不传 purpose：llm-error-retry 只约束带 sessionId 的主请求，
  // 那套「首字 90s × 5 次」的重试不该覆盖测速——否则一个挂掉的模型会独占几分钟。
  // 超时由这里自己的 AbortController 控制，一个模型最多占 timeoutMs。
  const SPEED_TEST_MIN_TIMEOUT_MS = 5_000
  const SPEED_TEST_MAX_TIMEOUT_MS = 120_000
  const SPEED_TEST_DEFAULT_TIMEOUT_MS = 45_000
  const SPEED_TEST_MAX_MODELS = 60
  const SPEED_TEST_MAX_PARALLEL = 6

  /**
   * 正在跑的测速任务，null 表示没有。
   *
   * 同一时刻只允许一个：并发打上游会把被测模型自己的账号池打满，测出来的首字
   * 延迟就全是排队时间，比不测更误导。
   */
  let speedTestJob = null

  /** 测速任务的对外快照（GET /speedtest 与启动响应共用）。 */
  function speedTestSnapshot() {
    if (!speedTestJob) return { running: false, startedAt: null, finishedAt: null, total: 0, done: 0, targets: [], results: [] }
    return {
      running: speedTestJob.finishedAt === null,
      startedAt: speedTestJob.startedAt,
      finishedAt: speedTestJob.finishedAt,
      total: speedTestJob.total,
      done: speedTestJob.done,
      // targets 是本次任务覆盖的模型清单：results 只含已经测完的，界面要标出
      // 「哪几行正在测」只能靠它；刷新页面后本地记不住，接上进度也靠它。
      targets: speedTestJob.targets,
      // 结果按目标顺序占位，未测的槽是 null：界面据 done/total 画进度条
      results: speedTestJob.results.filter(Boolean),
    }
  }

  /**
   * 把请求体解析成待测模型清单。
   *
   * 两种入口：给 groupId（测整组）或给 models（测界面上当前看到的那些行，
   * 通常就是「按当前排序 + 已排除无数据模型」的结果）。都走同一条去重路径。
   *
   * @param {{groupId?: string, models?: Array<{provider?: string, model?: string, effort?: string}>}} body - 请求体。
   * @returns {Array<{provider: string, model: string, effort?: string}>} 去重后的待测清单。
   */
  function resolveSpeedTestTargets(body) {
    const out = []
    const seen = new Set()
    const push = (provider, model, effort) => {
      const p = String(provider ?? '')
      const m = String(model ?? '')
      if (!p || !m) return
      const k = `${p}/${m}`
      if (seen.has(k)) return
      seen.add(k)
      out.push({ provider: p, model: m, ...(effort ? { effort: String(effort) } : {}) })
    }
    if (Array.isArray(body.models)) {
      for (const m of body.models) push(m?.provider, m?.model, m?.effort)
      return out.slice(0, SPEED_TEST_MAX_MODELS)
    }
    if (body.groupId) {
      const group = groups.find(g => g.id === body.groupId)
      if (!group) return []
      for (const m of group.models || []) {
        // 已禁用的模型不测：它在路由里根本不会被选中，测出来的数只会误导。
        if (m.disabled === true) continue
        push(m.provider, m.model, m.effort)
      }
      return out.slice(0, SPEED_TEST_MAX_MODELS)
    }
    return []
  }

  /**
   * 测一个模型：发一次最小请求，回填首字延迟、输出速度与用量。
   *
   * 采样不在这里记：调用走的就是 `llm.stream`，`guardedStream` 已经按同一套口径
   * 记了一条样本（首字/速度/token/成败），这里再记一遍会把看板计数翻倍。
   *
   * @param {{provider: string, model: string, effort?: string}} target - 待测模型。
   * @param {number} timeoutMs - 单模型超时。
   * @param {AbortSignal} outerSignal - 整个任务的取消信号。
   * @returns {Promise<object>} 一行测速结果。
   */
  async function probeModel(target, timeoutMs, outerSignal) {
    const base = { provider: target.provider, model: target.model, effort: target.effort ?? null }
    let llm
    try { llm = ctx.get('llm') } catch { /* 下面统一报错 */ }
    if (!llm || typeof llm.stream !== 'function') {
      return { ...base, ok: false, ttftMs: null, tps: null, inTokens: null, outTokens: null, cacheReadTokens: null, cacheWriteTokens: null, errorCode: 'NO_LLM_SERVICE', error: 'llm 服务不可用' }
    }
    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    outerSignal.addEventListener('abort', onOuterAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), Math.max(SPEED_TEST_MIN_TIMEOUT_MS, timeoutMs))
    const startedAt = Date.now()
    let firstAt = null
    let usageIn = null
    let usageOut = null
    let usageCacheRead = null
    let usageCacheWrite = null
    let finish = null
    let thrown = null
    try {
      const options = {
        provider: target.provider,
        model: target.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        // 只要够触发一次首字与少量输出即可：测的是链路往返，不是回答质量。
        maxTokens: 24,
        signal: controller.signal,
        ...(target.effort ? { reasoningEffort: target.effort } : {}),
      }
      for await (const chunk of llm.stream(options)) {
        if (firstAt === null
          && (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta' || chunk?.type === 'tool-call-delta')) {
          firstAt = Date.now()
        }
        if (chunk?.type === 'usage') {
          if (typeof chunk.usage?.inputTokens === 'number') usageIn = chunk.usage.inputTokens
          if (typeof chunk.usage?.outputTokens === 'number') usageOut = chunk.usage.outputTokens
          if (typeof chunk.usage?.cacheReadTokens === 'number') usageCacheRead = chunk.usage.cacheReadTokens
          if (typeof chunk.usage?.cacheWriteTokens === 'number') usageCacheWrite = chunk.usage.cacheWriteTokens
        }
        if (chunk?.type === 'finish') finish = chunk.reason
      }
    } catch (e) {
      thrown = e
    } finally {
      clearTimeout(timer)
      outerSignal.removeEventListener('abort', onOuterAbort)
    }
    const endedAt = Date.now()
    const elapsedMs = endedAt - startedAt
    // 失败判定与看板口径一致：finish.kind 为 error/aborted 即失败，或用抛出来的异常。
    const failure = finish?.kind === 'error' || finish?.kind === 'aborted' ? finish.failure : null
    const errorCode = failure?.code
      ?? (thrown ? String(thrown.code ?? thrown.name ?? 'ERROR') : null)
      ?? (controller.signal.aborted ? 'TIMEOUT' : null)
    const ok = failure === null && thrown === null && !controller.signal.aborted
    const ttftMs = firstAt === null ? null : firstAt - startedAt
    const tps = usageOut !== null && firstAt !== null && endedAt > firstAt
      ? Math.round((usageOut / ((endedAt - firstAt) / 1000)) * 10) / 10
      : null
    return {
      ...base,
      ok,
      ttftMs,
      tps,
      inTokens: usageIn,
      outTokens: usageOut,
      cacheReadTokens: usageCacheRead,
      cacheWriteTokens: usageCacheWrite,
      elapsedMs,
      errorCode: ok ? null : (errorCode ?? 'ERROR'),
      error: ok ? null : (failureTextOf(failure) ?? String(thrown?.message ?? (controller.signal.aborted ? '测速超时' : '测速失败')).slice(0, 200)),
    }
  }

  /**
   * 启动一次测速：立刻返回任务快照，进度由界面轮询 GET /speedtest 拿。
   *
   * 为什么不等测完再返回：一个组几十个模型、每个最多几十秒，一次 HTTP 请求
   * 扛不住（浏览器与代理都会先超时），而且用户需要边测边看。
   *
   * @param {object} body - 请求体，见 {@link resolveSpeedTestTargets}，另含 timeoutMs / parallel。
   * @returns {{status: number, body: object}} HTTP 状态与响应体。
   */
  function runSpeedTest(body) {
    if (speedTestJob && speedTestJob.finishedAt === null) {
      return { status: 409, body: { ok: false, error: '测速正在进行中，等它跑完再点一次', ...speedTestSnapshot() } }
    }
    const targets = resolveSpeedTestTargets(body)
    if (targets.length === 0) {
      return { status: 400, body: { ok: false, error: '没有可测速的模型（分组为空、全被禁用，或没给模型清单）' } }
    }
    const timeoutRaw = Number(body.timeoutMs)
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.min(SPEED_TEST_MAX_TIMEOUT_MS, Math.max(SPEED_TEST_MIN_TIMEOUT_MS, Math.round(timeoutRaw)))
      : SPEED_TEST_DEFAULT_TIMEOUT_MS
    const parallelRaw = Number(body.parallel)
    const parallel = Number.isFinite(parallelRaw) && parallelRaw > 0
      ? Math.min(SPEED_TEST_MAX_PARALLEL, Math.max(1, Math.round(parallelRaw)))
      : 2
    const job = {
      startedAt: Date.now(),
      finishedAt: null,
      total: targets.length,
      done: 0,
      // 目标清单先落进任务：单个模型测速与整组测速共用一份快照，界面只有拿到
      // 清单才知道该把哪几行标成「测速中」（results 是跑完一个才多一个）。
      targets: targets.map(t => ({ provider: t.provider, model: t.model })),
      results: new Array(targets.length).fill(null),
      cancel: new AbortController(),
    }
    speedTestJob = job
    ctx.logger.info(`[model-failover] 一键测速开始：${targets.length} 个模型，并发 ${parallel}，单模型超时 ${Math.round(timeoutMs / 1000)}s`)
    // 任务在后台跑：HTTP 响应立即返回，界面轮询进度。
    void (async () => {
      let cursor = 0
      const worker = async () => {
        for (;;) {
          const i = cursor++
          if (i >= targets.length) return
          if (job.cancel.signal.aborted) return
          try {
            job.results[i] = await probeModel(targets[i], timeoutMs, job.cancel.signal)
          } catch (e) {
            // 单个模型崩掉不该让整批停下：记一行失败，继续下一个。
            job.results[i] = {
              provider: targets[i].provider, model: targets[i].model, effort: targets[i].effort ?? null,
              ok: false, ttftMs: null, tps: null, inTokens: null, outTokens: null,
              errorCode: 'PROBE_CRASH', error: String(e?.message ?? e).slice(0, 200),
            }
          }
          job.done++
        }
      }
      try {
        await Promise.all(Array.from({ length: Math.min(parallel, targets.length) }, worker))
      } catch (e) {
        ctx.logger.warn(`[model-failover] 一键测速异常退出：${e?.message || e}`)
      } finally {
        job.finishedAt = Date.now()
        const okCount = job.results.filter(r => r && r.ok).length
        ctx.logger.info(`[model-failover] 一键测速结束：${okCount}/${job.total} 成功，用时 ${Math.round((job.finishedAt - job.startedAt) / 1000)}s`)
      }
    })()
    return { status: 200, body: { ok: true, ...speedTestSnapshot() } }
  }

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
      // 注意：并发上限不在这里。它是模型的属性（见 modelConcurrency 表），
      // 由 POST /model-concurrency 单独维护；旧数据里残留的 entry.concurrency 会被丢弃。
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
          models: g.models.map(m => ({
            provider: m.provider, model: m.model, priority: m.priority ?? 99, effort: m.effort ?? null,
            windows: m.windows ?? null, from: m.from ?? null, to: m.to ?? null, until: m.until ?? null,
            disabled: m.disabled === true, failed: isFailed(m.provider, m.model),
            // 生效的并发上限（含 defaultConcurrency）；null = 不限。
            // 想区分「显式配置」与「跟随默认」，查顶层的 modelConcurrency。
            concurrency: (() => {
              const limit = concurrencyLimitOf(m.provider, m.model)
              return limit > 0 ? limit : null
            })(),
            inflight: inflightByModel.get(`${m.provider}/${m.model}`) ?? 0,
            // 并发冷却现场：非 null 表示它此刻因并发被临时挡在路由之外，到期自动恢复
            capacityCooldown: (() => {
              const cd = capacityCooldownOf(m.provider, m.model)
              return cd === null ? null : { until: cd.until, reason: cd.reason }
            })(),
          })),
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
        hostVersion: HOST_VERSION,
        // qoder 压缩 shim：截获 prepareInfer 的明文请求 + 经 bili 转发回来的压缩结果
        qoderShim: { ...describeQoderShim(), registryProbe: shimRegistryProbe, startError: shimStartError },
        // codearts 自救是否具备执行条件：loader 可见 + 找得到运行中的条目。
        // 这两项缺一就先在这里暴露出来，而不是等真失败时才发现救不了。
        codeartsSelfHeal: await describeCodeartsSelfHeal(),
        failureLog: failureLog.slice(-10).reverse(),
        // 生效的默认并发上限（0 = 不限）；设置入口见 settings.defaultConcurrency
        defaultConcurrency,
        // config 里的出厂值：界面据此说明「当前是跟随 config 还是被改过」
        configDefaultConcurrency,
        // 按模型显式配置的并发上限（没配的模型不出现在这里，跟随 defaultConcurrency）
        modelConcurrency: Object.fromEntries(modelConcurrency),
        concurrencyQueueTimeoutMs,
        capacityCooldownMs,
        capacitySwitchRevertMs,
        // 因并发被临时换走的会话：provider/model 是**原模型**，看板与排障用
        capacitySwitches: [...capacitySwitches.entries()].map(([sessionId, s]) => ({
          sessionId, provider: s.provider, model: s.model, at: s.at,
        })),
        capacityCooldowns: [...capacityCooldowns.entries()]
          .filter(([, cd]) => cd.until > Date.now())
          .map(([key, cd]) => ({ key, until: cd.until, reason: cd.reason })),
      })
      return
    }

    /* ----- 免费渠道推荐：装了什么、要不要我装 ----- */
    if (path === `${API_PATH}/free-channels` && req.method === 'GET') {
      sendJson(res, 200, await describeFreeChannels())
      return
    }
    if (path === `${API_PATH}/free-channels/install` && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const outcome = await installFreeChannel(typeof body?.id === 'string' ? body.id : '')
      sendJson(res, outcome.ok ? 200 : 409, outcome)
      return
    }

    /* ----- 数据看板：各模型的首字延迟与输出速度 ----- */
    if (path === `${API_PATH}/metrics` && req.method === 'GET') {
      // 日期筛选：`since` / `until` 为 YYYY-MM-DD（按北京时间整天，两端包含）。
      // 在北京时间上取自然日，与「当日失败」的日界线口径一致；筛选在这里做，
      // 因为缓冲区只有最近 N 条样本，界面拿不到被裁掉的更早数据。
      const parseDay = (raw, endOfDay) => {
        if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined
        // 北京时间 00:00:00 / 23:59:59.999 对应 UTC 前一天 16:00
        const start = Date.parse(`${raw}T00:00:00+08:00`)
        if (!Number.isFinite(start)) return undefined
        return endOfDay ? start + 86_400_000 - 1 : start
      }
      const since = parseDay(url.searchParams.get('since'), false)
      const until = parseDay(url.searchParams.get('until'), true)
      const window = since === undefined && until === undefined ? undefined : { since, until }
      // 只列出「分组里出现过的」模型，避免把宿主里几百个模型全塞给界面。
      // 同一模型出现在多个分组时取第一条的 priority / groupName；并发上限来自
      // modelConcurrency，与出现在哪个分组无关。
      const seen = new Set()
      const rows = []
      // 同一时刻的读数喂给所有行：一屏里的「总速度」必须是同一瞬间快照，
      // 否则逐行取 now 会让先算的行比后算的行早几毫秒，同一份响应自相矛盾。
      const sampledAt = Date.now()
      for (const g of groups) {
        for (const m of g.models || []) {
          const key = `${m.provider}/${m.model}`
          if (seen.has(key)) continue
          seen.add(key)
          const stats = speedStatsOf(key, window)
          const limit = concurrencyLimitOf(m.provider, m.model)
          const cooldown = capacityCooldownOf(m.provider, m.model)
          rows.push({
            provider: m.provider,
            model: m.model,
            // priority 与 groupName 一起给，界面才能按「分组 → 优先级」排序
            priority: m.priority ?? 99,
            effort: m.effort ?? null,
            groupId: g.id,
            groupName: g.name,
            ...stats,
            // 活跃区间合计速度：该模型这批在跑请求（各自已吐出过增量）在同一区间里的
            // 总 token/s（见 liveSpeedOf）；没有请求在产出时为 null（空着比写 0 诚实——
            // 0 会被读成「在跑但卡住了」）。与上面的 tpsP50/tpsP90 是不同的量：那两条是
            // 已完成调用的历史分位数，这条跟着「进行中」涨落。
            aggregateTps: liveSpeedOf(key, sampledAt),
            concurrency: limit > 0 ? limit : null,
            inflight: inflightByModel.get(key) ?? 0,
            // 等槽位中的请求数：闸门自己不再排队，这个数只在「整组都满、正在等这个
            // 模型的槽位释放」时才不为 0（见 routeAfterModelFailure 的那条等待）。
            queued: (waitingByModel.get(key) ?? []).length,
            failed: isFailed(m.provider, m.model),
            disabled: m.disabled === true,
            // 并发冷却现场：界面据此显示「并发冷却中，约 Ns 后恢复」
            capacityUntil: cooldown === null ? null : cooldown.until,
            capacityReason: cooldown === null ? null : cooldown.reason,
            // 是否有会话正被从这个模型临时换走
            switchedAway: [...capacitySwitches.values()].some(s => s.provider === m.provider && s.model === m.model),
          })
        }
      }
      sendJson(res, 200, {
        rows,
        // 与各行 aggregateTps 用的是同一个时刻，界面才能拿它做「几秒前」的基准
        sampledAt,
        // 采样不设条数上限：界面据 sampleLimit === null 说明「保留全部历史」
        sampleLimit: null,
        // 筛选回显：界面据此知道结果对应哪个区间，而不是只信本地状态
        window: { since: url.searchParams.get('since') || null, until: url.searchParams.get('until') || null },
        defaultConcurrency,
        concurrencyQueueTimeoutMs,
        capacityCooldownMs,
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
        // metricsSort：看板表头排序的持久化。显式传 null 表示「回到默认序」，
        // 也是合法的保存动作，所以用 `in` 判断而不是 truthy 判断。
        if ('metricsSort' in body) settings.metricsSort = normalizeMetricsSort(body.metricsSort)
        // defaultConcurrency：界面上的「默认并发」。null / '' = 清掉覆盖，回落 config
        // 的出厂值；0 是合法值（不限），所以必须用 `in` 判断、单独校验，不能靠 truthy。
        if ('defaultConcurrency' in body) {
          const raw = body.defaultConcurrency
          if (raw === null || raw === '') {
            settings.defaultConcurrency = null
            defaultConcurrency = configDefaultConcurrency
            ctx.logger.info(`[model-failover] 默认并发改为跟随 config（${configDefaultConcurrency === 0 ? '不限' : configDefaultConcurrency}）`)
          } else {
            const n = Number(raw)
            if (!Number.isInteger(n) || n < 0 || n > 999) {
              sendJson(res, 400, { ok: false, error: 'defaultConcurrency 需为 0..999 的整数（0 = 不限），或 null / 留空表示跟随 config' })
              return
            }
            settings.defaultConcurrency = n
            defaultConcurrency = n
            ctx.logger.info(`[model-failover] 默认并发设为 ${n === 0 ? '不限' : n}`)
          }
        }
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

    /* ----- 手动解除某个模型的并发冷却（并发已恢复但不想等冷却到期） ----- */
    if (path === `${API_PATH}/capacity/reset` && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (body.provider && body.model) capacityCooldowns.delete(failKey(String(body.provider), String(body.model)))
        else capacityCooldowns.clear()
        sendJson(res, 200, { ok: true })
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e) }) }
      return
    }

    /* ----- 禁用/启用某个模型参与路由（写进分组条目的 disabled 字段） ----- */
    /* ----- 按模型设置并发上限（对所有分组生效） ----- */
    if (path === `${API_PATH}/model-concurrency` && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (!body.provider || !body.model) { sendJson(res, 400, { ok: false, error: 'provider / model 必填' }); return }
        const key = modelConcKey(body.provider, body.model)
        const raw = body.concurrency
        // 空 / 0 / null = 清除覆盖，回落到 config.defaultConcurrency
        const cleared = raw === undefined || raw === null || raw === '' || raw === 0 || raw === '0'
        if (!cleared) {
          const n = Number(raw)
          if (!Number.isInteger(n) || n < 1) {
            sendJson(res, 400, { ok: false, error: 'concurrency 需为正整数（或 0 / null 表示不限）' })
            return
          }
          modelConcurrency.set(key, n)
        } else {
          modelConcurrency.delete(key)
        }
        saveModelConcurrency()
        const limit = concurrencyLimitOf(body.provider, body.model)
        sendJson(res, 200, {
          ok: true, provider: body.provider, model: body.model,
          // 该模型显式配置的值（清除后为 null）
          concurrency: modelConcurrency.get(key) ?? null,
          // 现在实际生效的上限（含 defaultConcurrency）；null = 不限
          effective: limit > 0 ? limit : null,
        })
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e) }) }
      return
    }

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

    /* ----- 按看板当前排序重设分组内的路由优先级 ----- */
    //
    // 用户在看板上点了几次表头（比如按速度降序），看着这个顺序正好就是想要的路由
    // 顺序，于是希望「把优先级按这个顺序重排」。界面把排序后的 provider/model 数组
    // 按先后顺序原样送上来，这里只负责按起始序号依次写回 priority：
    //  - 只看该分组里**实际存在**的条目，不在分组里的名字被忽略（界面不该送，但坏了
    //    也不该整批失败）；
    //  - 跳过的条目保持原优先级不变——「没有数据的模型排除」由界面决定要不要送，
    //    Host 不替它判断有没有采样，避免两边口径不一致；
    //  - 整批一次写入、一次落盘：失败不会留下半套优先级。
    if (path === `${API_PATH}/groups/reorder-priority` && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (!body.groupId) { sendJson(res, 400, { ok: false, error: 'groupId 必填' }); return }
        const group = groups.find(g => g.id === body.groupId)
        if (!group) { sendJson(res, 404, { ok: false, error: '分组不存在' }); return }
        const startRaw = body.start
        const start = Number(startRaw)
        // 起始序号：正整数；缺省 1。上限 999 与界面输入框一致（priority 只是排序键，
        // 但上界能挡住手改请求体写进来的天文数字）。
        if (startRaw !== undefined && startRaw !== null && startRaw !== ''
          && (!Number.isInteger(start) || start < 1 || start > 999)) {
          sendJson(res, 400, { ok: false, error: 'start 需为 1..999 的整数' }); return
        }
        const order = Array.isArray(body.order) ? body.order : []
        if (order.length === 0) { sendJson(res, 400, { ok: false, error: 'order 不能为空' }); return }
        const base = Number.isInteger(start) && start >= 1 ? start : 1
        const byKey = new Map()
        for (const m of group.models || []) byKey.set(`${m.provider}/${m.model}`, m)
        const applied = []
        let next = base
        const touched = new Set()
        for (const entry of order) {
          const provider = String(entry?.provider ?? '')
          const model = String(entry?.model ?? '')
          if (!provider || !model) continue
          const k = `${provider}/${model}`
          // 同一条目在 order 里出现两次时只认第一次，否则后面那次会把它顶到两位数
          if (touched.has(k)) continue
          const member = byKey.get(k)
          if (!member) continue
          touched.add(k)
          member.priority = Math.min(999, next)
          applied.push({ provider, model, priority: member.priority })
          next++
        }
        if (applied.length === 0) {
          sendJson(res, 400, { ok: false, error: 'order 里没有任何属于该分组的模型' }); return
        }
        saveGroups()
        ctx.logger.info(`[model-failover] 分组「${group.name}」按看板排序重设了 ${applied.length} 个模型的优先级（${base} 起）`)
        sendJson(res, 200, { ok: true, groupId: group.id, start: base, applied: applied.length, models: applied })
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e) }) }
      return
    }

    /* ----- 一键测速：对给的模型清单各打一次最小请求，测首字与速度 ----- */
    if (path === `${API_PATH}/speedtest` && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const result = await runSpeedTest(body)
        sendJson(res, result.status, result.body)
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e) }) }
      return
    }

    if (path === `${API_PATH}/speedtest` && req.method === 'GET') {
      sendJson(res, 200, speedTestSnapshot())
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
        const llmSvc = ctx.get('llm')
        const reg = llmSvc === null || llmSvc === undefined ? null : llmSvc.adapters
        shimRegistryProbe = {
          llm: llmSvc === null || llmSvc === undefined ? 'none' : 'ok',
          registry: reg === null || reg === undefined ? 'none' : (typeof reg.get === 'function' ? 'map:' + reg.size : typeof reg),
          keys: reg !== null && reg !== undefined && typeof reg.forEach === 'function' ? (() => { const out = []; reg.forEach((v, k) => out.push(String(k))); return out.filter((k) => k.includes('qoder')) })() : [],
        }
        qoderShimHandle = await shimModule.startQoderShim({ ctx, logger: ctx.logger, port: qoderShimPort, wasmPath: qoderShimWasmPath })
        const st = qoderShimHandle.status()
        if (st.installed && st.enabled) {
          ctx.logger.info(`[model-failover] qoder 压缩 shim 就绪：127.0.0.1:${st.port} 已接管 prepareInfer（明文经 bili 压缩后再加密发往上游）`)
        } else {
          ctx.logger.warn(`[model-failover] qoder 压缩 shim 未接管：${st.lastError ?? '未知原因'}（qoder 模型仍按未压缩直发）`)
        }
      } catch (err) {
        shimStartError = String(err && err.message ? err.message : err) + ' @ ' + String(err && err.stack ? err.stack : '').split(String.fromCharCode(10)).slice(1, 4).join(' | ')
        ctx.logger.warn(`[model-failover] qoder 压缩 shim 启动失败：${shimStartError}`)
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

  ctx.logger.info(`[model-failover-manager ${HOST_VERSION}] mounted from ${PLUGIN_FILE} (agent.model.select routing + microtask auto continuation + compression guard + qoder compress shim + concurrency gate with temporary capacity switching + speed board + agent/error entry + continuation failsafe)`)

  /* ==================== 清理 ==================== */
  ctx.effect(() => () => {
    disposed = true
    disposeCreated()
    disposeStatus()
    disposeApiStatus()
    disposeLlmStream()
    disposeSessionEvent()
    disposeError()
    disposeAgentError()
    disposeStop()
    if (qoderShimHandle) qoderShimHandle.stop()
    if (routeDisposer) routeDisposer()
    // 兜底闹钟随插件一起结束：卸载后既没人投递，也不该再留定时器
    for (const timer of continuationTimers.values()) clearTimeout(timer)
    continuationTimers.clear()
    // 卸载即刷新待写样本，否则最近 1.5s 内的采样会随进程一起消失
    flushMetrics()
  }, 'model-failover-manager: unmount')
}
