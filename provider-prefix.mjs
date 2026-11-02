/**
 * provider 前缀换算：六个免费渠道插件各加一个前缀，未打门面的插件仍是裸 id。
 *
 * ## 为什么需要它
 *
 * 「免费渠道」页签里的六个插件都会往宿主 llm 注册 provider，其中好几个用同名 id
 * （qoder、qodercn、trae、cline、loomy、raccoon、minimax、zcode、gemini、codearts、
 * workbuddy…），而宿主每个 provider id 只允许一个 adapter
 * （packages/llm/llm/src/index.ts:437-459 的 prepareRoutes 抛 DUPLICATE_ADAPTER，整组
 * all-or-nothing）。方案是给每个插件一个前缀，由 llm 门面在**真实注册表侧**加上，
 * 插件自身代码不改：
 *
 *   dsh-our-free-model     ofm-   ofm-qoder / ofm-trae / …
 *   dsh-codearts           ca-    ca-codearts / …
 *   dsh-connect-workbuddy  cw-    cw-workbuddy / …
 *   dsh-connect-trae       ct-    ct-trae / …
 *   dsh-connect-qoder      cq-    cq-qoder / …
 *   dsh-codearts-auth      caa-   caa-codearts / caa-buddy / …
 *
 * 于是同一个裸名（qoder）可以同时以 ofm-qoder、caa-qoder、cq-qoder 三条路由在线。
 *
 * ## 三种视图
 *
 *  · **裸 id**（qoder）：没装门面的插件注册的样子，也是 groups.json、配置、界面里
 *    用户一贯写的名字。
 *  · **真实注册表 id**（ofm-qoder）：宿主 llm 里真正的那条路由，llm.stream /
 *    agent.model.select 只认它。
 *  · 两者可以**同时存在**（门面只覆盖一部分插件），换算必须两边都成立。
 *
 * 本模块是纯函数集合：无副作用、不读 ctx、不碰文件，因此可以单独离线自检。
 *
 * @module model-failover-manager/provider-prefix
 */

/**
 * 六个插件的 provider 前缀，顺序与 host.mjs 的 FREE_CHANNELS 一致（＝免费渠道卡片顺序）。
 *
 * 顺序有意义：一个裸名在多个前缀下同时在线时，liveProviderIdOf 按这个顺序取第一个
 * 命中的前缀，所以顺序变了「裸 qoder 解析成哪条路由」就跟着变。
 *
 * 注意 ca- 不是 caa- 的前缀（'caa-codearts'.startsWith('ca-') 为 false），
 * 但换算一律走 startsWith 而不是 indexOf：indexOf 会把 caa- 误判成 ca-。
 *
 * @type {readonly string[]}
 */
export const PROVIDER_PREFIXES = Object.freeze(['ofm-', 'ca-', 'cw-', 'ct-', 'cq-', 'caa-'])

/**
 * 把任意一侧的 provider id 拆成「前缀 + 裸名」。
 *
 * 非字符串、空串一律当作「没有 provider」：返回空前缀与空裸名，调用方不用再判空。
 *
 * @param {unknown} id 任意一侧的 provider id。
 * @returns {{prefix: string, bare: string}} prefix 命中已知前缀时为该前缀，否则 ''；
 *   bare 为剥掉一次前缀后的余下部分（未命中前缀时就是原串）。
 */
export function providerIdentity(id) {
  const s = String(id ?? '')
  if (s === '') return { prefix: '', bare: '' }
  for (const prefix of PROVIDER_PREFIXES) {
    if (s.startsWith(prefix)) return { prefix, bare: s.slice(prefix.length) }
  }
  return { prefix: '', bare: s }
}

/**
 * 剥掉插件前缀，得到用户与配置文件里一贯使用的裸 provider id。
 *
 * @param {unknown} id 任意一侧的 provider id。
 * @returns {string} 裸 provider id；没有已知前缀的 id 原样返回。
 */
export function bareProvider(id) {
  return providerIdentity(id).bare
}

/**
 * 保留前缀的稳定标识：命中前缀时即原串，未命中时也是原串。
 *
 * 用于「同一渠道同一个 key」的诊断场景：ofm-qoder 与 caa-qoder 是两个插件注册的两条
 * 路由，不能当成同一个 key。**记账键不要用它**——分组条目只有一条裸 qoder，失败与并发
 * 必须按裸名合计，否则 ofm-qoder 失败后 isFailed('qoder', …) 仍为 false，路由会立刻
 * 再次选中它（liveProviderIdOf('qoder') 又解析回 ofm-qoder），形成失败死循环。
 *
 * @param {unknown} id 任意一侧的 provider id。
 * @returns {string} 带前缀的稳定标识。
 */
export function canonicalProvider(id) {
  const { prefix, bare } = providerIdentity(id)
  return prefix === '' ? bare : prefix + bare
}

/**
 * 两个 provider id 是否指同一个渠道。
 *
 * 规则：裸名相同，且（前缀相同 或 任一侧没有前缀）。
 *
 *  · providerEquals('codearts', 'ca-codearts') 为 true —— 裸配置兼容：groups.json 里
 *    写的裸 id 必须能对上注册表里的 ca-codearts。
 *  · providerEquals('ca-codearts', 'caa-codearts') 为 false —— 不同插件注册的两条
 *    路由（dsh-codearts 与 dsh-codearts-auth），不能混为一谈。
 *  · providerEquals('ofm-qoder', 'caa-qoder') 为 false —— 同上。
 *
 * @param {unknown} a 一侧的 provider id。
 * @param {unknown} b 另一侧的 provider id。
 * @returns {boolean} 指向同一渠道则为 true。
 */
export function providerEquals(a, b) {
  const x = providerIdentity(a)
  const y = providerIdentity(b)
  if (x.bare !== y.bare) return false
  return x.prefix === y.prefix || x.prefix === '' || y.prefix === ''
}

/**
 * 认领用的裸化：这个注册表 id 归不归「prefix 这个渠道」看。
 *
 * 与 bareProvider 的区别是「别的插件前缀下的 id 一律不算我的」：
 *  · channelBare('ca-', 'caa-codearts') 为 null —— caa- 是 dsh-codearts-auth 的，
 *    不能因为裸名也叫 codearts 就算到 dsh-codearts 头上；
 *  · channelBare('ofm-', 'qoder') 为 'qoder' —— 未打门面的裸 id 照旧参与认领；
 *  · channelBare('cq-', 'qoder') 为 'qoder' —— 同一个裸名各渠道都要能看见，
 *    归属由撞号规则决定（见 claimFreeChannels）。
 *
 * @param {string} prefix 渠道自己的前缀（FREE_CHANNELS 的 prefix）。
 * @param {unknown} id 注册表里的 provider id。
 * @returns {string|null} 剥掉本渠道前缀后的裸名；别的插件前缀下的 id 返回 null。
 */
export function channelBare(prefix, id) {
  const s = String(id ?? '')
  const p = String(prefix ?? '')
  if (p !== '' && s.startsWith(p)) return s.slice(p.length)
  const { prefix: other } = providerIdentity(s)
  if (other !== '') return null
  return s
}

/**
 * 免费渠道认领：每张卡片「此刻在线的是哪几条路由」，值是**注册表原始 id**。
 *
 * 规则（与原先 describeFreeChannels 里内联的那段一致，只是搬到纯函数里便于自检）：
 *
 *  1. 认领顺序：专用连接器按 channels 数组顺序在前，聚合渠道（aggregator === true）
 *     按数组顺序在后。聚合渠道若排在前面，会把专用连接器的 id 全吃掉。
 *  2. 撞号（contested）：某个裸名同时被本渠道与某个聚合渠道的正则命中时，专用连接器
 *     只在「自己装了 / 装没装未知(null) / 该裸名根本没被聚合渠道命中」时才认领；没装
 *     就让给聚合渠道。
 *  3. 归属判定（对每个注册表原始 id）：
 *     · 本插件前缀下的 id（含未打门面的裸 id）→ 对裸名跑本渠道正则；或干脆是本插件
 *       前缀（前缀本身就是归属声明，用于 codearts-auth 那种正则刻意不含 codearts 的卡）。
 *     · 别的插件前缀下的 id（channelBare 返回 null）→ 只有聚合渠道、且裸名命中它的
 *       正则时才认领：caa-qoder 归 Our Free Model 的正则，而 caa-codearts 不是
 *       dsh-codearts 的（那是 dsh-codearts-auth 注册的另一条路由）。
 *  4. claimed 以**注册表原始 id** 为粒度：ofm-qoder 与 caa-qoder 是两条不同的路由，
 *     按裸名去重会把其中一条吞掉。
 *
 * @param {{channels: Array<{id: string, pkg: string, prefix: string, aggregator?: boolean, providers: RegExp}>, providerIds: string[], isInstalled: (pkg: string) => boolean|null}} params
 *   channels 为 FREE_CHANNELS；providerIds 为 llm 注册表现场 id；isInstalled 返回该包
 *   装没装（null 表示服务不可用，此时按静态顺序认领）。
 * @returns {Map<string, string[]>} channelId -> 注册表原始 id 数组（顺序同 providerIds）。
 */
export function claimFreeChannels({ channels, providerIds, isInstalled }) {
  const list = Array.isArray(channels) ? channels : []
  const ids = (Array.isArray(providerIds) ? providerIds : [])
    .map(id => String(id ?? ''))
    .filter(Boolean)
  const installedOf = typeof isInstalled === 'function' ? isInstalled : () => null
  const aggregators = list.filter(c => c.aggregator === true)
  const claimOrder = [...list.filter(c => c.aggregator !== true), ...aggregators]
  /** @type {Map<string, string[]>} */
  const owned = new Map(list.map(c => [c.id, []]))
  /** @type {Set<string>} 已认领的注册表原始 id */
  const claimed = new Set()

  /** 该裸名是否同时被本渠道与某个聚合渠道命中（撞号） */
  const contested = (c) => aggregators.some(a => ids.some((id) => {
    const bare = bareProvider(id)
    return c.providers.test(bare) && a.providers.test(bare)
  }))

  for (const c of claimOrder) {
    const installedNow = installedOf(c.pkg)
    const mayClaim = c.aggregator === true || installedNow === null || installedNow === true || !contested(c)
    if (!mayClaim) continue
    const mine = owned.get(c.id)
    for (const id of ids) {
      if (claimed.has(id) || mine.includes(id)) continue
      const own = channelBare(c.prefix, id)
      const eligible = own === null
        // 别的插件前缀下的 id：只有聚合渠道按裸名认领（caa-qoder 归 Our Free Model）
        ? c.aggregator === true && c.providers.test(bareProvider(id))
        // 本插件前缀下的 id 与裸 id：正则或「就是本插件前缀」二者其一
        : (c.providers.test(own) || (String(c.prefix ?? '') !== '' && id.startsWith(String(c.prefix))))
      if (!eligible) continue
      claimed.add(id)
      mine.push(id)
    }
  }
  return owned
}
