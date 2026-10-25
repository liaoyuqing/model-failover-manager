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
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './host.v14.mjs'

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
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get(name) {
    if (name === 'accountPool') return accountPool
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
  on(event, fn) {
    const list = handlers.getAll(event)
    list.push(fn)
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

apply(ctx, { dataDir: dir })

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

const errHandler = handlers.one('agent/request-error')
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
ctx.get = baseGet
globalThis.fetch = baseFetch

const failed = checks.filter(c => !c.pass).length
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
