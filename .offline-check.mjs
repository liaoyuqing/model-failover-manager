/**
 * 离线自检：用假的 ctx 直接跑 host.v6.mjs 的监听器与 HTTP 处理器。
 * 目的：在不重启宿主的前提下验证
 *   ① 子代理按 parentSession 继承分组（含旧 bug 写入的无 explicit 绑定）
 *   ② 子代理模型切换不再调用 sessionController.selectModel（宿主必拒）
 *   ③ 子代理彻底失败后返回 {kind:'retry'} 并换到组内下一个模型
 *   ④ /session-info / /session-model 的读写结果
 * 只在临时 dataDir 里读写，不碰真实分组/绑定。
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './host.v7.mjs'

const dir = mkdtempSync(join(tmpdir(), 'mfm-offline-'))
writeFileSync(join(dir, 'groups.json'), JSON.stringify([
  {
    id: 'g1', name: 'G1', enabled: true, models: [
      { provider: 'p', model: 'm1', priority: 1 },
      { provider: 'p', model: 'm2', priority: 2 },
      { provider: 'p', model: 'm3', priority: 3 },
    ],
  },
]))
writeFileSync(join(dir, 'failed.json'), '[]')
writeFileSync(join(dir, 'default-binding.json'), JSON.stringify({ groupId: null }))
writeFileSync(join(dir, 'session-bindings.json'), JSON.stringify([
  { sessionId: 'parent-1', groupId: 'g1', mode: 'route' },
  // 历史 bug 自动写上的：没有 explicit
  { sessionId: 'sub-legacy', groupId: 'other', mode: 'route' },
  // 用户显式给子代理绑的
  { sessionId: 'sub-explicit', groupId: 'g1', mode: 'route', explicit: true },
]))

const appended = []
function makeSession(id, header, model) {
  return {
    id,
    header,
    append(type, data) { appended.push({ id, type, data }) },
    requestHeader() { return { config: { provider: 'p', model } } },
  }
}
const agents = [
  { id: 'parent-1', session: makeSession('parent-1', {}, 'm1'), options: { provider: 'p', model: 'm1' } },
  { id: 'sub-legacy', session: makeSession('sub-legacy', { origin: 'subagent', parentSession: 'parent-1' }, 'm1'), options: { provider: 'p', model: 'm1' } },
  { id: 'sub-explicit', session: makeSession('sub-explicit', { origin: 'subagent', parentSession: 'parent-1' }, 'm1'), options: { provider: 'p', model: 'm1' } },
]

const handlers = new Map()
let routeHandler = null
let selectModelCalls = 0
const ctx = {
  logger: { info() {}, warn(m) { console.log('  warn:', m) }, error(m) { console.log('  error:', m) } },
  get(name) {
    if (name === 'agents') return { list: () => agents, get: (id) => agents.find(a => a.id === id) }
    if (name === 'sessionController') {
      return {
        selectModel() { selectModelCalls++; return Promise.reject(new Error('session "x" is owned by subagent routing')) },
      }
    }
    return undefined
  },
  on(event, fn) { handlers.set(event, fn); return () => handlers.delete(event) },
  inject(_names, cb) { cb({ webServer: { register(spec) { routeHandler = spec.handler; return () => {} } }, effect() {}, interval() { return () => {} } }) },
  effect() {},
  interval() { return () => {} },
}

apply(ctx, { dataDir: dir })

function call(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.on = req.on.bind(req)
  const res = {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(s) { this.body = s },
  }
  const p = routeHandler(req, res)
  if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); }
  req.emit('end')
  return Promise.resolve(p).then(() => ({ status: res.statusCode, body: JSON.parse(res.body || 'null') }))
}

const checks = []
function ok(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const info = async (id) => (await call('GET', `/api/model-failover/session-info?sessionId=${id}`)).body

// ① 继承
const legacy = await info('sub-legacy')
ok('旧 bug 写入的子代理绑定被忽略，继承父会话分组',
  legacy.effectiveBinding?.groupId === 'g1' && legacy.effectiveBinding?.inherited === true && legacy.effectiveBinding?.viaSessionId === 'parent-1',
  JSON.stringify(legacy.effectiveBinding))

const explicit = await info('sub-explicit')
ok('用户显式绑定的子代理用自己的分组',
  explicit.effectiveBinding?.groupId === 'g1' && explicit.effectiveBinding?.inherited === false,
  JSON.stringify(explicit.effectiveBinding))

// ② 选模型不碰 sessionController
selectModelCalls = 0
const set = await call('POST', '/api/model-failover/session-model', { sessionId: 'sub-legacy', provider: 'p', model: 'm2' })
ok('子代理设模型成功且不调用 sessionController.selectModel',
  set.body.ok === true && selectModelCalls === 0 && set.body.model?.model === 'm2',
  `status=${set.status} selectModelCalls=${selectModelCalls}`)
ok('子代理写了一条 model/selection 日志事件',
  appended.some(a => a.id === 'sub-legacy' && a.type === 'model/selection' && a.data.model === 'm2'))

// ③ agent/request 覆写
const disposeRequest = handlers.get('agent/request')
const proposed = { provider: 'p', model: 'm1', maxTokens: 5 }
const out = await disposeRequest({ agent: agents[1] }, () => Promise.resolve(proposed))
ok('agent/request 用覆盖值改写请求模型',
  out.provider === 'p' && out.model === 'm2' && out.maxTokens === 5,
  `${out.provider}/${out.model}`)

// ④ 失败后同轮重试（关键：旧版这里返回 undefined，子代理整轮中断）
const errHandler = handlers.get('agent/request-error')
const errAgent = agents[2] // sub-explicit，m1 失败 → 应切到 m2
const action = await errHandler(
  { agent: errAgent, turn: 1, provider: 'p', failure: { code: 'QUOTA_EXCEEDED', message: '余额不足', status: 403 } },
  () => Promise.resolve(undefined),
)
ok('子代理彻底失败后返回 retry（旧版因 selectModel 失败返回 undefined）',
  action?.kind === 'retry', JSON.stringify(action))
ok('子代理失败后切到组内下一个模型（不是被拽回第一个）',
  appended.some(a => a.id === 'sub-explicit' && a.type === 'model/selection' && a.data.model === 'm2'),
  JSON.stringify(appended.filter(a => a.id === 'sub-explicit')))

// ⑥ 全新子代理：沿用父会话当前模型，而不是被拽回组内第一个
const fresh = { id: 'sub-fresh', session: makeSession('sub-fresh', { origin: 'subagent', parentSession: 'parent-1' }, 'm3'), options: { provider: 'p', model: 'm3' } }
agents.push(fresh)
const keptOut = await disposeRequest({ agent: fresh }, () => Promise.resolve({ provider: 'p', model: 'm3' }))
ok('新子代理沿用父会话当前模型 m3（组内第一个是 m1）',
  keptOut.provider === 'p' && keptOut.model === 'm3', `${keptOut.provider}/${keptOut.model}`)

// ⑤ 子代理绑分组不写默认分组
const defBefore = (await call('GET', '/api/model-failover/status')).body.defaultBinding
const bind = await call('POST', '/api/model-failover/session-group', { sessionId: 'sub-legacy', groupId: 'g1', mode: 'route' })
const defAfter = (await call('GET', '/api/model-failover/status')).body.defaultBinding
ok('子代理绑分组不改变新会话默认分组',
  bind.body.ok === true && JSON.stringify(defBefore) === JSON.stringify(defAfter),
  `${JSON.stringify(defBefore)} → ${JSON.stringify(defAfter)}`)

const failed = checks.filter(c => !c.pass).length
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
