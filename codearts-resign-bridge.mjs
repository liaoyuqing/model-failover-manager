/**
 * CodeArts 凭据镜像：把 dsh-codearts 的活跃凭据持续写进 billion-context 重签用的 ref。
 *
 * ## 解决什么
 *
 * billion-context（bili）改写请求体之前，必须用当前账号的 AK/SK 重新计算
 * SDK-HMAC-SHA256 签名 —— 签名覆盖请求体，改写后原签名必然对不上。它从 credentials
 * 服务的 ref 读到材料，并按**入站请求的 AK** 匹配账号：匹配成功才用那份凭据重签。
 *
 * CodeArts 的 AK/SK/security_token 随刷新轮换（每次刷新换一组），静态 ref 里的副本
 * 很快过期；bili 匹配不到就按 compress-or-refuse 契约拒绝转发，回 403
 * signed_request_requires_resign，dsh-codearts 再把该账号标成 disabled，最后冒到
 * 用户面前是 429 soft_rate「当前没有可用账号」。
 *
 * ## 怎么做
 *
 * 定时读 `$DSH_HOME/.codearts-accounts.json`（dsh-codearts 自己的账号库，它是唯一
 * 持有与刷新凭据的一方），把**每个**账号的 accessKeyId / secretAccessKey / token 写成
 * bili 解析时认识的字段名，各自写进该账号对应的 ref。
 *
 * 多账号必须分别镜像：bili 遍历候选 ref、按 AK 挑匹配的那份。只镜像一个账号时，另一个
 * 账号的请求匹配不上，会被退回错误凭据重签而 401。
 *
 * ## ref 从哪来
 *
 * 优先读 `$DSH_HOME/jet-hub/state.json`（bili 默认扫描的候选清单），按**账号出现
 * 顺序**把 CodeArts 账号库里的账号依次映射到 `provider: "codearts"` 记录的
 * `credentialRef` —— 两边同为「账号池快照」，顺序稳定，且不依赖任何账号 id 的取值。
 * 候选 ref 不足时用 `fallbackRefs` 补齐，保证每个账号都有落点。
 *
 * 本模块原先是一个独立插件（dsh-codearts-resign-bridge）；并入本插件后由宿主侧的
 * startCodeartsResignBridge() 挂载，开关与间隔可在设置页调整。
 *
 * @module model-failover-manager/codearts-resign-bridge
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
// 剥插件前缀（ca-codearts → codearts）：账号库里的 provider 是裸名，注册表侧才带前缀
import { bareProvider } from './provider-prefix.mjs'

const HOME_DIR = process.env['DSH_HOME'] || join(homedir(), '.dsh')
/** dsh-codearts 的账号库：账号 id 为键，含 accessKeyId / secretAccessKey / token / expiration。 */
const ACCOUNTS_FILE = join(HOME_DIR, '.codearts-accounts.json')
/** bili 默认扫描的候选清单（未配置 credentialRef 时走这里）。 */
const JET_HUB_STATE = join(HOME_DIR, 'jet-hub', 'state.json')
/** 同步间隔下限：AK/SK 轮换后到同步完成之间，bili 会用旧 AK 签出 401，这段窗口越短越好。 */
export const MIN_SYNC_INTERVAL_SECONDS = 10

/**
 * 把一个账号转成 bili 解析时认识的凭据 JSON。
 *
 * 字段名不能改：bili 的 parse 只认 `access_key_id` / `secret_access_key` / `security_token`。
 * @param {unknown} account - `.codearts-accounts.json` 里的一条账号记录。
 * @returns {string|undefined} 凭据 JSON 文本，或 undefined（材料不全）。
 */
export function credentialPayloadOf(account) {
  const ak = typeof account?.accessKeyId === 'string' ? account.accessKeyId : ''
  const sk = typeof account?.secretAccessKey === 'string' ? account.secretAccessKey : ''
  const token = typeof account?.token === 'string' ? account.token : ''
  if (ak === '' || sk === '') return undefined
  return JSON.stringify({
    access_key_id: ak,
    secret_access_key: sk,
    security_token: token,
    expires_at: typeof account?.expiration === 'string' ? account.expiration : undefined,
  })
}

/**
 * 读出仍可用的账号，按 `order` 里给出的顺序（缺省用对象键顺序）排列。
 *
 * 排除已过期的条目：镜像一份过期凭据只会让 bili 继续失败。
 * @param {string} [file] - 账号库路径，缺省为 `$DSH_HOME/.codearts-accounts.json`。
 * @returns {Promise<{ key: string, payload: string }[]>} 每个可用账号的 id 与凭据 JSON。
 */
export async function usableAccounts(file = ACCOUNTS_FILE) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // 账号库不存在（没装 dsh-codearts）或还没写出来：没有可镜像的账号，不是故障。
    return []
  }
  const accounts = parsed !== null && typeof parsed === 'object' ? parsed.accounts : undefined
  if (accounts === null || typeof accounts !== 'object') return []
  const order = Array.isArray(parsed.order) ? parsed.order : []
  const ids = order.filter((id) => Object.hasOwn(accounts, id))
  for (const id of Object.keys(accounts)) if (!ids.includes(id)) ids.push(id)
  const now = Date.now()
  const out = []
  for (const id of ids) {
    const account = accounts[id]
    const payload = credentialPayloadOf(account)
    if (payload === undefined) continue
    const expiry = typeof account?.expiration === 'string' ? Date.parse(account.expiration) : Number.NaN
    // 过期时间不可解析时按「可用」处理：宁可镜像一份可能过期的凭据，也不要因为缺少
    // expiry 字段而完全不镜像（该字段在上游某些登录路径下可能缺席）。
    if (!Number.isNaN(expiry) && expiry <= now) continue
    out.push({ key: id, payload })
  }
  return out
}

/**
 * bili 会遍历的候选 ref 列表。
 *
 * `jet-hub/state.json` 里 provider 为 codearts、未被禁用且有 credentialRef 的记录，
 * 按文件顺序取 ref。读不到时返回空数组，由调用方用 fallbackRefs 补齐。
 * @param {string} [file] - jet-hub 状态路径，缺省为 `$DSH_HOME/jet-hub/state.json`。
 * @returns {Promise<string[]>} ref 名数组（去重、保序）。
 */
export async function candidateRefs(file = JET_HUB_STATE) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return []
  }
  const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : []
  const refs = []
  for (const account of accounts) {
    if (account === null || typeof account !== 'object') continue
    // 落盘的 accounts 用裸 provider id，但状态文件可能被门面态（ca-codearts）写回，
    // 两种写法都认，否则整份候选 ref 列表会突然变空、bili 退到 fallbackRefs。
    if (bareProvider(account.provider) !== 'codearts') continue
    if (account.enabled === false) continue
    const ref = account.credentialRef
    if (typeof ref !== 'string' || ref.trim() === '') continue
    if (!refs.includes(ref.trim())) refs.push(ref.trim())
  }
  return refs
}

/**
 * jet-hub 里 codearts 的闸门现场 —— bili 的候选 ref **完全由它决定**。
 *
 * bili 的 `codeartsRefCandidates()` 只读 `jet-hub/state.json`，跳过 `enabled === false`
 * 的记录。所以用户一旦在 Jet Hub 里关掉 codearts 供应商（一次动作写三处：账号
 * `enabled:false`、`providerClosed.codearts:true`、模型黑名单），候选清单就空了 ——
 * bili 转发前直接回 403 `signed_request_requires_resign`，压缩随之消失。
 *
 * ⚠️ 这是本模块最危险的盲区：`fallbackRefs` 保证镜像永远「成功」，于是 /status 的
 * `mirroredRefs` / `accountCount` / `lastError` 全都健康，而 bili 根本枚举不到任何 ref。
 * 把闸门现场如实回传，是让这个盲区**可见**的唯一办法。
 *
 * @param {string} [file] - jet-hub 状态路径，缺省为 `$DSH_HOME/jet-hub/state.json`。
 * @returns {Promise<object|null>} 闸门现场；读不到文件（没装 Providers Hub）时为 null。
 */
export async function jetHubGate(file = JET_HUB_STATE) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // 读不到 ≠ 被关闭：没有 jet-hub 时这一段整体不适用，返回 null 让调用方跳过。
    return null
  }
  const rows = Array.isArray(parsed?.accounts) ? parsed.accounts : []
  const ours = rows.filter((row) => row !== null && typeof row === 'object' && bareProvider(row.provider) === 'codearts')
  const closed = (parsed?.providerClosed ?? {})['codearts'] === true
  const hasRef = (row) => typeof row.credentialRef === 'string' && row.credentialRef.trim() !== ''
  return {
    closed,
    accountsTotal: ours.length,
    accountsDisabled: ours.filter((row) => row.enabled === false).length,
    // bili 真正能枚举到的 ref 数（与 candidateRefs 同一判据）：0 = 重签臂必然失败
    seeableRefs: ours.filter((row) => row.enabled !== false && hasRef(row)).length,
    // 结构还在但被停用：ref 与凭据仍有效，自愈就是把它们捞回来
    staleRefs: ours.filter((row) => row.enabled === false && hasRef(row)).length,
  }
}

/**
 * 规整同步间隔：非整数或低于下限一律回落到下限（10 秒），不拒绝启动。
 * @param {unknown} raw - settings / config 里的原值。
 * @returns {number} 生效的同步间隔（秒）。
 */
export function normalizeIntervalSeconds(raw) {
  return Number.isInteger(raw) && raw >= MIN_SYNC_INTERVAL_SECONDS ? raw : MIN_SYNC_INTERVAL_SECONDS
}

/**
 * 挂载凭据镜像。
 *
 * 运行期可 `reconfigure()`：设置页改了开关或间隔不必重挂插件，下一次定时唤醒就按新值走。
 * 没有 credentials 服务（插件被裁掉）或没有账号库（没装 dsh-codearts）时不产生任何写入，
 * 只在 /status 里留下 skipReason，好过静默无声让人以为镜像在跑。
 *
 * @param {object} options - 挂载参数。
 * @param {object} options.ctx - 插件上下文（用 ctx.get('credentials') 取服务）。
 * @param {object} options.logger - 插件日志器。
 * @param {object} [options.settings] - 初始设置：{ enabled, intervalSeconds }。
 * @param {string[]} [options.fallbackRefs] - 候选 ref 不足时用来补齐的 ref 名。
 * @param {string} [options.accountsFile] - 账号库路径（缺省 `$DSH_HOME/.codearts-accounts.json`）。
 * @param {string} [options.jetHubStateFile] - 候选清单路径（缺省 `$DSH_HOME/jet-hub/state.json`）。
 * @returns {{ status: () => object, syncNow: () => Promise<object>, reconfigure: (next: object) => object, stop: () => void }} 句柄。
 */
export function startCodeartsResignBridge({ ctx, logger, settings, fallbackRefs = [], accountsFile = ACCOUNTS_FILE, jetHubStateFile = JET_HUB_STATE }) {
  let enabled = settings?.enabled !== false
  let intervalSeconds = normalizeIntervalSeconds(settings?.intervalSeconds)
  const refsFallback = fallbackRefs.filter((ref) => typeof ref === 'string' && ref.trim() !== '').map((ref) => ref.trim())

  // 宿主日志器有 info/warn/error；debug 在部分日志器上不存在（离线自检的假 logger 就没有），
  // 少一个可选方法不该让整轮同步抛错，所以在这里收敛成 no-op。
  const debugLog = typeof logger.debug === 'function' ? (message) => logger.debug(message) : () => {}
  /** 上一次写入的内容（ref → payload），用于跳过无变化的写入。 */
  let lastWritten = new Map()
  /** 连续失败次数：日志压成「首次一次 + 之后每 10 次一次」，避免每 10 秒刷一行。 */
  let failures = 0
  /** @type {NodeJS.Timeout|null} */
  let timer = null
  let stopped = false
  /** 最近一次同步的现场，随 /status 回传。 */
  const state = {
    lastSyncAt: null,
    lastWroteCount: 0,
    lastError: null,
    skipReason: enabled ? '尚未同步' : '已关闭',
    mirroredRefs: [],
    accountCount: 0,
    // 闸门现场（见 jetHubGate）：bili 能不能枚举到 ref，取决于这里而不是镜像本身
    gate: null,
  }
  const setState = (patch) => { Object.assign(state, patch); return snapshot() }

  function snapshot() {
    return {
      enabled,
      intervalSeconds,
      fallbackRefs: refsFallback,
      lastSyncAt: state.lastSyncAt,
      lastWroteCount: state.lastWroteCount,
      lastError: state.lastError,
      skipReason: state.skipReason,
      mirroredRefs: [...state.mirroredRefs],
      accountCount: state.accountCount,
      gate: state.gate,
    }
  }

  /** 上一次闸门告警的形态，用来把「每 10 秒刷一行」压成「只在形态变化时报一次」。 */
  let gateWarnedSignature = null

  /**
   * 把闸门现场变成一条可执行的告警。
   *
   * 只有一种形态值得打扰用户：**有可用账号，但 bili 一个 ref 都枚举不到**（`seeableRefs === 0`）。
   * 那种情况下镜像照样成功、/status 照样健康，而每次 CodeArts 请求都会被 bili 在转发前拒掉，
   * 用户看到的是一句「本地代理拦下了这条签名请求」。其余形态（没装 Providers Hub、用户
   * 没有 CodeArts 账号）都是正常部署，不打扰。
   *
   * @param {object|null} gate - {@link jetHubGate} 的返回值。
   */
  function reportGate(gate) {
    if (gate === null || gate === undefined) return
    const blind = gate.accountsTotal > 0 && gate.seeableRefs === 0
    const signature = blind ? `blind:${gate.accountsTotal}:${gate.closed}` : `ok:${gate.seeableRefs}`
    if (signature === gateWarnedSignature) return
    gateWarnedSignature = signature
    if (!blind) {
      logger.info(`[model-failover] codearts 闸门已恢复：bili 能枚举到 ${gate.seeableRefs} 个候选 ref`)
      return
    }
    const why = gate.closed
      ? `Jet Hub 把整个 codearts 供应商标成了「已关闭」（providerClosed.codearts=true），${gate.accountsDisabled} 个账号随之停用`
      : `Jet Hub 里 ${gate.accountsDisabled} 个 codearts 账号被停用`
    logger.warn(
      `[model-failover] codearts 闸门关闭：${why}；bili 的候选 ref 因此为 0，CodeArts 请求会在转发前被拒（403 signed_request_requires_resign），压缩也随之消失。`
      + `凭据镜像本身是健康的（已镜像 ${state.mirroredRefs.length} 个 ref），别去查凭据 —— 要改的是 Jet Hub 的供应商开关。`
      + `修法：Jet Hub 里把 codearts 供应商打开（provider.setEnabled {provider:"codearts",enabled:true}），或等本插件在真实失败时自愈。`,
    )
  }

  const sync = async () => {
    if (stopped) return snapshot()
    if (!enabled) { setState({ skipReason: '已关闭' }); return snapshot() }
    // 闸门现场先读：它是「镜像一切正常、bili 却仍拒收」的唯一解释来源（见 jetHubGate）。
    const gate = await jetHubGate(jetHubStateFile)
    setState({ gate })
    reportGate(gate)
    const credSvc = ctx.get('credentials')
    if (credSvc === null || credSvc === undefined || typeof credSvc.set !== 'function') {
      failures += 1
      if (failures === 1 || failures % 10 === 0) debugLog('[model-failover] codearts 凭据镜像：没有 credentials 服务，跳过')
      return setState({ skipReason: '没有 credentials 服务（dsh-credentials 未装载）' })
    }
    const accounts = await usableAccounts(accountsFile)
    if (accounts.length === 0) {
      failures += 1
      // 没装 dsh-codearts 的用户每次都会走到这里：只留 debug，不打扰。
      if (failures === 1 || failures % 10 === 0) {
        debugLog(`[model-failover] codearts 凭据镜像：暂无可用 CodeArts 凭据（已重试 ${failures} 次）`)
      }
      return setState({ skipReason: '没有可用的 CodeArts 账号（未安装 dsh-codearts 或尚未登录）', accountCount: 0 })
    }
    const refs = await candidateRefs(jetHubStateFile)
    for (const ref of refsFallback) if (!refs.includes(ref)) refs.push(ref)
    if (refs.length === 0) {
      failures += 1
      if (failures === 1 || failures % 10 === 0) {
        logger.warn('[model-failover] codearts 凭据镜像：找不到任何候选 ref（jet-hub/state.json 无 codearts 记录，也没有 fallbackRefs）')
      }
      return setState({ skipReason: '没有候选 ref（jet-hub/state.json 无 codearts 记录，也没有 fallbackRefs）', accountCount: accounts.length })
    }
    // 账号数可能多于候选 ref：多出的账号没有落点，只能跳过 —— 但要说出来，
    // 否则「某个账号始终 401」会变成一个查不到原因的现象。
    if (accounts.length > refs.length && failures % 10 === 0) {
      logger.warn(`[model-failover] codearts 凭据镜像：有 ${accounts.length} 个可用账号但只有 ${refs.length} 个候选 ref，多出的账号不会被镜像`)
    }
    const next = new Map()
    for (let i = 0; i < Math.min(accounts.length, refs.length); i += 1) next.set(refs[i], accounts[i].payload)
    let wrote = 0
    let writeError = null
    for (const [ref, payload] of next) {
      if (lastWritten.get(ref) === payload) continue
      try {
        await credSvc.set(ref, payload)
        wrote += 1
      } catch (error) {
        writeError = `写入 ${ref} 失败 → ${String((error && error.message) || error)}`
        failures += 1
        if (failures === 1 || failures % 10 === 0) logger.warn(`[model-failover] codearts 凭据镜像：${writeError}`)
      }
    }
    if (wrote > 0) {
      failures = 0
      lastWritten = next
      logger.info(`[model-failover] codearts 凭据镜像：已同步 ${wrote} 个账号的凭据到 [${[...next.keys()].join(', ')}]（billion-context 可据此重新签名并保留压缩）`)
    } else if (writeError === null) {
      lastWritten = next
    }
    return setState({
      lastSyncAt: Date.now(),
      lastWroteCount: wrote,
      lastError: writeError,
      skipReason: writeError === null ? null : state.skipReason,
      mirroredRefs: [...next.keys()],
      accountCount: accounts.length,
    })
  }

  const schedule = () => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    if (stopped || !enabled) return
    timer = setTimeout(() => {
      timer = null
      void sync().catch((error) => {
        setState({ lastError: String((error && error.message) || error) })
        logger.warn(`[model-failover] codearts 凭据镜像：同步异常 → ${state.lastError}`)
      }).finally(() => { schedule() })
    }, intervalSeconds * 1000)
    // 定时器不该把进程钉住（命令行一次性调用、离线自检都会被它拖住）。
    if (typeof timer.unref === 'function') timer.unref()
  }

  void sync().catch((error) => setState({ lastError: String((error && error.message) || error) }))
  schedule()
  logger.info(`[model-failover] codearts 凭据镜像已启动（每 ${intervalSeconds} 秒同步一次，候选 ref 来自 jet-hub/state.json${refsFallback.length > 0 ? ' 与 fallbackRefs' : ''}）`)

  return {
    status: () => snapshot(),
    syncNow: () => sync(),
    /**
     * 闸门现场（供 /status 与真实失败路径共用一次读取）。
     * @returns {Promise<object|null>} {@link jetHubGate} 的返回值。
     */
    inspectGate: () => jetHubGate(jetHubStateFile),
    /**
     * 让镜像忘掉「已写入」的缓存并立刻重同步一轮。
     *
     * 自愈刚把账号捞回来时必须走这里：`lastWritten` 记的是上一次的 payload，账号重新启用后
     * 内容可能没变，不失效的话这一轮会判「无变化」跳过，而 bili 那边正等着这份凭据。
     * @returns {Promise<object>} 同步后的现场。
     */
    resyncNow() {
      lastWritten = new Map()
      gateWarnedSignature = null
      return sync()
    },
    /**
     * 运行期改开关或间隔（设置页）。
     * @param {{ enabled?: boolean, intervalSeconds?: unknown }} next - 新的设置值。
     * @returns {object} 改完的现场（供 /status 直接用）。
     */
    reconfigure(next) {
      if (typeof next?.enabled === 'boolean') enabled = next.enabled
      if (next?.intervalSeconds !== undefined) intervalSeconds = normalizeIntervalSeconds(next.intervalSeconds)
      const wasEnabled = state.skipReason !== '已关闭'
      if (!enabled) {
        if (timer !== null) { clearTimeout(timer); timer = null }
        state.skipReason = '已关闭'
        logger.info('[model-failover] codearts 凭据镜像已关闭')
      } else if (!wasEnabled || timer === null) {
        state.skipReason = null
        logger.info(`[model-failover] codearts 凭据镜像已开启（每 ${intervalSeconds} 秒同步一次）`)
        void sync().catch(() => {})
        schedule()
      }
      return snapshot()
    },
    stop() {
      stopped = true
      if (timer !== null) { clearTimeout(timer); timer = null }
    },
  }
}
