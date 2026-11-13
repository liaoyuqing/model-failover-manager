/**
 * lan-gateway.mjs — 把路由分组以 OpenAI 兼容接口提供给局域网（LAN）。
 *
 * 分工：本模块只做 HTTP/JSON/SSE 的翻译，以及「失败就换下一个候选」的循环；
 * 分组、候选挑选、失败记账、并发闸门、速度采样全部由 host.mjs 通过 runtime
 * 回调注入，这里不重复实现任何路由规则。
 *
 * 三个必须成立的性质：
 *  1. 转发一律走 ctx.get('llm').stream()，于是宿主与本插件挂在 llm/stream 上的
 *     并发闸门、实时速度、采样对局域网流量与 GUI 会话是同一份账——这正是
 *     「局域网调用的并发要一起统计」的实现方式，而不是另建一个计数器。
 *  2. 静默切换：在第一个内容增量写给客户端**之前**失败（401/429/容量满/没有
 *     adapter…）就悄悄换下一个候选，客户端看不到任何痕迹；已经出字之后再失败
 *     只能报错——此时重来会让客户端收到半截重复内容。
 *  3. model 字段就是路由名（分组别名，缺省用分组名）。
 *
 * 监听 0.0.0.0：宿主的 webServer 只绑回环（dsh web 明确拒绝 --host 0.0.0.0），
 * 局域网转发必须自己开端口。服务不做鉴权（用户明确选择内网直用），因此这里
 * 只承诺「能连上就能调」，隔离靠防火墙与内网。
 */

import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { randomUUID } from 'node:crypto'

/** 跨重载复用同一个监听套接字与统计：Loader 重建条目时旧实例先 dispose，但端口
 *  尚在 TIME_WAIT 或旧实例还没关完时，新实例直接接管同一个 server 比重新 listen 稳。 */
const STATE_KEY = Symbol.for('model-failover-manager.lan-gateway')
/** 请求体上限：带图片的聊天历史会很大（base64 会再膨胀 4/3），但也不该无限收。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** 一次请求最多换几个候选：候选多于这个数就说明分组里大半模型都不可用，继续换也没意义。 */
const MAX_ATTEMPTS = 8
/** /status 里保留的最近请求条数。 */
const RECENT_LIMIT = 20

/**
 * 启动（或接管）局域网转发服务。
 *
 * @param {object} options - 启动参数。
 * @param {number} options.port - 监听端口（1..65535）。
 * @param {object} options.logger - 宿主的 ctx.logger（info/warn）。
 * @param {object} options.runtime - host.mjs 注入的路由回调，见文件头。
 * @returns {Promise<{status: () => object, stop: () => Promise<void>}>} 句柄。
 */
export async function startLanGateway({ port, logger, runtime }) {
  const previous = globalThis[STATE_KEY]
  if (previous !== undefined) {
    if (previous.port === port && previous.server !== null) {
      // 同端口热替换：沿用旧套接字，只换实现与运行时回调，端口不会闪断
      previous.runtime = runtime
      previous.logger = logger
      logger.info('[model-failover] 局域网转发已热替换实现（继续复用 0.0.0.0:' + port + '）')
      return { status: () => snapshot(previous), stop: previous.stop }
    }
    await previous.stop()
  }

  const handle = {
    port,
    runtime,
    logger,
    startedAt: Date.now(),
    lastError: null,
    stats: {
      requests: 0,
      ok: 0,
      failed: 0,
      retried: 0,
      active: 0,
      recent: [],
      byRoute: new Map(),
    },
    server: null,
    stop,
  }

  const server = createServer((req, res) => {
    const current = globalThis[STATE_KEY] ?? handle
    Promise.resolve(handleRequest(req, res, current)).catch((err) => {
      handle.lastError = messageOf(err)
      if (!res.headersSent) {
        sendError(res, 500, '服务端错误：' + messageOf(err), 'server_error', 'server_error')
        return
      }
      try { res.end() } catch { /* 连接已断，没什么可做的 */ }
    })
  })
  handle.server = server
  server.on('error', (err) => { handle.lastError = '监听期间错误：' + messageOf(err) })

  // listen 的失败是异步 'error' 事件：没有监听器就是未捕获异常，会带走整个宿主。
  // 端口被占（另一份部署、旧实例没退干净）在这里折成可捕获失败，交给调用方告警。
  try {
    await new Promise((resolve, reject) => {
      const onError = (err) => { server.removeListener('listening', onListening); reject(err) }
      const onListening = () => { server.removeListener('error', onError); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '0.0.0.0')
    })
  } catch (err) {
    handle.lastError = '监听 0.0.0.0:' + port + ' 失败：' + messageOf(err)
    await stop.call(handle)
    throw err
  }

  // port 传 0 时由系统分配，快照与可复制地址必须回真实绑定端口，否则界面上那个端口是错的
  const bound = server.address()
  if (bound !== null && typeof bound === 'object') handle.port = bound.port

  globalThis[STATE_KEY] = handle

  /**
   * 退场：停止监听并释放槽位。幂等；重复调用不会抛。
   * @returns {Promise<void>} 套接字关完即 resolve（最多等 2s）。
   */
  async function stop() {
    if (handle.server === null) return
    const closing = handle.server
    handle.server = null
    if (globalThis[STATE_KEY] === handle) delete globalThis[STATE_KEY]
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { closing.closeAllConnections?.() } catch { /* 老 Node 没有这个方法 */ }
        resolve()
      }, 2000)
      try {
        closing.close(() => { clearTimeout(timer); resolve() })
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  return { status: () => snapshot(handle), stop }
}

/**
 * 服务现场：端口、监听状态、可复制给客户端的地址、累计统计与最近请求。
 * @param {object} handle - 内部状态。
 * @returns {object} 可 JSON 序列化的快照。
 */
function snapshot(handle) {
  const stats = handle.stats
  return {
    running: handle.server !== null,
    listening: handle.server !== null && handle.server.listening === true,
    port: handle.port,
    bindHost: '0.0.0.0',
    baseUrl: 'http://' + (localAddresses()[0] ?? '127.0.0.1') + ':' + handle.port + '/v1',
    addresses: localAddresses().map(ip => 'http://' + ip + ':' + handle.port + '/v1'),
    startedAt: handle.startedAt,
    lastError: handle.lastError,
    routes: typeof handle.runtime.describeRoutes === 'function' ? handle.runtime.describeRoutes() : [],
    stats: {
      requests: stats.requests,
      ok: stats.ok,
      failed: stats.failed,
      retried: stats.retried,
      active: stats.active,
      recent: stats.recent.slice(),
      byRoute: [...stats.byRoute.entries()].map(([route, row]) => ({ route, ...row })),
    },
  }
}

/** 本机的局域网 IPv4 地址（排除回环）；取不到时返回空数组。 */
function localAddresses() {
  const out = []
  try {
    const nets = networkInterfaces()
    for (const list of Object.values(nets)) {
      for (const net of list ?? []) {
        if (net.family !== 'IPv4' || net.internal) continue
        out.push(net.address)
      }
    }
  } catch { /* 取不到网卡信息不影响服务本身 */ }
  return out
}

/**
 * 一个请求的总入口：路由分发、CORS、错误兜底。
 *
 * @param {import('node:http').IncomingMessage} req - 原始请求。
 * @param {import('node:http').ServerResponse} res - 原始响应。
 * @param {object} handle - 内部状态。
 * @returns {Promise<void>} 响应写完即 resolve。
 */
async function handleRequest(req, res, handle) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'authorization, content-type')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }

  let url
  try { url = new URL(req.url || '/', 'http://lan.local') } catch {
    sendError(res, 400, '请求 URL 不合法', 'invalid_request_error', 'invalid_request')
    return
  }
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (path === '/v1/models' && req.method === 'GET') { sendJson(res, 200, modelsPayload(handle)); return }
  if ((path === '/v1/chat/completions' || path === '/chat/completions') && req.method === 'POST') {
    await handleChat(req, res, handle)
    return
  }
  if (path === '/healthz' || path === '/' || path === '/v1') {
    sendJson(res, 200, { ok: true, service: 'model-failover-manager LAN gateway', routes: handle.runtime.describeRoutes() })
    return
  }
  sendError(res, 404, '未知端点 ' + req.method + ' ' + path + '（可用：GET /v1/models、POST /v1/chat/completions）', 'invalid_request_error', 'not_found')
}

/**
 * /v1/models：一个可调用的路由就是一行，id 即客户端要填的 model。
 * @param {object} handle - 内部状态。
 * @returns {object} OpenAI 模型列表。
 */
function modelsPayload(handle) {
  const created = Math.floor(handle.startedAt / 1000)
  return {
    object: 'list',
    data: handle.runtime.describeRoutes().map((route) => ({
      id: route.id,
      object: 'model',
      created,
      owned_by: 'model-failover-manager',
    })),
  }
}
/**
 * POST /v1/chat/completions 的主流程：解析 → 选首个候选 → 逐个候选尝试
 * （首个内容增量之前失败就静默换下一个）。
 *
 * @param {import('node:http').IncomingMessage} req - 原始请求。
 * @param {import('node:http').ServerResponse} res - 原始响应。
 * @param {object} handle - 内部状态。
 * @returns {Promise<void>} 响应写完即 resolve。
 */
async function handleChat(req, res, handle) {
  const { runtime, stats } = handle
  let body
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch (err) {
    sendError(res, 400, '请求体不是合法 JSON：' + messageOf(err), 'invalid_request_error', 'invalid_json')
    return
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendError(res, 400, '请求体必须是 JSON 对象', 'invalid_request_error', 'invalid_json')
    return
  }
  const wanted = typeof body.model === 'string' ? body.model.trim() : ''
  if (!wanted) {
    sendError(res, 400, 'model 必填：填路由名（分组别名，缺省为分组名）', 'invalid_request_error', 'model_required')
    return
  }
  const route = runtime.resolveRoute(wanted)
  if (route === null) {
    sendError(res, 404, '没有名为「' + wanted + '」的路由：分组不存在、已停用，或该分组的局域网转发没开', 'invalid_request_error', 'route_not_found')
    return
  }

  let prepared
  try {
    prepared = await prepareRequest(body, runtime)
  } catch (err) {
    sendError(res, 400, messageOf(err), 'invalid_request_error', 'invalid_request')
    return
  }

  const wantsStream = body.stream === true
  const controller = new AbortController()
  res.on('close', () => { if (!res.writableEnded) controller.abort() })

  stats.requests += 1
  stats.active += 1
  const row = routeRow(stats, route.name)
  row.requests += 1
  row.active += 1
  const startedAt = Date.now()
  const completionId = 'chatcmpl-' + randomUUID()
  const created = Math.floor(startedAt / 1000)
  const sink = wantsStream
    ? createSseSink(res, route.name, completionId, created, Boolean(body.stream_options?.include_usage))
    : createBufferSink(res, route.name, completionId, created)

  let candidate = runtime.firstCandidate(route.groupId)
  if (candidate === null) {
    stats.active -= 1; row.active -= 1; stats.failed += 1; row.failed += 1
    noteRecent(stats, { at: startedAt, route: route.name, ok: false, candidate: null, ms: 0, code: 'NO_CANDIDATE', attempts: 0 })
    sendError(res, 503, '路由「' + route.name + '」此刻没有可用模型（全部当日失败、不在时段、已禁用，或并发已满）', 'server_error', 'no_candidate')
    return
  }

  const skipped = new Set()
  let attempts = 0
  let lastFailure = null

  try {
    while (candidate !== null && attempts < MAX_ATTEMPTS) {
      attempts += 1
      if (controller.signal.aborted) break
      const options = buildOptions(candidate, prepared, controller.signal, runtime)
      const llm = runtime.llm()
      if (llm === null || typeof llm.stream !== 'function') {
        sendError(res, 503, 'llm 服务不可用（宿主没挂载模型运行时）', 'server_error', 'llm_unavailable')
        return
      }

      const acc = createAttempt()
      let failure = null
      try {
        for await (const chunk of llm.stream(options)) {
          if (controller.signal.aborted) break
          consumeChunk(chunk, acc, sink)
          if (chunk.type === 'finish') {
            const kind = chunk.reason?.kind
            if (kind === 'error' || kind === 'aborted') failure = failureOf(chunk.reason)
            break
          }
        }
      } catch (err) {
        failure = { code: errorCodeOf(err), message: messageOf(err) }
      }
      if (failure === null && acc.finish === undefined) {
        // 流没给出 finish 就结束了：宿主不该这样，但这里不能把半截回答当成功
        failure = { code: 'STREAM_INCOMPLETE', message: '上游流在没有 finish 的情况下结束' }
      }

      if (failure === null) {
        sink.finish(acc)
        const ms = Date.now() - startedAt
        stats.ok += 1; row.ok += 1
        noteRecent(stats, { at: startedAt, route: route.name, ok: true, candidate: labelOf(candidate), ms, code: null, attempts })
        return
      }

      lastFailure = failure
      try { runtime.onFailure(candidate, failure) } catch { /* 记账失败不影响转发 */ }
      // 与 host 的记账同一口径（裸 provider/model），避免前缀写法不同时同一个模型被重复挑中
      skipped.add(typeof runtime.keyOf === 'function'
        ? runtime.keyOf(candidate)
        : String(candidate.provider) + '/' + String(candidate.model))

      // 已经给客户端写过内容：不能重来，只能如实报错（客户端看到的是半截 + 错误）
      if (sink.committed) {
        sink.fail(failure)
        const ms = Date.now() - startedAt
        stats.failed += 1; row.failed += 1
        noteRecent(stats, { at: startedAt, route: route.name, ok: false, candidate: labelOf(candidate), ms, code: failure.code ?? null, attempts })
        return
      }
      if (controller.signal.aborted || String(failure.code) === 'ABORTED') {
        sendError(res, 499, '客户端已断开', 'invalid_request_error', 'client_closed')
        return
      }
      const next = runtime.nextCandidate(route.groupId, candidate, skipped)
      if (next !== null) {
        stats.retried += 1
        handle.logger.info('[model-failover] 局域网转发：' + labelOf(candidate) + ' 失败（' + (failure.code ?? 'unknown') + '），静默换到 ' + labelOf(next))
      }
      candidate = next
    }

    // 所有候选都失败（或一次都没拿到）
    const why = lastFailure === null
      ? '没有可用候选'
      : '所有候选都失败，最后一个：' + (lastFailure.code ?? 'unknown') + ' ' + (lastFailure.message ?? '')
    const ms = Date.now() - startedAt
    stats.failed += 1; row.failed += 1
    noteRecent(stats, { at: startedAt, route: route.name, ok: false, candidate: null, ms, code: lastFailure?.code ?? 'NO_CANDIDATE', attempts })
    sendError(res, 502, '路由「' + route.name + '」' + why, 'upstream_error', lastFailure?.code ?? 'no_candidate')
  } finally {
    stats.active = Math.max(0, stats.active - 1)
    row.active = Math.max(0, row.active - 1)
  }
}

/** 一次尝试的累加器：成功的回答从这里组装，失败则整份丢弃。 */
function createAttempt() {
  return {
    text: '',
    reasoning: '',
    /** block index -> { id, name, arguments } */
    tools: new Map(),
    usage: null,
    finish: undefined,
  }
}

/**
 * 把宿主的 StreamChunk 折进累加器，并同时推给 sink（流式）。
 * @param {object} chunk - StreamChunk。
 * @param {object} acc - 本次尝试的累加器。
 * @param {object} sink - 输出端（SSE 或缓冲）。
 * @returns {void}
 */
function consumeChunk(chunk, acc, sink) {
  switch (chunk.type) {
    case 'text-delta':
      acc.text += chunk.text
      sink.text(chunk.text)
      return
    case 'reasoning-delta':
      acc.reasoning += chunk.text
      sink.reasoning(chunk.text)
      return
    case 'tool-call-delta': {
      const key = chunk.index
      const entry = acc.tools.get(key) ?? { id: '', name: '', arguments: '' }
      if (typeof chunk.id === 'string' && chunk.id) entry.id = chunk.id
      if (typeof chunk.name === 'string' && chunk.name) entry.name = chunk.name
      if (typeof chunk.argumentsDelta === 'string') entry.arguments += chunk.argumentsDelta
      acc.tools.set(key, entry)
      sink.toolDelta(key, entry, chunk.argumentsDelta)
      return
    }
    case 'block-end': {
      // tool-call 的最终入参以 block-end 为准（适配器会把校验过的 JSON 放回来）
      if (chunk.block?.type === 'tool-call' && typeof chunk.block.arguments === 'string') {
        const key = chunk.index
        const entry = acc.tools.get(key) ?? { id: chunk.block.id, name: chunk.block.name, arguments: '' }
        entry.id = chunk.block.id || entry.id
        entry.name = chunk.block.name || entry.name
        entry.arguments = chunk.block.arguments
        acc.tools.set(key, entry)
      }
      return
    }
    case 'usage':
      acc.usage = chunk.usage ?? null
      return
    case 'finish':
      acc.finish = chunk.reason
      return
    default:
      return
  }
}
/**
 * SSE 输出端。**关键状态是 committed**：在第一个内容增量之前不写响应头，
 * 于是上游失败时可以静默换候选，客户端连一个字节都没收到。
 *
 * @param {import('node:http').ServerResponse} res - 原始响应。
 * @param {string} model - 对客户端呈现的模型名（路由名）。
 * @param {string} id - chatcmpl id。
 * @param {number} created - 秒级时间戳。
 * @param {boolean} includeUsage - stream_options.include_usage。
 * @returns {object} sink。
 */
function createSseSink(res, model, id, created, includeUsage) {
  let committed = false
  let closed = false
  // 上游的 tool-call 序号是「块序号」，可能是 1、5 这种跳号——同一个工具调用
  // 前面还有别的块。OpenAI 的 tool_calls[].index 是客户端拼数组用的 0..n-1 位置，
  // 照抄块序号会让严格实现拼出 [空, 调用] 这样的洞，所以这里按出现顺序重新编号。
  const toolOrder = new Map()
  // id 与函数名只在**第一次**出现该调用时发（OpenAI 的形状），后文只发参数增量。
  const announced = new Set()

  const write = (payload) => {
    if (closed) return
    res.write('data: ' + JSON.stringify(payload) + '\n\n')
  }
  /** 流结束标记：OpenAI 客户端靠这一行走完「正常结束」那条分支。 */
  const done = () => {
    if (closed) return
    res.write('data: [DONE]\n\n')
  }
  const commit = () => {
    if (committed) return
    committed = true
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
  }
  const chunk = (delta, finishReason) => {
    const choices = [{ index: 0, delta, finish_reason: finishReason ?? null }]
    const payload = { id, object: 'chat.completion.chunk', created, model, choices }
    if (includeUsage && finishReason !== null) payload.usage = null
    write(payload)
  }

  return {
    get committed() { return committed },
    text(delta) {
      if (!delta) return
      commit()
      chunk({ content: delta })
    },
    reasoning(delta) {
      if (!delta) return
      commit()
      chunk({ reasoning_content: delta })
    },
    toolDelta(index, entry, argumentsDelta) {
      commit()
      if (!toolOrder.has(index)) toolOrder.set(index, toolOrder.size)
      const at = toolOrder.get(index)
      // 「首片」指第一次拿得到函数名的那片：上游可能先发空参数、名在后一片才到，
      // 若按第一片就定首片，名字会永远发不出去。
      const first = !announced.has(index) && Boolean(entry.name)
      if (first) announced.add(index)
      chunk({
        tool_calls: [{
          index: at,
          id: first ? (entry.id || undefined) : undefined,
          type: 'function',
          function: first
            ? { name: entry.name || undefined, arguments: argumentsDelta ?? '' }
            : { arguments: argumentsDelta ?? '' },
        }],
      })
    },
    finish(acc) {
      commit()
      const finishReason = finishReasonOf(acc.finish, acc.tools.size > 0)
      chunk({}, finishReason)
      if (includeUsage) write({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOf(acc.usage) })
      // OpenAI 的流以 data: [DONE] 收尾；客户端（含官方 SDK）靠它判断「正常结束」，
      // 少了它只能等连接关闭，有些实现会一直挂着读。
      done()
      if (!closed) { closed = true; res.end() }
    },
    fail(failure) {
      // 只有已经出字的情况会走到这里：不能再写内容的 delta，只能补一条 error 结束
      if (!committed) {
        sendError(res, 502, '上游失败：' + (failure.message ?? ''), 'upstream_error', failure.code ?? 'upstream_error')
        closed = true
        return
      }
      write({ error: { message: failure.message ?? '上游失败', type: 'upstream_error', code: failure.code ?? 'upstream_error' } })
      // 出错也一样补 [DONE]：客户端不必靠连接关闭去猜「没有后文了」。
      done()
      if (!closed) { closed = true; res.end() }
    },
  }
}

/**
 * 非流式输出端：攒完整份回答再一次性返回。committed 恒为 false——
 * 在写出响应之前失败都能换候选，这正是非流式请求最稳定的原因。
 *
 * @param {import('node:http').ServerResponse} res - 原始响应。
 * @param {string} model - 对客户端呈现的模型名（路由名）。
 * @param {string} id - chatcmpl id。
 * @param {number} created - 秒级时间戳。
 * @returns {object} sink。
 */
function createBufferSink(res, model, id, created) {
  return {
    committed: false,
    text() {},
    reasoning() {},
    toolDelta() {},
    finish(acc) {
      const message = { role: 'assistant', content: acc.text.length > 0 ? acc.text : null }
      if (acc.reasoning.length > 0) message.reasoning_content = acc.reasoning
      if (acc.tools.size > 0) {
        message.tool_calls = [...acc.tools.values()].map((entry, index) => ({
          id: entry.id || 'call_' + index,
          type: 'function',
          function: { name: entry.name, arguments: entry.arguments || '{}' },
        }))
      }
      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message, finish_reason: finishReasonOf(acc.finish, acc.tools.size > 0) }],
        usage: usageOf(acc.usage),
      })
    },
    fail(failure) {
      sendError(res, 502, '上游失败：' + (failure.message ?? ''), 'upstream_error', failure.code ?? 'upstream_error')
    },
  }
}

/**
 * 把 OpenAI 请求体翻译成与候选无关的中间结构。图片在这里落盘到附件服务
 * （每个候选都要用同一份引用，所以只做一次）。
 *
 * 系统提示作为 messages 里的一条消息交给宿主，不用 `GenerateOptions.system`：
 * 宿主自己的 agent-loop 只发一条 messages 序列，`system` 字段留给一次性调用者、
 * loop 构造的请求留空（见宿主 dsh-llm 的 GenerateOptions 说明）。
 *
 * 具体挂成**首条 system 消息**还是**首条 user 消息**由 buildOptions 按候选的
 * provider 决定（qoder 系上游只读用户轮）。这里只把 system/developer 文本合并成
 * 一段带出去，形态留到知道候选之后再定——一次请求可能先后试到两类通道。
 *
 * 客户端把 system 行散落在对话中间也照样能用：这里全部上提到最前面合成一条，
 * 因为宿主适配器对中途 system 行的解释取决于各家的 `systemPromptUpdate`
 * 声明，不是每家都认。
 *
 * @param {object} body - OpenAI chat.completions 请求体。
 * @param {object} runtime - host 注入的运行时回调。
 * @returns {Promise<object>} 中间结构。
 */
async function prepareRequest(body, runtime) {
  const raw = body.messages
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('messages 必填且必须是非空数组')
  const messages = []
  const systemTexts = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') throw new Error('messages 里含非对象元素')
    const role = typeof entry.role === 'string' ? entry.role : ''
    if (role === 'system' || role === 'developer') {
      const text = textOf(entry.content)
      if (text) systemTexts.push(text)
      continue
    }
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
      throw new Error('不支持的消息角色「' + (role || '(空)') + '」（支持 system/developer/user/assistant/tool）')
    }
    messages.push(await toRequestMessage(entry, role, runtime))
  }
  if (messages.length === 0) throw new Error('messages 里没有 user/assistant/tool 角色的内容')

  const stop = body.stop === undefined ? undefined : toStop(body.stop)
  return {
    messages,
    systemText: systemTexts.length > 0 ? systemTexts.join('\n\n') : '',
    tools: toToolSchemas(body.tools, body.functions),
    temperature: numberOf(body.temperature),
    maxTokens: intOf(body.max_completion_tokens ?? body.max_tokens),
    stop,
  }
}

/**
 * 单条消息 → 宿主 RequestMessage。assistant 的 source 由 buildOptions 按候选改写。
 * @param {object} entry - OpenAI 消息。
 * @param {string} role - 已校验的角色。
 * @param {object} runtime - host 注入的运行时回调。
 * @returns {Promise<object>} RequestMessage。
 */
async function toRequestMessage(entry, role, runtime) {
  if (role === 'tool') {
    const callId = typeof entry.tool_call_id === 'string' && entry.tool_call_id ? entry.tool_call_id : 'call_0'
    return {
      role: 'tool',
      id: randomUUID(),
      toolCallId: callId,
      isError: entry.is_error === true,
      source: { kind: 'tool', callId },
      content: await toBlocks(entry.content, runtime, 'tool'),
    }
  }
  const blocks = await toBlocks(entry.content, runtime, role)
  if (role === 'assistant') {
    const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : []
    for (const call of calls) {
      const fn = call?.function ?? {}
      const name = typeof fn.name === 'string' ? fn.name : ''
      if (!name) continue
      const args = typeof fn.arguments === 'string'
        ? fn.arguments
        : (fn.arguments === undefined ? '{}' : JSON.stringify(fn.arguments))
      blocks.push({ type: 'tool-call', id: typeof call.id === 'string' && call.id ? call.id : randomUUID(), name, arguments: args })
    }
    return {
      role: 'assistant',
      id: randomUUID(),
      content: blocks,
      source: { kind: 'model', provider: 'lan-gateway', model: 'lan-gateway' },
    }
  }
  return { role: 'user', id: randomUUID(), content: blocks, source: { kind: 'user' } }
}

/**
 * 内容（字符串或 OpenAI 内容块数组）→ 宿主内容块。
 * @param {unknown} content - OpenAI content。
 * @param {object} runtime - host 注入的运行时回调。
 * @param {string} role - 所属角色，决定是否允许图片。
 * @returns {Promise<object[]>} 内容块。
 */
async function toBlocks(content, runtime, role) {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const out = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    const type = typeof part.type === 'string' ? part.type : 'text'
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = typeof part.text === 'string' ? part.text : ''
      if (text) out.push({ type: 'text', text })
      continue
    }
    if (type === 'image_url' || type === 'input_image') {
      // tool 消息在宿主里只认 text/image，assistant 只认 text/reasoning/tool-call
      if (role === 'assistant') continue
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      const block = await toImageBlock(url, runtime)
      if (block !== null) out.push(block)
      continue
    }
    if (type === 'file' || type === 'input_file') {
      out.push({ type: 'text', text: '[文件] ' + (part.file?.filename ?? part.filename ?? '未命名文件') + '（本接口不转发文件内容）' })
      continue
    }
    if (type === 'reasoning' || type === 'thinking') {
      const text = typeof part.text === 'string' ? part.text : ''
      if (text && role === 'assistant') out.push({ type: 'reasoning', text })
      continue
    }
  }
  return out
}

/**
 * data: URL → 附件服务里的图片引用。取不到附件服务就降级成一段文字占位。
 * @param {unknown} url - image url（支持 data:base64；http(s) 不代下）。
 * @param {object} runtime - host 注入的运行时回调。
 * @returns {Promise<object|null>} image 块，或 null。
 */
async function toImageBlock(url, runtime) {
  if (typeof url !== 'string' || !url) return null
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (match === null) {
    if (url.startsWith('http://') || url.startsWith('https://')) return { type: 'text', text: '[图片] ' + url }
    return null
  }
  const mediaType = match[1]
  if (!mediaType.startsWith('image/')) return { type: 'text', text: '[附件] ' + mediaType }
  const attachments = runtime.attachments()
  if (attachments === null || typeof attachments.saveImages !== 'function') {
    return { type: 'text', text: '[图片 ' + mediaType + ']（附件服务不可用，未转发图片内容）' }
  }
  try {
    const data = Buffer.from(match[2], 'base64')
    const saved = await attachments.saveImages([{ data, mediaType }])
    const ref = Array.isArray(saved) ? saved[0] : undefined
    if (ref === undefined) return { type: 'text', text: '[图片 ' + mediaType + ']（保存失败）' }
    return { type: 'image', attachment: ref }
  } catch (err) {
    return { type: 'text', text: '[图片 ' + mediaType + ']（保存失败：' + messageOf(err) + '）' }
  }
}

/**
 * OpenAI tools/functions → 宿主 ToolSchema[]。没有工具时返回 undefined。
 * @param {unknown} tools - body.tools。
 * @param {unknown} functions - 旧版 body.functions。
 * @returns {object[]|undefined} ToolSchema 数组。
 */
function toToolSchemas(tools, functions) {
  const list = Array.isArray(tools) ? tools : (Array.isArray(functions) ? functions.map(fn => ({ type: 'function', function: fn })) : null)
  if (list === null || list.length === 0) return undefined
  const out = []
  for (const entry of list) {
    const fn = entry?.function ?? entry
    if (fn === null || typeof fn !== 'object') continue
    const name = typeof fn.name === 'string' ? fn.name : ''
    if (!name) continue
    out.push({
      name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: fn.parameters !== null && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} },
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * 把合并好的 system 文本挂成 messages 的第一条。
 *
 * 两种形态交给宿主适配器解读：
 *  · 首条 **system 消息**（`source.kind='system-prompt'`）：宿主自己的形状，多数
 *    适配器直接转成上游的 system 参数。
 *  · 首条 **user 消息**：qoder 系（channel-pack 的 QoderAdapter）只把
 *    `options.system` 转成 `ask.systemText` 发到 payload 顶层，而实测那个字段
 *    的上游读不到——它只认对话轮里的指令。同样的文字放进一条独立的 user 轮会
 *    被严格执行（实测 0/4 → 4/4，见 README 的「局域网转发」一节）。
 *
 * 形态由 runtime.systemAsUserTurn 按**候选**决定：一次请求可能先试到 qoder 系、
 * 失败后再换到别家，两边必须各自拿到自己认的那种。
 *
 * @param {object} prepared - prepareRequest 的结果。
 * @param {string} provider - 该候选在宿主注册表里的 provider id。
 * @param {object} runtime - host 注入的运行时回调。
 * @returns {object[]} 带 system 头部的 messages。
 */
function withSystemHead(prepared, provider, runtime) {
  const text = typeof prepared.systemText === 'string' ? prepared.systemText : ''
  if (text.length === 0) return prepared.messages
  const asUserTurn = runtime.systemAsUserTurn(provider) === true
  const head = asUserTurn
    ? { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
    : { id: randomUUID(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } }
  return [head, ...prepared.messages]
}

/**
 * 候选 + 请求 → GenerateOptions。provider 必须换成宿主注册表里的路由 id，
 * 否则 llm.stream 找不到适配器。
 *
 * @param {object} candidate - { provider, model, effort? }。
 * @param {object} prepared - prepareRequest 的结果。
 * @param {AbortSignal} signal - 请求取消信号。
 * @param {object} runtime - host 注入的运行时回调。
 * @returns {object} GenerateOptions。
 */
function buildOptions(candidate, prepared, signal, runtime) {
  const provider = runtime.liveProviderIdOf(candidate.provider)
  const model = String(candidate.model)
  const messages = withSystemHead(prepared, provider, runtime).map((message) => (message.role === 'assistant'
    ? { ...message, source: { kind: 'model', provider, model } }
    : message))
  const options = { provider, model, messages, signal, purpose: 'lan-gateway' }
  if (prepared.tools !== undefined) options.tools = prepared.tools
  if (prepared.temperature !== undefined) options.temperature = prepared.temperature
  if (prepared.maxTokens !== undefined) options.maxTokens = prepared.maxTokens
  if (prepared.stop !== undefined) options.stop = prepared.stop
  if (typeof candidate.effort === 'string' && candidate.effort) options.reasoningEffort = candidate.effort
  return options
}

/**
 * 宿主 finish reason → OpenAI finish_reason。
 * @param {object|undefined} reason - StreamChunk.finish.reason。
 * @param {boolean} sawToolCall - 是否产出了工具调用。
 * @returns {string} stop | tool_calls | length | content_filter。
 */
function finishReasonOf(reason, sawToolCall) {
  const kind = reason?.kind
  if (kind === 'tool-calls') return 'tool_calls'
  if (kind === 'max-tokens') return 'length'
  if (kind === 'error' || kind === 'aborted') return 'content_filter'
  if (sawToolCall) return 'tool_calls'
  return 'stop'
}

/**
 * 宿主 TokenUsage → OpenAI usage。缓存命中与写入都是输入的一部分，计入 prompt_tokens。
 * @param {object|null} usage - TokenUsage。
 * @returns {object} usage。
 */
function usageOf(usage) {
  const input = intOf(usage?.inputTokens) ?? 0
  const cacheRead = intOf(usage?.cacheReadTokens) ?? 0
  const cacheWrite = intOf(usage?.cacheWriteTokens) ?? 0
  const output = intOf(usage?.outputTokens) ?? 0
  const prompt = input + cacheRead + cacheWrite
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: intOf(usage?.totalTokens) ?? (prompt + output),
    prompt_tokens_details: { cached_tokens: cacheRead },
    completion_tokens_details: { reasoning_tokens: intOf(usage?.reasoningTokens) ?? 0 },
  }
}

/**
 * 宿主 failure → 网关内部 failure（都带稳定 code，便于记账与日志）。
 * @param {object} reason - finish.reason（kind 为 error/aborted）。
 * @returns {{code: string, message: string}} 失败事实。
 */
function failureOf(reason) {
  const failure = reason?.failure ?? {}
  return {
    code: typeof failure.code === 'string' && failure.code ? failure.code : (reason?.kind === 'aborted' ? 'ABORTED' : 'UNKNOWN'),
    message: typeof failure.message === 'string' && failure.message ? failure.message : '上游未给出失败原因',
  }
}

/** 任意异常 → 稳定错误码。 */
function errorCodeOf(err) {
  const code = err?.code
  if (typeof code === 'string' && code) return code
  if (err?.name === 'AbortError') return 'ABORTED'
  return 'UNKNOWN'
}

/** 候选 → 日志与记账用的短标签。 */
function labelOf(candidate) {
  if (candidate === null || candidate === undefined) return '(无候选)'
  return String(candidate.provider) + '/' + String(candidate.model)
}

/**
 * 取（或建）某条路由的累计计数。
 * @param {object} stats - handle.stats。
 * @param {string} route - 路由名。
 * @returns {object} 计数行。
 */
function routeRow(stats, route) {
  let row = stats.byRoute.get(route)
  if (row === undefined) {
    row = { requests: 0, ok: 0, failed: 0, active: 0 }
    stats.byRoute.set(route, row)
  }
  return row
}

/**
 * 追加一条最近请求记录（环形保留 RECENT_LIMIT 条）。
 * @param {object} stats - handle.stats。
 * @param {object} entry - 一条记录。
 * @returns {void}
 */
function noteRecent(stats, entry) {
  stats.recent.unshift(entry)
  if (stats.recent.length > RECENT_LIMIT) stats.recent.length = RECENT_LIMIT
}

/** 任意值 → 人类可读消息文本。 */
function messageOf(err) {
  if (err === null || err === undefined) return '未知错误'
  if (typeof err === 'string') return err
  if (typeof err.message === 'string' && err.message) return err.message
  return String(err)
}

/** 只取文本部分（system/developer 消息用）。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part !== null && typeof part === 'object' && typeof part.text === 'string' && part.text) parts.push(part.text)
  }
  return parts.join('\n')
}

/**
 * 读取并限制请求体大小。
 * @param {import('node:http').IncomingMessage} req - 原始请求。
 * @returns {Promise<string>} UTF-8 文本。
 */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体超过 ' + Math.floor(MAX_BODY_BYTES / 1024 / 1024) + 'MB 上限')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 写 JSON 响应。 */
function sendJson(res, status, payload) {
  if (res.headersSent) { try { res.end() } catch { /* 连接已断 */ } return }
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** 写 OpenAI 风格的错误响应。 */
function sendError(res, status, message, type, code) {
  if (res.headersSent) { try { res.end() } catch { /* 连接已断 */ } return }
  sendJson(res, status, { error: { message, type, code } })
}

/** 任意值 → 整数，无效返回 undefined。 */
function intOf(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return undefined
  return Math.trunc(n)
}

/** 任意值 → 有限数字，无效返回 undefined。 */
function numberOf(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** OpenAI stop（字符串或数组）→ 宿主 stop（字符串数组）。 */
function toStop(value) {
  if (typeof value === 'string' && value) return [value]
  if (Array.isArray(value)) {
    const out = value.filter(item => typeof item === 'string' && item.length > 0)
    return out.length > 0 ? out : undefined
  }
  return undefined
}
