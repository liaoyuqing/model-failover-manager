/**
 * 离线自检：用假的 ctx 直接跑宿主半的监听器与 HTTP 处理器，不重启宿主即可验证行为。
 * 只在临时 dataDir 里读写，不碰真实的分组/绑定文件。
 *
 * 覆盖：
 *   ① 子代理沿 parentSession 继承分组（旧 bug 写进去的无 explicit 绑定必须被忽略）
 *   ② 子代理换模型不调用 sessionController.selectModel（宿主对子代理一律拒绝）
 *   ③ 子代理彻底失败后仍返回 {kind:'retry'} 并切到组内下一个模型
 *   ④ agent/request 用覆盖值改写请求；新子代理沿用父会话当前模型
 *   ⑤ 每次发消息（step 0）的健康检查：可用即保留，失败/出窗/过期才切
 *   ⑥ 给子代理绑分组不改变「新会话默认分组」
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './host.v9.mjs'

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
function makeAgent(id, header, model) {
  return { id, session: makeSession(id, header, model), options: { provider: 'p', model } }
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
let routeHandler = null
let selectModelCalls = 0
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get(name) {
    if (name === 'agents') return { list: () => agents, get: (id) => agents.find(a => a.id === id) }
    if (name === 'sessionController') {
      return {
        // 与宿主同一条规则：子代理会话一律拒绝（session/agent-busy）
        selectModel({ sessionId, model }) {
          selectModelCalls++
          const agent = agents.find(a => a.id === sessionId)
          if (agent?.session?.header?.origin === 'subagent') {
            return Promise.reject(new Error(`session "${sessionId}" is owned by subagent routing`))
          }
          agent.session.state.model = model
          return Promise.resolve()
        },
      }
    }
    return undefined
  },
  on(event, fn) { handlers.set(event, fn); return () => handlers.delete(event) },
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

/** 跑一次「新一轮第一步」，返回这轮结束后该会话的模型 */
async function runPreStep(id) {
  const agent = agents.find(a => a.id === id)
  const handler = handlers.get('agent/pre-step')
  await handler({ agent, step: 0 }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  return agent.session.state.model
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
ok('② 子代理仍写 durable model/selection 事件', switchOf('sub-legacy') === 'm2')

// ③ agent/request 覆写 + 失败续跑
const requestHandler = handlers.get('agent/request')
const rewritten = await requestHandler(
  { agent: agents.find(a => a.id === 'sub-legacy') },
  () => Promise.resolve({ provider: 'p', model: 'm1', maxTokens: 5 }),
)
ok('③ agent/request 用覆盖值改写请求模型',
  rewritten.model === 'm2' && rewritten.maxTokens === 5, `${rewritten.provider}/${rewritten.model}`)

const errHandler = handlers.get('agent/request-error')
const action = await errHandler(
  { agent: agents.find(a => a.id === 'sub-explicit'), turn: 1, provider: 'p', failure: { code: 'QUOTA_EXCEEDED', message: '余额不足', status: 403 } },
  () => Promise.resolve(undefined),
)
ok('③ 子代理彻底失败后返回 retry（旧版在这里直接结束本轮）', action?.kind === 'retry', JSON.stringify(action))
ok('③ 失败后切到组内下一个而不是被拽回第一个', switchOf('sub-explicit') === 'm2')

const fresh = makeAgent('sub-fresh', { origin: 'subagent', parentSession: 'parent-1' }, 'm3')
agents.push(fresh)
const kept = await requestHandler({ agent: fresh }, () => Promise.resolve({ provider: 'p', model: 'm3' }))
ok('③ 新子代理沿用父会话当前模型 m3（组内第一是 m1）', kept.model === 'm3')

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

const failed = checks.filter(c => !c.pass).length
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
