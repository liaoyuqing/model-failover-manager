/**
 * llm-prefix-facade —— 在 cordis isolate realm 内按「每插件 provider 前缀」提供 llm 门面。
 *
 * ## 为什么需要门面
 *
 * DSH 的 llm 注册表对同一个 provider 只允许一个 adapter
 *（packages/llm/llm/src/index.ts 的 registerAdapter / prepareRoutes：重复即
 * DUPLICATE_ADAPTER；被 registerAdapterIdempotent 包过的 consumer 更是被静默吞成
 * 「保留现有路由」—— 路由陈旧、无报错）。而免费渠道里的六个插件都以「裸 product id」
 * 注册同一批 provider：
 *
 *   dsh-our-free-model      ofm-   qoder / qodercn / trae / ...
 *   dsh-codearts            ca-    codearts / qoder / cline / ...
 *   dsh-connect-workbuddy   cw-    workbuddy / ...
 *   dsh-connect-trae        ct-    trae / ...
 *   dsh-connect-qoder       cq-    qoder / qodercn / ...
 *   dsh-codearts-auth       caa-   qoder / trae / minimax / ...
 *
 * ## 做法：per-plugin 前缀 + isolate realm
 *
 * 同一个门面模块被加载成多个 Loader 条目；每个条目在自己的 isolate realm 里，用
 * 自己的 config.prefix provide 一个 llm：对 consumer 呈现裸 provider id，对真实 llm
 * 呈现「本插件的 provider 前缀」拼出来的 id。于是 consumer 内部硬编码的裸 id 表一行
 * 都不用改，而真实 llm 上每家插件占的是一段互不相交的 id 空间，六家可以同时在线。
 *
 * ## 部署方式（cordis.yml / cordis.patch.yml）
 *
 * consumer 条目与门面条目必须共用一个 isolate label，形如：
 *
 *   - id: mfm-prefix-ofm
 *     name: './llm-prefix-facade.mjs'
 *     isolate: { llm: 'mfm-ofm' }
 *     config: { prefix: 'ofm-' }
 *   - id: dsh-our-free-model
 *     name: 'dsh-our-free-model'
 *     isolate: { llm: 'mfm-ofm' }
 *
 * 本插件自身不要 inject llm —— 它自己就是 llm 的提供者，注入 llm 会形成自等待。
 *
 * ## ⚠ 门面条目必须放在「没有 dsh.client 声明的包」里
 *
 * client-modules 按包名归并 bundle：这个只在宿主侧运行的门面文件所在的包，一旦在
 * package.json 里声明了 dsh.client.platform，就会被算成「同名包的另一个 client
 * bundle」，和真正带 client 的那个包互相覆盖，宿主直接启动失败（上一次把 DSH 搞崩的
 * 直接原因）。所以本包的 package.json 只有 private + type: module + main/exports，
 * 不含任何 dsh 字段。
 *
 * @module model-failover-provider-prefix/llm-prefix-facade
 */

/** cordis 插件名（loader 日志与错误信息里使用）。 */
export const name = 'model-failover-provider-prefix'

/**
 * 本插件不注入任何服务：它自己就是 llm 的提供者，注入 llm 会形成自等待。
 * 取真实 llm 走 root context 的 get('llm')（绕过 realm 的影子映射）。
 */
export const inject = []

/** 统一日志标签。 */
const LOG_TAG = '[mfm-prefix]'

/** provider 前缀的合法形态：字母开头、只含小写字母与数字、以 '-' 结尾。 */
const PREFIX_PATTERN = /^[a-z][a-z0-9]*-$/

/** 合法形态的中文说明，校验报错与告警共用同一句。 */
const PREFIX_FORM_HINT = "合法形态：小写字母开头、只含小写字母与数字、以 '-' 结尾"
  + "（例如 'ofm-'、'caa-'、'cw-'）"

/** 默认等待真实 llm 的上限：宿主插件装载顺序可能让 llm 晚于本插件出现。 */
const DEFAULT_WAIT_TIMEOUT_MS = 20000

/** 默认轮询间隔。 */
const DEFAULT_POLL_INTERVAL_MS = 100

/**
 * 校验并返回 provider 前缀。
 *
 * 为什么必须校验而不是「随便拼」：前缀是真实 llm 上 provider id 的命名空间，
 * 拼错（少个 '-'、混进大写、带空格）只会让路由名悄悄变样 —— 真实 llm 照样接受，
 * 出问题时却要在几十个 provider id 里人肉比对。所以非法形态一律当场抛。
 *
 * @param {unknown} prefix 待校验的前缀。
 * @returns {string} 原值（校验通过）。
 * @throws {TypeError} 非字符串、空串或不匹配 /^[a-z][a-z0-9]*-$/ 时抛出。
 */
export function normalizePrefix(prefix) {
  if (typeof prefix !== 'string') {
    throw new TypeError(LOG_TAG + ' config.prefix 必须是字符串，实际收到 ' + typeof prefix
      + '；' + PREFIX_FORM_HINT)
  }
  if (prefix.length === 0) {
    throw new TypeError(LOG_TAG + ' config.prefix 不能是空串；' + PREFIX_FORM_HINT)
  }
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new TypeError(LOG_TAG + ' config.prefix "' + prefix + '" 不合法；' + PREFIX_FORM_HINT)
  }
  return prefix
}

/**
 * 把 consumer 侧的裸 provider id 加上本插件前缀（幂等）。
 *
 * 为什么不是「无脑加前缀」：consumer 里存在本身就带同名前缀的 id（例如
 * codearts-auth 的 'caa-hub-auto' 这类白名单项），重复加前缀会改坏它的匹配，
 * 所以已带前缀的 id 原样返回。
 *
 * @param {string} prefix 本插件的 provider 前缀（应已过 normalizePrefix）。
 * @param {string} id consumer 侧 provider id。
 * @returns {string} 真实 llm 侧 provider id；非字符串/空串原样返回。
 */
export function prefixedProviderId(prefix, id) {
  if (typeof id !== 'string' || id.length === 0) return id
  return id.startsWith(prefix) ? id : prefix + id
}

/**
 * 剥掉一次本插件前缀；不认识的 id 原样返回。
 *
 * 只剥一次：'ofm-ofm-x' 剥成 'ofm-x'，再剥是调用方的事。仅用于「没有登记过的
 * 映射」时的兜底推断；一旦 registerAdapter 建立过映射，一律走映射表。
 *
 * @param {string} prefix 本插件的 provider 前缀。
 * @param {string} id 真实 llm 侧 provider id。
 * @returns {string} consumer 侧 provider id。
 */
export function baseProviderId(prefix, id) {
  if (typeof id !== 'string' || !id.startsWith(prefix)) return id
  return id.slice(prefix.length)
}

/**
 * 把 consumer 侧的 provider 显示名加上本插件前缀（幂等）。
 *
 * 为什么显示名也要前缀：模型选择器与设置页的「提供商」行只用显示名做标题
 *（ui-model-selection 的 group.provider.name、ui-settings-models 的
 * entry.displayName），id 加了前缀而名字没加，界面里就会出现两个 "CodeArts"
 * 并列、用户分不清哪一行是哪个插件的路由。同名冲突和 id 冲突一样真实。
 *
 * 形态与 id 一致：'ca-' + 'CodeArts' = 'ca-CodeArts'。已经带本插件前缀的名字
 * 原样返回（门面被套两层时不会变成 'ca-ca-CodeArts'）。
 *
 * @param {string} prefix 本插件的 provider 前缀（应已过 normalizePrefix）。
 * @param {string} providerName consumer 侧的显示名（可能为空）。
 * @param {string} fallbackId 显示名缺失时用的 consumer 侧 provider id。
 * @returns {string} 真实 llm 侧显示名。
 */
export function prefixedProviderName(prefix, providerName, fallbackId) {
  const base = typeof providerName === 'string' && providerName.length > 0 ? providerName : fallbackId
  if (typeof base !== 'string' || base.length === 0) return base
  return base.startsWith(prefix) ? base : prefix + base
}

/**
 * 剥掉一次本插件前缀的显示名；不带前缀的原样返回。
 *
 * @param {string} prefix 本插件的 provider 前缀。
 * @param {string} providerName 真实 llm 侧的显示名。
 * @returns {string} consumer 侧的显示名。
 */
export function baseProviderName(prefix, providerName) {
  if (typeof providerName !== 'string' || !providerName.startsWith(prefix)) return providerName
  return providerName.slice(prefix.length)
}

/**
 * 用一组薄闭包把 provider id 在两个视图之间来回映射。
 *
 * @param {string} prefix 本插件的 provider 前缀。
 * @param {(consumerId: string, realId: string) => void} [onCollision] 真实 id 冲突时的告警回调。
 * @returns {{ toReal: (id: string) => string, toConsumer: (id: string) => string,
 *   realIdOf: (id: string) => string, peekRealId: (id: string) => string,
 *   consumerIdOf: (id: string) => string, isKnownRealId: (id: string) => boolean }}
 *   映射函数集合：toReal/realIdOf 是「consumer id -> 真实 id（会登记）」，
 *   toConsumer/consumerIdOf 是「真实 id -> consumer id（只查）」。
 */
function createIdMap(prefix, onCollision = () => {}) {
  /** consumerId -> realId */
  const consumerToReal = new Map()
  /** realId -> consumerId */
  const realToConsumer = new Map()

  // 只读查询用：不登记新映射，避免一次拼错的查询把映射表污染成「二次前缀」。
  const peekRealId = (id) => {
    if (typeof id !== 'string' || id.length === 0) return id
    return consumerToReal.get(id) ?? prefixedProviderId(prefix, id)
  }

  // 注册用：登记双向映射。新 id 默认加前缀；若该 realId 已被另一个 consumerId
  // 占用（'hub-auto' 与 'ofm-hub-auto' 并存的情形），继续加前缀直到不冲突，
  // 因为真实 llm 绝不允许两个 provider 指向同一个 id。
  const realIdOf = (id) => {
    if (typeof id !== 'string' || id.length === 0) return id
    const known = consumerToReal.get(id)
    if (known !== undefined) return known
    let next = prefixedProviderId(prefix, id)
    // 两个不同的 consumer id 撞到同一个真实 id 时（例如 'hub-auto' 已经占用了
    // 'ofm-hub-auto'，之后真正的 'ofm-hub-auto' 才注册），真实 llm 不允许两条
    // 路由同名，只能继续加前缀。这是退化情形：提供告警钩子让上层看得见。
    while (realToConsumer.has(next) && realToConsumer.get(next) !== id) {
      next = prefix + next
      onCollision(id, next)
    }
    consumerToReal.set(id, next)
    realToConsumer.set(next, id)
    return next
  }

  const consumerIdOf = (id) => {
    if (typeof id !== 'string' || id.length === 0) return id
    const known = realToConsumer.get(id)
    if (known !== undefined) return known
    return baseProviderId(prefix, id)
  }

  return {
    toReal: realIdOf,
    toConsumer: consumerIdOf,
    realIdOf,
    peekRealId,
    consumerIdOf,
    isKnownRealId: (id) => realToConsumer.has(id),
  }
}

/**
 * 按 key 去重，保留首次出现的顺序。
 *
 * 为什么需要：consumer 的 id 视图可能把多条真实路由折叠成同一个 id（别的插件占着
 * 裸 id 时），重复项会污染 consumer 侧目录。
 *
 * @param {Array<object>} items 待去重条目。
 * @param {(item: object) => string} keyOf 取去重键。
 * @returns {Array<object>} 去重后的条目。
 */
function dedupeBy(items, keyOf) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * 超时降级用的「会报错的桩」：任何成员被取用都抛出带真实等待时长的说明。
 *
 * 为什么不是 Object.freeze({})：consumer 拿到裸空对象后第一次调用
 * llm.registerAdapter(...) 只会抛 TypeError: not a function，外观和「插件自己加载
 * 失败」完全一样，排查方向会一路偏到插件代码上。换成显式报错桩后，第一个报错就点名
 * 「DSH 没有提供 llm、门面在降级」，而报错里的时长又能区分「宿主根本没起 llm」和
 * 「只是比本插件晚了几十毫秒」。
 *
 * @param {number} timeoutMs 实际等待时长（毫秒），写进报错文案。
 * @param {string} [prefix] 本插件的 provider 前缀，写进报错文案便于定位是哪一条门面。
 * @returns {object} 任何属性访问都会抛错的桩对象。
 */
function makeDegradedLlm(timeoutMs, prefix = '') {
  const message = LOG_TAG + ' 真实 llm 服务在 ' + timeoutMs + ' ms 内未出现，provider 前缀 '
    + '"' + prefix + '" 的 llm 门面处于降级状态；请检查 DSH 是否正常提供 llm 服务'
  const fail = () => { throw new Error(message) }
  return new Proxy({}, {
    get(_target, prop) {
      // symbol（inspect 等运行时协议）与 'then'（防止被 await 当 thenable）
      // 不触发报错，否则连打印这个对象都会抛。
      if (typeof prop === 'symbol' || prop === 'then') return undefined
      return fail()
    },
    has(_target, prop) {
      if (typeof prop === 'symbol') return false
      return fail()
    },
  })
}

/**
 * 创建 llm 门面（纯工厂，不依赖 cordis，便于单测）。
 *
 * 门面只做 id 翻译，不缓存任何业务状态：所有调用都落到真实 llm 上，未显式处理的
 * 成员通过 Proxy 自动透传（真实 llm 有 20+ 方法，白名单会随宿主升级失配）。
 *
 * @param {object} realLlm 真实的 llm 服务（LlmRuntime 实例）。
 * @param {object} options 配置。
 * @param {string} options.prefix 本插件的 provider 前缀（必填，normalizePrefix 校验）。
 * @param {(message: string, ...rest: unknown[]) => void} [options.warn] 非致命问题告警回调。
 * @param {(release: () => void) => void} [options.trackHandle] 每转发一个 registerAdapter
 *   handle 时回调，供插件在 fiber 卸载时统一释放，避免残留幽灵路由。
 * @returns {object} 门面对象（对 consumer 呈现裸 id 视图）。
 */
export function createPrefixedLlmFacade(realLlm, options = {}) {
  if (!realLlm || (typeof realLlm !== 'object' && typeof realLlm !== 'function')) {
    throw new TypeError(LOG_TAG + ' createPrefixedLlmFacade 需要一个真实的 llm 服务')
  }
  const prefix = normalizePrefix(options.prefix)
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  const trackHandle = typeof options.trackHandle === 'function' ? options.trackHandle : () => {}
  /**
   * 门面自己转发出去的注册，按真实 provider 集合记账。
   *
   * 为什么门面要自己释放旧注册：realLlm 取自 root context 的 get('llm')，它的 this.ctx 是
   * root 上下文，所以真实 registerAdapter 里的 ctx.effect 挂在 root fiber 上，而不是
   * consumer 自己那个 fiber。consumer 条目单独重载时 root 不会卸载，旧注册不会被
   * 自动撤回；新注册撞上 DUPLICATE_ADAPTER 后被 registerAdapterIdempotent 当成
   * 「幂等重复」静默吞掉并保留旧路由——路由悄悄陈旧，还没有任何报错。
   *
   * @type {Array<{ realProviders: string[], release: () => void }>}
   */
  const liveHandles = []
  /**
   * 跨代登记表：按 provider 前缀记下本门面转发出去的目录 / 发现注册。
   *
   * 为什么需要跨越模块实例：真实 registerConfigurableProviders 与
   * registerModelDiscovery 里的 ctx.effect 挂在 realLlm 的 ctx（root fiber）上，
   * 不是 consumer 的 fiber，root 又不会随 consumer 重载而卸载。于是有两种残留：
   *
   *   1. consumer 条目重载、门面条目不动 —— 本实例的 liveDirectoryHandles 还能
   *      找到上一次的 handle，注册前接管它即可（adoptDirectory）。
   *   2. 门面条目自己也重载 —— 模块被清缓存重新求值，上一代实例的闭包连同它的
   *      记账数组一起被丢弃，handle 就成了没有任何人持有的孤儿；下一次 consumer
   *      apply 注册同一批 id 时宿主抛 DUPLICATE_DIRECTORY，一次抛错打断整次
   *      apply（插件后面的 webServer 路由与模型发现都不再注册，界面表现为
   *      「无法连接插件后端 / not found」）。
   *
   * 第 2 种只能靠模块外的登记表交接：新一代实例沿用上一代留下的记账数组，于是
   * 上一代那份仍然活着的 handle 就在自己手里 —— 下次 consumer 声明同一批 id 时
   * 直接 replace（不留空窗，也不会有孤儿）。
   *
   * 只按前缀分组：不同前缀的门面各占自己的 id 命名空间，互不接管。
   */
  const REGISTRY_KEY = Symbol.for('mfm-prefix.registration-registry')
  const registry = (() => {
    const existing = globalThis[REGISTRY_KEY]
    if (existing instanceof Map) return existing
    const created = new Map()
    globalThis[REGISTRY_KEY] = created
    return created
  })()
  const inherited = registry.get(prefix) ?? { directory: [], discovery: [] }
  /**
   * 门面自己转发出去的目录注册，按真实 provider 集合记账。
   *
   * 与 liveHandles 同一个理由（见上）：consumer 重载不会带走旧目录条目，
   * 新一次 apply 再注册同一批 id 就撞 DUPLICATE_DIRECTORY。
   *
   * 数组可能来自上一代实例，所以下面 push / splice 的都是它本身。
   *
   * @type {Array<{ realProviders: string[], release: () => void }>}
   */
  const liveDirectoryHandles = inherited.directory
  /**
   * 门面自己转发出去的模型发现注册，按 settingsNs 记账。理由同上：同一命名空间
   * 第二次注册会撞 DUPLICATE_DISCOVERY。
   *
   * @type {Array<{ settingsNs: string, release: () => void }>}
   */
  const liveDiscoveryHandles = inherited.discovery
  // 登记表指向这两个数组本身，下一代实例就能看到本代新增的 handle。
  registry.set(prefix, { directory: liveDirectoryHandles, discovery: liveDiscoveryHandles })

  /**
   * 认领一条已经持有本批 provider id 的目录注册，用 replace 换成新条目集。
   *
   * 为什么优先接管而不是「释放旧注册 + 全新注册」：宿主的目录注册是
   * all-or-nothing 的，中间一旦有空窗，同一瞬间读到目录的界面会看到提供商消失；
   * 而接管是宿主文档里的原子换组（`DirectoryRegistrationHandle.replace`）。
   * 跨代交接走的也是这条路 —— 上一代门面实例留下的 handle 仍在具名登记表里，
   * 它的 effect 还活在宿主那份 root fiber 上，replace 完全有效。
   *
   * @param {string[]} realProviders 本批真实 provider id。
   * @param {object[]} localized 已翻译成真实 id 的目录条目。
   * @returns {Function | undefined} 被认领注册的对外 handle；没有可接管的则 undefined。
   */
  const adoptDirectory = (realProviders, localized) => {
    for (let i = liveDirectoryHandles.length - 1; i >= 0; i -= 1) {
      const entry = liveDirectoryHandles[i]
      if (!entry.realProviders.some((realId) => realProviders.includes(realId))) continue
      if (typeof entry.handle?.replace !== 'function' || typeof entry.wrapped !== 'function') {
        // 记账来自更早的门面版本（没有留 handle）：只能释放后重新声明。
        liveDirectoryHandles.splice(i, 1)
        try {
          entry.release()
        } catch (error) {
          warn(LOG_TAG + ' 释放不可接管的陈旧目录注册失败', error)
        }
        continue
      }
      try {
        entry.handle.replace(localized)
      } catch (error) {
        // 这条旧注册在宿主那边已经不可用；丢掉它，交给下面的全新注册。
        liveDirectoryHandles.splice(i, 1)
        warn(LOG_TAG + ' 接管陈旧目录注册失败，改为重新注册：' + (error?.message ?? error))
        continue
      }
      entry.realProviders = realProviders
      return entry.wrapped
    }
    return undefined
  }

  /**
   * 清掉「没有本门面 handle 认领」的遗留条目，供无法接管的旧故障现场自救。
   *
   * 什么时候会走到这里：本门面还没有跨代登记表的那几代（本文件的旧版本）直接在
   * 宿主 root fiber 上登记过目录条目与模型发现。root fiber 不随 consumer 重载而
   * 卸载，那些注册就再没有任何人持有 —— 宿主对「已声明」抛 DUPLICATE_DIRECTORY /
   * DUPLICATE_DISCOVERY，一次抛错打断 consumer 的整次 apply，它后面的 webServer
   * 路由也就永远不注册（界面报「无法连接插件后端 / not found」）。除了重启宿主
   * 没有别的公开路径能撤掉它们，所以这里直接读宿主对象上的登记表把它们摘掉。
   *
   * 只摘「本批要声明、且设置命名空间也对得上」的 id：同名前缀下由别的渠道改名占用
   * 的条目不能碰，那种冲突必须原样抛给调用方，让宿主报出真实原因。
   *
   * @param {object[]} localized 本批已翻译成真实 id 的目录条目。
   * @returns {string[]} 实际摘掉的 id。
   */
  const reclaimOrphanDirectory = (localized) => {
    const directory = realLlm.directory
    if (!directory || typeof directory.delete !== 'function') return []
    const owned = new Set()
    for (const entry of liveDirectoryHandles) for (const id of entry.realProviders) owned.add(id)
    const reclaimed = []
    for (const candidate of localized) {
      const provider = candidate.provider
      if (owned.has(provider)) continue
      const existing = directory.get(provider)
      // 命名空间不同 = 这条不是本渠道留下的残留，而是真的被别人占用了。
      if (!existing || existing.settingsNs !== candidate.settingsNs) continue
      if (directory.delete(provider)) reclaimed.push(provider)
    }
    return reclaimed
  }

  /**
   * 清掉没有本门面 handle 认领的遗留模型发现注册，理由同
   * {@link reclaimOrphanDirectory}。
   *
   * @param {string} settingsNs 本批要声明的设置命名空间。
   * @returns {boolean} 是否真的摘掉了一条。
   */
  const reclaimOrphanDiscovery = (settingsNs) => {
    const discoveries = realLlm.discoveries
    if (!discoveries || typeof discoveries.delete !== 'function') return false
    if (liveDiscoveryHandles.some((entry) => entry.settingsNs === settingsNs)) return false
    return discoveries.delete(settingsNs)
  }

  /**
   * 记账一条新声明的目录注册，并给出对外的 handle。
   *
   * @param {object} handle 宿主返回的目录注册 handle。
   * @param {string[]} realProviders 本条注册覆盖的真实 provider id。
   * @returns {object} 记账条目（含对外的 wrapped handle）。
   */
  const trackDirectory = (handle, realProviders) => {
    /** @type {{ realProviders: string[], handle: object, wrapped?: Function, release: () => void }} */
    const entry = { realProviders, handle, release: () => {} }
    let released = false
    entry.release = () => {
      if (released) return
      released = true
      const at = liveDirectoryHandles.indexOf(entry)
      if (at >= 0) liveDirectoryHandles.splice(at, 1)
      try {
        handle()
      } catch (error) {
        warn(LOG_TAG + ' 释放目录注册失败', error)
      }
    }
    // 目录注册同样要包 replace：渠道插件会在设置变更时用 replace 重发整张
    // 目录（dsh-connect-workbuddy 的 syncRegionRegistration 就是），不翻译就会
    // 用裸 id 把带前缀的那份覆盖掉，模型设置页随即出现两个同名提供商。
    const wrapped = () => entry.release()
    wrapped.replace = (next) => {
      const nextLocalized = (next ?? []).map(toRealDirectoryEntry)
      const nextReal = nextLocalized.map((item) => item.provider)
      // 新集合可能扩到别家占用的 id，替换前同样要撤掉有交集的旧条目。
      releaseStaleDirectory(nextReal, entry)
      handle.replace(nextLocalized)
      entry.realProviders = nextReal
    }
    entry.wrapped = wrapped
    liveDirectoryHandles.push(entry)
    trackHandle(entry.release)
    return entry
  }

  /**
   * 撤掉与本批真实 id 有交集的陈旧目录注册。
   *
   * 只释放有交集的那几条：别的 consumer（别的 isolate realm）的目录条目不动。
   * `adoptDirectory` 没能接管的那些（登记来自没有留 handle 的旧门面版本）也在这
   * 里被清掉，否则它们会一直挡着新注册。
   *
   * @param {string[]} realProviders 本次要注册的真实 provider id。
   * @param {object} [exclude] 记账条目，replace 时把自己排除在外。
   */
  const releaseStaleDirectory = (realProviders, exclude) => {
    for (let i = liveDirectoryHandles.length - 1; i >= 0; i -= 1) {
      const entry = liveDirectoryHandles[i]
      if (entry === exclude) continue
      if (!entry.realProviders.some((realId) => realProviders.includes(realId))) continue
      liveDirectoryHandles.splice(i, 1)
      try {
        entry.release()
      } catch (error) {
        warn(LOG_TAG + ' 释放陈旧目录注册失败，继续注册新目录', error)
      }
    }
  }

  /**
   * 在真实 llm 上声明一批目录条目，并先清掉挡路的孤儿登记。
   *
   * 正常路径上 `adoptDirectory` 已经接管了同批旧注册，这里不会真的摘掉任何东西；
   * 只有在宿主上残留着「本门面没有任何 handle 认领」的旧登记（旧版本门面留下的）
   * 时才会生效。宿主把它们当硬错误，一次抛错就会打断 consumer 的整次 apply。
   *
   * @param {object} llm 真实 llm 服务。
   * @param {object[]} localized 已翻译成真实 id 的目录条目。
   * @param {unknown[]} rest 调用方传给宿主的额外参数。
   * @returns {object} 宿主的目录注册 handle。
   */
  const declareDirectory = (llm, localized, rest) => {
    const reclaimed = reclaimOrphanDirectory(localized)
    if (reclaimed.length > 0) {
      warn(LOG_TAG + ' 摘掉无人持有的遗留目录登记：' + reclaimed.join(', '))
    }
    return llm.registerConfigurableProviders(localized, ...rest)
  }

  /**
   * 撤掉同一 settingsNs 的陈旧模型发现注册。
   *
   * @param {string} settingsNs 本次要注册的设置命名空间。
   */
  const releaseStaleDiscovery = (settingsNs) => {
    for (let i = liveDiscoveryHandles.length - 1; i >= 0; i -= 1) {
      const entry = liveDiscoveryHandles[i]
      if (entry.settingsNs !== settingsNs) continue
      liveDiscoveryHandles.splice(i, 1)
      try {
        entry.release()
      } catch (error) {
        warn(LOG_TAG + ' 释放陈旧模型发现注册失败，继续注册新的', error)
      }
    }
  }

  const { realIdOf, peekRealId, consumerIdOf, isKnownRealId } = createIdMap(prefix, (consumerId, realId) => {
    warn(LOG_TAG + ' provider id 冲突：' + consumerId + ' 的真实 id 被占用，退化为 ' + realId)
  })

  /**
   * 把 stream 选项里的 provider 从真实 id 翻回 consumer id。
   * 宿主 llm 的 dispatch 闭包捕获的是 adapterCall.stream，options.provider 一定是
   * 注册时用的真实 id；consumer 的适配器只认裸 id，所以必须翻回去。
   *
   * @param {object} callOptions 一次调用的选项。
   * @param {string} fallbackProvider 缺失 provider 时的兜底 consumer id。
   * @returns {object} 翻译后的选项。
   */
  const toConsumerOptions = (callOptions, fallbackProvider) => {
    if (!callOptions || typeof callOptions !== 'object') return callOptions
    const provider = callOptions.provider === undefined
      ? fallbackProvider
      : consumerIdOf(callOptions.provider)
    return provider === callOptions.provider ? callOptions : { ...callOptions, provider }
  }

  /**
   * 把 stream 选项里的 provider 从 consumer id 翻成真实 id（门面自身调用真实 llm 用）。
   *
   * @param {object} callOptions 一次调用的选项。
   * @param {string} fallbackProvider 缺失 provider 时的兜底真实 id。
   * @returns {object} 翻译后的选项。
   */
  const toRealOptions = (callOptions, fallbackProvider) => {
    if (!callOptions || typeof callOptions !== 'object') return callOptions
    const provider = callOptions.provider === undefined
      ? fallbackProvider
      : peekRealId(callOptions.provider)
    return provider === callOptions.provider ? callOptions : { ...callOptions, provider }
  }

  /**
   * 把真实 llm 的 provider 列表折叠成 consumer 视图。
   *
   * 为什么不是简单去重：别的插件可能正占着裸 id 'qoder'，而本 consumer 的 'qoder'
   * 注册进来是 '<prefix>qoder'，两条路由翻译后都叫 'qoder'。consumer 侧不能让目录
   * 出现重复项，而裸 id 的查询到底落到哪条路由取决于映射表——所以同一 id 上优先保留
   * 「由本门面登记过的那条」，名字才与实际路由一致。位置保持首次出现处，避免打乱
   * consumer 依赖的注册顺序。
   *
   * 显示名同时剥回裸形态：真实 llm 上的 name 带本插件前缀，consumer 拿它和自己
   * 硬编码的名字做比较（例如聚合适配器按名字分组）时必须看到自己写的那份。
   *
   * @param {Array<{id: string, name?: string}>} list 真实 llm 的 provider 列表。
   * @returns {Array<{id: string, name?: string}>} consumer 视图的 provider 列表。
   */
  const foldProviders = (list) => {
    const out = []
    const index = new Map()
    for (const provider of list) {
      const id = consumerIdOf(provider.id)
      const name = baseProviderName(prefix, provider.name)
      const registered = isKnownRealId(provider.id)
      const at = index.get(id)
      if (at === undefined) {
        index.set(id, out.length)
        out.push({ entry: { ...provider, id, name }, registered })
      } else if (registered && !out[at].registered) {
        out[at] = { entry: { ...provider, id, name }, registered }
      }
    }
    return out.map((slot) => slot.entry)
  }

  /**
   * 把一条目录条目翻成真实 llm 侧形态：provider 走 id 映射，displayName 加前缀。
   *
   * displayName 缺失时退回 provider id：宿主 registerConfigurableProviders 要求它
   * 非空，空串会让整批目录注册以 INVALID_DIRECTORY 失败。
   *
   * @param {{ provider: string, displayName?: string }} entry consumer 侧目录条目。
   * @returns {object} 真实 llm 侧目录条目。
   */
  const toRealDirectoryEntry = (entry) => ({
    ...entry,
    provider: realIdOf(entry.provider),
    displayName: prefixedProviderName(prefix, entry.displayName, entry.provider),
  })

  /**
   * 包装 consumer 的 adapter，让它在真实 llm 面前表现为「带本插件前缀」的 id 版本。
   *
   * 用 Proxy 而非 class 子类：adapter 往往是 LlmAdapter 子类实例并带私有字段，
   * Proxy + 目标对象自调用（value.bind(target)）既能保持原型方法可见，也不必
   * 复制实现。只改写承载 id 的成员，其余成员绑定透传。
   *
   * @param {object} adapter consumer 侧 adapter。
   * @returns {object} 真实 llm 侧 adapter 视图。
   */
  const wrapAdapter = (adapter) => {
    /** 方法身份缓存：同一 prop 每次 get 返回同一个绑定函数，避免消费方做身份比较时抖动。 */
    const bound = new Map()
    const bind = (target, prop) => {
      let fn = bound.get(prop)
      if (!fn) {
        const value = Reflect.get(target, prop, target)
        fn = typeof value === 'function' ? value.bind(target) : value
        bound.set(prop, fn)
      }
      return fn
    }

    return new Proxy(adapter, {
      get(target, prop, receiver) {
        switch (prop) {
          // 宿主 prepareRoutes 校验 info.id === provider（这里是真实 id），name 非空。
          case 'providerInfo':
            return (provider) => {
              const consumerProvider = consumerIdOf(provider)
              const info = Reflect.apply(bind(target, 'providerInfo'), target, [consumerProvider]) ?? {}
              // 显示名同样加前缀：模型选择器与设置页的「提供商」行只拿 name 当标题，
              // 六个插件都用裸 id 注册同一批渠道时，界面会出现并排的多个同名分组。
              return {
                ...info,
                id: provider,
                name: prefixedProviderName(prefix, info.name, consumerProvider),
              }
            }
          // listModels 返回项 provider 必须等于传入的 provider（这里是真实 id），
          // 否则宿主抛 INVALID_CATALOG。
          case 'listModels':
            return async (provider, ...rest) => {
              const items = await Reflect.apply(bind(target, 'listModels'), target, [consumerIdOf(provider), ...rest])
              return (items ?? []).map((item) => ({ ...item, provider }))
            }
          case 'resolveModel':
            return async (provider, model, ...rest) => {
              const info = await Reflect.apply(bind(target, 'resolveModel'), target, [consumerIdOf(provider), model, ...rest])
              return { ...info, provider, id: info?.id ?? model }
            }
          // 最要紧的一步：宿主 prepareCall 返回的 dispatch 闭包捕获的是
          // adapterCall.stream（不是 adapter.stream），所以既要改写 model.provider，
          // 也必须在返回时就把 call.stream 换成把 provider 翻回裸 id 的版本。
          case 'prepareCall':
            return async (provider, model, ...rest) => {
              const consumerProvider = consumerIdOf(provider)
              const call = await Reflect.apply(bind(target, 'prepareCall'), target, [consumerProvider, model, ...rest])
              if (!call) return call
              const innerStream = call.stream
              return {
                ...call,
                model: call.model ? { ...call.model, provider } : call.model,
                stream: (callOptions) => Reflect.apply(innerStream, call, [toConsumerOptions(callOptions, consumerProvider)]),
              }
            }
          // 顶层 stream 在宿主生产路径里基本不走（走 prepared），但 consumer 自己会
          // 直接调它，必须同样翻译。
          case 'stream':
            return (callOptions) => Reflect.apply(bind(target, 'stream'), target, [toConsumerOptions(callOptions, undefined)])
          case 'providerRetryPolicy':
            return (provider) => Reflect.apply(bind(target, 'providerRetryPolicy'), target, [consumerIdOf(provider)])
          case 'imageRequestPricing':
            return (provider, model, ...rest) => Reflect.apply(bind(target, 'imageRequestPricing'), target, [consumerIdOf(provider), model, ...rest])
          case 'imageRequestTarget':
            return (provider, model, image, ...rest) => Reflect.apply(bind(target, 'imageRequestTarget'), target, [consumerIdOf(provider), model, image, ...rest])
          default:
            return bind(target, prop)
        }
      },
      has(target, prop) {
        return prop in target
      },
    })
  }

  /** 门面自身方法缓存（同一个 prop 返回同一个函数，语义上像普通对象）。 */
  const members = new Map()
  const member = (key, factory) => {
    let fn = members.get(key)
    if (!fn) {
      fn = factory()
      members.set(key, fn)
    }
    return fn
  }

  const facade = new Proxy({}, {
    get(_target, prop) {
      // symbol（inspect / iterator / toStringTag 等）一律透传，避免 Proxy 干扰
      // 运行时内部协议；'then' 显式返回 undefined，防止门面被 await 当成 thenable。
      if (typeof prop === 'symbol') return Reflect.get(realLlm, prop)
      if (prop === 'then') return undefined

      switch (prop) {
        case 'registerAdapter':
          return member(prop, () => (providers, adapter) => {
            const realProviders = Array.from(providers ?? [], (provider) => realIdOf(provider))
            // 先撤掉与本批真实 id 有交集的旧注册：否则新注册会被真实 llm 判成
            // DUPLICATE_ADAPTER。只释放有交集的那几条，别的 consumer 的路由不动。
            for (let i = liveHandles.length - 1; i >= 0; i -= 1) {
              const entry = liveHandles[i]
              if (!entry.realProviders.some((realId) => realProviders.includes(realId))) continue
              liveHandles.splice(i, 1)
              try {
                entry.release()
              } catch (error) {
                warn(LOG_TAG + ' 释放陈旧 adapter 注册失败，继续注册新路由', error)
              }
            }
            const handle = realLlm.registerAdapter(realProviders, wrapAdapter(adapter))
            let released = false
            /** 记账条目；release 先于条目创建被引用，用对象属性而不是闭包变量互相指向。 */
            const entry = { realProviders, release: () => {} }
            entry.release = () => {
              if (released) return
              released = true
              const at = liveHandles.indexOf(entry)
              if (at >= 0) liveHandles.splice(at, 1)
              try {
                handle()
              } catch (error) {
                warn(LOG_TAG + ' 释放 adapter 注册失败', error)
              }
            }
            liveHandles.push(entry)
            const wrapped = () => entry.release()
            // 宿主把 replace 当作「同一注册换一组路由」，所以 provider 也要翻译。
            // 释放后再 replace 交给真实 llm 抛 REGISTRATION_DISPOSED —— 这里故意不
            // 拦：那条错误说明了「注册已经没有主人」，是调用方必须看见的事实。
            wrapped.replace = (next) => {
              const nextReal = Array.from(next ?? [], (provider) => realIdOf(provider))
              handle.replace(nextReal)
              // 替换后这条注册覆盖的真实 id 变了，记账要跟着变，否则下一次同 id
              // 重载会漏释放，又回到 DUPLICATE_ADAPTER 静默吞掉的老问题。
              entry.realProviders = nextReal
            }
            trackHandle(entry.release)
            return wrapped
          })
        case 'registerConfigurableProviders':
          return member(prop, () => (entries, ...rest) => {
            const localized = (entries ?? []).map(toRealDirectoryEntry)
            const realProviders = localized.map((entry) => entry.provider)
            // 先认领同一批真实 id 的旧目录注册：宿主把「已经声明过」当硬错误
            // （DUPLICATE_DIRECTORY），而旧注册挂在上一次 apply 的 root fiber 上、
            // consumer 重载不会带走它。能接管就原子换组，接管不了才释放后重注册。
            const adopted = adoptDirectory(realProviders, localized)
            if (adopted !== undefined) return adopted
            const handle = declareDirectory(realLlm, localized, rest)
            return trackDirectory(handle, realProviders).wrapped
          })
        // 目录条目剥的是 provider 与 displayName，consumer 侧要看到自己写的那份裸形态。
        case 'listConfigurableProviders':
          return member(prop, () => (...args) => dedupeBy(
            (realLlm.listConfigurableProviders(...args) ?? []).map((entry) => ({
              ...entry,
              provider: consumerIdOf(entry.provider),
              displayName: baseProviderName(prefix, entry.displayName),
            })),
            (entry) => entry.provider,
          ))
        // 聚合式 adapter 用 listProviders().map(i => i.id) 与裸 id 白名单取交集；
        // 不翻回裸 id 会让白名单交集为空、网关目录变空。
        //
        // 这里必须去重：别的插件可能正占着裸 id 'qoder'，而本 consumer 的 'qoder'
        // 是 '<prefix>qoder'，两条路由翻译后都是 'qoder'。重复项会让 consumer 侧目录
        //（例如 openai-gateway/models.js 逐 provider 收集模型）出现重复条目。
        case 'listProviders':
          return member(prop, () => (...args) => foldProviders(realLlm.listProviders(...args) ?? []))
        case 'listModels':
          return member(prop, () => async (provider, ...args) => {
            const items = await realLlm.listModels(peekRealId(provider), ...args)
            return (items ?? []).map((item) => ({ ...item, provider: consumerIdOf(item.provider) }))
          })
        case 'resolveModelInfo':
          return member(prop, () => async (provider, model, ...args) => {
            const info = await realLlm.resolveModelInfo(peekRealId(provider), model, ...args)
            return { ...info, provider: consumerIdOf(info.provider) }
          })
        // 真实 LlmRuntime 没有 resolveModel 成员（只有 resolveModelInfo），
        // 这里用 resolveModelInfo 合成一个，避免 consumer 拿到 undefined。
        case 'resolveModel':
          return member(prop, () => async (provider, model, signal) => {
            const info = await realLlm.resolveModelInfo(peekRealId(provider), model, signal)
            return { ...info, provider: consumerIdOf(info.provider), id: info?.id ?? model }
          })
        case 'prepareCall':
          return member(prop, () => async (config, ...args) => {
            const consumerProvider = config?.provider
            const realProvider = realIdOf(consumerProvider)
            const prepared = await realLlm.prepareCall({ ...config, provider: realProvider }, ...args)
            const view = { ...prepared, config: prepared.config ? { ...prepared.config, provider: consumerProvider } : prepared.config }
            // 宿主 prepared.stream 用 callConfigEquals 比对 options 与 resolvedConfig，
            // 所以这里必须把 consumer 传回的裸 id 再翻成真实 id。
            if (typeof prepared.stream === 'function') {
              view.stream = (callOptions) => prepared.stream(toRealOptions(callOptions, realProvider))
            }
            return view
          })
        case 'stream':
          return member(prop, () => (callOptions) => realLlm.stream(toRealOptions(callOptions, undefined)))
        case 'discoverModels':
          return member(prop, () => (settingsNs, request, signal) => {
            const localized = request && typeof request === 'object' && typeof request.provider === 'string'
              ? { ...request, provider: peekRealId(request.provider) }
              : request
            return realLlm.discoverModels(settingsNs, localized, signal)
          })
        case 'registerModelDiscovery':
          return member(prop, () => (settingsNs, discover, ...rest) => {
            // 同 settingsNs 的旧注册挂在上一次 apply 的 root fiber 上、重载带不走；
            // 不先撤掉，宿主会以 DUPLICATE_DISCOVERY 打断整次 apply。
            releaseStaleDiscovery(settingsNs)
            if (reclaimOrphanDiscovery(settingsNs)) {
              warn(LOG_TAG + ' 摘掉无人持有的遗留模型发现登记：' + settingsNs)
            }
            const handle = realLlm.registerModelDiscovery(settingsNs, discover, ...rest)
            /** @type {{ settingsNs: string, release: () => void }} */
            const entry = { settingsNs, release: () => {} }
            let released = false
            entry.release = () => {
              if (released) return
              released = true
              const at = liveDiscoveryHandles.indexOf(entry)
              if (at >= 0) liveDiscoveryHandles.splice(at, 1)
              try {
                handle()
              } catch (error) {
                warn(LOG_TAG + ' 释放模型发现注册失败', error)
              }
            }
            liveDiscoveryHandles.push(entry)
            const wrapped = () => entry.release()
            trackHandle(entry.release)
            return wrapped
          })
        case 'providerRetryPolicy':
          return member(prop, () => (provider, ...args) => realLlm.providerRetryPolicy(peekRealId(provider), ...args))
        case 'imageRequestPricing':
          return member(prop, () => (provider, model, ...args) => realLlm.imageRequestPricing(peekRealId(provider), model, ...args))
        case 'imageRequestTarget':
          return member(prop, () => (provider, model, image, ...args) => realLlm.imageRequestTarget(peekRealId(provider), model, image, ...args))
        // 真实 llm 没有 has；用注册表判断，保持与 listProviders 同一视图。
        case 'has':
          return member(prop, () => (provider) => (realLlm.listProviders() ?? [])
            .some((info) => info.id === peekRealId(provider)))
        default: {
          // 未显式处理的成员自动透传：函数绑定到真实 llm，其它值原样返回。
          const value = Reflect.get(realLlm, prop)
          return typeof value === 'function' ? value.bind(realLlm) : value
        }
      }
    },
    has(_target, prop) {
      if (prop === 'has') return true
      return prop in realLlm
    },
  })

  return facade
}

/**
 * 轮询等待真实 llm 出现。
 *
 * 为什么轮询而不是直接取：profiles 的插件装载顺序决定了 llm 可能晚于本插件出现；
 * 但门面又必须在 consumer 之前 provide，所以只能「先上线，等真实 llm」。
 *
 * @param {object} ctx 本插件的 fiber 上下文。
 * @param {{ timeoutMs: number, intervalMs: number, isStopped: () => boolean }} options
 *   等待参数；isStopped 让卸载中的插件立刻放弃等待。
 * @returns {Promise<object | undefined>} 真实 llm，超时则 undefined。
 */
async function waitForRealLlm(ctx, options) {
  const deadline = Date.now() + options.timeoutMs
  while (!options.isStopped()) {
    // 必须绕到 root context 取值：门面一旦 provide，本 realm 的 ctx.get('llm')
    // 返回的就是门面自己，用它会自引用（isolate 的影子映射不会回退到 root）。
    //
    // cordis core 4.0.0-rc.12（dsh 0.2.2-rc.3）把 ctx.root 实例属性改成了
    // ctx[Context.root] = ctx[Symbol.for('cordis.root')]；旧写法在新版会直接抛
    // "cannot get property \"root\" without inject"，bootstrap 因此连 provide
    // 都执行不到，整个 realm 的 consumer 永久 pending。这里三级兜底兼容新旧：
    // 短路求值保证 symbol 可用时不会去读那个会抛错的旧属性。
    const root = ctx[Symbol.for('cordis.root')] ?? ctx.root ?? ctx
    const real = root.get('llm') ?? root.get('llm', false)
    if (real) return real
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs))
  }
  return undefined
}

/**
 * cordis 插件入口：在所属 isolate realm 内 provide 带本插件前缀的 llm 门面。
 *
 * ⚠ config.prefix 缺失或非法时**直接抛**，不做任何降级：门面靠前缀在真实 llm 上
 * 占住自己的 id 空间，前缀错了（或少配了这一行）等于「门面装上了但根本不生效」——
 * 那会退回到六家插件互相撞号、路由被静默吞掉的老故障，而且现场看起来一切正常。
 * 配置错误必须在装载时就炸出来。
 *
 * 失败兜底：前缀合法但真实 llm 在超时窗口内始终没出现时，仍然 provide 一个会明确
 * 报错的降级桩并告警——让 consumer 至少能启动，问题以显式告警暴露，而不是让整个
 * realm 卡在等 llm 的状态。
 *
 * @param {object} ctx 插件上下文（应处于 label 与 consumer 相同的 isolate realm 内）。
 * @param {object} config 配置。
 * @param {string} config.prefix 本插件的 provider 前缀（必填，形如 'ofm-'）。
 * @param {number} [config.waitTimeoutMs] 等待真实 llm 的上限，默认 20000。
 * @param {number} [config.pollIntervalMs] 轮询间隔，默认 100。
 * @param {(message: string, ...rest: unknown[]) => void} [config.warn] 告警回调。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  // fail loud：配置错不能静默降级成「门面不生效」。
  const prefix = normalizePrefix(config?.prefix)
  const waitTimeoutMs = Number.isFinite(config.waitTimeoutMs) ? config.waitTimeoutMs : DEFAULT_WAIT_TIMEOUT_MS
  const pollIntervalMs = Number.isFinite(config.pollIntervalMs) ? config.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS
  const warn = typeof config.warn === 'function' ? config.warn : fallbackWarn(ctx)

  /** 已转发出去的 registerAdapter 释放函数；fiber 卸载时统一调用。 */
  const releases = new Set()
  let stopped = false

  // 卸载顺序：先让 provide 撤下（consumer 随之失活），再释放路由。
  ctx.effect(() => () => {
    stopped = true
    for (const release of [...releases]) {
      try {
        release()
      } catch (error) {
        warn(LOG_TAG + ' 释放 adapter 注册失败', error)
      }
    }
    releases.clear()
  }, 'model-failover-provider-prefix.release')

  const provide = (value) => {
    // 让路：上游渠道插件若已在同一 isolate realm 提供 llm，再 provide 会被
    // reflect.ts 直接抛 "service llm has been registered at <...>"；吞掉异常
    // 只会让门面静默失效、退回裸 id 撞号，看不出原因。先探测再决定。
    try {
      const existing = ctx.get('llm', false)
      if (existing && existing !== value) {
        warn(LOG_TAG + ' realm 内已有 llm 提供者，前缀 "' + prefix
          + '" 的门面让路（不重复 provide）；该渠道的 provider 前缀将不生效')
        return false
      }
    } catch { /* 探测失败不阻塞正常 provide */ }
    try {
      ctx.provide('llm', value)
      return true
    } catch (error) {
      warn(LOG_TAG + ' provide llm 失败，前缀 "' + prefix + '" 的门面未生效', error)
      return false
    }
  }

  const bootstrap = async () => {
    const real = await waitForRealLlm(ctx, { timeoutMs: waitTimeoutMs, intervalMs: pollIntervalMs, isStopped: () => stopped })
    if (stopped) return
    if (!real) {
      // 降级仍然要 provide：不 provide 的话 consumer 会静默挂在等 llm 的 fiber 上，
      // 表现成「插件装上了但毫无反应」，比显式报错更难查。
      warn(LOG_TAG + ' 真实 llm 服务在 ' + waitTimeoutMs + ' ms 内未出现，provider 前缀 "'
        + prefix + '" 的 llm 门面降级；该 consumer 的 adapter 注册会失败并明确报错')
      provide(makeDegradedLlm(waitTimeoutMs, prefix))
      return
    }
    let facade
    try {
      facade = createPrefixedLlmFacade(real, {
        prefix,
        warn,
        trackHandle: (release) => {
          if (stopped) release()
          else releases.add(release)
        },
      })
    } catch (error) {
      warn(LOG_TAG + ' 创建 llm 门面失败（前缀 "' + prefix + '"），降级为原始 llm', error)
      provide(real)
      return
    }
    provide(facade)
  }

  void bootstrap().catch((error) => warn(LOG_TAG + ' 门面初始化失败（前缀 "' + prefix + '"）', error))
}

/**
 * 默认告警输出：优先用 cordis logger，取不到就退回 console。
 *
 * @param {object} ctx 插件上下文。
 * @returns {(message: string, ...rest: unknown[]) => void} 告警函数。
 */
function fallbackWarn(ctx) {
  return (message, ...rest) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : undefined
      if (logger?.warn) {
        logger.warn(message, ...rest)
        return
      }
    } catch (error) {
      // 读 logger 需要注入声明，取不到时降级到 console；这里只关心「别丢消息」。
    }
    console.warn(message, ...rest)
  }
}
