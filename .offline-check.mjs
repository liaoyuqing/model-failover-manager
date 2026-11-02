/**
 * 离线自检：用假的 ctx 直接跑宿主半的监听器与 HTTP 处理器，不重启宿主即可验证行为。
 * 只在临时 dataDir 里读写，不碰真实的分组/绑定文件。
 *
 * 对齐新版宿主的契约：
 *   · 模型切换只经 `agent.model.select()`（写 durable model/selection）；
 *     `agent/request` 已废弃，改 provider/model 会让整轮崩掉 —— 本插件绝不注册它。
 *   · 健康检查挂在 `agent/status` 的 running 边沿（pre-step 之前的窗口）。
 *   · 失败切换在 `agent/request-error` 里 select + followup 排队续跑，不再返回 retry。
 *
 * 覆盖：
 *   ① 子代理沿 parentSession 继承分组（旧 bug 写进去的无 explicit 绑定必须被忽略）
 *   ② 子代理换模型走 agent.model.select()，不经 sessionController
 *   ③ 子代理彻底失败 → 切到组内下一个 + 排队续跑（不返回 retry）
 *   ④ 新子代理沿用宿主继承来的模型，不被拽回组内第一名
 *   ⑤ 每次发消息的健康检查：可用即保留，失败/出窗/过期才切
 *   ⑥ 给子代理绑分组不改变「新会话默认分组」
 *   ⑦ 手动标记失败 / ⑧ 禁用参与路由
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './host.mjs'
import { collectShimRegistrations } from './qoder-compress-shim.mjs'
// provider 前缀换算（六个插件各一个前缀 + 裸 id 共存），见 provider-prefix.mjs 顶部
import {
  PROVIDER_PREFIXES,
  providerIdentity,
  bareProvider,
  canonicalProvider,
  providerEquals,
  channelBare,
  claimFreeChannels,
} from './provider-prefix.mjs'

const dir = mkdtempSync(join(tmpdir(), 'mfm-offline-'))
// 与宿主同一套判据：北京时间当前小时，造一个「此刻必然不在窗内」的时段
const bjHour = Number(new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', hourCycle: 'h23', hour: '2-digit',
}).format(new Date()))
const badHour = (bjHour + 5) % 24

writeFileSync(join(dir, 'groups.json'), JSON.stringify([
  // g1：子代理继承链用
  { id: 'g1', name: 'G1', enabled: true, models: [
    { provider: 'p', model: 'm1', priority: 1 },
    { provider: 'p', model: 'm2', priority: 2 },
    { provider: 'p', model: 'm3', priority: 3 },
  ] },
  // g2：每轮健康检查的主分组
  { id: 'g2', name: 'G2', enabled: true, models: [
    { provider: 'p', model: 'm1', priority: 1 },
    { provider: 'p', model: 'm2', priority: 2 },
    { provider: 'p', model: 'm5', priority: 5 },
  ] },
  // g4：m4 的时段此刻必然不命中
  { id: 'g4', name: 'G4', enabled: true, models: [
    { provider: 'p', model: 'm4', priority: 1, windows: [{ from: badHour, to: badHour }] },
    { provider: 'p', model: 'm5', priority: 2 },
  ] },
  // g5：m6 的截止日已过
  { id: 'g5', name: 'G5', enabled: true, models: [
    { provider: 'p', model: 'm6', priority: 1, until: '2020-01-01' },
    { provider: 'p', model: 'm5', priority: 2 },
  ] },
]))
writeFileSync(join(dir, 'failed.json'), '[]')
writeFileSync(join(dir, 'default-binding.json'), JSON.stringify({ groupId: null }))
writeFileSync(join(dir, 'session-bindings.json'), JSON.stringify([
  { sessionId: 'parent-1', groupId: 'g1', mode: 'route' },
  { sessionId: 'sub-legacy', groupId: 'g1', mode: 'route' }, // 无 explicit：历史 bug 写入
  { sessionId: 'sub-explicit', groupId: 'g1', mode: 'route', explicit: true },
  // 每轮健康检查
  { sessionId: 'keep-1', groupId: 'g2', mode: 'route' },     // 当前 m2 可用 → 保留
  { sessionId: 'out-keep', groupId: 'g2', mode: 'failover' },// 当前 m99 不在组 → 不插手
  { sessionId: 'win-sess', groupId: 'g4', mode: 'route' },    // m4 出窗 → 切 m5
  { sessionId: 'exp-1', groupId: 'g5', mode: 'route' },       // m6 过期 → 切 m5
  { sessionId: 'probe-1', groupId: 'g2', mode: 'route' },     // m1 被标记失败 → 切 m2
]))

const appended = []
const followups = []
function makeSession(id, header, model) {
  const state = { model }
  return {
    id,
    header,
    state,
    append(type, data) { appended.push({ id, type, data }) },
    requestHeader() { return { config: { provider: 'p', model: state.model } } },
  }
}
/**
 * 假 Agent，按宿主新契约提供 `model.select/current` 与 `followup`。
 *
 * `selection` 模拟宿主的 durable model/selection 投影：select() 写它并抛一条
 * model/selection 事件（真实宿主由 AgentModel 完成），current() 读它 ——
 * 正是 preStep 取本步 selection 的那条路径。
 */
function makeAgent(id, header, model) {
  const session = makeSession(id, header, model)
  let selection
  const agent = {
    id,
    session,
    options: { provider: 'p', model },
    model: {
      current() { return selection ?? { provider: 'p', model: session.state.model } },
      select(next) {
        selection = { ...next }
        session.state.model = next.model
        appended.push({ id, type: 'model/selection', data: { ...next } })
        for (const fn of handlers.getAll('session/event')) fn(session, { type: 'model/selection', data: { ...next } })
      },
    },
    followup(message) {
      if (agent.status !== 'idle') throw new Error(`agent "${id}" cannot followup while ${agent.status}`)
      followups.push({ id, message })
    },
    status: 'idle',
  }
  return agent
}
const agents = [
  makeAgent('parent-1', {}, 'm1'),
  makeAgent('sub-legacy', { origin: 'subagent', parentSession: 'parent-1' }, 'm1'),
  makeAgent('sub-explicit', { origin: 'subagent', parentSession: 'parent-1' }, 'm1'),
  makeAgent('keep-1', {}, 'm2'),
  makeAgent('out-keep', {}, 'm99'),
  makeAgent('win-sess', {}, 'm4'),
  makeAgent('exp-1', {}, 'm6'),
  // ⑤ 之后才用到：m1 被标记失败后要切的会话
  makeAgent('probe-1', {}, 'm1'),
]

const handlers = new Map()
/** 取某事件的监听器数组（不存在时为空数组，不写入）。 */
handlers.getAll = event => handlers.get(event) ?? []
/** 取单监听器事件的唯一监听器；多监听器事件返回最后一个。 */
handlers.one = event => handlers.getAll(event).at(-1)
let routeHandler = null
let selectModelCalls = 0
/**
 * 假的 Our Free Model 账号池。
 *
 * 只对 'pool-p' 报出两个可用账号——正是「池里有这个 provider 的账号」这一事实，
 * 而 'codearts' 明明也有历史账号：插件必须靠 config.ofmHandoffExcludeProviders
 * 而不是账号存在性来判断是否换号。
 */
const poolCalls = []
const accountPool = {
  listAccountsByProvider(provider) {
    if (provider !== 'pool-p') return []
    return [
      { id: 'pool-p-1', provider, enabled: true },
      { id: 'pool-p-2', provider, enabled: true },
    ]
  },
  async getAvailableAccount(provider, model) {
    poolCalls.push(['getAvailableAccount', provider, model])
    return { entry: { id: 'pool-p-1' } }
  },
  async updateModelRateLimit(accountId, model, resetAt) {
    poolCalls.push(['updateModelRateLimit', accountId, model, resetAt])
  },
}
/** 假的 goal 服务：记录 resume 调用，并可预置某个会话的 goal 现场 */
const goalCalls = []
const goalState = new Map() // sessionId -> { id, revision, phase, activation }
const goalsService = {
  get(agent) {
    const st = goalState.get(String(agent?.session?.id))
    return st === undefined ? undefined : { ...st }
  },
  resume(agent, ref) {
    const sid = String(agent?.session?.id)
    goalCalls.push({ sid, ref: { ...ref } })
    const st = goalState.get(sid)
    if (st === undefined) throw new Error('no current goal')
    if (st.id !== ref.id || st.revision !== ref.revision) throw new Error('stale goal ref')
    if (st.phase === 'active' && st.activation === 'armed') throw new Error('already active and armed')
    if (st.phase !== 'active') throw new Error(`invalid phase ${st.phase}`)
    goalState.set(sid, { ...st, activation: 'armed' })
    return { ...goalState.get(sid) }
  },
}

const mountState = { count: 0, stub: false }
const applyTwice = (target, conf) => {
  mountState.count += 1
  mountState.stub = mountState.count > 1
  apply(target, conf)
  mountState.stub = false
}

// ㉞ 免费渠道推荐要读这两个服务：默认不存在（与原先「取不到就按没有算」一致），
// 只有那一段测试期间才装上，避免改变其它断言的现场。
let managerStub
let llmStub

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get(name) {
    if (name === 'pluginManager') return managerStub
    if (name === 'llm') return llmStub
    if (name === 'accountPool') return accountPool
    if (name === 'goals') return goalsService
    if (name === 'agents') return { list: () => agents, get: (id) => agents.find(a => a.id === id) }
    if (name === 'sessionController') {
      return {
        // 与宿主同一条规则：子代理会话一律拒绝（session/agent-busy）。
        // 新版插件根本不该走这条路——调用次数必须保持 0。
        selectModel({ sessionId, model }) {
          selectModelCalls++
          const agent = agents.find(a => a.id === sessionId)
          if (agent?.session?.header?.origin === 'subagent') {
            return Promise.reject(new Error(`session "${sessionId}" is owned by subagent routing`))
          }
          agent.model.select({ provider: 'p', model })
          return Promise.resolve()
        },
      }
    }
    return undefined
  },
  /** 同一事件的多个监听器都要保留：agent/status 上可能还挂着别的观察者。 */
  /**
   * 与 vendor/cordis 的 ctx.on 同语义：第三个参数是 { prepend }，prepend 用 unshift。
   *
   * 少了这一段，「㉖ 抢在 goal-round-driver 之前读 goal」就验不出来——删掉插件的
   * `{ prepend: true }` 照样全绿，那这条断言只是装饰。
   */
  on(event, fn, options) {
    // 只在第一次挂载时真正登记：同一进程里插件本来就只 apply 一次。
    if (mountState.stub) return () => {}
    const list = handlers.getAll(event)
    if (options?.prepend === true) list.unshift(fn)
    else list.push(fn)
    handlers.set(event, list)
    return () => { handlers.set(event, handlers.getAll(event).filter(f => f !== fn)) }
  },
  inject(_names, cb) {
    cb({
      webServer: { register(spec) { routeHandler = spec.handler; return () => {} } },
      effect() {}, interval() { return () => {} },
    })
  },
  effect() {}, interval() { return () => {} },
}

// 真实主机里 goal-round-driver 先于本插件装载，它监听 agent/error 并在**同一个 emit** 里
// 同步 disarm 活跃目标。这里先装上同样的监听器，本插件要抢在它前面读到 armed 现场，
// 就只能靠 prepend —— 这正是 ㉖ 要验的那条性质。
ctx.on('agent/error', ({ agent }) => {
  const sid = String(agent?.session?.id)
  const st = goalState.get(sid)
  if (st !== undefined && st.phase === 'active') goalState.set(sid, { ...st, activation: 'disarmed' })
})

applyTwice(ctx, { dataDir: dir })

// 插件在本进程只挂一次，所以直接取唯一那份监听器（下方 agent/error 的取法同理）。
const errHandler = handlers.one('agent/request-error')

function call(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  const res = {
    statusCode: 0, body: '',
    setHeader() {}, end(s) { this.body = s },
  }
  const done = routeHandler(req, res)
  if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  return Promise.resolve(done).then(() => ({ status: res.statusCode, body: JSON.parse(res.body || 'null') }))
}
const api = (method, path, body) => call(method, `/api/model-failover${path}`, body)
const sessionInfo = async (id) => (await api('GET', `/session-info?sessionId=${id}`)).body
const switchOf = (id) => appended.filter(a => a.id === id && a.type === 'model/selection').at(-1)?.data?.model ?? null

/**
 * 让一个会话此刻「打算用」某个模型。
 *
 * 真实宿主里这段状态由 AgentModel 从 durable model/selection 投影读出来，
 * 所以这里走 agent.model.select() —— 与本插件自己的切换同一条路径。
 */
function useModel(id, model) {
  agents.find(a => a.id === id).model.select({ provider: 'p', model })
}

/**
 * 跑一次「新一轮开始」：先发 status running（插件的挂钩），再看这一轮
 * pre-step 会读到哪个模型。宿主 preStep 先 emoji model.current() 取 selection，
 * 所以两者必须分别是「切换前窗口」与「切换后生效值」。
 */
async function runPreStep(id) {
  const agent = agents.find(a => a.id === id)
  for (const fn of handlers.getAll('agent/status')) fn({ agent, status: 'running' })
  // 插件的 reroute 是 void 的异步任务，让微任务跑完再读 selection。
  await new Promise(resolve => setTimeout(resolve, 0))
  return agent.model.current().model
}

const checks = []
function ok(name, pass, detail) {
  checks.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

// ── ① 子代理继承 ───────────────────────────────────────────────────────────
const legacy = await sessionInfo('sub-legacy')
ok('① 子代理忽略自身绑定、继承父会话分组',
  legacy.effectiveBinding?.groupId === 'g1'
  && legacy.effectiveBinding?.inherited === true
  && legacy.effectiveBinding?.viaSessionId === 'parent-1',
  JSON.stringify(legacy.effectiveBinding))

// ② 子代理换模型走自己的通道
selectModelCalls = 0
const set = await api('POST', '/session-model', { sessionId: 'sub-legacy', provider: 'p', model: 'm2' })
ok('② 子代理设模型成功且不经 sessionController',
  set.body.ok === true && selectModelCalls === 0 && set.body.model?.model === 'm2',
  `selectModelCalls=${selectModelCalls}`)
ok('② 子代理切换经 agent.model.select() 写 durable model/selection', switchOf('sub-legacy') === 'm2')

// ③ 失败续跑：select 新模型 + 排队续跑，不再返回 retry
ok('③ 插件不再注册已废弃的 agent/request', !handlers.has('agent/request'))

const failedAgent = agents.find(a => a.id === 'sub-explicit')
// 真实时序：request-error 运行在失败步骤收尾阶段，驱动器仍在跑（status=running）。
failedAgent.status = 'running'
const action = await errHandler(
  { agent: failedAgent, turn: 1, provider: 'p', failure: { code: 'QUOTA_EXCEEDED', message: '余额不足', status: 403 } },
  () => Promise.resolve(undefined),
)
ok('③ 彻底失败不返回 retry（本步 selection 已冻结，retry 也换不了模型）', action === undefined, JSON.stringify(action))
ok('③ 失败后切到组内下一个而不是被拽回第一个', switchOf('sub-explicit') === 'm2')
ok('③ 失败当下不投递续跑（驱动器还在跑，排队会被搁浅）',
  !followups.some(f => f.id === 'sub-explicit'))
failedAgent.status = 'idle'
for (const fn of handlers.getAll('agent/status')) fn({ agent: failedAgent, status: 'idle' })
ok('③ idle 边沿不同步投递（followup 会同步唤醒驱动器再发一次 running，嵌在 idle dispatch 里会让 GUI 收到倒序）',
  !followups.some(f => f.id === 'sub-explicit'))
await Promise.resolve()
ok('③ 本轮收尾（idle）后一个微任务内完成投递', followups.some(f => f.id === 'sub-explicit'))
ok('③ 续跑消息不会伪装成 user 发言',
  followups.find(f => f.id === 'sub-explicit')?.message?.source?.kind === 'model-failover')

const fresh = makeAgent('sub-fresh', { origin: 'subagent', parentSession: 'parent-1' }, 'm3')
agents.push(fresh)
ok('③ 新子代理沿用宿主继承来的 m3（组内第一是 m1）', (await runPreStep('sub-fresh')) === 'm3')

// ④ 每轮健康检查
ok('④ 当前模型可用 → 保留，不切换', (await runPreStep('keep-1')) === 'm2')
const outBefore = agents.find(a => a.id === 'out-keep').session.state.model
ok('④ 当前模型不在分组内 → 不插手用户的选择', (await runPreStep('out-keep')) === outBefore)
ok('④ 模型超出北京时间时段 → 切到组内可用模型', (await runPreStep('win-sess')) === 'm5')
ok('④ 模型过了截止日 → 切到组内可用模型', (await runPreStep('exp-1')) === 'm5')

// ⑤ 被标记当日失败的模型：新一轮必须换掉
ok('⑤ p/m1 已被标记当日失败', (await api('GET', '/status')).body.failed.some(f => f.provider === 'p' && f.model === 'm1'))
ok('⑤ 新一轮把失败的模型换成组内下一个', (await runPreStep('probe-1')) === 'm2')

// ⑥ 子代理绑分组不改默认分组
const defBefore = JSON.stringify((await api('GET', '/status')).body.defaultBinding)
await api('POST', '/session-group', { sessionId: 'sub-legacy', groupId: 'g1', mode: 'route' })
const defAfter = JSON.stringify((await api('GET', '/status')).body.defaultBinding)
ok('⑥ 子代理绑分组不改变「新会话默认分组」', defBefore === defAfter, `${defBefore} → ${defAfter}`)

// ⑦ 手动把分组里的模型标记为失败（分组页签模型块上的「失败」按钮）
const markAgent = makeAgent('mark-1', {}, 'm2')
agents.push(markAgent)
await api('POST', '/session-group', { sessionId: 'mark-1', groupId: 'g2', mode: 'route' })
await api('POST', '/failed/reset', { provider: 'p', model: 'm1' })
useModel('mark-1', 'm2')
ok('⑦ 前置：m2 可用时新一轮保留 m2', (await runPreStep('mark-1')) === 'm2')
const marked = await api('POST', '/failed/mark', { provider: 'p', model: 'm2' })
ok('⑦ 手动标记接口返回 ok', marked.body.ok === true)
const markRow = (await api('GET', '/status')).body.failed.find(f => f.provider === 'p' && f.model === 'm2')
ok('⑦ 复用同一份当日失败记录（code=MANUAL）',
  !!markRow && markRow.code === 'MANUAL', markRow && `code=${markRow.code} count=${markRow.count}`)
ok('⑦ 标记后下一轮换成组内其它可用模型', (await runPreStep('mark-1')) === 'm1')
await api('POST', '/failed/reset', { provider: 'p', model: 'm2' })
ok('⑦ 恢复失败后：仍不可用则保持替换结果（m1）', (await runPreStep('mark-1')) === 'm1')
useModel('mark-1', 'm2')
ok('⑦ 换回 m2 后新一轮仍保留它（恢复生效）', (await runPreStep('mark-1')) === 'm2')

// ⑧ 禁用参与路由：与失败分开的持久状态
const dis = await api('POST', '/groups/model-disabled', { provider: 'p', model: 'm2', disabled: true })
ok('⑧ 禁用接口成功，且覆盖所有含该模型的分组',
  dis.body.ok === true && dis.body.disabled === true, `groups=${dis.body.groups}`)
const m2Of = async () => (await api('GET', '/status')).body.groups.find(g => g.id === 'g2').models.find(m => m.model === 'm2')
ok('⑧ /status 回传 disabled=true', (await m2Of()).disabled === true)
ok('⑧ 禁用后下一轮不再选它（m2 是当前模型也会被换掉）', (await runPreStep('mark-1')) === 'm1')
ok('⑧ 禁用不受「恢复失败」影响（不是同一条状态）',
  (await api('POST', '/failed/reset', { provider: 'p', model: 'm2' })).body.ok === true
  && (await m2Of()).disabled === true)
const en = await api('POST', '/groups/model-disabled', { provider: 'p', model: 'm2', disabled: false })
ok('⑧ 解除禁用后字段被移除', en.body.disabled === false && !(await m2Of()).disabled)
useModel('mark-1', 'm2')
ok('⑧ 解除禁用后重新可被选中', (await runPreStep('mark-1')) === 'm2')

// ⑨ 状态序列诊断：续跑投递必须落在 idle 与下一次 running 之间
for (const fn of handlers.getAll('agent/status')) fn({ agent: failedAgent, status: 'running' })
const logResp = await api('GET', '/debug/status-log?sessionId=sub-explicit&limit=200')
const entries = logResp.body.entries ?? []
const lastSeq = (predicate) => [...entries].reverse().find(predicate)?.seq ?? -1
const idleSeq = lastSeq(e => e.kind === 'agent/status' && e.running === false)
const schedSeq = lastSeq(e => e.kind === 'continuation/scheduled')
const delivSeq = lastSeq(e => e.kind === 'continuation/delivered')
const runSeq = lastSeq(e => e.kind === 'agent/status' && e.running === true)
ok('⑨ 诊断接口可按会话取回状态事件序列', entries.length > 0, `entries=${entries.length}`)
ok('⑨ 顺序：idle → 排队续跑 → 投递 → running（running 不会嵌在 idle 之前）',
  idleSeq > 0 && idleSeq < schedSeq && schedSeq <= delivSeq && delivSeq < runSeq,
  `idle=${idleSeq} sched=${schedSeq} deliv=${delivSeq} running=${runSeq}`)
for (const fn of handlers.getAll('api-session/status')) fn('sub-explicit', true)
const logResp2 = await api('GET', '/debug/status-log?sessionId=sub-explicit&limit=5')
ok('⑨ 诊断同时记录转发给 GUI 的 api-session/status',
  (logResp2.body.entries ?? []).some(e => e.kind === 'api-session/status' && e.running === true),
  JSON.stringify((logResp2.body.entries ?? []).at(-1)))

// ⑨b 切换不得把活跃 goal 暂停：goal-round-driver 见到 agent/error 就 disarm，
//     而 failover 正是靠「让本轮以错误收尾」换模型，所以必须在续跑前把授权恢复。
//     界面把 active+disarmed 显示成「已暂停的目标」——这就是用户报的现象。
const goalSid = 'goal-sess'
const goalAgent = makeAgent(goalSid, {}, 'm1')
agents.push(goalAgent)
await api('POST', '/session-group', { sessionId: goalSid, groupId: 'g2', mode: 'route' })
goalState.set(goalSid, { id: 'goal-a', revision: 3, phase: 'active', activation: 'armed' })
goalCalls.length = 0
goalAgent.status = 'running'
await errHandler(
  { agent: goalAgent, turn: 1, provider: 'p', failure: { code: 'QUOTA_EXCEEDED', message: '余额不足', status: 403 } },
  () => Promise.resolve(undefined),
)
// 模拟宿主：切换时 goal 被 goal-round-driver disarm（我们只关心续跑阶段能否恢复）
goalState.set(goalSid, { id: 'goal-a', revision: 3, phase: 'active', activation: 'disarmed' })
goalAgent.status = 'idle'
for (const fn of handlers.getAll('agent/status')) fn({ agent: goalAgent, status: 'idle' })
await new Promise(resolve => setTimeout(resolve, 5))
ok('⑨b 切换后把被 disarm 的活跃 goal 重新 arm',
  goalState.get(goalSid)?.activation === 'armed',
  JSON.stringify(goalState.get(goalSid)))
ok('⑨b 恢复用的是切换前记下的 ref（revision 做 CAS）',
  goalCalls.some(c => c.sid === goalSid && c.ref.id === 'goal-a' && c.ref.revision === 3),
  JSON.stringify(goalCalls))
// 已经 armed 的 goal 不该被重复 resume（resume 会抛 GOAL_INVALID_TRANSITION）
goalState.set('goal-armed-2', { id: 'goal-b', revision: 1, phase: 'active', activation: 'armed' })
const armedAgent = makeAgent('goal-armed-2', {}, 'm1')
agents.push(armedAgent)
await api('POST', '/session-group', { sessionId: 'goal-armed-2', groupId: 'g2', mode: 'route' })
goalCalls.length = 0
armedAgent.status = 'running'
await errHandler(
  { agent: armedAgent, turn: 1, provider: 'p', failure: { code: 'QUOTA_EXCEEDED', message: '余额不足', status: 403 } },
  () => Promise.resolve(undefined),
)
armedAgent.status = 'idle'
for (const fn of handlers.getAll('agent/status')) fn({ agent: armedAgent, status: 'idle' })
await new Promise(resolve => setTimeout(resolve, 5))
ok('⑨b 本来就 armed 的 goal 不会被重复 resume',
  goalCalls.every(c => c.sid !== 'goal-armed-2'),
  JSON.stringify(goalCalls))
// 用户主动 pause 的 goal 绝不能被切换复活
goalState.set('goal-paused-3', { id: 'goal-c', revision: 2, phase: 'paused', activation: 'disarmed' })
const pausedAgent = makeAgent('goal-paused-3', {}, 'm1')
agents.push(pausedAgent)
await api('POST', '/session-group', { sessionId: 'goal-paused-3', groupId: 'g2', mode: 'route' })
goalCalls.length = 0
pausedAgent.status = 'running'
await errHandler(
  { agent: pausedAgent, turn: 1, provider: 'p', failure: { code: 'QUOTA_EXCEEDED', message: '余额不足', status: 403 } },
  () => Promise.resolve(undefined),
)
pausedAgent.status = 'idle'
for (const fn of handlers.getAll('agent/status')) fn({ agent: pausedAgent, status: 'idle' })
await new Promise(resolve => setTimeout(resolve, 5))
ok('⑨b 用户 pause 的 goal 不被切换复活',
  goalState.get('goal-paused-3')?.phase === 'paused'
  && goalState.get('goal-paused-3')?.activation === 'disarmed',
  JSON.stringify(goalState.get('goal-paused-3')))
// 三个 goal 用例各自切换都会在本子上记一条「当日失败」；清干净再跑后面的用例，
// 否则 ⑫ 会因为 g2 组内模型全被标记而找不到目标。
await api('POST', '/failed/reset', {})

// 离线自检不碰线上：任何 codearts 状态查询都返回空池、无签名证据。
// ⑪ 会按用例改写这个桩。
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  if (String(url).includes('/api/codearts/status')) return { ok: true, async json() { return { usage: { slots: [] } } } }
  return { ok: false, async json() { return {} } }
}

// ⑩ Our Free Model 换账号的 provider 归属：名单内的 provider 不参与换号
const caAgent = makeAgent('codearts-1', {}, 'm1')
agents.push(caAgent)
await api('POST', '/session-group', { sessionId: 'codearts-1', groupId: 'g2', mode: 'route' })
caAgent.status = 'running'
const caAction = await errHandler(
  { agent: caAgent, turn: 1, provider: 'codearts', failure: { code: 'hard_credit', message: 'codearts 上游错误 (http 402): quota exhausted', status: 402 } },
  () => Promise.resolve(undefined),
)
caAgent.status = 'idle'
const caLog = (await api('GET', '/status')).body.failureLog.find(f => f.provider === 'codearts')
ok('⑩ 名单内的 provider 不写账号冷却（池里就算留着它的历史账号）',
  !poolCalls.some(c => c[0] === 'updateModelRateLimit' && String(c[1]).startsWith('codearts')),
  JSON.stringify(poolCalls))
ok('⑩ codearts 失败不再被当成换号重试', caAction?.kind !== 'retry' && caLog?.outcome !== 'account-handoff',
  JSON.stringify({ action: caAction, outcome: caLog?.outcome }))
ok('⑩ codearts 失败照常进分组路由（标记失败 + 选下一个）',
  caLog?.outcome === 'switched' || caLog?.outcome === 'no-target', JSON.stringify(caLog))

// 对照：不在名单里的 provider 仍走换号（且写池级冷却）
const ofmAgent = makeAgent('ofm-1', {}, 'm1')
agents.push(ofmAgent)
await api('POST', '/session-group', { sessionId: 'ofm-1', groupId: 'g2', mode: 'route' })
ofmAgent.status = 'running'
const ofmAction = await errHandler(
  { agent: ofmAgent, turn: 1, provider: 'pool-p', failure: { code: 'QUOTA_EXCEEDED', message: '额度用尽', status: 403 } },
  () => Promise.resolve(undefined),
)
ofmAgent.status = 'idle'
ok('⑩ 名单外的 provider 仍先换账号重试（非限流失败也写冷却标记）',
  ofmAction?.kind === 'retry' && poolCalls.some(c => c[0] === 'updateModelRateLimit' && c[1] === 'pool-p-1'),
  JSON.stringify({ action: ofmAction, calls: poolCalls }))
ok('⑩ /status 回传生效的排除名单',
  JSON.stringify((await api('GET', '/status')).body.ofmHandoffExcludeProviders) === JSON.stringify(['codearts']))

// ⑪ dsh-codearts：分辨「可以重建账号池」与「billion-context 拒绝转发签名请求」
let restartCalls = 0
let codeartsRegistered = true
/** 假的 /api/codearts/status 应答；每个用例改写它 */
let codeartsStatus = { usage: { slots: [] } }
let providersHubRestarts = 0
const fakeLoader = {
  *entries() {
    // Providers Hub 的名字以 dsh-codearts 开头，且排在前面：旧实现用
    // includes('dsh-codearts') 匹配会先命中它，把「重建账号池」打在错误的实例上
    // （真正的 codearts 池仍是死的）。现在按包名精确匹配，命中的是 llm-codearts。
    yield { options: { id: 'codearts-auth', name: 'dsh-codearts-auth' }, fiber: { uid: 6, async restart() { providersHubRestarts += 1 } } }
    yield { options: { id: 'llm-codearts', name: 'dsh-codearts' }, fiber: { uid: 7, async restart() { restartCalls += 1 } } }
    yield { options: { id: 'other', name: 'some-other-plugin' }, fiber: { uid: 8, async restart() { throw new Error('不该重启这个') } } }
  },
}
const baseGet = ctx.get.bind(ctx)
const baseFetch = globalThis.fetch   // 即 ⑩ 之前装的桩
ctx.get = (name) => {
  if (name === 'loader') return fakeLoader
  if (name === 'llm') return { listProviders: () => codeartsRegistered ? [{ id: 'p', name: 'P' }, { id: 'codearts', name: 'CodeArts' }] : [{ id: 'p', name: 'P' }] }
  return baseGet(name)
}
// 插件用 fetch 读 codearts 状态接口；离线自检里换成可控应答，绝不发真实请求。
globalThis.fetch = async (url) => {
  if (String(url).includes('/api/codearts/status')) {
    return { ok: true, async json() { return codeartsStatus } }
  }
  return { ok: false, async json() { return {} } }
}

const poolEmptyMsg = 'codearts 当前没有可用账号（全部被禁用或冷却中），请稍后重试'
// ⑩ 已把 codearts 标成当日失败（那是它对真实上游错误的正确处置）；清掉再验 ⑪。
await api('POST', '/failed/reset', { provider: 'codearts', model: 'm1' })

/** 跑一次 codearts 失败，返回插件给宿主的动作 */
async function failOnCodearts(sessionId, failure, provider = 'codearts') {
  const a = makeAgent(sessionId, {}, 'm1')
  agents.push(a)
  await api('POST', '/session-group', { sessionId, groupId: 'g2', mode: 'route' })
  a.status = 'running'
  const act = await errHandler({ agent: a, turn: 1, provider, failure }, () => Promise.resolve(undefined))
  a.status = 'idle'
  return act
}
const lastLogFor = async (sessionId) => (await api('GET', '/status')).body.failureLog.find(f => f.sessionId === sessionId)

// B 类：池里账号被停用，但不是签名问题 → 重启条目即可
codeartsStatus = { usage: { slots: [
  { id: 'a1', state: 'disabled', detail: 'upstream 401' },
  { id: 'a2', state: 'disabled', detail: 'upstream 401' },
] } }
const reviveAction = await failOnCodearts('codearts-pool-1', { code: 'RATE_LIMIT', status: 429, message: poolEmptyMsg })
ok('⑪ 池被停用（非签名）时重启 dsh-codearts 条目', restartCalls === 1, `restartCalls=${restartCalls}`)
ok('⑪ 重建账号池成功后返回 retry（同一步重试，不换模型）', reviveAction?.kind === 'retry', JSON.stringify(reviveAction))
ok('⑪ 诊断记录 codearts-retry', (await lastLogFor('codearts-pool-1'))?.outcome === 'codearts-retry', JSON.stringify(await lastLogFor('codearts-pool-1')))
ok('⑪ 未把可自愈的池状态写成「模型当日失败」',
  !(await api('GET', '/status')).body.failed.some(f => f.provider === 'codearts'))

// A 类：billion-context 拒绝转发签名请求 → 重启没有任何用，也不能重试
const resignDetail = JSON.stringify({ error: { type: 'signed_request_requires_resign', code: 'bili_resign_unavailable' } })
codeartsStatus = { usage: { slots: [
  { id: 'a1', state: 'disabled', detail: resignDetail },
  { id: 'a2', state: 'disabled', detail: resignDetail },
] } }
const blockedAction = await failOnCodearts('codearts-signature-1', { code: 'RATE_LIMIT', status: 429, message: poolEmptyMsg })
ok('⑪ 签名中间层拒绝时不重启（重启救不了）', restartCalls === 1, `restartCalls=${restartCalls}`)
ok('⑪ 签名中间层拒绝时不返回 retry（避免对注定失败的链路反复重试）', blockedAction?.kind !== 'retry', JSON.stringify(blockedAction))
const blockedLog = await lastLogFor('codearts-signature-1')
ok('⑪ 诊断记录 codearts-signature-blocked 并给出修法',
  blockedLog?.outcome === 'codearts-signature-blocked'
  && (String(blockedLog.detail ?? '').includes('billion-context') || String(blockedLog.detail ?? '').includes('重签')),
  JSON.stringify(blockedLog))

// 池状态读不到（接口不可达）时按未知处理，不盲目重启
globalThis.fetch = async () => ({ ok: false, async json() { return {} } })
const unknownAction = await failOnCodearts('codearts-unknown-1', { code: 'RATE_LIMIT', status: 429, message: poolEmptyMsg })
ok('⑪ 池状态不可读时不盲目重启也不 retry', restartCalls === 1 && unknownAction?.kind !== 'retry',
  `restartCalls=${restartCalls} action=${JSON.stringify(unknownAction) ?? 'undefined'}`)
ok('⑪ 诊断记录 codearts-unrecoverable', (await lastLogFor('codearts-unknown-1'))?.outcome === 'codearts-unrecoverable',
  JSON.stringify(await lastLogFor('codearts-unknown-1')))

// /status 回传现场快照，界面能据此直接告诉用户该怎么办
globalThis.fetch = baseFetch
await api('POST', '/status')
const heal = (await api('GET', '/status')).body.codeartsSelfHeal
ok('⑪ /status 回传 codeartsSelfHeal 现场快照',
  heal && typeof heal.loaderAvailable === 'boolean' && typeof heal.blockedBySignature === 'boolean',
  JSON.stringify(heal))

// ⑫ 并发打满（capped）不能当成「账号故障」去重启，必须落给分组路由。
//    这正是用户报的「选了路由，但模型报错没有正确路由」：旧判定只数 disabled/cooling，
//    capped 不计，于是既不自愈也不换模型，直接把它们当成不可恢复放弃。
globalThis.fetch = async (url) => {
  if (String(url).includes('/api/codearts/status')) {
    return { ok: true, async json() { return codeartsStatus } }
  }
  return { ok: false, async json() { return {} } }
}
await api('POST', '/failed/reset', { provider: 'codearts', model: 'm1' })
restartCalls = 0
// 两个账号都没坏，只是并发满：active 达到 max，state=capped
codeartsStatus = { usage: { slots: [
  { id: 'a1', active: 2, max: 2, state: 'capped', detail: 'upstream session cap hit' },
  { id: 'a2', active: 2, max: 2, state: 'capped', detail: 'upstream session cap hit' },
] } }
const cappedAction = await failOnCodearts('codearts-capped-1', { code: 'soft_rate', status: 429, message: poolEmptyMsg })
ok('⑫ 并发打满时绝不重启账号池（重启只会打断在跑的请求）', restartCalls === 0, `restartCalls=${restartCalls}`)
ok('⑫ 并发打满时照常进分组路由（换模型，而不是放弃）',
  (await lastLogFor('codearts-capped-1'))?.outcome === 'capacity-switched',
  JSON.stringify(await lastLogFor('codearts-capped-1')))
ok('⑫ 并发打满不算不可恢复（action 不是被 codearts 分支拦下的 undefined）',
  cappedAction?.kind !== 'retry', JSON.stringify(cappedAction))
const cappedDiag = (await api('GET', '/status')).body.codeartsSelfHeal.lastDiagnosis
ok('⑫ 诊断给出 capped 而非 unknown', cappedDiag?.kind === 'capped', JSON.stringify(cappedDiag))

// ⑫b 并发类失败必须**临时**处置：写短冷却，不写当日失败。
//     这是用户报的「触发到模型并发时，临时切换到路由中其他模型」的核心契约。
const cappedStatus = (await api('GET', '/status')).body
ok('⑫b 并发失败不写进当日失败列表（否则一整天不参与路由）',
  !cappedStatus.failed.some(f => f.provider === 'codearts' && f.model === 'm1'),
  JSON.stringify(cappedStatus.failed))
const cooldownRow = cappedStatus.capacityCooldowns.find(c => c.key === 'codearts/m1')
ok('⑫b 并发失败写进 capacityCooldowns（短冷却）',
  cooldownRow !== undefined && cooldownRow.until > Date.now(), JSON.stringify(cooldownRow))
ok('⑫b capacityCooldowns 带可读原因',
  typeof cooldownRow?.reason === 'string' && cooldownRow.reason.length > 0, JSON.stringify(cooldownRow))
ok('⑫b 记录会话被从原模型临时换走（provider/model 是原模型）',
  (() => {
    const sw = cappedStatus.capacitySwitches.find(s => s.sessionId === 'codearts-capped-1')
    return sw?.provider === 'codearts' && sw?.model === 'm1'
  })(), JSON.stringify(cappedStatus.capacitySwitches))
ok('⑫b /status 回传并发三参数（冷却/排队超时/回切保护）',
  typeof cappedStatus.capacityCooldownMs === 'number'
  && typeof cappedStatus.concurrencyQueueTimeoutMs === 'number'
  && typeof cappedStatus.capacitySwitchRevertMs === 'number',
  JSON.stringify({
    cooldown: cappedStatus.capacityCooldownMs,
    queueTimeout: cappedStatus.concurrencyQueueTimeoutMs,
    revert: cappedStatus.capacitySwitchRevertMs,
  }))
// 冷却中的模型必须被排除出路由候选：这才是「临时切换到组内其它模型」的实际效果。
// 用一个同时含 codearts/m1 与 p/m5 的分组验证（g2 里没有 codearts/m1）。
await api('POST', '/groups', { id: 'gk', name: 'GK', models: [
  { provider: 'codearts', model: 'm1', priority: 1 },
  { provider: 'p', model: 'm5', priority: 2 },
] })
await api('POST', '/capacity/reset', {})
await api('POST', '/failed/reset', {})
const kSwitch = await (async () => {
  const a = makeAgent('capacity-pick-1', {}, 'm1')
  agents.push(a)
  await api('POST', '/session-group', { sessionId: 'capacity-pick-1', groupId: 'gk', mode: 'route' })
  a.status = 'running'
  const act = await errHandler({ agent: a, turn: 1, provider: 'codearts', failure: { code: 'soft_rate', status: 429, message: poolEmptyMsg } }, () => Promise.resolve(undefined))
  a.status = 'idle'
  return act
})()
const kSwitchLog = await lastLogFor('capacity-pick-1')
ok('⑫b 并发满时切到组内下一个模型（而不是原地不动）',
  kSwitchLog?.outcome === 'capacity-switched' && String(kSwitchLog.detail).includes('p/m5'),
  JSON.stringify(kSwitchLog))
ok('⑫b 并发满时不返回 retry（同一步重试仍会用同一个满模型）',
  kSwitch?.kind !== 'retry', JSON.stringify(kSwitch))
const kStatus = (await api('GET', '/status')).body
const kRow = kStatus.groups.find(g => g.id === 'gk')?.models?.find(m => m.provider === 'codearts' && m.model === 'm1')
ok('⑫b /status 的分组条目带 capacityCooldown（界面可显示冷却中）',
  kRow?.capacityCooldown !== null && typeof kRow?.capacityCooldown?.until === 'number',
  JSON.stringify(kRow))
// 冷却期内组内挑选必须避开它，直接命中 p/m5
ok('⑫b 冷却期内再挑一次仍然避开它', (() => {
  const pick = kStatus.activeModels.find(m => m.sessionId === 'capacity-pick-1')
  return pick?.provider === 'p' && pick?.model === 'm5'
})(), JSON.stringify(kStatus.activeModels))
await api('POST', '/capacity/reset', {})
await api('POST', '/failed/reset', {})
ok('⑫b 手动解除并发冷却后回到候选',
  (await api('GET', '/status')).body.capacityCooldowns.every(c => c.key !== 'codearts/m1'))
await api('POST', '/failed/reset', { provider: 'p', model: 'm1' })

// ── ㊶ 归属看前缀、记账看裸名：同名的两条路由不能被认成同一个插件 ──────────
// 六前缀之后，同一个裸名会有多个插件的路由（ofm-qoder 与 caa-qoder）。失败处置里
// 有两处按「归属」分流，必须看前缀：
//   · codearts 账号池自愈（重启 dsh-codearts 条目）只属于 ca- 与裸 codearts；
//     caa-codearts 是 Providers Hub 的路由，重启 dsh-codearts 救不了它。
//   · Our Free Model 的换号只属于 ofm- 与裸 id；ca-/caa- 的账号由各自的插件管。
// 之前这里把 provider 先剥成裸名再判归属，前缀信息全丢，两条判据都退化成「按裸名
// 猜」——caa-codearts 会被当成 dsh-codearts 的池故障，去重启一个无关的实例。
await api('POST', '/failed/reset', {})
await api('POST', '/capacity/reset', {})
restartCalls = 0
providersHubRestarts = 0
// 池子读得到「账号被停用」，所以 codearts 分支会真的走重建分支
codeartsStatus = { usage: { slots: [
  { id: 'a1', state: 'disabled', detail: 'upstream 401' },
] } }
// Providers Hub 的路由（caa-codearts）失败：不该去重启 dsh-codearts 的条目
const caaAction = await failOnCodearts('caa-pool-1', { code: 'RATE_LIMIT', status: 429, message: poolEmptyMsg }, 'caa-codearts')
const caaOutcome = (await lastLogFor('caa-pool-1'))?.outcome
ok('㊶ caa-codearts 的失败不进 dsh-codearts 的自愈分支（那是别人的账号池）',
  !String(caaOutcome ?? '').startsWith('codearts-'),
  `outcome=${caaOutcome}`)
ok('㊶ caa-codearts 的失败不重启任何条目（既不 dsh-codearts 也不 Providers Hub）',
  restartCalls === 0 && providersHubRestarts === 0,
  `restartCalls=${restartCalls} providersHubRestarts=${providersHubRestarts}`)
ok('㊶ caa-codearts 的失败落进分组路由，不返回 retry（重试对 Providers Hub 无意义）',
  caaAction?.kind !== 'retry', JSON.stringify(caaAction))

// 同一个名字、同一句话，但属于 dsh-codearts 自己（ca-codearts）：照旧走自愈分支
// （自愈本身有没有重启条目取决于 30s 冷却，这里只守「进了哪条分支」）
const caPrefixedAction = await failOnCodearts('ca-pool-1', { code: 'RATE_LIMIT', status: 429, message: poolEmptyMsg }, 'ca-codearts')
const caOutcome = (await lastLogFor('ca-pool-1'))?.outcome
ok('㊶ ca-codearts 的失败照旧进 dsh-codearts 的自愈分支（与裸 codearts 同一条路径）',
  String(caOutcome ?? '').startsWith('codearts-'),
  `outcome=${caOutcome}`)
ok('㊶ 自愈只重启 dsh-codearts，绝不重启 Providers Hub（按包名精确匹配）',
  providersHubRestarts === 0, `providersHubRestarts=${providersHubRestarts}`)

// 换号只属于 Our Free Model：caa- 前缀的路由不走 OFM 的账号池。
// 用 'caa-pool-p'（裸名 pool-p，池里真有两个可用账号）做这个用例：裸名不在排除名单里，
// 所以只要前缀被提前剥掉，它就会真的换号——这条断言因此能抓住「剥前缀后判归属」。
const poolCallsBefore = poolCalls.length
const caaHandoffAction = await failOnCodearts('caa-handoff-1', { code: 'QUOTA_EXCEEDED', message: '额度用尽', status: 403 }, 'caa-pool-p')
ok('㊶ caa- 路由的失败不触发 Our Free Model 的换号（账号不归它管）',
  poolCalls.length === poolCallsBefore && caaHandoffAction?.kind !== 'retry',
  JSON.stringify({ action: caaHandoffAction, calls: poolCalls.slice(poolCallsBefore) }))
await api('POST', '/failed/reset', {})
await api('POST', '/capacity/reset', {})

// ⑬ 模型并发上限：按模型（全局）配置生效，且 llm/stream 闸门按它判满并当场交给路由换模型。
await api('POST', '/failed/reset', { provider: 'codearts', model: 'm1' })
await api('POST', '/groups', { id: 'gc', name: 'GC', models: [
  { provider: 'pc', model: 'mc', priority: 1 },
] })
// 并发以模型为单位配置；分组条目上的 concurrency 不再生效
const concSet = await api('POST', '/model-concurrency', { provider: 'pc', model: 'mc', concurrency: 1 })
ok('⑬ POST /model-concurrency 生效', concSet.status === 200 && concSet.body?.concurrency === 1,
  JSON.stringify(concSet.body))
const gcStatus = (await api('GET', '/status')).body.groups.find(g => g.id === 'gc')
ok('⑬ 分组条目回传生效的并发上限', gcStatus?.models?.[0]?.concurrency === 1, JSON.stringify(gcStatus?.models?.[0]))
ok('⑬ /status.modelConcurrency 带按模型配置',
  (await api('GET', '/status')).body.modelConcurrency?.['pc/mc'] === 1,
  JSON.stringify((await api('GET', '/status')).body.modelConcurrency))
ok('⑬ 分组条目回传当前 inflight',
  typeof gcStatus?.models?.[0]?.inflight === 'number', JSON.stringify(gcStatus?.models?.[0]))
// 同一模型出现在第二个分组时，上限仍然来自按模型的配置，不随分组漂移
await api('POST', '/groups', { id: 'gc2', name: 'GC2', models: [
  { provider: 'pc', model: 'mc', priority: 1 },
] })
const gc2Status = (await api('GET', '/status')).body.groups.find(g => g.id === 'gc2')
ok('⑬ 同一模型在其它分组沿用同一上限', gc2Status?.models?.[0]?.concurrency === 1,
  JSON.stringify(gc2Status?.models?.[0]))
// 清除覆盖后回落到 defaultConcurrency（本用例默认 0 = 不限 → null）
const concCleared = await api('POST', '/model-concurrency', { provider: 'pc', model: 'mc', concurrency: null })
ok('⑬ 清除覆盖后回落默认（不限）',
  concCleared.status === 200 && concCleared.body?.concurrency === null && concCleared.body?.effective === null,
  JSON.stringify(concCleared.body))
ok('⑬ 非法并发值被拒绝',
  (await api('POST', '/model-concurrency', { provider: 'pc', model: 'mc', concurrency: -3 })).status === 400)
// 恢复 1，供后面的闸门与看板断言使用
await api('POST', '/model-concurrency', { provider: 'pc', model: 'mc', concurrency: 1 })
// 直接驱动 llm/stream 闸门：并发已满时第二个流不再排队等槽，而是当场以 CAPACITY_TIMEOUT
// 收尾——宿主把它当一次失败交给 agent/request-error，本插件据此换到组内空闲模型。
const streamHandler = handlers.getAll('llm/stream').at(-1)
ok('⑬ 插件注册了 llm/stream（并发闸门与速度采样挂在这里）', typeof streamHandler === 'function',
  `listeners=${handlers.getAll('llm/stream').length}`)
/** 造一个可控的假流：yield 几个 delta 与 usage，再由 releaseFlag 决定何时结束 */
function fakeStream(gate) {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text: 'hel' }
    yield { type: 'text-delta', index: 0, text: 'lo' }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } }
    if (gate !== undefined) await gate
    yield { type: 'finish', reason: 'stop' }
  })()
}
const gateA = Promise.withResolvers()
const outA = []
const outB = []
let bCalledUpstream = false
const iterA = await streamHandler({ provider: 'pc', model: 'mc', messages: [] }, () => fakeStream(gateA.promise))
const iterB = await streamHandler({ provider: 'pc', model: 'mc', messages: [] }, () => {
  bCalledUpstream = true
  return fakeStream()
})
// gate 由测试外部放开；流自己绝不 resolve 自己的 gate（否则会自我死锁）。
const finishedA = (async () => { for await (const c of iterA) outA.push(c.type) })()
const finishedB = (async () => { for await (const c of iterB) outB.push(c) })()
await new Promise(r => setTimeout(r, 40))
// 第二个流在闸门里就被判失败：唯一一个 chunk 是 finish(error)，没有首字、没有 usage。
ok('⑬ 并发=1 时第二个流不再排队，当场以 CAPACITY_TIMEOUT 失败（满了就换模型）',
  outB.length === 1 && outB[0]?.type === 'finish' && outB[0]?.reason?.kind === 'error'
  && outB[0]?.reason?.failure?.code === 'CAPACITY_TIMEOUT',
  `outB=${JSON.stringify(outB)}`)
ok('⑬ 满了就不再去上游（不占着连接空等首字）', bCalledUpstream === false)
ok('⑬ 第一个流不受第二个流失败影响（还没跑完）', outA.includes('finish') === false, `outA=${JSON.stringify(outA)}`)
const cappedRow = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pc' && r.model === 'mc')
// 记进采样是为了看板能说明「为什么切了」；只记成功会让满槽失败变成看不见的空白。
ok('⑬ 满槽失败记进采样（看板看得见原因，不冒充成功）',
  cappedRow?.lastErrorCode === 'CAPACITY_TIMEOUT',
  JSON.stringify({ lastErrorCode: cappedRow?.lastErrorCode, okSamples: cappedRow?.okSamples }))
gateA.resolve()
await Promise.all([finishedA, finishedB])
ok('⑬ 第一个流完整透传（闸门不改写 chunk）',
  outA.join(',') === 'text-delta,text-delta,usage,finish', `outA=${outA.join(',')}`)
// 闸门放开后再跑一次成功调用：上面那条满槽失败不是成功样本，而 ⑰/⑱/⑲ 的 token 累计
// 需要两个成功样本（这是这次改动与之前唯一的行为差别）。
const openGate = Promise.withResolvers()
const iterOpen = await streamHandler({ provider: 'pc', model: 'mc', messages: [] }, () => fakeStream(openGate.promise))
openGate.resolve()
for await (const _c of iterOpen) { /* 只为补一个成功样本 */ }

// ⑬b 未配置并发上限的模型：不排队，但「当前并发」照样计数（数据看板要显示它）
//     上限与计数是两件事：limit=0 只意味着「不排队」，不是「不统计」。
//     这一条盯的正是那个曾经把计数整段跳过的早退分支。
await api('POST', '/groups', { id: 'gu', name: 'GU', models: [
  { provider: 'pu', model: 'mu', priority: 1 },
] })
const guRow = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pu' && r.model === 'mu')
ok('⑬b 未配置上限：看板行 concurrency 为 null（不限）但 inflight 仍是数字',
  guRow?.concurrency === null && typeof guRow?.inflight === 'number' && guRow.inflight === 0,
  JSON.stringify(guRow && { concurrency: guRow.concurrency, inflight: guRow.inflight, queued: guRow.queued }))
const looseA = Promise.withResolvers()
const looseB = Promise.withResolvers()
const iterU1 = await streamHandler({ provider: 'pu', model: 'mu', messages: [] }, () => fakeStream(looseA.promise))
const iterU2 = await streamHandler({ provider: 'pu', model: 'mu', messages: [] }, () => fakeStream(looseB.promise))
const outU1 = []
const outU2 = []
const doneU1 = (async () => { for await (const c of iterU1) outU1.push(c.type) })()
const doneU2 = (async () => { for await (const c of iterU2) outU2.push(c.type) })()
await new Promise(r => setTimeout(r, 40))
ok('⑬b 不限上限时两个流同时拿到首字（没有排队）', outU1.length > 0 && outU2.length > 0,
  `outU1=${JSON.stringify(outU1)} outU2=${JSON.stringify(outU2)}`)
const liveRow = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pu' && r.model === 'mu')
ok('⑬b 不限上限的模型进行中计数跟着流走（此刻 2）',
  liveRow?.inflight === 2 && liveRow?.queued === 0,
  JSON.stringify({ inflight: liveRow?.inflight, queued: liveRow?.queued }))
const liveStatus = (await api('GET', '/status')).body.groups.find(g => g.id === 'gu')?.models?.[0]
ok('⑬b /status 也报出进行中计数（不只有上限的模型才有）',
  liveStatus?.concurrency === null && liveStatus?.inflight === 2,
  JSON.stringify({ concurrency: liveStatus?.concurrency, inflight: liveStatus?.inflight }))
// ⑭b 实时总速度：借 ⑬b 的两路并发窗口读它，因为这一格问的正是「此刻在跑的请求加起来多快」。
//     它不是历史 P50（那两个数回答的不是同一个问题），所以必须在流还没结束时才有值。
ok('⑭b 有流在跑时行上带活跃区间合计速度 aggregateTps > 0',
  typeof liveRow?.aggregateTps === 'number' && liveRow.aggregateTps > 0,
  JSON.stringify({ aggregateTps: liveRow?.aggregateTps }))
looseA.resolve()
looseB.resolve()
await Promise.all([doneU1, doneU2])
const afterRow = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pu' && r.model === 'mu')
ok('⑬b 流结束后计数归零（不会只涨不落）',
  afterRow?.inflight === 0 && afterRow?.queued === 0,
  JSON.stringify({ inflight: afterRow?.inflight, queued: afterRow?.queued }))
// 实时值必须跟着流消失：留着会让看板一直显示一个不动的数，比空着更容易误读。
ok('⑭b 流结束后合计速度回到 null（不留一个不动的数）',
  afterRow?.aggregateTps === null, JSON.stringify({ aggregateTps: afterRow?.aggregateTps }))
ok('⑬b 两个流都完整透传（无上限这条路也不改写 chunk）',
  outU1.join(',') === 'text-delta,text-delta,usage,finish'
  && outU2.join(',') === 'text-delta,text-delta,usage,finish',
  `outU1=${outU1.join(',')} outU2=${outU2.join(',')}`)
// ⑭c 活跃区间合计：分母必须是「这批请求共同的活跃区间」，不是每个请求各算各的时长。
//     构造一个「很早就产出、之后一直没动静」的请求 A 和一个「刚开始、一口气吐很多」的
//     请求 B：A 已静默 600ms，B 的字符是在最近几十毫秒里出的。若各请求各算各的时长
//     （旧口径），B 会被算成上万 tok/s 的瞬时值；用共同区间作分母，读数就是
//     (A+B 的总字符) ÷ 4 ÷ 区间秒数，量级在千级。
const holdLateA = Promise.withResolvers()
const holdLateB = Promise.withResolvers()
async function* charStream(text, gate) {
  yield { type: 'text-delta', text }
  await gate
  yield { type: 'finish', reason: 'stop' }
}
const iterLateA = await streamHandler({ provider: 'pu', model: 'mu', messages: [] }, () => charStream('aaaa', holdLateA.promise))
const doneLateA = (async () => { for await (const _c of iterLateA) { /* 保持活跃 */ } })()
await new Promise(r => setTimeout(r, 600))
const iterLateB = await streamHandler({ provider: 'pu', model: 'mu', messages: [] }, () => charStream('b'.repeat(4000), holdLateB.promise))
const doneLateB = (async () => { for await (const _c of iterLateB) { /* 保持活跃 */ } })()
await new Promise(r => setTimeout(r, 60))
const lateRow = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pu' && r.model === 'mu')
ok('⑭c 合计速度的分母是共同活跃区间（刚起步的请求不会虚高）',
  typeof lateRow?.aggregateTps === 'number' && lateRow.aggregateTps > 200 && lateRow.aggregateTps < 8000,
  JSON.stringify({ aggregateTps: lateRow?.aggregateTps }))
holdLateA.resolve()
holdLateB.resolve()
await Promise.all([doneLateA, doneLateB])
await api('DELETE', '/groups/gu')

// ⑭d 默认并发（面板级设置）：改一次对「所有没有单独设上限的模型」生效，并且落进 settings.json。
//     出厂值来自 config；界面覆盖存 settings.json，重启后仍在。0 是合法上限（不限），
//     所以「没设置」只能用 null 表示，不能用 0 冒充——否则清空界面输入框会变成「设成不限」。
await api('POST', '/groups', { id: 'gdef', name: 'GDEF', models: [
  { provider: 'pd', model: 'md', priority: 1 },
  { provider: 'pd', model: 'md2', priority: 2 },
] })
const dflBefore = (await api('GET', '/status')).body
ok('⑭d 默认并发未覆盖时跟随 config 出厂值',
  dflBefore.settings?.defaultConcurrency === null
  && dflBefore.defaultConcurrency === dflBefore.configDefaultConcurrency,
  JSON.stringify({ settings: dflBefore.settings?.defaultConcurrency, eff: dflBefore.defaultConcurrency, cfg: dflBefore.configDefaultConcurrency }))
const dflRowBefore = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pd' && r.model === 'md')
ok('⑭d 没设默认并发时模型不限（concurrency 为 null）', dflRowBefore?.concurrency === null,
  JSON.stringify({ concurrency: dflRowBefore?.concurrency }))
const dflSet = await api('POST', '/settings', { defaultConcurrency: 1 })
const dflAfter = (await api('GET', '/status')).body
const dflRowAfter = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pd' && r.model === 'md')
ok('⑭d 设了默认并发后，没单独配置的模型立刻按它算',
  dflSet.status === 200 && dflAfter.defaultConcurrency === 1
  && dflAfter.settings?.defaultConcurrency === 1 && dflRowAfter?.concurrency === 1,
  JSON.stringify({ status: dflSet.status, eff: dflAfter.defaultConcurrency, row: dflRowAfter?.concurrency }))
// 闸门认的是同一个生效值：默认 1 时第二个流也当场判满，交给人去换模型。
const holdDefault = Promise.withResolvers()
const iterDef = await streamHandler({ provider: 'pd', model: 'md', messages: [] }, () => fakeStream(holdDefault.promise))
const doneDef = (async () => { for await (const _c of iterDef) { /* 占住唯一的槽 */ } })()
await new Promise(r => setTimeout(r, 30))
const outDef2 = []
const iterDef2 = await streamHandler({ provider: 'pd', model: 'md', messages: [] }, () => fakeStream())
for await (const c of iterDef2) outDef2.push(c)
ok('⑭d 默认并发同样会被闸门判满（超了立刻交给路由，不排队）',
  outDef2.length === 1 && outDef2[0]?.type === 'finish' && outDef2[0]?.reason?.failure?.code === 'CAPACITY_TIMEOUT',
  JSON.stringify(outDef2))
holdDefault.resolve()
await doneDef
ok('⑭d 非法默认并发被拒绝',
  (await api('POST', '/settings', { defaultConcurrency: -1 })).status === 400)
const dflCleared = await api('POST', '/settings', { defaultConcurrency: null })
const dflClearedStatus = (await api('GET', '/status')).body
const dflRowCleared = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pd' && r.model === 'md')
ok('⑭d 清空后回落 config 出厂值（模型重新不限）',
  dflCleared.status === 200 && dflClearedStatus.settings?.defaultConcurrency === null
  && dflClearedStatus.defaultConcurrency === dflClearedStatus.configDefaultConcurrency
  && dflRowCleared?.concurrency === null,
  JSON.stringify({ settings: dflClearedStatus.settings?.defaultConcurrency, eff: dflClearedStatus.defaultConcurrency, row: dflRowCleared?.concurrency }))
await api('DELETE', '/groups/gdef')

// ⑬c 并发满了换模型，不排队（这条盯的是「不要排队」的终点，不只是闸门那一刻）
//     闸门立刻判失败只是第一步：这次失败要真的变成「临时切到组内其它模型」；而整组都满
//     时必须等槽位释放再切，不能就此判死——否则「不排队」就变成了「直接失败」。
await api('POST', '/groups', { id: 'gcap', name: 'GCAP', models: [
  { provider: 'pcx', model: 'mx', priority: 1 },
  { provider: 'pcx', model: 'mx2', priority: 2 },
] })
await api('POST', '/model-concurrency', { provider: 'pcx', model: 'mx', concurrency: 1 })
await api('POST', '/model-concurrency', { provider: 'pcx', model: 'mx2', concurrency: 1 })
// 顺序很关键：会话先绑组（此刻 mx 空着，所以落在 priority 1 的 mx），再把 mx 占满。
// 反过来做就成了「会话本来就在 mx2 上，却收到一条 mx 的满分失败」——那不是要验的场景。
const a = makeAgent('cap-switch-1', {}, 'mx')
agents.push(a)
await api('POST', '/session-group', { sessionId: 'cap-switch-1', groupId: 'gcap', mode: 'route' })
const routedTo = switchOf('cap-switch-1')
const holdMx = Promise.withResolvers()
const iterMx = await streamHandler({ provider: 'pcx', model: 'mx', messages: [] }, () => fakeStream(holdMx.promise))
const drainMx = (async () => { for await (const _c of iterMx) { /* 只为占住槽位 */ } })()
await new Promise(r => setTimeout(r, 30))
{
  const mxRow = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pcx' && r.model === 'mx')
  ok('⑬c 会话先绑到组的首选模型（它是后面失败的模型）', routedTo === 'mx', JSON.stringify({ routedTo }))
  ok('⑬c 先占满 mx（1/1），组内还剩 mx2 空着', mxRow?.inflight === 1, JSON.stringify({ inflight: mxRow?.inflight }))
  a.status = 'running'
  const startedAt = Date.now()
  await errHandler({ agent: a, turn: 1, provider: 'pcx',
    failure: { code: 'CAPACITY_TIMEOUT', message: 'pcx/mx 的并发已满（1/1），立刻换组内其它模型' } },
    () => Promise.resolve(undefined))
  const elapsedMs = Date.now() - startedAt
  a.status = 'idle'
  const log = await lastLogFor('cap-switch-1')
  // 不是原地重试同一个满模型，而是换到空闲的兄弟——这才是「临时切到其他模型」。
  ok('⑬c 并发满了临时切到组内空闲的兄弟模型',
    log?.outcome === 'capacity-switched' && switchOf('cap-switch-1') === 'mx2',
    JSON.stringify({ outcome: log?.outcome, model: switchOf('cap-switch-1') }))
  ok('⑬c 有兄弟可用时立刻切，没在任何地方等槽', elapsedMs < 1000, `elapsedMs=${elapsedMs}`)
  for (const fn of handlers.getAll('agent/status')) fn({ agent: a, status: 'idle' })
  await Promise.resolve()
  ok('⑬c 切换后照样排一条续跑（换了模型，话得接着说）',
    followups.some(f => f.id === 'cap-switch-1'), JSON.stringify(followups.map(f => f.id)))
}
holdMx.resolve()
await drainMx

// ⑬c 续：整组都满 → 等槽位释放（concurrencyQueueTimeoutMs 只管这一段），而不是判死
const holdMxAgain = Promise.withResolvers()
const holdMx2 = Promise.withResolvers()
const iterMxA = await streamHandler({ provider: 'pcx', model: 'mx', messages: [] }, () => fakeStream(holdMxAgain.promise))
const iterMx2 = await streamHandler({ provider: 'pcx', model: 'mx2', messages: [] }, () => fakeStream(holdMx2.promise))
const drainMxA = (async () => { for await (const _c of iterMxA) { /* 占住 */ } })()
const drainMx2 = (async () => { for await (const _c of iterMx2) { /* 占住 */ } })()
await new Promise(r => setTimeout(r, 30))
{
  const pcxRows = (await api('GET', '/metrics')).body.rows.filter(r => r.provider === 'pcx')
  const rowOf = (name) => pcxRows.find(r => r.model === name)
  ok('⑬c 组内两个模型都占满（各自 1/1）',
    rowOf('mx')?.inflight === 1 && rowOf('mx2')?.inflight === 1,
    JSON.stringify(pcxRows.map(r => ({ m: r.model, i: r.inflight, q: r.queued }))))
  const a = makeAgent('cap-wait-1', {}, 'mx')
  agents.push(a)
  await api('POST', '/session-group', { sessionId: 'cap-wait-1', groupId: 'gcap', mode: 'route' })
  a.status = 'running'
  const waiting = errHandler({ agent: a, turn: 1, provider: 'pcx',
    failure: { code: 'CAPACITY_TIMEOUT', message: 'pcx/mx 的并发已满（1/1），立刻换组内其它模型' } },
    () => Promise.resolve(undefined))
  await new Promise(r => setTimeout(r, 60))
  // 唯一能换过去的 mx2 也满 → 只能等它释放；看板上的 queued 就是这件事的读数。
  // 这一刻 errHandler 还没返回，所以这条断言证明的是「在等」，不是「等完失败了」。
  const waitingRows = (await api('GET', '/metrics')).body.rows.filter(r => r.provider === 'pcx')
  ok('⑬c 整组都满时不判死，转成等槽位（看板 queued≥1）',
    waitingRows.reduce((sum, r) => sum + (r.queued ?? 0), 0) >= 1,
    JSON.stringify(waitingRows.map(r => ({ m: r.model, i: r.inflight, q: r.queued }))))
  // 两个槽位一起放开：等的是哪一个都不影响「等到了就切」这件事，也避免用例自己死锁。
  holdMx2.resolve()
  holdMxAgain.resolve()
  await waiting
  a.status = 'idle'
  const log = await lastLogFor('cap-wait-1')
  const picks = appended.filter(e => e.id === 'cap-wait-1').map(e => e.data?.model)
  // 等到的那个模型必须真的换了人（不是原地不动），并且记成一次并发切换。
  ok('⑬c 槽位一释放就切过去（等到就是切，不是放弃）',
    log?.outcome === 'capacity-switched' && picks.at(-1) === 'mx2',
    JSON.stringify({ outcome: log?.outcome, picks }))
  const freedRows = (await api('GET', '/metrics')).body.rows.filter(r => r.provider === 'pcx')
  ok('⑬c 等到槽位后 queued 归零（等人这件事有始有终）',
    freedRows.every(r => (r.queued ?? 0) === 0), JSON.stringify(freedRows.map(r => ({ m: r.model, q: r.queued }))))
}
await Promise.all([drainMxA, drainMx2])
await api('POST', '/model-concurrency', { provider: 'pcx', model: 'mx', concurrency: null })
await api('POST', '/model-concurrency', { provider: 'pcx', model: 'mx2', concurrency: null })
await api('POST', '/capacity/reset', {})
await api('DELETE', '/groups/gcap')

// ⑭ 数据看板：首字延迟与输出速度
const metrics = (await api('GET', '/metrics')).body
ok('⑭ /metrics 返回分组内模型的看板行', Array.isArray(metrics?.rows) && metrics.rows.length > 0,
  `rows=${metrics?.rows?.length}`)
const mcRow = metrics.rows.find(r => r.provider === 'pc' && r.model === 'mc')
ok('⑭ 看板行带首字延迟与速度字段',
  mcRow !== undefined && 'ttftP50' in mcRow && 'tpsP50' in mcRow && 'samples' in mcRow,
  JSON.stringify(mcRow))
ok('⑭ 采集到了样本（两次调用）', mcRow?.samples >= 2, `samples=${mcRow?.samples}`)
ok('⑭ 首字延迟是正数（毫秒）', typeof mcRow?.ttftP50 === 'number' && mcRow.ttftP50 >= 0, `ttftP50=${mcRow?.ttftP50}`)
ok('⑭ 输出速度按 usage.outputTokens 算出正数（token/s）',
  typeof mcRow?.tpsP50 === 'number' && mcRow.tpsP50 > 0, `tpsP50=${mcRow?.tpsP50}`)
ok('⑭ 看板行同时带并发现场（上限/占用/排队）',
  mcRow?.concurrency === 1 && typeof mcRow?.inflight === 'number' && typeof mcRow?.queued === 'number',
  JSON.stringify({ concurrency: mcRow?.concurrency, inflight: mcRow?.inflight, queued: mcRow?.queued }))
ok('⑭ 未采集过的模型也有行（样本 0，字段为 null）', (() => {
  const empty = metrics.rows.find(r => r.samples === 0)
  return empty !== undefined && empty.ttftP50 === null && empty.tpsP50 === null
})(), JSON.stringify(metrics.rows.find(r => r.samples === 0)))

// ⑮ 日期筛选：按北京时间整天，在 Host 侧筛（区间内的分位数与合计要在同一批样本上算）
const bjDay = (offsetDays) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(Date.now() + offsetDays * 86_400_000))
const today = bjDay(0)
const tomorrow = bjDay(1)
const longAgo = bjDay(-30)
// 今天：mc 有刚才那两次采样
const todayMetrics = (await api('GET', `/metrics?since=${today}&until=${today}`)).body
const todayRow = todayMetrics.rows.find(r => r.provider === 'pc' && r.model === 'mc')
ok('⑮ 今天区间包含今天的采样', todayRow?.samples >= 2, JSON.stringify(todayRow && { s: todayRow.samples }))
// 只筛未来：一条都没有
const futureMetrics = (await api('GET', `/metrics?since=${tomorrow}`)).body
const futureRow = futureMetrics.rows.find(r => r.provider === 'pc' && r.model === 'mc')
ok('⑮ 区间外没有样本时 samples=0、分位数为 null',
  futureRow?.samples === 0 && futureRow?.ttftP50 === null && futureRow?.tpsP50 === null,
  JSON.stringify(futureRow && { s: futureRow.samples, t: futureRow.ttftP50 }))
// 一个覆盖很久以前到很久以后的区间：仍包含今天的采样
const wideMetrics = (await api('GET', `/metrics?since=${longAgo}&until=${tomorrow}`)).body
const wideRow = wideMetrics.rows.find(r => r.provider === 'pc' && r.model === 'mc')
ok('⑮ 宽区间仍包含今天采样', wideRow?.samples >= 2, JSON.stringify(wideRow && { s: wideRow.samples }))
ok('⑮ 只给 since 也生效（until 开放）',
  (await api('GET', `/metrics?since=${today}`)).body.rows.find(r => r.provider === 'pc' && r.model === 'mc')?.samples >= 2)
ok('⑮ /metrics 回显筛选区间',
  (() => {
    const w = todayMetrics.window
    return w?.since === today && w?.until === today
  })(), JSON.stringify(todayMetrics.window))
ok('⑮ 非法日期被忽略，等价于不筛',
  (await api('GET', '/metrics?since=not-a-date')).body.rows.find(r => r.provider === 'pc' && r.model === 'mc')?.samples >= 2)
ok('⑮ 不传日期时 window 为 null（表示未筛选）',
  (await api('GET', '/metrics')).body.window?.null === undefined && (await api('GET', '/metrics')).body.window?.since === null)

// ⑯ 请求被拒（输入超长 / 按参数拒绝）也必须正确路由：
//    这类 400 换号无效、原地重试也无效，唯一有效的是换模型；而且不能把它写成
//    「当日失败」——模型本身没坏，只是这条请求超过它的上限。
const rejectedMsg = 'workbuddy 上游失败：请求被上游拒绝（http 400）（code 11115，requestId 7dec406a）。'
  + 'prompt is too long (upstream code 11115)。本次输入加上历史对话超过了模型上限。请精简内容、删掉大附件，或新建任务。'
  + '该请求被上游按参数拒绝：与网络、账号、额度都无关，换账号也不会改变结果，请按上面的提示调整后重试'
await api('POST', '/failed/reset', {})
// 该会话绑到只有一个别的模型的组，便于断言「换到了谁」
await api('POST', '/groups', { id: 'gr', name: 'GR', models: [
  { provider: 'p', model: 'm1', priority: 1 },
  { provider: 'p', model: 'm2', priority: 2 },
] })
const rejAgent = makeAgent('rejected-1', {}, 'm1')
agents.push(rejAgent)
await api('POST', '/session-group', { sessionId: 'rejected-1', groupId: 'gr', mode: 'route' })
rejAgent.status = 'running'
const rejAction = await errHandler(
  { agent: rejAgent, turn: 1, provider: 'p', failure: { code: 'client', status: 400, message: rejectedMsg } },
  () => Promise.resolve(undefined),
)
rejAgent.status = 'idle'
const rejLog = await lastLogFor('rejected-1')
ok('⑯ 请求被拒时照常进分组路由（而不是原地不动）',
  rejLog?.outcome === 'rejected-switched', JSON.stringify(rejLog))
ok('⑯ 换到了组内下一个模型',
  String(rejLog?.detail ?? '').includes('p/m2'), JSON.stringify(rejLog))
ok('⑯ 请求被拒不返回 retry（同一步重试还是同一个超限模型）',
  rejAction?.kind !== 'retry', JSON.stringify(rejAction))
ok('⑯ 请求被拒不写「当日失败」（模型没坏，只是这条请求太大）',
  !(await api('GET', '/status')).body.failed.some(f => f.provider === 'p' && f.model === 'm1'),
  JSON.stringify((await api('GET', '/status')).body.failed))
ok('⑯ 请求被拒不走换账号（换号改变不了上下文上限）',
  !(await api('GET', '/status')).body.failureLog.some(
    f => f.sessionId === 'rejected-1' && f.outcome === 'account-handoff'))

// ⑯b 同一个超限模型不能被下一轮又选回来（否则每次续跑都白烧一次上游请求）。
//     它没被标记当日失败，只能靠「本轮已试过」名单排除；组内没有别的可用模型时
//     应当明确报 no-target，而不是回到原模型再失败一次。
await api('POST', '/groups', { id: 'gr2', name: 'GR2', models: [
  { provider: 'p', model: 'm9', priority: 1 },
] })
const soloAgent = makeAgent('rejected-solo', {}, 'm9')
agents.push(soloAgent)
await api('POST', '/session-group', { sessionId: 'rejected-solo', groupId: 'gr2', mode: 'route' })
soloAgent.status = 'running'
await errHandler(
  { agent: soloAgent, turn: 1, provider: 'p', failure: { code: 'client', status: 400, message: rejectedMsg } },
  () => Promise.resolve(undefined),
)
soloAgent.status = 'idle'
ok('⑯b 组内只剩同一个超限模型时报 no-target（不回到它再失败一次）',
  (await lastLogFor('rejected-solo'))?.outcome === 'no-target',
  JSON.stringify(await lastLogFor('rejected-solo')))

// ⑯c 纯文本没有超限字样、只是普通网关 400：仍按「真失败」处理（不被误判）
await api('POST', '/failed/reset', {})
const plainAgent = makeAgent('plain400', {}, 'm1')
agents.push(plainAgent)
await api('POST', '/session-group', { sessionId: 'plain400', groupId: 'gr', mode: 'route' })
plainAgent.status = 'running'
await errHandler(
  { agent: plainAgent, turn: 1, provider: 'p', failure: { code: 'client', status: 400, message: 'bad gateway request shape' } },
  () => Promise.resolve(undefined),
)
plainAgent.status = 'idle'
ok('⑯c 普通 400 仍按当日失败处理（阈值不过宽）',
  (await api('GET', '/status')).body.failed.some(f => f.provider === 'p' && f.model === 'm1'),
  JSON.stringify((await api('GET', '/status')).body.failed))
await api('POST', '/failed/reset', {})

// ⑰ token 用量：入/出分别累加，且只统计适配器报了 usage 的调用
const tokRow = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pc' && r.model === 'mc')
ok('⑰ 看板行带 token 汇总字段',
  tokRow !== undefined && 'inTokens' in tokRow && 'outTokens' in tokRow && 'tokenSamples' in tokRow,
  JSON.stringify(tokRow && { i: tokRow.inTokens, o: tokRow.outTokens, n: tokRow.tokenSamples }))
// fakeStream 每次吐 input 10 / output 8；成功的两跑 = ⑬ 的 A 与紧接着那次补跑（B 被闸门判满、没有 usage）
ok('⑰ 输入 token 是区间内累加值（10×2）', tokRow?.inTokens === 20, `in=${tokRow?.inTokens}`)
ok('⑰ 输出 token 是区间内累加值（8×2）', tokRow?.outTokens === 16, `out=${tokRow?.outTokens}`)
ok('⑰ tokenSamples 只数带 usage 的样本', tokRow?.tokenSamples >= 2, `n=${tokRow?.tokenSamples}`)
const emptyTokRow = (await api('GET', '/metrics')).body.rows.find(r => r.samples === 0)
ok('⑰ 没采样过的模型 token 为 0 而不是 null（sum of nothing）',
  emptyTokRow !== undefined && emptyTokRow.inTokens === 0 && emptyTokRow.outTokens === 0
  && emptyTokRow.tokenSamples === 0, JSON.stringify(emptyTokRow))

// ⑱ 采样落盘：看板数据必须跨重启保留
//     刷新是防抖的（1.5s），这里等它落盘后检查文件内容与「重启后能否读回」。
await new Promise(r => setTimeout(r, 1800))
const metricsPath = join(dir, 'metrics.json')
ok('⑱ 采样写进了 dataDir/metrics.json', existsSync(metricsPath), metricsPath)
const onDisk = existsSync(metricsPath) ? JSON.parse(readFileSync(metricsPath, 'utf8')) : null
ok('⑱ 落盘内容按 provider/model 分组，且带 token 字段',
  (onDisk?.['pc/mc']?.length ?? 0) >= 2
  && onDisk['pc/mc'].every(s => 'inTokens' in s && 'outTokens' in s)
  && onDisk['pc/mc'].some(s => s.inTokens === 10 && s.outTokens === 8),
  JSON.stringify(onDisk?.['pc/mc']?.slice(-2)))
// 模拟重启：用同一个 dataDir 重新 apply 一次，历史样本应被读回
const ctx2 = Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx)
let routeHandler2 = null
ctx2.get = baseGet
ctx2.on = ctx.on
ctx2.inject = (_n, cb) => cb({
  webServer: { register(spec) { routeHandler2 = spec.handler; return () => {} } },
  effect() {}, interval() { return () => {} },
})
applyTwice(ctx2, { dataDir: dir })
const res2 = { statusCode: 0, body: '', setHeader() {}, end(s) { this.body = s } }
const req2 = new EventEmitter()
req2.method = 'GET'; req2.url = '/api/model-failover/metrics'
routeHandler2(req2, res2)
req2.emit('end')
await new Promise(r => setTimeout(r, 30))
const restarted = JSON.parse(res2.body || '{}').rows?.find(r => r.provider === 'pc' && r.model === 'mc')
ok('⑱ 重启后样本仍在（samples/token 都能读回）',
  restarted?.samples >= 2 && restarted?.inTokens === 20 && restarted?.outTokens === 16,
  JSON.stringify(restarted && { s: restarted.samples, i: restarted.inTokens, o: restarted.outTokens }))
ok('⑱ 重启后首字与速度分位数也在', typeof restarted?.tpsP50 === 'number' && typeof restarted?.ttftP50 === 'number',
  JSON.stringify(restarted && { t: restarted.tpsP50, f: restarted.ttftP50 }))

// ⑲ 采样不设条数上限：历史全部保留，统计不被「最近 N 条」偷换
//     造超过旧上限（200）的调用次数，看板行数必须一条不少地累加。
const BULK = 220
const beforeBulk = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pc' && r.model === 'mc')
const beforeSamples = beforeBulk?.samples ?? 0
// 带 usage 的样本数另算：闸门判满的那次失败样本没有 token，不能算进 10/8 的倍数里。
const beforeTokenSamples = beforeBulk?.tokenSamples ?? 0
for (let i = 0; i < BULK; i++) {
  // 逐条串行：并发上限是 1，并发跑会在闸门里排队
  const iter = await streamHandler({ provider: 'pc', model: 'mc', messages: [] }, () => fakeStream())
  for await (const _chunk of iter) { /* 消费完整个流，触发采样 */ }
}
const bulkMetrics = (await api('GET', '/metrics')).body
const bulkRow = bulkMetrics.rows.find(r => r.provider === 'pc' && r.model === 'mc')
ok('⑲ 超过 200 条也不裁剪，样本数等于实际调用次数',
  bulkRow?.samples === beforeSamples + BULK,
  `before=${beforeSamples} after=${bulkRow?.samples} expect=${beforeSamples + BULK}`)
ok('⑲ /metrics 不再声明每模型条数上限（sampleLimit 为 null）',
  bulkMetrics.sampleLimit === null, `sampleLimit=${JSON.stringify(bulkMetrics.sampleLimit)}`)
ok('⑲ token 合计按全部样本累加（不是最近 200 条）',
  bulkRow?.inTokens === 10 * (beforeTokenSamples + BULK)
  && bulkRow?.outTokens === 8 * (beforeTokenSamples + BULK),
  JSON.stringify({ i: bulkRow?.inTokens, o: bulkRow?.outTokens, n: bulkRow?.samples }))
await new Promise(r => setTimeout(r, 1800))
ok('⑲ 全量样本也照样落盘（重启后能读回同样条数）', (() => {
  const saved = JSON.parse(readFileSync(metricsPath, 'utf8'))
  return Array.isArray(saved?.['pc/mc']) && saved['pc/mc'].length >= beforeSamples + BULK
})(), 'ok')

// ── ⑳ 看板排序的持久化（settings.metricsSort） ─────────────────────────────
//     排序存在宿主侧的 settings.json，而不是浏览器的 localStorage：刷新页面、
//     换个浏览器、换台机器看到的都是同一份；坏值必须回落成默认序，不能让插件带病启动。
const sortDefault = (await api('GET', '/status')).body.settings
ok('⑳ 初始没有记忆的排序（默认序）', sortDefault.metricsSort === null, JSON.stringify(sortDefault))
const sortSaved = await api('POST', '/settings', { metricsSort: { key: 'tps', dir: 'desc' } })
ok('⑳ 点表头后排序被存下（key + dir）',
  sortSaved.body.settings?.metricsSort?.key === 'tps' && sortSaved.body.settings?.metricsSort?.dir === 'desc',
  JSON.stringify(sortSaved.body.settings?.metricsSort))
ok('⑳ 排序落盘到 settings.json（这是跨重启保留的前提）',
  JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).metricsSort?.key === 'tps')
ok('⑳ 认不出的列名回落成默认序（旧值不该带病启动）',
  (await api('POST', '/settings', { metricsSort: { key: 'nope', dir: 'desc' } })).body.settings?.metricsSort === null)
ok('⑳ 显式传 null 也合法（用户退回默认序）',
  (await api('POST', '/settings', { metricsSort: null })).body.settings?.metricsSort === null)
ok('⑳ 方向只认 desc，其余一律 asc（界面只有两态）',
  (await api('POST', '/settings', { metricsSort: { key: 'rate', dir: 'sideways' } })).body.settings?.metricsSort?.dir === 'asc')
ok('⑳ 非对象排序值也回落成默认序（数组/字符串都不算）',
  (await api('POST', '/settings', { metricsSort: 'tps' })).body.settings?.metricsSort === null)
await api('POST', '/settings', { metricsSort: { key: 'tokens', dir: 'desc' } })

// 模拟重启：新 ctx 读同一份 settings.json，上次的排序必须还在
const ctx3 = Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx)
let routeHandler3 = null
ctx3.get = baseGet
ctx3.on = ctx.on
ctx3.inject = (_n, cb) => cb({
  webServer: { register(spec) { routeHandler3 = spec.handler; return () => {} } },
  effect() {}, interval() { return () => {} },
})
applyTwice(ctx3, { dataDir: dir })
const res3 = { statusCode: 0, body: '', setHeader() {}, end(s) { this.body = s } }
const req3 = new EventEmitter()
req3.method = 'GET'; req3.url = '/api/model-failover/status'
routeHandler3(req3, res3)
req3.emit('end')
await new Promise(r => setTimeout(r, 30))
const restoredSort = JSON.parse(res3.body || '{}').settings?.metricsSort
ok('⑳ 重启后仍是上次的排序（用户刷新页面不用重排）',
  restoredSort?.key === 'tokens' && restoredSort?.dir === 'desc', JSON.stringify(restoredSort))

// ── ㉑ 历史 token 用量：看板大字不随日期筛选变化 ────────────────────────────
const allTok = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pc' && r.model === 'mc')
ok('㉑ 看板行带「历史 token 用量」三个字段',
  allTok !== undefined && 'lifetimeInTokens' in allTok && 'lifetimeOutTokens' in allTok && 'lifetimeTokenSamples' in allTok,
  JSON.stringify(allTok && { i: allTok.lifetimeInTokens, o: allTok.lifetimeOutTokens, n: allTok.lifetimeTokenSamples }))
ok('㉑ 不加筛选时历史用量与区间合计一致（口径自洽）',
  allTok?.lifetimeInTokens === allTok?.inTokens && allTok?.lifetimeOutTokens === allTok?.outTokens,
  JSON.stringify({ li: allTok?.lifetimeInTokens, i: allTok?.inTokens, lo: allTok?.lifetimeOutTokens, o: allTok?.outTokens }))
const emptyWin = (await api('GET', '/metrics?since=1990-01-01&until=1990-01-02')).body.rows.find(r => r.provider === 'pc' && r.model === 'mc')
ok('㉑ 换到没有样本的区间：区间内用量归零（副行参考所选区间）',
  emptyWin !== undefined && emptyWin.samples === 0 && emptyWin.inTokens === 0 && emptyWin.outTokens === 0,
  JSON.stringify(emptyWin && { s: emptyWin.samples, i: emptyWin.inTokens, o: emptyWin.outTokens }))
ok('㉑ 但历史用量原地不动（大字说的是「一共用掉多少」）',
  emptyWin?.lifetimeInTokens === allTok?.lifetimeInTokens && emptyWin?.lifetimeOutTokens === allTok?.lifetimeOutTokens,
  JSON.stringify(emptyWin && { li: emptyWin.lifetimeInTokens, lo: emptyWin.lifetimeOutTokens }))
ok('㉑ 历史 token 样本数也不随筛选变化',
  emptyWin?.lifetimeTokenSamples === allTok?.lifetimeTokenSamples,
  JSON.stringify({ a: emptyWin?.lifetimeTokenSamples, b: allTok?.lifetimeTokenSamples }))

// ── ㉒ 按看板当前排序重设路由优先级 ────────────────────────────────────────
await api('POST', '/groups', { id: 'go', name: 'GO', models: [
  { provider: 'p', model: 'm1', priority: 1 },
  { provider: 'p', model: 'm2', priority: 2 },
  { provider: 'p', model: 'm3', priority: 3 },
] })
const groupOf = async (id) => (await api('GET', '/groups')).body.groups.find(g => g.id === id)
const prioOf = (g, model) => g.models.find(m => m.model === model)?.priority ?? null

const reordered = await api('POST', '/groups/reorder-priority', { groupId: 'go', start: 10, order: [
  { provider: 'p', model: 'm3' }, { provider: 'p', model: 'm1' },
] })
ok('㉒ 按给定顺序从起始序号写回优先级',
  reordered.body.ok === true && reordered.body.start === 10 && reordered.body.applied === 2,
  JSON.stringify(reordered.body))
let goGroup = await groupOf('go')
ok('㉒ 顺序里第一个拿到起始序号，第二个 +1',
  prioOf(goGroup, 'm3') === 10 && prioOf(goGroup, 'm1') === 11,
  JSON.stringify({ m3: prioOf(goGroup, 'm3'), m1: prioOf(goGroup, 'm1') }))
ok('㉒ 没送进来的模型保持原优先级（排除无数据模型不会把它清空）', prioOf(goGroup, 'm2') === 2)
ok('㉒ 一次落盘：groups.json 里就是新值',
  JSON.parse(readFileSync(join(dir, 'groups.json'), 'utf8'))
    .find(g => g.id === 'go').models.find(m => m.model === 'm3').priority === 10)
ok('㉒ 起始序号可自定义（不传就默认 1）',
  (await api('POST', '/groups/reorder-priority', { groupId: 'go', order: [{ provider: 'p', model: 'm3' }] })).body.start === 1)

await api('POST', '/groups/reorder-priority', { groupId: 'go', start: 1, order: [
  { provider: 'p', model: 'm1' }, { provider: 'p', model: 'm1' }, { provider: 'p', model: 'mX' }, { provider: 'p', model: 'm2' },
] })
goGroup = await groupOf('go')
ok('㉒ 重复条目只认第一次、组外模型被忽略，序号仍然连续',
  prioOf(goGroup, 'm1') === 1 && prioOf(goGroup, 'm2') === 2,
  JSON.stringify({ m1: prioOf(goGroup, 'm1'), m2: prioOf(goGroup, 'm2') }))

const reorderBad = (body) => api('POST', '/groups/reorder-priority', body)
ok('㉒ start 越界被拒（挡住手改请求体写进来的天文数字）',
  (await reorderBad({ groupId: 'go', start: 0, order: [{ provider: 'p', model: 'm1' }] })).status === 400)
ok('㉒ start 非整数被拒',
  (await reorderBad({ groupId: 'go', start: 1.5, order: [{ provider: 'p', model: 'm1' }] })).status === 400)
ok('㉒ 空 order 被拒',
  (await reorderBad({ groupId: 'go', order: [] })).status === 400)
ok('㉒ 缺 groupId 被拒',
  (await reorderBad({ order: [{ provider: 'p', model: 'm1' }] })).status === 400)
ok('㉒ 分组不存在返回 404',
  (await reorderBad({ groupId: 'no-such-group', order: [{ provider: 'p', model: 'm1' }] })).status === 404)
ok('㉒ 全是组外模型时整批拒绝（不留半套优先级）',
  (await reorderBad({ groupId: 'go', order: [{ provider: 'p', model: 'mX' }] })).status === 400)

// ── ㉓ 一键测速 ────────────────────────────────────────────────────────────
//     probeModel 走 ctx.get('llm').stream。这里给假 llm 补一个受闸门控制的流，
//     好在「跑着的时候」验证并发保护与进度快照。
let probeGateRelease = null
const probeGate = new Promise(resolve => { probeGateRelease = resolve })
const probeStream = async function* () {
  await probeGate
  yield { type: 'text-delta', text: 'pong' }
  // 制造一点真实的首字→末字间隔：同一毫秒里算不出 tps
  await new Promise(r => setTimeout(r, 20))
  yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
const getBeforeProbe = ctx.get
ctx.get = (name) => {
  const svc = getBeforeProbe(name)
  if (name === 'llm') return Object.assign({}, svc, { stream: () => probeStream() })
  return svc
}
const waitNotRunning = async () => {
  for (let i = 0; i < 80; i++) {
    const snap = (await api('GET', '/speedtest')).body
    if (snap.running === false) return snap
    await new Promise(r => setTimeout(r, 25))
  }
  return (await api('GET', '/speedtest')).body
}

const startedProbe = await api('POST', '/speedtest', { models: [
  { provider: 'p', model: 'm1' }, { provider: 'p', model: 'm2' },
] })
ok('㉓ 启动测速立刻返回任务快照（不等测完：整组几十个模型扛不住一次请求）',
  startedProbe.status === 200 && startedProbe.body.total === 2 && startedProbe.body.running === true,
  JSON.stringify({ status: startedProbe.status, total: startedProbe.body.total, running: startedProbe.body.running }))
ok('㉓ 已在跑时不允许再起一个（并测会把首字延迟测成排队时间）',
  (await api('POST', '/speedtest', { models: [{ provider: 'p', model: 'm3' }] })).status === 409)
ok('㉓ GET 也能拿到进度（界面 1.5s 轮询这条）',
  (await api('GET', '/speedtest')).body.total === 2)

probeGateRelease()
const probeDone = await waitNotRunning()
ok('㉓ 测完 running=false 且 done=total',
  probeDone.running === false && probeDone.done === 2, JSON.stringify({ r: probeDone.running, d: probeDone.done }))
ok('㉓ 每个模型一行结果，带首字/速度/token',
  probeDone.results?.length === 2
  && probeDone.results.every(r => r.ok === true && typeof r.ttftMs === 'number' && typeof r.tps === 'number'
    && r.inTokens === 3 && r.outTokens === 2),
  JSON.stringify(probeDone.results?.map(r => ({ ok: r.ok, f: r.ttftMs, s: r.tps, i: r.inTokens, o: r.outTokens }))))
ok('㉓ 结果按 provider/model 对齐，界面据此在模型列挂副行',
  probeDone.results?.map(r => `${r.provider}/${r.model}`).sort().join(',') === 'p/m1,p/m2',
  JSON.stringify(probeDone.results?.map(r => `${r.provider}/${r.model}`)))

await api('POST', '/groups', { id: 'gs', name: 'GS', models: [
  { provider: 'p', model: 'm1', priority: 1 },
  { provider: 'p', model: 'm2', priority: 2, disabled: true },
] })
const probeByGroup = await api('POST', '/speedtest', { groupId: 'gs' })
ok('㉓ 按分组测速时跳过已禁用的模型（它在路由里根本不会被选中）',
  probeByGroup.status === 200 && probeByGroup.body.total === 1, JSON.stringify(probeByGroup.body))
await waitNotRunning()
ok('㉓ 没有可测模型时报 400（不是静默起一个空任务）',
  (await api('POST', '/speedtest', { models: [] })).status === 400)
ok('㉓ 连分组也不给时报 400', (await api('POST', '/speedtest', {})).status === 400)

// ── ㉗ 单模型测速 ──────────────────────────────────────────────────────────
//     「一键测速」测整组，但用户经常只想确认某一个模型（刚报错的、刚换号的、
//     甚至已经禁用的）。走的是同一个 models 清单入口，差别只在清单长度与
//     「显式点名的不排除禁用模型」。
const probeIdle = await api('GET', '/speedtest')
ok('㉗ 快照带 targets 清单（界面标「哪几行在测」只能靠它，刷新页面也靠它接上）',
  Array.isArray(probeIdle.body.targets) && probeIdle.body.targets.length === 1
  && probeIdle.body.targets[0].model === 'm1', JSON.stringify(probeIdle.body.targets))
const probeOne = await api('POST', '/speedtest', { models: [{ provider: 'p', model: 'm2' }] })
ok('㉗ 单个模型可以单独发起（total=1，不牵连整组）',
  probeOne.status === 200 && probeOne.body.total === 1 && probeOne.body.running === true,
  JSON.stringify({ s: probeOne.status, t: probeOne.body.total, r: probeOne.body.running }))
ok('㉗ 单模型任务的 targets 就是这一行',
  JSON.stringify(probeOne.body.targets) === JSON.stringify([{ provider: 'p', model: 'm2' }]),
  JSON.stringify(probeOne.body.targets))
// m2 在分组 gs 里是 disabled:true：按分组测会跳过它，单独点名要照测——
// 想单独点某一行的场景就是「它到底还通不通」，禁用状态不该挡掉这次排查。
const probeOneDone = await waitNotRunning()
ok('㉗ 单独点名的模型即使在分组里被禁用也照测',
  probeOneDone.results?.length === 1 && probeOneDone.results[0].model === 'm2'
  && probeOneDone.results[0].ok === true, JSON.stringify(probeOneDone.results))
ok('㉗ 单模型结果与整组同一份字段（首字/速度/token 都在），界面复用同一行渲染',
  probeOneDone.results?.[0]?.inTokens === 3 && probeOneDone.results?.[0]?.outTokens === 2
  && typeof probeOneDone.results?.[0]?.ttftMs === 'number',
  JSON.stringify(probeOneDone.results?.[0]))

  // ㉘ 缓存命中的 token 是输入的一部分：看板的大字必须把它算进去
  //     （DSH 的 usage 把 cacheReadTokens/cacheWriteTokens 拆开报，billed input
  //       = 三者之和；只看 inputTokens 会把命中缓存的那部分整段丢掉）。
  //     /metrics 只列分组里出现过的模型，所以先给它一个分组。
  await api('POST', '/groups', { id: 'gc', name: 'GC', models: [
    { provider: 'pc', model: 'cache-mc', priority: 1 },
  ] })
  const cacheStream = async function* () {
    yield { type: 'text-delta', text: 'hi' }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8, cacheReadTokens: 400, cacheWriteTokens: 100 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  {
    const s = await streamHandler({ provider: 'pc', model: 'cache-mc' }, () => cacheStream())
    for await (const _c of s) { /* 只驱动，不改写 */ }
  }
  const cacheRow = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pc' && r.model === 'cache-mc')
  ok('㉘ 看板行带缓存命中的字段（输入拆分成未命中 + 命中 + 写入）',
    cacheRow !== undefined
    && cacheRow.cacheReadTokens === 400 && cacheRow.cacheWriteTokens === 100
    && cacheRow.inTokens === 10 && cacheRow.outTokens === 8,
    JSON.stringify(cacheRow && { i: cacheRow.inTokens, o: cacheRow.outTokens, r: cacheRow.cacheReadTokens, w: cacheRow.cacheWriteTokens }))
  ok('㉘ 历史 token 总用量含缓存命中（400 + 100 + 10 + 8）',
    cacheRow?.lifetimeInTokens === 10 && cacheRow?.lifetimeCacheReadTokens === 400 && cacheRow?.lifetimeCacheWriteTokens === 100,
    JSON.stringify(cacheRow && { li: cacheRow.lifetimeInTokens, lr: cacheRow.lifetimeCacheReadTokens, lw: cacheRow.lifetimeCacheWriteTokens }))
  // 区间筛选：缓存字段与其它 token 字段一起随窗口变化，历史字段原地不动
  const cacheEmpty = (await api('GET', '/metrics?since=1990-01-01&until=1990-01-02')).body.rows.find(r => r.provider === 'pc' && r.model === 'cache-mc')
  ok('㉘ 换到空区间：缓存字段随区间归零，但历史缓存用量原地不动',
    cacheEmpty?.cacheReadTokens === 0 && cacheEmpty?.cacheWriteTokens === 0
    && cacheEmpty?.lifetimeCacheReadTokens === 400 && cacheEmpty?.lifetimeCacheWriteTokens === 100,
    JSON.stringify(cacheEmpty && { r: cacheEmpty.cacheReadTokens, w: cacheEmpty.cacheWriteTokens, lr: cacheEmpty.lifetimeCacheReadTokens, lw: cacheEmpty.lifetimeCacheWriteTokens }))
  // 没有缓存字段的旧样本：缓存字段显示 0 而不是 null（与既有 inTokens/outTokens 口径一致）
  const legacyRow = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pc' && r.model === 'mc')
  ok('㉘ 没有缓存字段的调用：缓存字段显示 0（不拿 null 冒充未知，与 inTokens 口径一致）',
    legacyRow !== undefined && legacyRow.cacheReadTokens === 0 && legacyRow.cacheWriteTokens === 0,
    JSON.stringify(legacyRow && { r: legacyRow.cacheReadTokens, w: legacyRow.cacheWriteTokens }))

// ── ㊾ 记账键统一：看板行、采样桶、并发闸门按同一个「渠道裸 id + 模型」 ─────────
//     闸门与采样一直按裸 id 记（ofm-qoder → qoder），而 /metrics 旧版按分组条目原文
//     取键。装了前缀门面之后条目是 ofm-trae 这种，于是看板对这些行永远显示 0 次采样、
//     无首字/速度、inflight 恒为 0，并发上限也形同虚设。这一段把两个方向都钉住。
{
  // 让假 llm 的 stream 走真实链路（宿主里 llm.stream 就是 llm/stream 瀑布）：
  // 只有这样测速的那次往返才会经过闸门与采样，否则测的是一条不记账的旁路。
  const getBeforeProbeBlock = ctx.get
  const llmThroughGate = (name) => {
    const svc = getBeforeProbeBlock(name)
    if (name === 'llm') return Object.assign({}, svc, { stream: (options) => streamHandler(options, () => probeStream()) })
    return svc
  }

  // (a) 条目带前缀、调用也带前缀 → 落在同一行（旧版这里会是 0）
  // 用独立分组 id：⑫b 的 gk 还留在 groups 里，重名会让 POST /groups 多推一条同名分组，
  // 后面按 id 取那条时读到的是先加入的那条（分组条目完全不同）。
  await api('POST', '/groups', { id: 'gmf1', name: 'GMF1', models: [
    { provider: 'ofm-pk', model: 'mk1', priority: 1 },
  ] })
  await api('POST', '/model-concurrency', { provider: 'ofm-pk', model: 'mk1', concurrency: 1 })
  {
    const s = await streamHandler({ provider: 'ofm-pk', model: 'mk1', messages: [] }, () => fakeStream())
    for await (const _c of s) { /* 消费完整个流，触发采样 */ }
  }
  const prefixedRow = (await api('GET', '/metrics')).body.rows.find(r => r.model === 'mk1')
  ok('㊾ 条目与调用都是注册表 id（ofm-pk）：采样落在这一行上',
    prefixedRow !== undefined && prefixedRow.samples === 1 && prefixedRow.okSamples === 1
    && typeof prefixedRow.ttftP50 === 'number',
    JSON.stringify(prefixedRow && { s: prefixedRow.samples, t: prefixedRow.ttftP50 }))
  ok('㊾ 并发上限按裸名记进表里（ofm-pk 写进去，键是 pk/mk1）',
    (await api('GET', '/status')).body.modelConcurrency['pk/mk1'] === 1
    && (await api('GET', '/status')).body.groups.find(g => g.id === 'gmf1').models[0].concurrency === 1,
    JSON.stringify((await api('GET', '/status')).body.modelConcurrency))

  // (b) 条目写裸名、调用用带前缀的 id → 仍是同一行（反向方向）
  await api('POST', '/groups', { id: 'gmf2', name: 'GMF2', models: [
    { provider: 'pk', model: 'mk2', priority: 1 },
  ] })
  {
    const s = await streamHandler({ provider: 'ofm-pk', model: 'mk2', messages: [] }, () => fakeStream())
    for await (const _c of s) { /* 同上 */ }
  }
  const bareRow = (await api('GET', '/metrics')).body.rows.find(r => r.model === 'mk2')
  ok('㊾ 条目写裸 pk、调用用 ofm-pk：采样照样落在裸名那一行（记账键按裸 id）',
    bareRow !== undefined && bareRow.samples === 1 && bareRow.provider === 'pk',
    JSON.stringify(bareRow && { s: bareRow.samples, p: bareRow.provider }))

  // (c) 一行 = 一个渠道 + 一个模型：两个分组各挂同一条也只出一行，并列出两个分组
  await api('POST', '/groups', { id: 'gdup1', name: 'GDUP1', models: [
    { provider: 'ofm-pd', model: 'md1', priority: 1 },
  ] })
  await api('POST', '/groups', { id: 'gdup2', name: 'GDUP2', models: [
    { provider: 'pd', model: 'md1', priority: 1 },
  ] })
  const dupRows = (await api('GET', '/metrics')).body.rows.filter(r => r.model === 'md1')
  ok('㊾ 同渠道同模型挂在两个分组（一个带前缀一个裸名）只出一行',
    dupRows.length === 1, 'rows=' + JSON.stringify(dupRows.map(r => r.provider)))
  ok('㊾ 这一行带 groupNames / groups：界面据此显示「它属于哪几个分组」',
    Array.isArray(dupRows[0]?.groupNames) && dupRows[0].groupNames.length === 2
    && dupRows[0].groupNames.includes('GDUP1') && dupRows[0].groupNames.includes('GDUP2')
    && Array.isArray(dupRows[0]?.groups) && dupRows[0].groups.length === 2,
    JSON.stringify(dupRows[0] && { names: dupRows[0].groupNames, groups: dupRows[0].groups }))

  // (d) 测速也进采样，且带 probe 标记（界面据此说明「历史列里有 N 次是测速打出来的」）
  ctx.get = llmThroughGate
  const beforeProbeRow = (await api('GET', '/metrics')).body.rows.find(r => r.model === 'mk1')
  const probeStarted = await api('POST', '/speedtest', { models: [{ provider: 'ofm-pk', model: 'mk1' }] })
  const probeFinished = await waitNotRunning()
  ctx.get = getBeforeProbeBlock
  ok('㊾ 测速结果带实际命中的路由 route（界面据此显示「测的是哪条路由」）',
    probeStarted.status === 200 && probeFinished.results?.[0]?.route === 'ofm-pk',
    JSON.stringify(probeFinished.results?.[0] && { route: probeFinished.results[0].route, ok: probeFinished.results[0].ok }))
  const afterProbeRow = (await api('GET', '/metrics')).body.rows.find(r => r.model === 'mk1')
  ok('㊾ 测速的一次往返计入首字/速度统计（samples 比之前多 1）',
    afterProbeRow?.samples === (beforeProbeRow?.samples ?? 0) + 1,
    `before=${beforeProbeRow?.samples} after=${afterProbeRow?.samples}`)
  ok('㊾ /metrics 行带 probeSamples：界面能说清「其中几样本是测速」',
    afterProbeRow?.probeSamples === (beforeProbeRow?.probeSamples ?? 0) + 1,
    JSON.stringify({ p: afterProbeRow?.probeSamples }))
  await new Promise(r => setTimeout(r, 1800))
  ok('㊾ 测速样本落盘时带 probe 标记（老样本没有该字段 = 不是测速）', (() => {
    const saved = JSON.parse(readFileSync(metricsPath, 'utf8'))
    const list = saved['pk/mk1'] ?? []
    return list.filter(s => s.probe === true).length === 1
  })(), 'ok')

  // (e) 测速不被并发闸门拦截：并发 1 且已被占满时，测速仍要成功
  //     （一个正被会话打满的模型恰恰是用户最想确认的那一个）
  const holdGate = Promise.withResolvers()
  const holdIter = await streamHandler({ provider: 'ofm-pk', model: 'mk1', messages: [] }, () => fakeStream(holdGate.promise))
  const holdTask = (async () => { for await (const _c of holdIter) { /* 占着槽位不结束 */ } })()
  await new Promise(r => setTimeout(r, 30))
  ok('㊾ 先占满并发槽位（模拟会话把这个模型打满）',
    (await api('GET', '/status')).body.groups.find(g => g.id === 'gmf1').models[0].inflight === 1,
    JSON.stringify((await api('GET', '/status')).body.groups.find(g => g.id === 'gmf1').models[0]))
  ctx.get = llmThroughGate
  const probeUnderFull = await api('POST', '/speedtest', { models: [{ provider: 'ofm-pk', model: 'mk1' }] })
  const probeUnderFullDone = await waitNotRunning()
  ctx.get = getBeforeProbeBlock
  ok('㊾ 并发已满时测速仍然成功（闸门对测速放行，不判 CAPACITY_TIMEOUT）',
    probeUnderFull.status === 200 && probeUnderFullDone.results?.[0]?.ok === true,
    JSON.stringify(probeUnderFullDone.results?.[0] && {
      ok: probeUnderFullDone.results[0].ok, code: probeUnderFullDone.results[0].errorCode,
    }))
  holdGate.resolve()
  await holdTask
  await api('POST', '/model-concurrency', { provider: 'ofm-pk', model: 'mk1', concurrency: null })

  // (f) 旧 metrics.json 的带前缀桶在启动时并进裸名桶（只迁一次，按 at 升序）
  const savedNow = JSON.parse(readFileSync(metricsPath, 'utf8'))
  savedNow['ofm-pmig/mig1'] = [
    { ttftMs: 100, inTokens: 1, outTokens: 1, speedTps: 10, waitMs: 0, ok: true, errorCode: null, errorMessage: null, at: 1 },
    { ttftMs: 200, inTokens: 2, outTokens: 2, speedTps: 20, waitMs: 0, ok: true, errorCode: null, errorMessage: null, at: 2 },
  ]
  savedNow['pmig/mig1'] = [
    { ttftMs: 300, inTokens: 3, outTokens: 3, speedTps: 30, waitMs: 0, ok: true, errorCode: null, errorMessage: null, at: 3 },
  ]
  writeFileSync(metricsPath, JSON.stringify(savedNow), 'utf8')
  // 迁移用例的分组必须真的在 groups 里，否则 /metrics 根本不会列出这一行
  // （它只列分组里出现过的模型）。先建好，用完一起删。
  await api('POST', '/groups', { id: 'gmig', name: 'GMIG', models: [
    { provider: 'pmig', model: 'mig1', priority: 1 },
  ] })
  const mountAgain = () => {
    const c = Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx)
    let handler = null
    c.get = getBeforeProbeBlock
    c.on = ctx.on
    c.inject = (_n, cb) => cb({
      webServer: { register(spec) { handler = spec.handler; return () => {} } },
      effect() {}, interval() { return () => {} },
    })
    applyTwice(c, { dataDir: dir })
    return handler
  }
  const readMetricsWith = async (handler) => {
    const res = { statusCode: 0, body: '', setHeader() {}, end(s) { this.body = s } }
    const req = new EventEmitter()
    req.method = 'GET'; req.url = '/api/model-failover/metrics'
    handler(req, res)
    req.emit('end')
    await new Promise(r => setTimeout(r, 30))
    return JSON.parse(res.body || '{}').rows ?? []
  }
  const migratedRows = await readMetricsWith(mountAgain())
  const migratedRow = migratedRows.find(r => r.model === 'mig1')
  ok('㊾ 旧前缀桶 ofm-pmig/mig1 启动时并进裸名桶（样本数 = 两个桶之和）',
    migratedRow?.samples === 3, JSON.stringify({ row: migratedRow && { s: migratedRow.samples }, rows: migratedRows.filter(r => r.model === 'mig1').map(r => r.provider + '/' + r.model + '=' + r.samples) }))
  // 等落盘（防抖 1.5s）后再看文件：迁移结果必须写回去，否则下次启动又要重做
  await new Promise(r => setTimeout(r, 1800))
  ok('㊾ 合并后按 at 升序（最近一次失败与分位数都按顺序取，顺序错了会读到更早的样本）', (() => {
    const list = JSON.parse(readFileSync(metricsPath, 'utf8'))['pmig/mig1'] ?? []
    return list.length >= 3 && list.every((s, i) => i === 0 || s.at >= list[i - 1].at)
  })(), 'ok')
  ok('㊾ 迁移后文件里不再留带前缀的旧键（否则同一模型会被记两遍）', (() => {
    const saved = JSON.parse(readFileSync(metricsPath, 'utf8'))
    return !Object.keys(saved).some(k => k.startsWith('ofm-') && k.endsWith('/mig1'))
  })(), 'ok')
  // 再挂一次：合并幂等，同一份历史不会越迁越多
  const migratedAgain = (await readMetricsWith(mountAgain())).find(r => r.model === 'mig1')
  ok('㊾ 再次启动不重复合并（同一份历史不会越迁越多）',
    migratedAgain?.samples === 3, JSON.stringify(migratedAgain && { s: migratedAgain.samples }))

  await api('DELETE', '/groups/gmf1')
  await api('DELETE', '/groups/gmf2')
  await api('DELETE', '/groups/gdup1')
  await api('DELETE', '/groups/gdup2')
  await api('DELETE', '/groups/gmig')
  await api('POST', '/failed/reset', {})
  await api('POST', '/capacity/reset', {})
}

ctx.get = baseGet
globalThis.fetch = baseFetch


// ㉔ 请求根本没发出去就抛的失败（UNKNOWN_MODEL）只在 agent/error 上可见：
//     用户报的 `pi-ai provider "codearts" has no configured model "glm-5.3-flash"`
//     就是这一条（prepareCall 同步抛，不进 agent/request-error 的 waterfall）。
//     这条入口从 agent 反查 provider/model，所以假 Agent 要能给出 model.current()。
const llmErr = (code, message) => {
  const err = new Error(message)
  err.name = 'LlmError'
  err.code = code
  err.failure = { code, message }
  return err
}
// 一个进程里插件只会被 apply 一次：⑱/⑳ 的「模拟重启」不该往同一个 handlers 里再挂
// 监听器（那样每个事件都攒三份实例，断言只能靠猜该用哪一份）。改成只让第一次 apply
// 注册监听器与路由；后两次仍真正执行（读回 settings/采样、重写 status 路由都靠它），
// 只是把不是 webServer.register 的注册 API 全部换成空实现。
// prepend 过的监听器排在列表第一位；goal-round-driver 是后注册的替身，只能排在它之后。
// 取插件那份（按实现特征认），不要按下标取：下标取法会把「prepend 生效了吗」这件事
// 混进 ㉔/㉕ 的断言里，真正的顺序性质由 ㉖ 单独断言。
const agentErrorHandler = handlers.getAll('agent/error').find(f => String(f).includes('llmFailureOf')) ?? (() => {})
const driverStandIn = handlers.getAll('agent/error').find(f => !String(f).includes('llmFailureOf')) ?? (() => {})
if (typeof errHandler !== 'function') throw new Error('agent/request-error 没有注册监听器')
// 插件没挂 agent/error 时这里取到的是替身：下面的 ㉔/㉕/㉖ 会自然报 FAIL，而不是把整份自检炸掉。
if (typeof agentErrorHandler !== 'function') throw new Error('agent/error 没有任何监听器')
{
  const a1 = makeAgent('err-only-1', {}, 'm1')
  agents.push(a1)
  await api('POST', '/session-group', { sessionId: 'err-only-1', groupId: 'g2', mode: 'route' })
  await api('POST', '/failed/reset', { provider: 'p', model: 'm1' })
  await api('POST', '/failed/reset', { provider: 'p', model: 'm2' })
  useModel('err-only-1', 'm1')
  // 真实时序：agent/error 在 turn 收尾阶段抛出，驱动器仍在跑（status=running）。
  a1.status = 'running'
  await agentErrorHandler({
    agent: a1, turn: 7, step: 1,
    error: llmErr('UNKNOWN_MODEL', 'pi-ai provider "codearts" has no configured model "glm-5.3-flash"'),
  })
  ok('㉔ 未配置模型（UNKNOWN_MODEL）也路由：切到组内下一个模型', switchOf('err-only-1') === 'm2',
    `→ ${switchOf('err-only-1')}`)
  ok('㉔ 该失败被记为当日失败（不再被路由选中）',
    (await api('GET', '/status')).body.failed.some(f => f.provider === 'p' && f.model === 'm1' && f.code === 'UNKNOWN_MODEL'))
  a1.status = 'idle'
  for (const fn of handlers.getAll('agent/status')) fn({ agent: a1, status: 'idle' })
  await Promise.resolve()
  ok('㉔ 切完模型仍排队一条续跑（本轮以错误收尾，下一轮用新模型继续）',
    followups.some(f => f.id === 'err-only-1'))
}

// ㉕ 两条入口同时可见时不能连跳两个模型：NO_ADAPTER 先经 request-error 换到 m2，
//     宿主随后在 turn 收尾时再发一次 agent/error（同一个 turn）——第二次必须被跳过。
{
  const a2 = makeAgent('err-only-2', {}, 'm1')
  agents.push(a2)
  await api('POST', '/session-group', { sessionId: 'err-only-2', groupId: 'g2', mode: 'route' })
  await api('POST', '/failed/reset', { provider: 'p', model: 'm1' })
  await api('POST', '/failed/reset', { provider: 'p', model: 'm2' })
  useModel('err-only-2', 'm1')
  a2.status = 'running'
  const action = await errHandler(
    { agent: a2, turn: 3, provider: 'p', failure: { code: 'NO_ADAPTER', message: 'pi-ai adapter does not own provider' } },
    () => Promise.resolve(undefined),
  )
  ok('㉕ request-error 换到组内下一个模型', action === undefined && switchOf('err-only-2') === 'm2',
    `action=${JSON.stringify(action)} → ${switchOf('err-only-2')}`)
  await agentErrorHandler({
    agent: a2, turn: 3, step: 1,
    error: llmErr('NO_ADAPTER', 'pi-ai adapter does not own provider'),
  })
  ok('㉕ 同一个 turn 的第二次进入（agent/error）被跳过，不连跳两个模型',
    switchOf('err-only-2') === 'm2', `→ ${switchOf('err-only-2')}`)
}


// ㉖ agent/error 那条入口也要保住目标：goal-round-driver 与我们在同一个 emit 里，
//     它在我们的监听器之后同步 disarm；所以 ref 必须在第一个 await 之前抓下来，
//     并且本监听器要 prepend 在它前面，否则读到的是已 disarm 的 goal（只认 armed）。
{
  const sid = 'goal-agent-error'
  const ga = makeAgent(sid, {}, 'm1')
  agents.push(ga)
  await api('POST', '/session-group', { sessionId: sid, groupId: 'g2', mode: 'route' })
  await api('POST', '/failed/reset', { provider: 'p', model: 'm1' })
  await api('POST', '/failed/reset', { provider: 'p', model: 'm2' })
  useModel(sid, 'm1')
  goalState.set(sid, { id: 'goal-d', revision: 5, phase: 'active', activation: 'armed' })
  goalCalls.length = 0
  ga.status = 'running'
  // 真实宿主是同步 emit：同一个调用栈里按注册顺序把同一个 payload 交给每个监听器。
  // 这里必须走真实顺序而不是「先调插件再调替身」——后者等于把要验的 prepend 写死了。
  const errPayload = {
    agent: ga, turn: 9, step: 1,
    error: llmErr('UNKNOWN_MODEL', 'pi-ai provider "codearts" has no configured model "glm-5.3-flash"'),
  }
  for (const fn of handlers.getAll('agent/error')) {
    const ret = fn(errPayload)
    if (ret !== undefined) await ret
  }
  ok('㉖ agent/error 监听器 prepend 在 goal-round-driver 之前（它在同一个 emit 里 disarm）',
    handlers.getAll('agent/error')[0] === agentErrorHandler,
    `index=${handlers.getAll('agent/error').indexOf(agentErrorHandler)}`)
  ok('㉖ agent/error 入口照样换到组内下一个模型', switchOf(sid) === 'm2', `→ ${switchOf(sid)}`)
  ga.status = 'idle'
  for (const fn of handlers.getAll('agent/status')) fn({ agent: ga, status: 'idle' })
  await new Promise(resolve => setTimeout(resolve, 5))
  ok('㉖ 切换后把被 disarm 的活跃 goal 重新 arm（ref 抓在 await 之前）',
    goalState.get(sid)?.activation === 'armed', JSON.stringify(goalState.get(sid)))
  ok('㉖ 恢复用的仍是切换前的 ref（revision 做 CAS）',
    goalCalls.some(c => c.sid === sid && c.ref.id === 'goal-d' && c.ref.revision === 5),
    JSON.stringify(goalCalls))
}

// ── ㉘ 看板的行级动作：恢复失败 / 改并发 / 从路由移除 ─────────────────────
//     界面新加的三个按钮都落在既有 HTTP 接口上（/failed/reset、/model-concurrency、
//     /groups PUT）。这里守住它们的口径，避免界面以为「只清这个模型」而接口实际清了
//     全部（/failed/reset 不带 provider/model 就是清全天），或以为「移除只动这一行」
//     而 PUT 把整份分组清单顶掉。
{
  // 先造两个当日失败：m1 在分组 go 里、m3 在分组 go 里，另一个分组 g2 里的 m2
  await api('POST', '/failed/mark', { provider: 'p', model: 'm1' })
  await api('POST', '/failed/mark', { provider: 'p', model: 'm3' })
  await api('POST', '/failed/mark', { provider: 'p', model: 'm2' })
  await api('POST', '/groups', { id: 'g3', name: 'G3', models: [
    { provider: 'q', model: 'n1', priority: 1 },
    { provider: 'q', model: 'n2', priority: 2, disabled: true },
  ] })
  // 看板「移除」走 PUT /groups 的整体替换：n2 被禁用、n1 优先级 1，都不许被动到
  const g3Before = (await api('GET', '/groups')).body.groups.find(g => g.id === 'g3')
  const g3Kept = g3Before.models.filter(m => m.model !== 'n1').map(m => ({
    provider: m.provider, model: m.model, priority: m.priority ?? 99, disabled: m.disabled === true,
  }))
  const removed = await api('PUT', '/groups', { id: 'g3', models: g3Kept })
  const g3After = (await api('GET', '/groups')).body.groups.find(g => g.id === 'g3')
  ok('㉘ 从分组移除：整体替换后目标模型不在分组里了',
    removed.status === 200 && g3After.models.every(m => m.model !== 'n1'),
    JSON.stringify(g3After.models))
  ok('㉘ 移除只动被摘掉的那一行：其余模型的优先级与禁用状态原样保留',
    g3After.models.length === 1 && g3After.models[0].model === 'n2'
    && g3After.models[0].priority === 2 && g3After.models[0].disabled === true,
    JSON.stringify(g3After.models))
  ok('㉘ 移除后该模型不在任何分组里（不再参与路由）',
    (await api('GET', '/status')).body.groups.every(g => g.models.every(m => m.model !== 'n1')))
  // 看板「恢复」走带 provider/model 的 /failed/reset：只清这一个模型
  await api('POST', '/failed/reset', { provider: 'p', model: 'm1' })
  const failedNow = (await api('GET', '/status')).body.failed
  ok('㉘ 恢复单个失败模型：只清这一个，同组其它模型仍留在失败名单里',
    !failedNow.some(f => f.provider === 'p' && f.model === 'm1')
    && failedNow.some(f => f.provider === 'p' && f.model === 'm3'),
    JSON.stringify(failedNow.map(f => f.model)))
  ok('㉘ 恢复后该模型重新参与路由（不再被标 failed）',
    // failed / concurrency 都是 /status 上的派生字段；/groups 返回的是原始分组
    (await api('GET', '/status')).body.groups
      .find(g => g.id === 'go').models.find(m => m.model === 'm1').failed === false)
  // 看板「并发」列的提交与「模型」页签同一份：/model-concurrency 按模型持久化
  await api('POST', '/model-concurrency', { provider: 'p', model: 'm2', concurrency: 2 })
  ok('㉘ 看板上改并发上限：按模型记录、对所有分组生效',
    (await api('GET', '/status')).body.modelConcurrency['p/m2'] === 2)
  // 生效上限是分组条目上看不到的派生值（/status 才算出来）：所有分组里 m2 必须一致
  const m2Status = (await api('GET', '/status')).body.groups
    .map(g => g.models.find(m => m.model === 'm2'))
    .filter(Boolean)
  ok('㉘ 并发上限不在分组条目上：所有分组里 m2 看到的生效上限一致',
    m2Status.length > 0 && m2Status.every(m => m.concurrency === 2), JSON.stringify(m2Status))
  await api('POST', '/model-concurrency', { provider: 'p', model: 'm2', concurrency: null })
  ok('㉘ 并发清空后回落到默认（不再出现在 modelConcurrency 里）',
    (await api('GET', '/status')).body.modelConcurrency['p/m2'] === undefined)
  await api('DELETE', '/groups/g3')
  await api('DELETE', '/groups/gc')
  await api('POST', '/failed/reset', {})
}

// ── ㉙ 看板状态列：错误码一直看得见，完整报错走悬停 ───────────────────────
//     状态列副行放错误码（截断显示），title 里是完整报错文案。错误码与文案
//     必须成对出现：只有码看不出「上游到底说了什么」，只有文案又没法归类。
{
  // 一次失败调用：finish 带上 failure 的 code 与 message
  const failStream = async function* () {
    yield { type: 'text-delta', index: 0, text: 'partial' }
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM_500', message: '上游 500：provider overloaded, retry later' } } }
  }
  await api('POST', '/groups', { id: 'ge', name: 'GE', models: [
    { provider: 'pe', model: 'em1', priority: 1 },
  ] })
  {
    const iter = await streamHandler({ provider: 'pe', model: 'em1', messages: [] }, () => failStream())
    for await (const _c of iter) { /* 消费到 finish，触发采样 */ }
  }
  const errRow = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pe' && r.model === 'em1')
  ok('㉙ 失败行带上错误码', errRow?.lastErrorCode === 'UPSTREAM_500',
    JSON.stringify(errRow && { c: errRow.lastErrorCode }))
  ok('㉙ 失败行带上完整报错文案（悬停要看的就是它）',
    errRow?.lastErrorMessage === '上游 500：provider overloaded, retry later',
    JSON.stringify(errRow && { m: errRow.lastErrorMessage }))
  // 成功之后，错误码与文案都要让位给最新的成功（否则会一直挂着旧错误）
  const okStream = async function* () {
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  {
    const iter = await streamHandler({ provider: 'pe', model: 'em1', messages: [] }, () => okStream())
    for await (const _c of iter) { /* 消费 */ }
  }
  const errRow2 = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'pe' && r.model === 'em1')
  ok('㉙ 成功之后仍报区间内最后一次失败（错误码/文案跟着「最后一次失败」走，不被后来的成功顶掉）',
    errRow2?.lastErrorCode === 'UPSTREAM_500'
    && errRow2?.lastErrorMessage === '上游 500：provider overloaded, retry later',
    JSON.stringify(errRow2 && { c: errRow2.lastErrorCode, m: errRow2.lastErrorMessage }))
  // 当日失败记录带原因：看板悬停优先用它（「所有重试耗尽后」的最终结论）
  const peAgent = makeAgent('pe-agent', {}, 'em2')
  peAgent.status = 'running'
  await errHandler({ agent: peAgent, turn: 1, provider: 'pe', failure: { code: 'QUOTA_EXCEEDED', message: '余额不足' } },
    () => Promise.resolve(undefined))
  const failedEntry = (await api('GET', '/status')).body.failed.find(f => f.provider === 'pe' && f.model === 'em2')
  ok('㉙ 当日失败记录带错误码与原因（看板悬停的文案来源）',
    failedEntry?.code === 'QUOTA_EXCEEDED' && failedEntry?.reason === '余额不足',
    JSON.stringify(failedEntry))
  await api('DELETE', '/groups/ge')
  await api('POST', '/failed/reset', {})
}

// ── ㉛ 失败文案不是字符串时，宁可没有文案 ──────────────────────────────
//     宿主把非 Error 的抛出值归一化成 HarnessError(String(value), 'UNKNOWN')，
//     message 就成了字符串 "[object Object]"。把它显示在看板上等于什么都没说，
//     错误码还在（那才是可归类的部分），文案必须留空。
{
  const objStream = async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: '[object Object]' } } }
  }
  await api('POST', '/groups', { id: 'go', name: 'GO', models: [
    { provider: 'po', model: 'om1', priority: 1 },
  ] })
  {
    const iter = await streamHandler({ provider: 'po', model: 'om1', messages: [] }, () => objStream())
    for await (const _c of iter) { /* 消费到 finish */ }
  }
  const objRow = (await api('GET', '/metrics')).body.rows.find(r => r.provider === 'po' && r.model === 'om1')
  ok('㉛ 「[object Object]」不算文案（错误码保留）',
    objRow?.lastErrorCode === 'UNKNOWN' && !objRow?.lastErrorMessage,
    JSON.stringify(objRow && { c: objRow.lastErrorCode, m: objRow.lastErrorMessage }))
  await api('DELETE', '/groups/go')
}

// ── ㉚ 「配置了路由却报错不自动路由」的两道回归 ────────────────────────────
//     真实故障（session-45110bcc turn 94，2026-10-26 21:00）有两条独立的成因，
//     都在这里钉住：
//     ① 内层监听器不调 next() 就返回 ⇒ 短路整条 waterfall，本插件压根没被调用；
//     ② 续跑消息投递失败就丢弃 ⇒ 模型换了、会话却停在原地。
//
//     ① 的现场是「llm-error-retry 的重试预算耗尽后直接 return undefined」：
//     它 prepend 在最外层，不放行 → 我们这条监听器根本不在链上。
//     这里用「内层监听器短路」复现同一形状：调用 next() 的那一层不往下传。
{
  const sid = 'short-circuit'
  const sa = makeAgent(sid, {}, 'm1')
  agents.push(sa)
  await api('POST', '/session-group', { sessionId: sid, groupId: 'g2', mode: 'route' })
  await api('POST', '/failed/reset', { provider: 'p', model: 'm1' })
  await api('POST', '/failed/reset', { provider: 'p', model: 'm2' })
  useModel(sid, 'm1')
  sa.status = 'running'
  // 内层短路：返回 undefined 却不把失败交给下游（真实插件的 exhausted 分支）。
  // 我们的监听器在这条链上，所以它**拿不到**这次失败 —— 只能靠 agent/error 入口兜。
  const shortCircuit = await errHandler(
    { agent: sa, turn: 11, provider: 'p', failure: { code: 'INVALID_REQUEST', message: '内容太长了，请精简输入或开启新对话', status: 400 } },
    () => Promise.resolve(undefined),
  )
  ok('㉚ 内层不表态时本插件不返回 retry（retry 也换不了已冻结的 selection）',
    shortCircuit === undefined, JSON.stringify(shortCircuit))
  // 宿主在 waterfall 之后照样抛 LlmError，turn 收尾时以 agent/error 广播。
  await agentErrorHandler({
    agent: sa, turn: 11, step: 1,
    error: llmErr('INVALID_REQUEST', '内容太长了，请精简输入或开启新对话'),
  })
  ok('㉚ 内层短路后，agent/error 入口照样把失败路由出去（不靠「自己最外层」的前提）',
    switchOf(sid) === 'm2', `→ ${switchOf(sid)}`)
  ok('㉚ 被拒的模型不算「当日失败」（上下文超长不是模型坏了，换个模型照样能用）',
    !(await api('GET', '/status')).body.failed.some(f => f.provider === 'p' && f.model === 'm1'))
  sa.status = 'idle'
  for (const fn of handlers.getAll('agent/status')) fn({ agent: sa, status: 'idle' })
  await new Promise(resolve => setTimeout(resolve, 5))
  ok('㉚ 切换后照常排队续跑（模型换了，话也得接着说）',
    followups.some(f => f.id === sid))
}

// ② 续跑投递失败不许丢：followup 抛错时条目留在原地，等下一个窗口再试。
{
  const sid = 'cont-retry'
  const ca = makeAgent(sid, {}, 'm1')
  agents.push(ca)
  await api('POST', '/session-group', { sessionId: sid, groupId: 'g2', mode: 'route' })
  await api('POST', '/failed/reset', { provider: 'p', model: 'm1' })
  await api('POST', '/failed/reset', { provider: 'p', model: 'm2' })
  useModel(sid, 'm1')
  ca.status = 'running'
  await errHandler(
    { agent: sa2(sid), turn: 12, provider: 'p', failure: { code: 'QUOTA_EXCEEDED', message: '余额不足' } },
    () => Promise.resolve(undefined),
  )
  ok('㉚ 失败后切到组内下一个', switchOf(sid) === 'm2', `→ ${switchOf(sid)}`)
  // 让 followup 抛错：agent 还��� running 时宿主会拒绝排队
  ca.status = 'running'
  ca.followup = () => { throw new Error('agent is busy') }
  for (const fn of handlers.getAll('agent/status')) fn({ agent: ca, status: 'idle' })
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 5))
  const log = (await api('GET', '/debug/status-log')).body
  ok('㉚ 投递失败时留下「continuation/failed」痕迹（不是静默消失）',
    log.entries.some(e => e.kind === 'continuation/failed' && e.sessionId === sid),
    JSON.stringify(log.entries.filter(e => e.kind.startsWith('continuation/')).map(e => e.kind)))
  ok('㉚ 投递失败时待续跑仍在队列里（等下一个窗口再试，不是丢掉）',
    log.pendingContinuations.includes(sid), JSON.stringify(log.pendingContinuations))
}
// 上面那段需要一个「取回假 Agent」的辅助（续跑链路用的是 session id，不是 agent 对象）
function sa2(id) { return agents.find(a => a.id === id) }

// ── ㉜ 模型选择弹窗出厂即开启（settings.dialogMode） ────────────────────────
//     新装用户第一次点模型位就该看到左右分区弹窗：出厂值是 true。用户关掉后
//     写进 settings.json，重新 apply 必须仍读到 false —— 出厂值只在「没存过」
//     时生效，不能把用户自己的选择顶回去。
{
  /** 用给定 dataDir 重新 apply 一次，返回该实例的 HTTP 调用器（等价于一次宿主重启） */
  const mountOn = (dataDir) => {
    let handler = null
    const c = Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx)
    c.get = baseGet
    c.on = ctx.on
    c.inject = (_n, cb) => cb({
      webServer: { register(spec) { handler = spec.handler; return () => {} } },
      effect() {}, interval() { return () => {} },
    })
    applyTwice(c, { dataDir })
    return (method, path, body) => {
      const req = new EventEmitter()
      req.method = method
      req.url = `/api/model-failover${path}`
      const res = { statusCode: 0, body: '', setHeader() {}, end(s) { this.body = s } }
      const done = handler(req, res)
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
      return Promise.resolve(done).then(() => ({ status: res.statusCode, body: JSON.parse(res.body || 'null') }))
    }
  }

  const freshDir = mkdtempSync(join(tmpdir(), 'mfm-dialog-'))
  const freshApi = mountOn(freshDir)
  const freshStatus = (await freshApi('GET', '/status')).body
  ok('㉜ 新装（还没有 settings.json）默认就是弹窗模式',
    freshStatus.settings?.dialogMode === true, JSON.stringify(freshStatus.settings))
  ok('㉜ 出厂值不落盘（用户没改过就不该生成 settings.json）',
    !existsSync(join(freshDir, 'settings.json')))

  await freshApi('POST', '/settings', { dialogMode: false })
  ok('㉜ 关掉弹窗会写进 settings.json',
    JSON.parse(readFileSync(join(freshDir, 'settings.json'), 'utf8')).dialogMode === false)
  const restartedApi = mountOn(freshDir)
  ok('㉜ 重启后仍是用户关掉的状态（出厂 true 不顶回已存的值）',
    (await restartedApi('GET', '/status')).body.settings?.dialogMode === false)
  ok('㉜ 重新打开又回到 true 并存盘',
    (await restartedApi('POST', '/settings', { dialogMode: true })).body.settings?.dialogMode === true
    && JSON.parse(readFileSync(join(freshDir, 'settings.json'), 'utf8')).dialogMode === true)
}

// ── ㉝ 依赖 dsh-llm-error-retry：一次装两件、重复安装只跑一份 ────────────────
// 只读静态文件、不联网：依赖能不能真拉下来是安装时 pnpm 的事，这里守的是
// 「拉下来之后一定被装载」与「两条安装路径不会各跑一个重试实例」这两件事。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const depSpec = pkg.dependencies?.['dsh-llm-error-retry']
ok('㉝ package.json 依赖 dsh-llm-error-retry，且固定到 GitHub 上的具体 commit',
  typeof depSpec === 'string' && /^github:liaoyuqing\/dsh-llm-error-retry#[0-9a-f]{40}$/.test(depSpec),
  String(depSpec))

const patchText = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8')
// 只认本 patch 的形状（文件由本仓库自己维护）：id 与 name 认不出来就说明有行没按
// 预期装载，让它在自检里挂掉，好过悄悄少一行。
function insertRows(text) {
  const out = []
  let cur = null
  for (const line of text.split(/\r?\n/)) {
    const id = line.match(/^\s*- id:\s*(\S+)\s*$/)
    const name = line.match(/^\s*name:\s*'([^']+)'\s*$/)
    if (id) { cur = { id: id[1], name: null }; out.push(cur); continue }
    if (name && cur && !cur.name) cur.name = name[1]
  }
  return out
}
const rows = insertRows(patchText)
ok('㉝ patch 插入两行：本插件 + 重试插件（裸包名，由 profile 的 node_modules 解析）',
  rows.length === 2
  && rows[0].id === 'model-failover-manager' && rows[0].name === 'model-failover-manager'
  && rows[1].id === 'llm-error-retry' && rows[1].name === 'dsh-llm-error-retry',
  JSON.stringify(rows))

// 重复安装：dsh-llm-error-retry 自己的 bundle patch 也插一行，id 与本 patch 相同、名字
// 是相对路径。Loader 的条目按 id 存放、后写覆盖先写（EntryGroup.update 按 id 建 map），
// 这里按同一语义走一遍，证明两个 id 相等就会收敛成一条。
const upstreamRow = { id: 'llm-error-retry', name: './host.mjs' }
const composed = new Map()
for (const row of [...rows, upstreamRow]) composed.set(row.id, row)
ok('㉝ 两条安装路径的两行同 id → 合成一个条目（不会跑两个重试实例）',
  composed.size === 2
  && composed.has('llm-error-retry')
  && rows.filter(r => r.id === 'llm-error-retry').length === 1
  && upstreamRow.name !== rows[1].name,
  JSON.stringify([...composed.keys()]))

const clientText = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
ok('㉝ 弹窗新增「错误重试」页签，且只在停在该页签时探测',
  clientText.includes("var RETRY_UI = '/llm-error-retry'")
  && clientText.includes("setTab('retry')")
  && clientText.includes("tab !== 'retry'"))
ok('㉝ 页签内容内嵌重试插件自己的页面与配置接口（不在本插件里重写一份编辑器）',
  clientText.includes("fetch(RETRY_UI + '/api/config'")
  && clientText.includes("e('iframe', { src: RETRY_UI"))

// ── ㉞ 免费渠道推荐页签：推荐表 / 安装状态 / 一键安装 ────────────────────────
// 装没装读 pluginManager.listBundles()（profile 依赖），在线渠道读 llm 注册表；
// 一键安装必须落在同一个 installBundle 上，且构建脚本待批准要原样抛回，不代批。
managerStub = {
  bundles: [{ name: 'dsh-connect-workbuddy', version: '5.16.0' }],
  installCalls: [],
  async listBundles() { return this.bundles },
  async installBundle(spec) { this.installCalls.push(spec); return { applied: true } },
}
llmStub = { listProviders: () => [{ id: 'codearts' }, { id: 'qoder' }, { id: 'unrelated' }] }

const fc = (await api('GET', '/free-channels')).body
const chOf = (id) => fc.channels.find(c => c.id === id) || {}
ok('㉞ GET /free-channels 回六个推荐渠道：装没装读 profile 依赖，在线渠道读 llm 注册表',
  fc.managerAvailable === true
  && fc.channels.length === 6
  // 卡片顺序 = FREE_CHANNELS 顺序，Our Free Model 排第一；认领顺序另算（聚合渠道最后认领）
  && fc.channels.map(c => c.id).join(',') === 'our-free-model,codearts,workbuddy,trae,qoder,codearts-auth'
  && fc.channels.every(c => typeof c.pkg === 'string' && typeof c.spec === 'string')
  // 安装 spec 必须是 npm 包名：github: / git+ 源会拉 codeload tarball，pnpm 每次安装
  // profile 都重拉一遍（不支持 Range），GitHub 慢时会把插件市场的更新拖过超时。
  && fc.channels.every(c => /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9.-]*$/.test(c.spec))
  && chOf('trae').pkg === 'dsh-connect-trae' && chOf('trae').spec === 'dsh-connect-trae'
  && chOf('qoder').pkg === '@dmh2002/dsh-connect-qoder' && chOf('qoder').spec === '@dmh2002/dsh-connect-qoder'
  && chOf('workbuddy').installed === true && chOf('workbuddy').version === '5.16.0'
  && chOf('codearts').installed === false && chOf('codearts').version === null
  && chOf('trae').installed === false && chOf('qoder').installed === false
  // 第二个聚合渠道仍用旧包名 dsh-codearts-auth（改名后的 dsh-providers-hub 同发同版本）
  && chOf('codearts-auth').pkg === 'dsh-codearts-auth' && chOf('codearts-auth').spec === 'dsh-codearts-auth'
  && chOf('codearts-auth').installed === false && chOf('codearts-auth').version === null
  && JSON.stringify(chOf('codearts').providers) === '["codearts"]'
  // trae / qoder 的专用连接器没装，同名 provider 归聚合渠道（否则聚合卡片会显示「无在线渠道」）
  && JSON.stringify(chOf('trae').providers) === '[]'
  && JSON.stringify(chOf('qoder').providers) === '[]'
  && JSON.stringify(chOf('our-free-model').providers) === '["qoder"]'
  // 它的正则刻意不含 codearts / workbuddy：那两个 id 由各自的专用卡片认领，重复计数会让
  // 同一路由在两张卡片上各算一次。此刻注册表里也没有它的渠道 id，所以是空数组。
  && JSON.stringify(chOf('codearts-auth').providers) === '[]',
  JSON.stringify(fc))

const inst = await api('POST', '/free-channels/install', { id: 'codearts' })
ok('㉞ 一键安装走 pluginManager.installBundle（与插件市场同一个引擎）',
  inst.status === 200 && inst.body.ok === true
  && managerStub.installCalls.length === 1 && managerStub.installCalls[0] === 'dsh-codearts',
  JSON.stringify(inst.body))

managerStub.installBundle = async () => ({ applied: false, pendingBuilds: ['esbuild'] })
const pend = await api('POST', '/free-channels/install', { id: 'our-free-model' })
ok('㉞ 需要执行构建脚本时按失败回执原样抛出待批准项，不替用户批准',
  pend.status === 409 && pend.body.ok === false
  && JSON.stringify(pend.body.pendingBuilds) === '["esbuild"]'
  && /需要先批准/.test(pend.body.message),
  JSON.stringify(pend.body))

const unknownChannel = await api('POST', '/free-channels/install', { id: 'nope' })
ok('㉞ 未知渠道 id 直接拒绝', unknownChannel.status === 409 && unknownChannel.body.ok === false, JSON.stringify(unknownChannel.body))

// 专用连接器装了就由它认领同名的 trae / qoder；聚合渠道只列没人认领的在线渠道，不重复计数。
managerStub = {
  bundles: [
    { name: 'dsh-connect-trae', version: '4.6.12' },
    { name: '@dmh2002/dsh-connect-qoder', version: '1.16.4' },
    { name: 'dsh-our-free-model', version: '2.0.0' },
    { name: 'dsh-codearts-auth', version: '2.12.261101' },
  ],
  async listBundles() { return this.bundles },
  async installBundle() { return { applied: true } },
}
llmStub = {
  listProviders: () => [
    { id: 'trae' }, { id: 'trae-global' }, { id: 'qoder' }, { id: 'qoder-global' }, { id: 'qodercn' },
    // 第二个聚合渠道独有的渠道 id（专用连接器与 Our Free Model 都不认领这些）
    { id: 'buddy' }, { id: 'magicrew' },
  ],
}
const fcOwned = (await api('GET', '/free-channels')).body
const ownOf = (id) => fcOwned.channels.find(c => c.id === id) || {}
ok('㉞ trae / qoder 装了就归专用连接器，聚合渠道只列剩下的（同名 provider 不重复计数）',
  ownOf('trae').installed === true && ownOf('trae').version === '4.6.12'
  && ownOf('qoder').installed === true && ownOf('qoder').version === '1.16.4'
  && ownOf('our-free-model').installed === true
  && JSON.stringify(ownOf('trae').providers) === '["trae","trae-global"]'
  && JSON.stringify(ownOf('qoder').providers) === '["qoder","qoder-global"]'
  && JSON.stringify(ownOf('our-free-model').providers) === '["qodercn"]'
  // 两个聚合渠道都装了：Our Free Model 排在推荐表前面，先认领；Providers Hub 只拿它剩下的
  && ownOf('codearts-auth').installed === true && ownOf('codearts-auth').version === '2.12.261101'
  && JSON.stringify(ownOf('codearts-auth').providers) === '["buddy","magicrew"]',
  JSON.stringify(fcOwned))

managerStub = undefined
llmStub = undefined
const fcNoManager = (await api('GET', '/free-channels')).body
ok('㉞ 取不到插件管理服务时 installed 回 null（界面显示「状态未检测」，不谎报未安装）',
  fcNoManager.managerAvailable === false && fcNoManager.channels.every(c => c.installed === null),
  JSON.stringify(fcNoManager))

// ── ㊴ provider 前缀：六插件各一前缀 + 裸 id 共存 ───────────────────────────
// 六个免费渠道插件用同名 provider（qoder、trae、codearts…），宿主每个 id 只允许一个
// adapter。方案是每个插件一个前缀（ofm- / ca- / cw- / ct- / cq- / caa-），由 llm 门面
// 加在**真实注册表**侧，插件自身代码不改。本段把 provider-prefix.mjs 的纯函数逐条钉住：
// 身份拆分、等价判断（裸配置兼容 / 不同插件不等价）、认领用的 channelBare、认领算法。
// 第 ⑯ 条起是「接入宿主后」的行为：前缀解析顺序、失败键按裸名、分组条目按 providerEquals。
const PREFIX_CHANNELS = [
  { id: 'our-free-model', pkg: 'dsh-our-free-model', prefix: 'ofm-', aggregator: true, providers: /^(qoder|qodercn|trae|cline|lobster|loomy|raccoon|minimax|zcode|gemini|eac|our-free)/i },
  { id: 'codearts', pkg: 'dsh-codearts', prefix: 'ca-', providers: /^codearts/i },
  { id: 'workbuddy', pkg: 'dsh-connect-workbuddy', prefix: 'cw-', providers: /^workbuddy/i },
  { id: 'trae', pkg: 'dsh-connect-trae', prefix: 'ct-', providers: /^(trae|trae-enterprise|trae-global)$/i },
  { id: 'qoder', pkg: '@dmh2002/dsh-connect-qoder', prefix: 'cq-', providers: /^(qoder|qoder-global)$/i },
  { id: 'codearts-auth', pkg: 'dsh-codearts-auth', prefix: 'caa-', aggregator: true, providers: /^(buddy|opencode|officeace|accio|astudio|autoclaw|autoclawintl|modelscope|qiniu|codely|magicrew)$/i },
]
/** 跑一遍认领，返回 { channelId: providers[] } 的 JSON（断言里直接比字符串） */
const claims = (ids, isInstalled = () => false) => JSON.stringify(
  Object.fromEntries(claimFreeChannels({ channels: PREFIX_CHANNELS, providerIds: ids, isInstalled })))

ok('㊴ PROVIDER_PREFIXES 是六个插件前缀，顺序 = 免费渠道卡片顺序（ofm- 在 ca- 之前）',
  Object.isFrozen(PROVIDER_PREFIXES)
  && JSON.stringify(PROVIDER_PREFIXES) === '["ofm-","ca-","cw-","ct-","cq-","caa-"]',
  JSON.stringify(PROVIDER_PREFIXES))

// host.mjs 的 FREE_CHANNELS 必须与它同序同值：两边各改一半会让认领与解析走岔
const hostSourceForPrefixes = readFileSync(new URL('./host.mjs', import.meta.url), 'utf8')
const declaredPrefixes = [...hostSourceForPrefixes.matchAll(/prefix: '(ofm-|ca-|cw-|ct-|cq-|caa-)'/g)].map(m => m[1])
ok('㊴ host.mjs 的 FREE_CHANNELS 六条各带 prefix，顺序与 PROVIDER_PREFIXES 一致',
  JSON.stringify(declaredPrefixes) === JSON.stringify([...PROVIDER_PREFIXES]),
  JSON.stringify(declaredPrefixes))

ok('㊴ providerIdentity 拆出前缀与裸名（ofm-qoder / caa-codearts / ca-codearts）',
  JSON.stringify(providerIdentity('ofm-qoder')) === '{"prefix":"ofm-","bare":"qoder"}'
  && JSON.stringify(providerIdentity('caa-codearts')) === '{"prefix":"caa-","bare":"codearts"}'
  // ca- 不是 caa- 的前缀：caa-codearts 必须落在 caa- 上，不能落成 ca- + 'a-codearts'
  && JSON.stringify(providerIdentity('ca-codearts')) === '{"prefix":"ca-","bare":"codearts"}',
  JSON.stringify([providerIdentity('ofm-qoder'), providerIdentity('caa-codearts'), providerIdentity('ca-codearts')]))

ok('㊴ providerIdentity 对未打门面的裸 id、空串、null 都给空前缀',
  JSON.stringify(providerIdentity('codearts')) === '{"prefix":"","bare":"codearts"}'
  && JSON.stringify(providerIdentity('qoder')) === '{"prefix":"","bare":"qoder"}'
  && JSON.stringify(providerIdentity('')) === '{"prefix":"","bare":""}'
  && JSON.stringify(providerIdentity(null)) === '{"prefix":"","bare":""}',
  JSON.stringify([providerIdentity('codearts'), providerIdentity('qoder'), providerIdentity(''), providerIdentity(null)]))

ok('㊴ bareProvider 剥一次前缀，未命中前缀的 id 原样返回',
  bareProvider('ofm-qoder') === 'qoder' && bareProvider('caa-codearts') === 'codearts'
  && bareProvider('cq-qodercn') === 'qodercn' && bareProvider('qoder') === 'qoder'
  && bareProvider('') === '',
  JSON.stringify(['ofm-qoder', 'caa-codearts', 'cq-qodercn', 'qoder'].map(bareProvider)))

ok('㊴ canonicalProvider 保留前缀（同一插件的路由各算一份），裸 id 也原样',
  canonicalProvider('ofm-qoder') === 'ofm-qoder'
  && canonicalProvider('caa-codearts') === 'caa-codearts'
  && canonicalProvider('qoder') === 'qoder',
  JSON.stringify(['ofm-qoder', 'caa-codearts', 'qoder'].map(canonicalProvider)))

ok('㊴ providerEquals：裸配置能对上自己的前缀（groups.json 写裸 codearts 也能命中 ca-codearts）',
  providerEquals('codearts', 'ca-codearts') === true
  && providerEquals('ca-codearts', 'codearts') === true
  && providerEquals('qoder', 'ofm-qoder') === true,
  JSON.stringify([providerEquals('codearts', 'ca-codearts'), providerEquals('qoder', 'ofm-qoder')]))

ok('㊴ providerEquals：不同插件的前缀互不等价（ca-codearts ≠ caa-codearts，ofm-qoder ≠ caa-qoder）',
  providerEquals('ca-codearts', 'caa-codearts') === false
  && providerEquals('ofm-qoder', 'caa-qoder') === false
  && providerEquals('qoder', 'qoder-global') === false,
  JSON.stringify([providerEquals('ca-codearts', 'caa-codearts'), providerEquals('ofm-qoder', 'caa-qoder'), providerEquals('qoder', 'qoder-global')]))

ok('㊴ channelBare：别的插件前缀下的 id 一律不算本渠道（ca- 看到 caa-codearts 返回 null）',
  channelBare('ca-', 'caa-codearts') === null
  && channelBare('caa-', 'ca-codearts') === null,
  JSON.stringify([channelBare('ca-', 'caa-codearts'), channelBare('caa-', 'ca-codearts')]))

ok('㊴ channelBare：裸 id 对任何渠道都可见，本渠道前缀下的 id 剥成裸名',
  channelBare('ofm-', 'qoder') === 'qoder'
  && channelBare('cq-', 'qoder') === 'qoder'
  && channelBare('caa-', 'caa-codearts') === 'codearts',
  JSON.stringify([channelBare('ofm-', 'qoder'), channelBare('cq-', 'qoder'), channelBare('caa-', 'caa-codearts')]))

// (a) 全裸 id 的旧世界：认领结果必须与加前缀之前完全一致
ok('㊴ claimFreeChannels (a) 全裸 id：Our Free Model 吃九个渠道、codearts / workbuddy 各归各卡',
  claims(['qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini', 'codearts', 'workbuddy', 'workbuddy-global'])
  === JSON.stringify({
    'our-free-model': ['qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini'],
    codearts: ['codearts'], workbuddy: ['workbuddy', 'workbuddy-global'],
    trae: [], qoder: [], 'codearts-auth': [],
  }),
  claims(['qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini', 'codearts', 'workbuddy', 'workbuddy-global']))

// (b) 全前缀视图：归属由前缀决定，caa-codearts 归 Providers Hub 而不是 dsh-codearts
ok('㊴ claimFreeChannels (b) 全前缀视图：ca-codearts 归 codearts 卡，caa-* 归 codearts-auth 卡',
  claims(['ofm-qoder', 'ofm-trae', 'ca-codearts', 'cw-workbuddy', 'caa-codearts', 'caa-buddy', 'caa-opencode'])
  === JSON.stringify({
    'our-free-model': ['ofm-qoder', 'ofm-trae'], codearts: ['ca-codearts'], workbuddy: ['cw-workbuddy'],
    trae: [], qoder: [], 'codearts-auth': ['caa-codearts', 'caa-buddy', 'caa-opencode'],
  }),
  claims(['ofm-qoder', 'ofm-trae', 'ca-codearts', 'cw-workbuddy', 'caa-codearts', 'caa-buddy', 'caa-opencode']))

// (c) 混合视图：门面只覆盖了 Our Free Model，trae 还是裸 id
ok('㊴ claimFreeChannels (c) 混合视图（ofm-qoder + 裸 trae）两条都归 Our Free Model',
  claims(['ofm-qoder', 'trae']) === JSON.stringify({
    'our-free-model': ['ofm-qoder', 'trae'], codearts: [], workbuddy: [], trae: [], qoder: [], 'codearts-auth': [],
  }),
  claims(['ofm-qoder', 'trae']))

// (d) 撞号：专用连接器装了就自己认领 ct-trae，没装就让给 Our Free Model
ok('㊴ claimFreeChannels (d) 专用连接器装了：ct-trae 归 trae 卡，Our Free Model 不重复计数',
  claims(['ct-trae'], pkg => pkg === 'dsh-connect-trae') === JSON.stringify({
    'our-free-model': [], codearts: [], workbuddy: [], trae: ['ct-trae'], qoder: [], 'codearts-auth': [],
  }),
  claims(['ct-trae'], pkg => pkg === 'dsh-connect-trae'))
ok('㊴ claimFreeChannels (d) 专用连接器没装：同一条 ct-trae 让给 Our Free Model（否则两张卡都没有它）',
  claims(['ct-trae'], () => false) === JSON.stringify({
    'our-free-model': ['ct-trae'], codearts: [], workbuddy: [], trae: [], qoder: [], 'codearts-auth': [],
  }),
  claims(['ct-trae'], () => false))

// (e) 装没装未知（pluginManager 不可用）→ 按静态顺序认领，专用连接器优先
ok('㊴ claimFreeChannels (e) isInstalled 为 null 时按静态顺序认领（专用连接器先拿）',
  claims(['ct-trae'], () => null) === JSON.stringify({
    'our-free-model': [], codearts: [], workbuddy: [], trae: ['ct-trae'], qoder: [], 'codearts-auth': [],
  }),
  claims(['ct-trae'], () => null))

// 同一插件的裸 id 与它自己的前缀 id 同时在线（门面正在生效 / 还没生效的交界）：
// 两条都要认出、都要归同一张卡，且不能让 Providers Hub 抢走 qoder。
ok('㊴ claimFreeChannels 混合视图：裸 qoder 与 ofm-qodercn / caa-qoder 同时在线都归 Our Free Model',
  claims(['qoder', 'ofm-qodercn', 'caa-qoder', 'codearts']) === JSON.stringify({
    'our-free-model': ['qoder', 'ofm-qodercn', 'caa-qoder'], codearts: ['codearts'],
    workbuddy: [], trae: [], qoder: [], 'codearts-auth': [],
  }),
  claims(['qoder', 'ofm-qodercn', 'caa-qoder', 'codearts']))

// ⑯ 前缀解析顺序：裸 qoder 在 ofm-qoder 与 caa-qoder 同时在线时解析到 ofm-qoder
// （PROVIDER_PREFIXES 的顺序＝免费渠道卡片顺序，Our Free Model 排第一张）。
// liveProviderIdOf 在 apply 闭包里，所以从 /session-model 这条路验证它写进 selection 的值。
llmStub = { listProviders: () => [{ id: 'caa-qoder' }, { id: 'ofm-qoder' }] }
const pfxOrderAgent = makeAgent('pfx-order-1', {}, 'm1')
agents.push(pfxOrderAgent)
await api('POST', '/session-group', { sessionId: 'pfx-order-1', groupId: 'g2', mode: 'route' })
await api('POST', '/session-model', { sessionId: 'pfx-order-1', provider: 'qoder', model: 'm1' })
ok('㊴ 裸 qoder 在 ofm-qoder 与 caa-qoder 同时在线时解析到 ofm-qoder（顺序＝卡片顺序）',
  appended.filter(a => a.id === 'pfx-order-1' && a.type === 'model/selection').at(-1)?.data?.provider === 'ofm-qoder',
  JSON.stringify(appended.filter(a => a.id === 'pfx-order-1').at(-1)?.data))
llmStub = undefined

// ⑰ 失败键按裸名合计：ofm-qoder 的失败必须让分组里那条裸 qoder 也显示「当日失败」，
// 否则路由会立刻再选中它（liveProviderIdOf 又解析回 ofm-qoder），形成失败死循环。
const pfxGroup = (await api('POST', '/groups', {
  name: 'zz-prefix-check',
  models: [
    { provider: 'qoder', model: 'pfx-m1', priority: 1 },
    { provider: 'qoder', model: 'pfx-m2', priority: 2 },
  ],
})).body.group
await api('POST', '/failed/mark', { provider: 'ofm-qoder', model: 'pfx-m1' })
const pfxFailed = (await api('GET', '/status')).body.groups.find(g => g.id === pfxGroup.id)?.models.find(m => m.model === 'pfx-m1')
ok('㊴ 失败键按裸名：ofm-qoder 的失败让分组里的裸 qoder 条目也变成「当日失败」',
  pfxFailed?.failed === true, JSON.stringify(pfxFailed))

// ⑱ 解除失败也走 providerEquals：界面传的是裸 qoder，失败表里记的可能是 ofm-qoder，
// 两边必须能对上（不同插件前缀之间仍不等价，见 ⑧ 那条断言）。
await api('POST', '/failed/reset', { provider: 'qoder', model: 'pfx-m1' })
const pfxCleared = (await api('GET', '/status')).body.groups.find(g => g.id === pfxGroup.id)?.models.find(m => m.model === 'pfx-m1')
ok('㊴ 解除失败按 providerEquals：传裸 qoder 能清掉 ofm-qoder 记下的那条当日失败',
  pfxCleared?.failed === false, JSON.stringify(pfxCleared))

// ⑲ 分组条目按 providerEquals 匹配注册表 id：当前模型是 ofm-qoder/pfx-m1，分组里是裸
// 'qoder' 且该条此刻不在生效时段 —— 必须能被认出来并换走。若 groupMember 用 ===，
// 查不到条目 → routable() 的时段检查被跳过 → 会话原地不动。
const pfxGmGroup = (await api('POST', '/groups', {
  name: 'zz-prefix-groupmember',
  models: [
    { provider: 'qoder', model: 'pfx-m1', priority: 1, windows: [{ from: badHour, to: badHour }] },
    { provider: 'qoder', model: 'pfx-m2', priority: 2 },
  ],
})).body.group
const pfxGmAgent = makeAgent('pfx-gm-1', {}, 'pfx-m1')
agents.push(pfxGmAgent)
await api('POST', '/session-group', { sessionId: 'pfx-gm-1', groupId: pfxGmGroup.id, mode: 'route' })
pfxGmAgent.model.select({ provider: 'ofm-qoder', model: 'pfx-m1' })
const pfxGmAfter = await runPreStep('pfx-gm-1')
ok('㊴ groupMember 按 providerEquals 对上注册表 id：ofm-qoder 的出窗条目被换到组内下一个',
  pfxGmAfter === 'pfx-m2', JSON.stringify({ after: pfxGmAfter, sel: pfxGmAgent.model.current() }))

// 收尾：临时分组与失败记账都清掉，后面的段落还要用同一份 ctx / groups
await api('DELETE', '/groups/' + encodeURIComponent(pfxGroup.id))
await api('DELETE', '/groups/' + encodeURIComponent(pfxGmGroup.id))
await api('POST', '/failed/reset', {})
await api('POST', '/capacity/reset', {})
ok('㊴ 自检用的临时分组与失败记账已清掉',
  (await api('GET', '/status')).body.groups.every(g => g.id !== pfxGroup.id && g.id !== pfxGmGroup.id))

// ── ㊵ qoder 压缩 shim 认领注册表里的 adapter：一个裸名可能有多条活路由 ──────
// 这一段补的是「㊴ 覆盖不到的装配路径」：collectTargets 不经过 host.mjs，改坏它
// offline-check 原本抓不到（上线时真发生过一次：数组误用 .has()，shim 整个启动失败，
// 263 项仍全绿）。断言放在导出的纯函数 collectShimRegistrations 上。
//
// 多前缀之后**同一个裸名会有多个活 adapter**（ofm-qoder 走 dsh-our-free-model 内联的
// encryptor，caa-qoder 走 dsh-codearts-auth 自己那份 qoder-wasm.js —— 两份是不同的类），
// 所以这里必须**逐个全收**：只挑一条会漏掉另一条，而 /status 仍显示已接管。
const shimMap = (ids) => new Map(ids.map((id) => [id, { adapter: { tag: id } }]))
const shimIds = (ids) => collectShimRegistrations(shimMap(ids)).adapters.map(a => a.id)
const shimMissing = (ids) => collectShimRegistrations(shimMap(ids)).missing
ok('㊵ 无门面：注册表里是裸 qoder/qodercn 时两条都命中，id 原样带出',
  JSON.stringify(shimIds(['qoder', 'qodercn'])) === '["qoder","qodercn"]'
  && shimMissing(['qoder', 'qodercn']).length === 0,
  JSON.stringify(shimIds(['qoder', 'qodercn'])))
ok('㊵ 门面态：ofm-qoder 与 caa-qoder 同时在线时两条都收（两条各有自己的加密器拷贝）',
  JSON.stringify(shimIds(['ofm-qoder', 'caa-qoder', 'qodercn'])) === '["ofm-qoder","caa-qoder","qodercn"]'
  && shimMissing(['ofm-qoder', 'caa-qoder', 'qodercn']).length === 0,
  JSON.stringify({ ids: shimIds(['ofm-qoder', 'caa-qoder', 'qodercn']), missing: shimMissing(['ofm-qoder', 'caa-qoder', 'qodercn'])}))
ok('㊵ 同名多条：按 SHIM_PROVIDER_IDS 顺序分组（qoder 在 qodercn 前），组内保持注册表枚举顺序',
  JSON.stringify(shimIds(['caa-qodercn', 'caa-qoder', 'qoder'])) === '["caa-qoder","qoder","caa-qodercn"]',
  JSON.stringify(shimIds(['caa-qodercn', 'caa-qoder', 'qoder'])))
ok('㊵ missing 只报「一条都没命中」的裸名：同名里坏一条不影响另一条',
  JSON.stringify(shimMissing(['ofm-qoder'])) === '["qodercn"]'
  && JSON.stringify(shimIds(['ofm-qoder'])) === '["ofm-qoder"]',
  JSON.stringify({ ids: shimIds(['ofm-qoder']), missing: shimMissing(['ofm-qoder'])}))
ok('㊵ 注册表里只有别的渠道时两个裸名都算缺失（notes 文案照旧，不静默接管）',
  JSON.stringify(shimMissing(['ca-codearts', 'trae', 'caa-buddy'])) === '["qoder","qodercn"]',
  JSON.stringify(shimMissing(['ca-codearts', 'trae', 'caa-buddy'])))
ok('㊵ 注册表缺失/不可枚举不抛错，只是全部记为缺失',
  JSON.stringify(collectShimRegistrations(null).missing) === '["qoder","qodercn"]'
  && JSON.stringify(collectShimRegistrations(new Map()).missing) === '["qoder","qodercn"]',
  JSON.stringify(collectShimRegistrations(null)))
ok('㊵ 注册表的值就是 adapter 本身（不带 .adapter 包装）时同样命中',
  JSON.stringify(collectShimRegistrations(new Map([['caa-qoder', { prepareInfer() {} }]])).adapters.map(a => a.id)) === '["caa-qoder"]',
  JSON.stringify(collectShimRegistrations(new Map([['caa-qoder', { prepareInfer() {} }]])).adapters.map(a => a.id)))


// 插件市场详情页渲染 locale meta.detail 指到的文档，图片按文档所在目录解析
// （packages/util/plugin-detail/src/document.ts 的 detailImage）：所以详情文档写在
// docs/ 里、图片用同级相对路径，文件也必须在 package.json 的 files 里才随包发布。
for (const [localeFile, docFile] of [['locale/zh.json', 'docs/market.zh.md'], ['locale/en.json', 'docs/market.en.md']]) {
  const meta = JSON.parse(readFileSync(new URL('./' + localeFile, import.meta.url), 'utf8')).meta
  const base = docFile.slice('docs/'.length)
  ok('㉞ ' + localeFile + ' 的 meta.detail 指向市场详情文档，且该文档引用的截图都在包里',
    meta.detail === docFile
    && existsSync(new URL('./' + docFile, import.meta.url))
    && pkg.files.includes(docFile)
    && [...readFileSync(new URL('./' + docFile, import.meta.url), 'utf8').matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
      .every(m => m[1].startsWith('http') || (existsSync(new URL('./docs/' + m[1], import.meta.url)) && pkg.files.includes('docs/' + m[1]))),
    String(meta.detail) + ' / ' + base)
}

ok('㉞ 每个渠道给出 GitHub 仓库地址，并提供一键复制',
  clientText.includes("repo: 'https://github.com/elegant01/dsh-codearts'")
  && clientText.includes("repo: 'https://github.com/dingminhua/dsh-connect-workbuddy'")
  && clientText.includes("repo: 'https://github.com/Ebony-Vinyl/dsh-our-free-model'")
  && clientText.includes("repo: 'https://github.com/dingminhua/dsh-connect-trae'")
  && clientText.includes("repo: 'https://github.com/dingminhua/dsh-connect-qoder'")
  // 第二个聚合渠道的仓库是改名后的 dsh-providers-hub（安装 spec 仍是旧名 dsh-codearts-auth）
  && clientText.includes("repo: 'https://github.com/zhuweiyou/dsh-providers-hub'")
  && clientText.includes('function copyText(')
  && clientText.includes("navigator.clipboard.writeText")
  && clientText.includes("'复制链接'"))

ok('㉞ 弹窗有「免费渠道」页签，只在停在该页签时读一次，安装按钮走本插件的 HTTP 接口',
  clientText.includes("setTab('channels')")
  && clientText.includes("tab !== 'channels'")
  && clientText.includes("apiGet(API + '/free-channels')")
  && clientText.includes("apiSend(API + '/free-channels/install', 'POST'")
  && clientText.includes("'免费渠道'"))

// ── ㉟ 路由分组页签：调优先级与移出分组 ────────────────────────────────────
// 这两件事在页签里就地做（不用开「编辑」弹窗），落到宿主已有的两个入口：
// 上/下移 = 交换两个条目的 priority 后整表送回 PUT /groups；移出 = 同一入口去掉一条。
// 下面既守界面接线，也守宿主这两个入口真的「只动被动的条目」。
ok('㉟ 分组页签每个模型带 ↑ ↓ ✕，分别调顺序与移出本分组',
  clientText.includes("moveGroupModel(g, idx, -1)")
  && clientText.includes("moveGroupModel(g, idx, 1)")
  && clientText.includes("removeGroupModel(g, m.provider, m.model)")
  && clientText.includes("}, '↑')") && clientText.includes("}, '↓')") && clientText.includes("}, '✕')"))

ok('㉟ 首/末位没有可去方向时按钮压暗并禁用，而不是点了没反应',
  clientText.includes('disabled: idx === 0')
  && clientText.includes('disabled: idx === sorted.length - 1')
  && clientText.includes('idx === 0 ? { opacity: .25, cursor: \'default\' }'))

ok('㉟ 调顺序只交换相邻两条的 priority（不整体重排，没动过的优先级保持原样）',
  clientText.includes('var a = Object.assign({}, sorted[index])')
  && clientText.includes('var b = Object.assign({}, sorted[j])')
  && clientText.includes('if (pa !== pb) { a.priority = pb; b.priority = pa }')
  && clientText.includes("apiSend(API + '/groups', 'PUT', { id: g.id, models: sorted })"))

// 宿主侧：整表替换要保持每条自己的时段/截止日/禁用，移走一条不动其余
const gCreated = (await api('POST', '/groups', {
  name: 'zz-move-check',
  models: [
    { provider: 'a', model: 'm1', priority: 5, windows: [{ from: 1, to: 2 }], until: '2027-01-01' },
    { provider: 'a', model: 'm2', priority: 9 },
  ],
})).body
const gId = gCreated.group.id
const gNow = (await api('GET', '/status')).body.groups.find(g => g.id === gId)
ok('㉟ 新建分组的条目按给定 priority（5 / 9）落库',
  JSON.stringify(gNow.models.map(m => m.priority)) === '[5,9]', JSON.stringify(gNow.models))

// 与 client.js 相同的做法：把 m2 上移一位
const ordered = gNow.models.slice().sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
const up = { ...ordered[1] }
const down = { ...ordered[0] }
const pa = up.priority ?? 99
const pb = down.priority ?? 99
if (pa !== pb) { up.priority = pb; down.priority = pa }
ordered[0] = up
ordered[1] = down
const moved = await api('PUT', '/groups', { id: gId, models: ordered })
const m1 = moved.body.group.models.find(m => m.model === 'm1')
const m2 = moved.body.group.models.find(m => m.model === 'm2')
ok('㉟ 上移一位：两条交换 priority，而 m1 的时段与截止日原样带过去',
  m2.priority === 5 && m1.priority === 9
  && JSON.stringify(m1.windows) === '[{"from":1,"to":2}]' && m1.until === '2027-01-01',
  JSON.stringify(moved.body.group.models))

const removed = await api('PUT', '/groups', { id: gId, models: moved.body.group.models.filter(m => m.model !== 'm1') })
ok('㉟ 移出分组：只少那一条，剩下那条的 order 与内容不动',
  removed.body.group.models.length === 1
  && removed.body.group.models[0].model === 'm2'
  && removed.body.group.models[0].priority === 5,
  JSON.stringify(removed.body.group.models))
await api('DELETE', '/groups/' + encodeURIComponent(gId))
ok('㉟ 自检用的临时分组已清掉',
  (await api('GET', '/status')).body.groups.every(g => g.id !== gId))

// ── ㊱ 数据看板：口径说明默认收起，P50 / P90 有解释 ─────────────────────
// 说明常驻会白白吃掉表格高度，改成可折叠；P90 是分位数，不写清楚没人该猜得出。
ok('㊱ 看板的指标说明默认收起，点一下才展开',
  clientText.includes('var metricsHelpPair = React.useState(false)')
  && clientText.includes("metricsHelp && e('div', { style: { fontSize: '11px'")
  && clientText.includes("metricsHelp && e('div', { style: S.metricsNote }")
  && clientText.includes('setMetricsHelp(!metricsHelp)')
  && clientText.includes("'收起指标说明 ▴'"))

ok('㊱ 说明里解释 P50 / P90 是分位数（P90 = 90% 的请求都比它快）',
  clientText.includes('P50 / P90 是同一批采样的分位数')
  && clientText.includes('P90 表示 90% 的请求都比它快')
  && clientText.includes('首字给 P90'))

// ── ㊲ CodeArts 凭据镜像：并入本插件后仍按原判据镜像（原 dsh-codearts-resign-bridge）──
// 这段既守静态接线（宿主挂载 / 设置页 / 手动同步入口），也用临时账号库跑一遍真实同步：
// 镜像的判据是「每个可用账号 → 一个候选 ref」，写进去的字段名必须是 bili 解析认的那三个。
const bridgeModule = await import(new URL('./codearts-resign-bridge.mjs', import.meta.url))
const hostText = readFileSync(new URL('./host.mjs', import.meta.url), 'utf8')
ok('㊲ 宿主静态挂载了凭据镜像，并把现场放进 /status.resignBridge',
  hostText.includes("from './codearts-resign-bridge.mjs'")
  && hostText.includes('startCodeartsResignBridge({')
  && hostText.includes('resignBridge: describeResignBridge(),')
  && hostText.includes('if (resignBridgeHandle) resignBridgeHandle.stop()'))

ok('㊲ 设置页可改开关与间隔，另有「立即同步」的独立入口',
  hostText.includes('settings.resignBridgeEnabled')
  && hostText.includes('settings.resignBridgeIntervalSeconds')
  && hostText.includes('/resign-bridge/sync')
  && clientText.includes("'CodeArts 凭据镜像'")
  && clientText.includes("API + '/resign-bridge/sync'"))

// 真跑一遍：临时账号库 + 假 credentials 服务，不碰真实凭据
const bridgeDir = mkdtempSync(join(tmpdir(), 'mfm-resign-'))
const accountsPath = join(bridgeDir, 'accounts.json')
const jetHubPath = join(bridgeDir, 'state.json')
const expired = new Date(Date.now() - 3600_000).toISOString()
// 同一份到期时间在下面两次写盘里复用：轮换必须只因为 AK 变，不能因为时间戳变
const expSoon = new Date(Date.now() + 3600_000).toISOString()
writeFileSync(accountsPath, JSON.stringify({
  order: ['a-old', 'a-1', 'a-2'],
  accounts: {
    'a-old': { accessKeyId: 'AKOLD', secretAccessKey: 'SKOLD', token: 'TOLD', expiration: expired },
    'a-1': { accessKeyId: 'AK1', secretAccessKey: 'SK1', token: 'T1', expiration: expSoon },
    'a-2': { accessKeyId: 'AK2', secretAccessKey: 'SK2', token: '', expiration: expSoon },
  },
}))
writeFileSync(jetHubPath, JSON.stringify({
  accounts: [
    { provider: 'codearts', credentialRef: 'REF_A', enabled: true },
    { provider: 'other', credentialRef: 'REF_X' },
    { provider: 'codearts', credentialRef: 'REF_B', enabled: false },
  ],
}))
const writes = []
const bridgeLogger = { info() {}, warn() {}, error() {}, debug() {} }
const bridgeHandle = bridgeModule.startCodeartsResignBridge({
  ctx: { get: (n) => (n === 'credentials' ? { set: (ref, payload) => writes.push({ ref, payload }) } : undefined) },
  logger: bridgeLogger,
  settings: { enabled: true, intervalSeconds: 10 },
  fallbackRefs: ['REF_FALLBACK'],
  accountsFile: accountsPath,
  jetHubStateFile: jetHubPath,
})
const firstSync = await bridgeHandle.syncNow()
ok('㊲ 每个可用账号各写一个 ref：过期账号跳过，禁用/非 codearts 的 ref 不进候选',
  JSON.stringify(firstSync.mirroredRefs) === '["REF_A","REF_FALLBACK"]'
  && firstSync.accountCount === 2
  && writes.length === 2
  && writes[0].ref === 'REF_A' && writes[1].ref === 'REF_FALLBACK',
  JSON.stringify({ refs: firstSync.mirroredRefs, writes: writes.map(w => w.ref) }))

const firstPayload = JSON.parse(writes[0].payload)
ok('㊲ 凭据字段名与 bili 解析一致（access_key_id / secret_access_key / security_token）',
  firstPayload.access_key_id === 'AK1' && firstPayload.secret_access_key === 'SK1'
  && firstPayload.security_token === 'T1' && typeof firstPayload.expires_at === 'string',
  JSON.stringify(Object.keys(firstPayload)))

const secondSync = await bridgeHandle.syncNow()
ok('㊲ 内容没变就不重写（每 10 秒一轮，不能每次都往凭据库塞一遍）',
  secondSync.lastWroteCount === 0 && writes.length === 2, String(secondSync.lastWroteCount))

// 密钥轮换：AK 变了必须立刻落库
writeFileSync(accountsPath, JSON.stringify({
  order: ['a-1', 'a-2'],
  accounts: {
    'a-1': { accessKeyId: 'AK1-NEW', secretAccessKey: 'SK1', token: 'T1', expiration: expSoon },
    'a-2': { accessKeyId: 'AK2', secretAccessKey: 'SK2', token: '', expiration: expSoon },
  },
}))
const rotated = await bridgeHandle.syncNow()
ok('㊲ 账号轮换后立刻把新 AK 写进去（不等到下一轮、也不比对时间戳）',
  rotated.lastWroteCount === 1 && JSON.parse(writes.filter(w => w.ref === 'REF_A').at(-1).payload).access_key_id === 'AK1-NEW',
  String(rotated.lastWroteCount))

const off = bridgeHandle.reconfigure({ enabled: false })
ok('㊲ 关掉后状态里说清「已关闭」，同步不再写任何东西',
  off.enabled === false && off.skipReason === '已关闭')
bridgeHandle.stop()

// 闸门现场：bili 的候选 ref 完全由 jet-hub 的 enabled/providerClosed 决定，
// 而 fallbackRefs 会让镜像「看起来永远成功」——闸门必须被单独读出来并报出来。
const gateBefore = await bridgeHandle.inspectGate?.() ?? null
// 上面已经 stop()，单独再开一个句柄读闸门（setup 阶段 REF_B 是停用的）
const gateProbe = bridgeModule.startCodeartsResignBridge({
  ctx: { get: (n) => (n === 'credentials' ? { set: () => {} } : undefined) },
  logger: bridgeLogger,
  settings: { enabled: true, intervalSeconds: 10 },
  fallbackRefs: ['REF_FALLBACK'],
  accountsFile: accountsPath,
  jetHubStateFile: jetHubPath,
})
const gateOpen = await gateProbe.inspectGate()
ok('㊳ 闸门现场：bili 能枚举到的 ref 数单独可见（不是靠镜像成功来推断）',
  gateOpen.seedless === undefined
  && gateOpen.accountsTotal === 2
  && gateOpen.accountsDisabled === 1
  && gateOpen.seeableRefs === 1
  && gateOpen.staleRefs === 1
  && gateOpen.closed === false,
  JSON.stringify(gateOpen))

// 用户关掉整个供应商：这次一个 ref 都枚举不到 —— 正是 bili 在转发前拒收的形态
writeFileSync(jetHubPath, JSON.stringify({
  providerClosed: { codearts: true },
  accounts: [
    { provider: 'codearts', credentialRef: 'REF_A', enabled: false },
    { provider: 'codearts', credentialRef: 'REF_B', enabled: false },
  ],
}))
const gateBlind = await gateProbe.inspectGate()
ok('㊳ 关掉供应商后 seeableRefs 归零且 closed=true —— 凭据镜像却照样成功',
  gateBlind.closed === true && gateBlind.seeableRefs === 0 && gateBlind.staleRefs === 2,
  JSON.stringify(gateBlind))
const blindSync = await gateProbe.syncNow()
// 三个事实一起构成那个盲区：①镜像没报错 ②还写进了 fallback（所以
// mirroredRefs 非空、/status 看起来「有落点」）③而 bili 能枚举到的真实 ref 是 0。
ok('㊳ 闸门关闭时镜像仍然「成功」并写进 fallback —— 这正是必须单独报闸门的原因',
  blindSync.lastError === null
  && blindSync.mirroredRefs.includes('REF_FALLBACK')
  && blindSync.gate.closed === true && blindSync.gate.seeableRefs === 0,
  JSON.stringify({ mirrored: blindSync.mirroredRefs, gate: blindSync.gate }))
gateProbe.stop()

const noCredHandle = bridgeModule.startCodeartsResignBridge({
  ctx: { get: () => undefined }, logger: bridgeLogger,
  settings: { enabled: true, intervalSeconds: 10 }, accountsFile: accountsPath, jetHubStateFile: jetHubPath,
})
const noCred = await noCredHandle.syncNow()
ok('㊲ 没有 credentials 服务时只记录原因，不报错也不写',
  noCred.skipReason && noCred.skipReason.includes('credentials') && noCred.lastSyncAt === null,
  String(noCred.skipReason))
noCredHandle.stop()

// 宿主 HTTP：/status 现场 + 设置项校验 + 手动同步
const hostStatus = (await api('GET', '/status')).body
ok('㊲ /status.resignBridge 回开关、间隔、落点与最近结果',
  hostStatus.resignBridge && typeof hostStatus.resignBridge.enabled === 'boolean'
  && typeof hostStatus.resignBridge.intervalSeconds === 'number'
  && Array.isArray(hostStatus.resignBridge.mirroredRefs)
  && 'skipReason' in hostStatus.resignBridge,
  JSON.stringify(hostStatus.resignBridge))

const intervalTooSmall = await api('POST', '/settings', { resignBridgeIntervalSeconds: 5 })
const intervalOk = await api('POST', '/settings', { resignBridgeIntervalSeconds: 30 })
const intervalStatus = (await api('GET', '/status')).body
ok('㊲ 同步间隔的下限是 10 秒（5 秒被拒，30 秒生效）',
  intervalTooSmall.status === 400
  && intervalOk.body.settings.resignBridgeIntervalSeconds === 30
  && intervalStatus.resignBridge.intervalSeconds === 30,
  JSON.stringify({ rejected: intervalTooSmall.status, live: intervalStatus.resignBridge.intervalSeconds }))

const syncCall = await api('POST', '/resign-bridge/sync', {})
ok('㊲ POST /resign-bridge/sync 手动触发一轮并回传现场',
  syncCall.status === 200 && syncCall.body.ok === true && syncCall.body.resignBridge !== undefined,
  JSON.stringify(syncCall.body.resignBridge || syncCall.body))

// ── ㊳ 插件市场：截图清单、卡片图标、50 字描述 ─────────────────────────────
// 市场读的是仓库根这一个文件与 locale 里的短描述，改完推送即生效；这里守的是
// 「不会因为路径写错/漏进 files 而在市场里变空图」与「描述不超字数、两处同句」。
const shotsJson = JSON.parse(readFileSync(new URL('./screenshots.json', import.meta.url), 'utf8'))
const shots = Array.isArray(shotsJson) ? shotsJson : shotsJson.screenshots
ok('㊳ screenshots.json 给市场 1 到 8 张仓库内截图，且都在 package.json 的 files 里',
  Array.isArray(shots) && shots.length >= 1 && shots.length <= 8
  && shots.every(p => typeof p === 'string' && !p.startsWith('/') && !p.includes('..')
    && existsSync(new URL('./' + p, import.meta.url)) && pkg.files.includes(p)),
  Array.isArray(shots) ? shots.length + ' 张' : String(shots))

const iconBytes = readFileSync(new URL('./assets/icon-180.png', import.meta.url))
ok('㊳ 市场卡片图标是随包发布的方形 PNG（SVG 会被市场拒绝）',
  iconBytes[0] === 0x89 && iconBytes.subarray(1, 4).toString('latin1') === 'PNG'
  && pkg.files.includes('assets/icon-180.png'),
  iconBytes.length + ' bytes')

const zhMeta = JSON.parse(readFileSync(new URL('./locale/zh.json', import.meta.url), 'utf8')).meta
const enMeta = JSON.parse(readFileSync(new URL('./locale/en.json', import.meta.url), 'utf8')).meta
ok('㊳ 市场描述不超过 50 字，且 package.json 与中文 locale 是同一句',
  [...pkg.description].length <= 50 && zhMeta.description === pkg.description,
  [...pkg.description].length + ' 字：' + pkg.description)
ok('㊳ 英文市场描述以句号结尾（awesome-dsh-plugin 的硬性要求）',
  typeof enMeta.description === 'string' && enMeta.description.trim().endsWith('.'),
  enMeta.description)
const failed = checks.filter(c => !c.pass).length
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
