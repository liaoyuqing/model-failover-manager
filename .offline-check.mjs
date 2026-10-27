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
 * 只对 'ofm-p' 报出两个可用账号——正是「池里有这个 provider 的账号」这一事实，
 * 而 'codearts' 明明也有历史账号：插件必须靠 config.ofmHandoffExcludeProviders
 * 而不是账号存在性来判断是否换号。
 */
const poolCalls = []
const accountPool = {
  listAccountsByProvider(provider) {
    if (provider !== 'ofm-p') return []
    return [
      { id: 'ofm-p-1', provider, enabled: true },
      { id: 'ofm-p-2', provider, enabled: true },
    ]
  },
  async getAvailableAccount(provider, model) {
    poolCalls.push(['getAvailableAccount', provider, model])
    return { entry: { id: 'ofm-p-1' } }
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

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get(name) {
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
  { agent: ofmAgent, turn: 1, provider: 'ofm-p', failure: { code: 'QUOTA_EXCEEDED', message: '额度用尽', status: 403 } },
  () => Promise.resolve(undefined),
)
ofmAgent.status = 'idle'
ok('⑩ 名单外的 provider 仍先换账号重试（非限流失败也写冷却标记）',
  ofmAction?.kind === 'retry' && poolCalls.some(c => c[0] === 'updateModelRateLimit' && c[1] === 'ofm-p-1'),
  JSON.stringify({ action: ofmAction, calls: poolCalls }))
ok('⑩ /status 回传生效的排除名单',
  JSON.stringify((await api('GET', '/status')).body.ofmHandoffExcludeProviders) === JSON.stringify(['codearts']))

// ⑪ dsh-codearts：分辨「可以重建账号池」与「billion-context 拒绝转发签名请求」
let restartCalls = 0
let codeartsRegistered = true
/** 假的 /api/codearts/status 应答；每个用例改写它 */
let codeartsStatus = { usage: { slots: [] } }
const fakeLoader = {
  *entries() {
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
async function failOnCodearts(sessionId, failure) {
  const a = makeAgent(sessionId, {}, 'm1')
  agents.push(a)
  await api('POST', '/session-group', { sessionId, groupId: 'g2', mode: 'route' })
  a.status = 'running'
  const act = await errHandler({ agent: a, turn: 1, provider: 'codearts', failure }, () => Promise.resolve(undefined))
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

// ⑬ 模型并发上限：按模型（全局）配置生效，且 llm/stream 闸门按它排队。
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
// 直接驱动 llm/stream 闸门：连开两个流，第二个必须等第一个结束才拿到首字。
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
const gateB = Promise.withResolvers()
const outA = []
const outB = []
const iterA = await streamHandler({ provider: 'pc', model: 'mc', messages: [] }, () => fakeStream(gateA.promise))
const iterB = await streamHandler({ provider: 'pc', model: 'mc', messages: [] }, () => fakeStream(gateB.promise))
// 两个流的 gate 都由测试外部放开；流自己绝不 resolve 自己的 gate（否则会自我死锁）。
gateB.resolve()
const finishedA = (async () => { for await (const c of iterA) outA.push(c.type) })()
const finishedB = (async () => { for await (const c of iterB) outB.push(c.type) })()
await new Promise(r => setTimeout(r, 40))
ok('⑬ 并发=1 时第二个流必须排队（首字还没到）', outB.length === 0, `outB=${JSON.stringify(outB)}`)
// 放开 A：它跑完 → 释放槽位 → B 才被唤醒
gateA.resolve()
await Promise.all([finishedA, finishedB])
ok('⑬ 第一个流跑完后第二个才拿到首字', outB.length > 0, `outA=${JSON.stringify(outA)} outB=${JSON.stringify(outB)}`)
ok('⑬ 两个流都完整透传（闸门不改写 chunk）',
  outA.join(',') === 'text-delta,text-delta,usage,finish'
  && outB.join(',') === 'text-delta,text-delta,usage,finish',
  `outA=${outA.join(',')} outB=${outB.join(',')}`)

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
// fakeStream 每次吐 input 10 / output 8，共跑了两次（⑬ 的 A、B）
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
  onDisk?.['pc/mc']?.length >= 2
  && typeof onDisk['pc/mc'][0].inTokens === 'number'
  && typeof onDisk['pc/mc'][0].outTokens === 'number',
  JSON.stringify(onDisk?.['pc/mc']?.slice(-1)))
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
  bulkRow?.inTokens === 10 * (beforeSamples + BULK) && bulkRow?.outTokens === 8 * (beforeSamples + BULK),
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

const failed = checks.filter(c => !c.pass).length
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
