/**
 * trae-compress-shim.mjs 的离线自检：纯函数往返 + 一条真实的端到端链路。
 *
 * 端到端这一段刻意**不用 bili**：假 adapter 的原始 fetchImpl 把回环 URL 直接
 * 转发给本机 shim（并在途中模拟 bili 的改写：把 messages 折叠、注入系统提示与
 * 压缩工具），这样能在没有代理的环境里验证「压缩后还原 → 直发上游 → SOLO SSE
 * 转 OpenAI SSE → 包装器再重建回 SOLO」整条路径。
 *
 * 运行：node trae-compress-shim.selfcheck.mjs
 */

import http from 'node:http'
import assert from 'node:assert/strict'
import { startTraeCompressShim, soloBodyToOpenAi, openAiBodyToSolo, soloSseFrameToOpenAi, openAiSseFrameToSolo } from './trae-compress-shim.mjs'

/** 判断普通对象（自检脚本自带，不依赖 shim 内部实现）。 */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (err) {
    console.log('  FAIL ' + name + ' :: ' + (err && err.message ? err.message : err))
    process.exitCode = 1
  }
}

/** 真实形态的 SOLO body（照着 trae-adapter.js 发出的样子构造）。 */
const baseSolo = () => ({
  model: 'glm-5.2',
  config_name: 'glm-5.2',
  function: 'solo_work_lite',
  stream: true,
  max_tokens: 64000,
  model_selection_strategy: 'max',
  mode_type: 1,
  context_window_size: 1000000,
  prompt_max_tokens: 936000,
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'you are a coding agent' }] },
    // 正文必须足够长：压缩判定看的是「正文净长度是否变短」，短短一句被折叠成
    // 占位符反而会让总长度增长，folded 永远不触发（这一步是刻意构造的边界）。
    { role: 'user', content: [{ type: 'text', text: 'read the file ' + 'x'.repeat(400) }] },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function_call: { name: 'read', arguments: '{"path":"a.txt"}', namespace: 'ns', partial_arguments: '' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'hello world' }] },
  ],
  tools: [{ type: 'function', function: { name: 'read', description: 'read a file', parameters: '{"type":"object","properties":{"path":{"type":"string"}}}' } }],
})

console.log('[unit] 请求体往返')
check('soloBodyToOpenAi 折出 OpenAI 形状', () => {
  const out = soloBodyToOpenAi(baseSolo())
  assert.equal(out.ok, true)
  assert.equal(out.body.model, 'glm-5.2')
  assert.equal(out.body.config_name, undefined)
  assert.equal(out.body.function, undefined)
  assert.equal(out.body.messages[0].content, 'you are a coding agent')
  assert.deepEqual(out.body.messages[2].tool_calls[0].function, { name: 'read', arguments: '{"path":"a.txt"}' })
  assert.equal(out.body.messages[2].tool_calls[0].function_call, undefined)
  assert.equal(typeof out.body.tools[0].function.parameters, 'object')
  assert.equal(out.body.messages[3].content, 'hello world')
})

check('openAiBodyToSolo 以原始 body 为底还原（保住 Max 模式与通道）', () => {
  const folded = soloBodyToOpenAi(baseSolo())
  const solo = openAiBodyToSolo(folded.body, { base: baseSolo(), channel: 'solo_work_lite' })
  assert.equal(solo.function, 'solo_work_lite')
  assert.equal(solo.config_name, 'glm-5.2')
  assert.deepEqual(solo.model_auto_selection, undefined)
  assert.equal(solo.mode_type, 1)
  assert.equal(solo.context_window_size, 1000000)
  assert.equal(solo.prompt_max_tokens, 936000)
  assert.equal(solo.messages[0].content[0].text, 'you are a coding agent')
  assert.equal(solo.messages[2].tool_calls[0].function_call.name, 'read')
  assert.equal(typeof solo.tools[0].function.parameters, 'string')
  // 回到 SOLO 侧时 content 必须重新变成数组：上游 Go 结构体要求
  // messages[].content 是 []*idecop，裸字符串会 4001（pack.js:35304 的
  // transformSOLOMessage 对任何 role 都包数组）。
  assert.deepEqual(solo.messages[3].content, [{ type: 'text', text: 'hello world' }])
})

check('soloBodyToOpenAi 对残缺形态拒绝接管', () => {
  const bad = baseSolo()
  bad.messages = []
  assert.equal(soloBodyToOpenAi(bad).ok, false)
  const bad2 = baseSolo()
  bad2.messages[1].content = [{ type: 'video', url: 'x' }]
  assert.equal(soloBodyToOpenAi(bad2).ok, false)
})

check('SOLO 产物不变量：任何 message 的 content 都不是裸字符串', () => {
  const openAiBody = {
    model: 'glm-5.2',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'file contents' },
      { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'segmented' }] },
      { role: 'assistant', content: 'done' },
    ],
  }
  const solo = openAiBodyToSolo(openAiBody, { base: { model: 'glm-5.2', config_name: 'glm-5.2', function: 'solo_work_lite', stream: true } })
  for (const message of solo.messages) {
    if (message.content === null) continue
    assert.ok(Array.isArray(message.content), message.role + ' 的 content 不能是 ' + typeof message.content)
  }
  assert.deepEqual(solo.messages[3].content, [{ type: 'text', text: 'file contents' }])
  assert.deepEqual(solo.messages[4].content, [{ type: 'text', text: 'segmented' }])
  assert.equal(solo.messages[2].content, null, '纯 tool_calls 的 assistant 仍允许 null')
})

console.log('[unit] SSE 双向')
check('soloSseFrameToOpenAi：output/token_usage/done/其它', () => {
  const out = soloSseFrameToOpenAi('output', { response: 'hi', reasoning_content: 'think', tool_calls: [{ id: 'c1', index: 0, function_call: { name: 'read', arguments: '{}' } }] })
  assert.equal(out.choices[0].delta.content, 'hi')
  assert.equal(out.choices[0].delta.reasoning_content, 'think')
  assert.equal(out.choices[0].delta.tool_calls[0].function.name, 'read')
  assert.equal(soloSseFrameToOpenAi('token_usage', { prompt_tokens: 5 }).usage.prompt_tokens, 5)
  assert.equal(soloSseFrameToOpenAi('done', { finish_reason: 'stop' }).choices[0].finish_reason, 'stop')
  assert.equal(soloSseFrameToOpenAi('metadata', { total_cost: 1 }), null)
})

check('openAiSseFrameToSolo：content/reasoning/tool_calls/usage/finish', () => {
  const evs = openAiSseFrameToSolo({ choices: [{ index: 0, delta: { content: 'hi', reasoning_content: 'think', tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'stop' }], usage: { prompt_tokens: 7 } })
  assert.deepEqual(evs.map((e) => e.event), ['output', 'output', 'output', 'token_usage', 'done'])
  assert.equal(evs[0].data.response, 'hi')
  assert.equal(evs[2].data.tool_calls[0].function_call.name, 'read')
  assert.equal(evs[4].data.finish_reason, 'stop')
  assert.deepEqual(openAiSseFrameToSolo({ choices: [{ index: 0, delta: {} }] }), [])
})

console.log('[e2e] 压缩后还原 → 直发上游 → 双段 SSE')

/** 假上游：按真实 SOLO 形态发事件流（含一条 tool_calls 与一条 usage）。 */
const startUpstream = (options) => new Promise((resolve) => {
  const failAlways = isPlainObject(options) && options.fail === true
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body = null
      try { body = JSON.parse(raw) } catch { body = null }
      globalThis.__upstreamSeen = { url: req.url, headers: req.headers, body }
      if (failAlways) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"code":5001,"message":"upstream exploded"}')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('event: output\ndata: {"response":"hello, ","reasoning_content":"thinking"}\n\n')
      res.write('event: output\ndata: {"response":"world","tool_calls":[{"id":"call_x","index":0,"function_call":{"name":"read","arguments":"{\\\"path\\\":\\\"a.txt\\\"}"}}]}\n\n')
      res.write('event: token_usage\ndata: {"prompt_tokens":9123,"completion_tokens":12,"cache_read_input_tokens":9000}\n\n')
      res.write('event: done\ndata: {"finish_reason":"stop"}\n\n')
      res.end()
    })
  })
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
})

/**
 * 模拟 bili 的压缩：把 user 消息正文折成占位符、注入系统提示与压缩工具。
 *
 * 用占位符而不是「摘要」两个字的理由：占位符必须比原文短，否则
 * stats.folded（正文变短）根本不会触发 —— 那正是本自检要验证的判定。
 */
const compress = (body) => {
  const messages = body.messages.map((m) => (
    m.role === 'user' && typeof m.content === 'string' && m.content.length > 120 ? { ...m, content: '<acp/>' } : m
  ))
  const tools = [...(body.tools ?? []), { type: 'function', function: { name: 'compress', description: 'compress the context', parameters: { type: 'object', properties: {} } } }]
  return { ...body, messages: [{ role: 'system', content: 'Compression Philosophy: fold old turns.' }, ...messages], tools }
}

const runE2e = async () => {
  const up = await startUpstream()
  const port = 47019
  const adapters = new Map()
  // 假 adapter 的 fetchImpl 就是「包装之前的原实现」：它把回环 URL 交给本机
  // shim，并在途中模拟 bili —— 折叠 messages、注入系统提示与压缩工具。
  const originalFetch = async (url, init) => {
    const target = String(url)
    if (!target.includes('/trae/')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    const rewritten = compress(JSON.parse(init.body))
    return fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rewritten) })
  }
  const adapter = { fetchImpl: originalFetch }
  adapters.set('ofm-trae', { adapter })
  const handle = await startTraeCompressShim({
    port,
    logger: { info: () => {}, warn: () => {} },
    ctx: { get: (name) => (name === 'llm' ? { adapters } : undefined) },
  })
  // 走 adapter 的**当前** fetchImpl（已被 shim 包成 portal），这才是真实调用路径。
  const response = await adapter.fetchImpl('http://127.0.0.1:' + up.port + '/api/agent/v3/llm_utils_chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Cloud-IDE-JWT tok', 'x-ide-token': 'tok' },
    body: JSON.stringify({ ...baseSolo(), config_name: 'glm-5.2' }),
  })
  assert.equal(response.status, 200)
  assert.ok(String(response.headers.get('content-type')).includes('text/event-stream'))
  const text = await response.text()
  assert.ok(text.includes('event: output'), '回程必须是 SOLO 事件（adapter 只认 event:）')
  assert.ok(text.includes('event: token_usage'))
  assert.ok(text.includes('event: done'))
  assert.ok(text.includes('"response":"hello, "'))
  assert.ok(text.includes('function_call'))
  assert.ok(text.includes('9123'), '真实用量必须保留（bili 的 0 值占位不能覆盖它）')
  // eslint 不参与：这里只要求上游收到的是「还原后的 SOLO body」。
  const seen = globalThis.__upstreamSeen
  assert.equal(seen.headers.authorization, 'Cloud-IDE-JWT tok', '上游必须收到原始鉴权头')
  assert.equal(seen.headers['x-ide-token'], 'tok')
  assert.equal(seen.body.function, 'solo_work_lite', '上行的 function 通道必须保住')
  assert.equal(seen.body.mode_type, 1, 'Max 模式字段必须保住')
  assert.equal(seen.body.messages[0].role, 'system', '压缩后的系统提示必须被带上去')
  assert.ok(seen.body.messages.some((m) => Array.isArray(m.content) && m.content[0]?.text === '<acp/>'), '压缩结果必须真的进上游')
  // 压低后的顺序：注入的 system / 原始 system / user / assistant / tool
  assert.equal(seen.body.messages[0].role, 'system')
  assert.equal(seen.body.messages[0].content[0].text, 'Compression Philosophy: fold old turns.')
  assert.equal(seen.body.messages[1].role, 'system')
  assert.equal(seen.body.messages[2].content[0].text, '<acp/>')
  assert.equal(seen.body.messages[3].content, null, '纯 tool_calls 的 assistant content 保持 null')
  assert.equal(seen.body.messages[3].tool_calls[0].function_call.name, 'read')
  assert.deepEqual(seen.body.messages[4].content, [{ type: 'text', text: 'hello world' }], 'tool 角色 content 在 SOLO wire 上也必须是数组')
  const st = handle.status()
  assert.equal(st.intercepted >= 1, true)
  assert.equal(st.forwarded >= 1, true)
  assert.equal(st.compacted, 1, 'bili 的改写必须被识别为 compacted')
  assert.equal(st.folded, 1, '正文变短必须被识别为 folded')
  assert.equal(st.returnLeg.openAiFrames > 0, true)
  assert.equal(st.returnLeg.soloFrames > 0, true)
  await handle.stop()
  await new Promise((resolve) => up.server.close(resolve))
  console.log('  ok   e2e 贯通（压缩 → 还原 → 上游 → 重建 SOLO）')
  passed += 1
}

/** 错误路径：上游 500 必须原样回到 adapter（不能伪造成事件流）。 */
const runErrorPath = async () => {
  const up = await startUpstream({ fail: true })
  const port = 47020
  const adapters = new Map()
  const adapter = {
    fetchImpl: async (url, init) => {
      const target = String(url)
      if (!target.includes('/trae/')) return new Response('{}', { status: 200 })
      return fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: init.body })
    },
  }
  adapters.set('ct-trae', { adapter })
  const handle = await startTraeCompressShim({ port, ctx: { get: (name) => (name === 'llm' ? { adapters } : undefined) }, logger: { info: () => {}, warn: () => {} } })
  const response = await adapter.fetchImpl('http://127.0.0.1:' + up.port + '/api/agent/v3/llm_utils_chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseSolo()) })
  assert.equal(response.status, 500)
  assert.equal(String(response.headers.get('content-type')).includes('text/event-stream'), false, '错误体不能被伪造成事件流')
  const body = await response.text()
  assert.ok(body.includes('5001'))
  await handle.stop()
  await new Promise((resolve) => up.server.close(resolve))
  console.log('  ok   e2e 错误路径原样透出')
  passed += 1
}

/** 非 TRAE 端点绝不被接管。 */
const runBypass = async () => {
  const port = 47021
  const adapters = new Map()
  const calls = []
  const fakeAdapter = {
    fetchImpl: async (url, init) => {
      calls.push(String(url))
      return new Response('{"models":[]}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
  adapters.set('caa-trae', { adapter: fakeAdapter })
  const handle = await startTraeCompressShim({ port, ctx: { get: (name) => (name === 'llm' ? { adapters } : undefined) }, logger: { info: () => {}, warn: () => {} } })
  const r = await fakeAdapter.fetchImpl('https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param', { method: 'POST', body: '{}' })
  assert.equal(r.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].includes('/trae/'), false)
  await handle.stop()
  console.log('  ok   e2e 非对话端点透传')
  passed += 1
}

/**
 * 端口被占：必须以**可捕获的拒绝**退场，而不是让宿主进程崩掉。
 *
 * listen 的失败在 Node 里是异步 'error' 事件：没有监听器时它会成为未捕获异常，
 * 直接结束进程。本 shim 的承诺是「装不上只告警、TRAE 照常直发」，所以这条路径
 * 必须 reject，且已经装上的 fetchImpl 包装要还原，不留半接管状态。
 */
const runPortConflict = async () => {
  const taken = await new Promise((resolve) => {
    const blocker = http.createServer((_req, res) => res.end())
    blocker.listen(0, '127.0.0.1', () => resolve({ blocker, port: blocker.address().port }))
  })
  const adapters = new Map()
  const original = async () => new Response('{}', { status: 200 })
  const adapter = { fetchImpl: original }
  adapters.set('ct-trae', { adapter })
  let rejected = null
  try {
    await startTraeCompressShim({ port: taken.port, ctx: { get: (name) => (name === 'llm' ? { adapters } : undefined) }, logger: { info: () => {}, warn: () => {} } })
  } catch (err) {
    rejected = err
  }
  assert.equal(rejected?.code, 'EADDRINUSE', '端口冲突必须 reject 成 EADDRINUSE')
  // 半接管检查：失败的启动不能把 adapter 的 fetchImpl 留在包装上。
  assert.equal(adapter.fetchImpl, original, '启动失败必须还原已装的包装')
  await new Promise((resolve) => taken.blocker.close(resolve))
  console.log('  ok   e2e 端口被占时只 reject，不崩进程、不留半接管')
  passed += 1
}

await runE2e()
await runErrorPath()
await runBypass()
await runPortConflict()
console.log('\n通过 ' + passed + ' 项')
