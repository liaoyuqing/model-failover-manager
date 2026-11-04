/**
 * TRAE（SOLO wire）压缩旁路 shim —— 让 trae / trae-enterprise / trae-global 的
 * 请求也能吃到 billion-context（bili）的上下文压缩。
 *
 * ## 为什么需要它
 *
 * TRAE adapter 的推理请求是 SOLO wire：POST 到 /api/agent/v3/llm_utils_chat，
 * body 是 SOLO JSON（content 是 [{type:"text"}]、assistant 的 tool_calls 用
 * function_call、tools.parameters 是 JSON 字符串、model/config_name 双字段），
 * 响应是 SOLO 自定义 SSE（event: output / token_usage / done）。bili 只改写它
 * 认得的协议路径（/chat/completions、/v1/messages…），llm_utils_chat 不在白名单
 * ⇒ 这条链路被 DIRECT 直发、一次也不压缩；而 bili 一旦生效又会关掉宿主自带的
 * compaction-gate，于是 TRAE 会话等于完全没有压缩，历史只涨不降。
 *
 * ## 做法：把协议差异挪到压缩的两端
 *
 *   1. 给活着的 TRAE adapter 包一层**实例属性 fetchImpl**（唯一不需要拿到内部
 *      类的接缝：adapter 的 send() 最终就是 this.fetchImpl(url, init)）；
 *   2. 接管时把 SOLO body 折成 OpenAI body，请求本机 shim 的
 *      /trae/<rid>/chat/completions —— 路径以 /chat/completions 结尾、又是会话内
 *      发起的 POST，宿主里的 bili-native fetch 链会把它改写进 bili 代理并压缩
 *      （bili 没生效时这条请求直达本机 shim：功能不降级，只是没有压缩）；
 *   3. 本机 shim 收到**压缩后**的 OpenAI body，以**原始 SOLO body 为底**还原
 *      （只覆盖 messages/tools/采样字段，保住 config_name、function 通道与 Max
 *      模式四项），再用**原始请求头**直发上游（绕开 bili，避免它按 OpenAI 协议
 *      把 SOLO 请求改写一次）；
 *   4. 上游 SOLO SSE 在 shim 里转成 OpenAI SSE 写回（bili 的返回腿只透传 OpenAI
 *      data 帧，SOLO 的 event: 行会被整段丢弃 —— 实测见
 *      /d/ai/dsh/home/_trae-shim-probe/probe-dualframe-verdict.mjs）；
 *   5. 包装器拿到响应后再**本地**把 OpenAI SSE 重建为 SOLO SSE 交回 adapter，
 *      所以 adapter 看到的永远是自己认识的那套事件。
 *
 * ## 不变量
 *
 *  · **任何一步失败都退回原始行为**：转换失败、体不是字符串、shim 没起来、上游
 *    非 SSE —— 一律把原始 fetchImpl 的响应原样交给 adapter，绝不让 TRAE 因为本
 *    shim 挂掉。回环请求抛错时**不吞**：原样抛回 adapter 的 TRANSPORT 路径，
 *    那里本来就有重试与换号逻辑。
 *  · adapter 的 sawAnyUpstreamEvent 必须为 true，否则它判「上游一个事件都没发」
 *    并抛 TRANSPORT。所以重建器只要读到**任何** OpenAI 帧就产出对应 SOLO 事件；
 *    流结束时若一帧 done 都没发过，补一条，别让 adapter 卡在无事件上。
 *  · 非 SSE / 非 2xx 响应**绝不伪造事件流**：那是上游错误体，原样交回，让
 *    adapter 用它的 httpErrorCode 路径如实报错。
 */

import { randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
// 剥插件前缀（ofm-trae / ct-trae / caa-trae → trae）：前缀表的唯一实现在
// provider-prefix.mjs。本模块曾自写一份「按第一个连字符切」的启发式，实测会把
// 改名前的前缀表与带连字符的裸名（trae-enterprise）判错 —— 两份判据必然漂移。
import { bareProvider } from './provider-prefix.mjs'

/**
 * 本 shim 接管的渠道（裸 id）。
 *
 * 与 host.mjs 的 TRAE_SHIM_PROVIDERS 同源，这里单独列一份而不是从 host 导入：
 * host 是异步动态 import 本模块，反向 import host 会形成循环，且 shim 也允许被
 * 单独启动（调试用）。两份名单要一起改。
 */
export const TRAE_SHIM_PROVIDERS = new Set(['trae', 'trae-enterprise', 'trae-global'])

/** TRAE 对话端点路径：只有以它结尾的调用才接管（其它请求一律透传）。 */
const TRAE_CHAT_PATH = '/api/agent/v3/llm_utils_chat'

/** SOLO 缺省通道（与 trae.js 的 TRAE_FUNCTION 一致，其它取值上游会回 4001）。 */
export const SOLO_DEFAULT_CHANNEL = 'solo_work_lite'

/** 在途请求表：rid 只在「发出 → bili 压缩 → 回来」这一段里有效。 */
const PENDING_TTL_MS = 120000
const PENDING_MAX = 256

/** 进程级状态槽。热替换只换 impl，不叠加监听端口，也不丢已装的包装。 */
const STATE_KEY = '__mfTraeCompressShim'

/** 对账间隔：adapter 可能被它自己的 fiber 重启换掉，包装要跟着注册表走。 */
const REBIND_INTERVAL_MS = 10000

/** 停服宽限：先停止监听，既有连接自然收尾；超时再强拆，避免端口长期被占。 */
const STOP_GRACE_MS = 2000

/**
 * SOLO 专属字段：发往 bili 前必须去掉，否则 OpenAI 协议解析会看到陌生键
 * （bili 会按 OpenAI 语义判断 max_tokens/上下文，Max 模式那几个字段会误导它）。
 */
const SOLO_ONLY_KEYS = [
  'config_name',
  'function',
  'model_auto_selection',
  'model_selection_strategy',
  'mode_type',
  'context_window_size',
  'prompt_max_tokens',
]

/** 采样参数：两个方向都要原样传递，bili 可能据此决定阈值与注入的工具集。 */
const SAMPLING_KEYS = ['max_tokens', 'temperature', 'top_p', 'stop', 'reasoning_effort', 'seed']

/**
 * 是否是这个 shim 该接管的 provider。
 *
 * @param {string} id 注册表 id（可能带门面前缀）
 * @returns {boolean} 属于本 shim 接管的渠道则为 true
 */
export function isTraeShimProvider(id) {
  return TRAE_SHIM_PROVIDERS.has(bareProvider(id))
}

/**
 * 判断一个值是不是普通对象（不是数组、不是 null）。
 *
 * @param {unknown} value 任意值
 * @returns {boolean} 是普通对象则为 true
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 把错误摊成一行可读文本（诊断字段用，绝不抛第二次）。
 *
 * @param {unknown} error 任意错误
 * @returns {string} 截断后的说明
 */
function describeError(error) {
  const text = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
  return text.slice(0, 160)
}

/**
 * 判断异常是不是「流已经关了」。
 *
 * 调用方提前取消时 WebStream 抛的 TypeError 文案随实现而变（Chromium 是
 * "Invalid state: Controller is already closed"，Node 是 "Invalid state:
 * ReadableStream is locked/closed"），所以按 Invalid state + closed/已关 匹配，
 * 不做精确字符串比较。
 *
 * @param {unknown} error 捕获到的异常
 * @returns {boolean} 是关闭态则 true
 */
function isClosedController(error) {
  const text = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
  return /Invalid state|already closed|is not readable/i.test(text) === true
}

/* ==================== 一层：SOLO ⇄ OpenAI 的请求体 ==================== */

/**
 * SOLO 的一条 content → OpenAI 的一条 content。
 *
 * 纯文本块合并成**字符串**（OpenAI 侧最常见形态，bili 的折叠逻辑按它判正文）；
 * 出现图片等非文本块时保留 parts 数组，且文本块显式写成 {type:"text"}，否则
 * OpenAI 侧解析不出来。遇到不认识的块**放弃接管**（返回 null）而不是猜：猜错会
 * 把图片或工具结果静默吞掉，比不压缩严重得多。
 *
 * @param {unknown} content 消息的 content
 * @param {string} role 消息角色（tool 角色只接受字符串 content）
 * @returns {object|string|null} OpenAI content；无法转换时为 null
 */
function contentToOpenAi(content, role) {
  if (typeof content === 'string') return { ok: true, content }
  // null 是**合法**的 OpenAI content（纯 tool_calls 的 assistant 就是它），
  // 与「形态不认识」必须分开：把前者当成失败会让每一条多步会话都放弃接管。
  if (content === null) return { ok: true, content: role === 'tool' ? '' : null }
  if (!Array.isArray(content)) return { ok: false, reason: 'content 既不是字符串也不是数组' }
  const parts = []
  let textOnly = true
  for (const part of content) {
    if (!isPlainObject(part)) return { ok: false, reason: 'content part 不是对象' }
    if (part.type === 'text') {
      if (typeof part.text !== 'string') return { ok: false, reason: 'text part 缺 text' }
      parts.push(part.text)
      continue
    }
    if (part.type === 'image_url' && isPlainObject(part.image_url)) {
      textOnly = false
      parts.push({ type: 'image_url', image_url: part.image_url })
      continue
    }
    return { ok: false, reason: '不认识的 content part：' + String(part.type) }
  }
  if (role === 'tool') return { ok: true, content: parts.filter((part) => typeof part === 'string').join('') }
  if (textOnly) return { ok: true, content: parts.join('') }
  return { ok: true, content: parts.map((part) => (typeof part === 'string' ? { type: 'text', text: part } : part)) }
}

/**
 * OpenAI 的一条 content → SOLO 的一条 content（统一成 [{type:"text"|"image_url"}]）。
 *
 * @param {unknown} content OpenAI content
 * @returns {object[]|null} SOLO content；无法转换时为 null
 */
function contentToSolo(content) {
  // ⚠️ 上游要求 messages[].content **永远是数组**，对所有 role 一视同仁。唯一权威
  // 是真实 adapter 的 transformSOLOMessage（pack.js:35304-35337）：
  //   else if (typeof content === "string") result.content = [{ type: "text", text: content }]
  // serializeTraeMessages 只是先产出字符串，同一趟流水线随后把它包成数组 —— 所以
  // 最终 SOLO wire 上没有裸字符串 content。
  //
  // 这里曾给 role:'tool' 开「保持字符串」的特权（理由写成「上游只收字符串」），
  // 方向正好反了：线上 7 条 ofm-trae 全部 4001
  // cannot unmarshal string into Go struct field LLMRawMessage.messages.content of type []*idecop。
  if (typeof content === 'string') return { ok: true, content: [{ type: 'text', text: content }] }
  // null 与「字段缺席」是两件事：纯 tool_calls 的 assistant 在 SOLO 里**允许**
  // 显式 content:null（且只允许 null，不允许裸字符串），缺席同样合法；这里保持
  // 原样，避免把两种历史形状归一成一种。
  if (content === null) return { ok: true, content: null }
  if (!Array.isArray(content)) return { ok: false, reason: 'content 形态不认识' }
  const out = []
  for (const part of content) {
    if (!isPlainObject(part)) return { ok: false, reason: 'content part 不是对象' }
    if (part.type === 'text') {
      if (typeof part.text !== 'string') return { ok: false, reason: 'text part 缺 text' }
      out.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'image_url' && isPlainObject(part.image_url)) {
      out.push({ type: 'image_url', image_url: part.image_url })
      continue
    }
    return { ok: false, reason: '不认识的 content part：' + String(part.type) }
  }
  return { ok: true, content: out }
}

/**
 * SOLO tool_calls（function_call 形态）→ OpenAI tool_calls（function 形态）。
 *
 * 顺手清掉 SOLO 专属的 namespace / partial_arguments：它们不是 OpenAI 字段，
 * 留着会让 bili 的解析器把它们当成陌生键。
 *
 * @param {unknown} calls SOLO tool_calls
 * @returns {object[]|null} OpenAI tool_calls；形状不合法时为 null
 */
function toolCallsToOpenAi(calls) {
  if (!Array.isArray(calls)) return null
  const out = []
  for (const call of calls) {
    if (!isPlainObject(call)) return null
    const fn = isPlainObject(call.function_call) ? call.function_call : isPlainObject(call.function) ? call.function : undefined
    if (fn === undefined) return null
    const next = { ...call }
    delete next.function_call
    delete next.function
    const fnOut = { name: typeof fn.name === 'string' ? fn.name : '' }
    if (typeof fn.arguments === 'string') fnOut.arguments = fn.arguments
    else if (fn.arguments !== undefined) fnOut.arguments = JSON.stringify(fn.arguments)
    else fnOut.arguments = ''
    next.type = next.type === undefined ? 'function' : next.type
    next.function = fnOut
    out.push(next)
  }
  return out
}

/**
 * OpenAI tool_calls（function 形态）→ SOLO tool_calls（function_call 形态）。
 *
 * @param {unknown} calls OpenAI tool_calls
 * @returns {object[]|null} SOLO tool_calls；形状不合法时为 null
 */
function toolCallsToSolo(calls) {
  if (!Array.isArray(calls)) return null
  const out = []
  for (const call of calls) {
    if (!isPlainObject(call)) return null
    const fn = isPlainObject(call.function) ? call.function : isPlainObject(call.function_call) ? call.function_call : undefined
    if (fn === undefined) return null
    const next = { ...call }
    delete next.function
    delete next.function_call
    const fnOut = { name: typeof fn.name === 'string' ? fn.name : '' }
    if (typeof fn.arguments === 'string') fnOut.arguments = fn.arguments
    else if (fn.arguments !== undefined) fnOut.arguments = JSON.stringify(fn.arguments)
    else fnOut.arguments = ''
    next.type = next.type === undefined ? 'function' : next.type
    next.function_call = fnOut
    out.push(next)
  }
  return out
}

/**
 * SOLO 请求体 → OpenAI 请求体（交给 bili 压缩的形状）。
 *
 * 只做协议层折叠，不改语义：content 归一化、function_call 改 function、
 * tools.parameters 从 JSON 字符串解回对象，并剥掉 SOLO 专属字段（见
 * SOLO_ONLY_KEYS）。**任何一处形状不认识就整体放弃**：半折叠的请求交给 bili
 * 只会让它按 OpenAI 语义误判（例如把残缺的 tool_calls 当成新工具调用）。
 *
 * @param {object} soloBody adapter 发出的 SOLO body（已 JSON.parse）
 * @returns {{ok: true, body: object}|{ok: false, reason: string}}
 */
export function soloBodyToOpenAi(soloBody) {
  if (!isPlainObject(soloBody)) return { ok: false, reason: 'body 不是对象' }
  const rawMessages = soloBody.messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return { ok: false, reason: 'body.messages 不是非空数组' }
  }
  const messages = []
  for (let index = 0; index < rawMessages.length; index++) {
    const message = rawMessages[index]
    if (!isPlainObject(message)) return { ok: false, reason: 'messages[' + index + '] 不是对象' }
    if (typeof message.role !== 'string' || message.role.length === 0) return { ok: false, reason: 'messages[' + index + '] 缺 role' }
    const next = { ...message }
    const content = contentToOpenAi(next.content, message.role)
    if (!content.ok) return { ok: false, reason: 'messages[' + index + '] ' + content.reason }
    if (content.content !== undefined) next.content = content.content
    if (Array.isArray(next.tool_calls)) {
      const calls = toolCallsToOpenAi(next.tool_calls)
      if (calls === null) return { ok: false, reason: 'messages[' + index + '] tool_calls 形态不认识' }
      // 空的 tool_calls 留着没有意义：OpenAI 侧会把它当成「这一轮没有工具调用」。
      if (calls.length === 0) delete next.tool_calls
      else next.tool_calls = calls
    }
    messages.push(next)
  }
  const body = { ...soloBody }
  for (const key of SOLO_ONLY_KEYS) delete body[key]
  body.messages = messages
  body.stream = true
  if (Array.isArray(body.tools)) {
    const tools = []
    for (let index = 0; index < body.tools.length; index++) {
      const tool = body.tools[index]
      if (!isPlainObject(tool)) return { ok: false, reason: 'tools[' + index + '] 不是对象' }
      if (!isPlainObject(tool.function)) return { ok: false, reason: 'tools[' + index + '] 缺 function' }
      const fn = tool.function
      if (typeof fn.name !== 'string' || fn.name.trim().length === 0) return { ok: false, reason: 'tools[' + index + '] 缺 function.name' }
      const next = { ...tool, function: { ...fn } }
      if (typeof fn.parameters === 'string') {
        try { next.function.parameters = JSON.parse(fn.parameters) } catch { /* 解不出来就保留原字符串：bili 自己也能容忍 */ }
      }
      tools.push(next)
    }
    body.tools = tools
  }
  // SOLO 把「点名某个工具」写成裸字符串，OpenAI 要求 {type:"function",...}。
  const choice = soloBody.tool_choice
  if (typeof choice === 'string' && choice.length > 0) {
    const lower = choice.trim().toLowerCase()
    body.tool_choice = lower === 'auto' || lower === 'required' || lower === 'none' ? lower : { type: 'function', function: { name: choice.trim() } }
  } else if (isPlainObject(choice)) {
    const type = typeof choice.type === 'string' ? choice.type.toLowerCase() : ''
    if (type === 'auto' || type === 'required' || type === 'none') body.tool_choice = type
    else {
      const fn = isPlainObject(choice.function) ? choice.function : choice
      if (typeof fn.name === 'string' && fn.name.trim().length > 0) body.tool_choice = { type: 'function', function: { name: fn.name.trim() } }
      else delete body.tool_choice
    }
  } else if (choice !== undefined && choice !== null) {
    return { ok: false, reason: 'tool_choice 形态不认识' }
  }
  if (typeof body.tool_choice === 'string' && body.tool_choice.length === 0) delete body.tool_choice
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : ''
  if (model.length === 0) return { ok: false, reason: '缺 model/config_name' }
  return { ok: true, body }
}

/**
 * OpenAI 请求体 → SOLO 请求体（发往 TRAE 上游的形状）。
 *
 * 与 {@link soloBodyToOpenAi} 互逆，但**不假设对称**：SOLO 侧还有一批上游必需的
 * 字段（config_name / function / Max 模式四项），所以以**原始 SOLO body** 为底，
 * 只用这里产出的 messages/tools/采样字段覆盖 —— 见 startTraeCompressShim 里的
 * handle。这样 Max 模式（1M 上下文）与模型通道不会被 bili 的改写弄丢：bili 看到
 * 的只是 OpenAI 语义，它无从知道这几个 SOLO 字段该怎么传。
 *
 * @param {object} openAiBody 压缩后回来的 OpenAI body
 * @param {{channel?: string, base?: object}} [options] channel 是 SOLO 的 function
 *   通道；base 是原始 SOLO body（协议字段的唯一来源）
 * @returns {object} SOLO body
 */
export function openAiBodyToSolo(openAiBody, options) {
  const opts = isPlainObject(options) ? options : {}
  const base = isPlainObject(opts.base) ? { ...opts.base } : {}
  const source = isPlainObject(openAiBody) ? openAiBody : {}
  const body = { ...base }
  body.stream = true
  if (Array.isArray(source.messages)) {
    const messages = []
    for (const message of source.messages) {
      if (!isPlainObject(message)) { messages.push(message); continue }
      const next = { ...message }
      const converted = contentToSolo(next.content)
      // 转换不出来（陌生 part 形态）就沿用原值：交给上游如实报错，而不是在这里
      // 静默删掉一段可能很重要的历史。
      if (converted.ok) next.content = converted.content
      if (Array.isArray(next.tool_calls)) {
        const calls = toolCallsToSolo(next.tool_calls)
        if (calls !== null) {
          if (calls.length === 0) delete next.tool_calls
          else next.tool_calls = calls
        }
      }
      messages.push(next)
    }
    body.messages = messages
  }
  if (Array.isArray(source.tools) && source.tools.length === 0) {
    // 压缩后一个工具都不剩（例如 bili 判定这轮不需要工具）：删掉而不是发空数组
    // —— 空数组在 SOLO 侧等于「声明了工具但一个都没给」，语义上比缺席更含糊。
    delete body.tools
  } else if (Array.isArray(source.tools)) {
    body.tools = source.tools.map((tool) => {
      if (!isPlainObject(tool)) return tool
      const next = { ...tool }
      if (isPlainObject(next.function) && next.function.parameters !== undefined && typeof next.function.parameters !== 'string') {
        next.function = { ...next.function, parameters: JSON.stringify(next.function.parameters) }
      }
      return next
    })
  } else if ('tools' in source) {
    body.tools = source.tools
  }
  // SOLO 的 tool_choice 是裸字符串 / auto / required / none；OpenAI 的 function
  // 形态要摊平成裸名字（见 transformToSOLOBody 的 normalizeToolChoice）。
  if ('tool_choice' in source) {
    const choice = source.tool_choice
    if (typeof choice === 'string') {
      if (choice.trim().toLowerCase() === 'none') { delete body.tools; delete body.tool_choice }
      else body.tool_choice = choice.trim()
    } else if (isPlainObject(choice)) {
      const type = typeof choice.type === 'string' ? choice.type.toLowerCase() : ''
      if (type === 'none') { delete body.tools; delete body.tool_choice }
      else if (type === 'auto' || type === 'required') body.tool_choice = type
      else {
        const fn = isPlainObject(choice.function) ? choice.function : choice
        if (typeof fn.name === 'string' && fn.name.trim().length > 0) body.tool_choice = fn.name.trim()
        else delete body.tool_choice
      }
    }
  }
  for (const key of SAMPLING_KEYS) {
    if (key in source) body[key] = source[key]
  }
  const model = typeof source.model === 'string' && source.model.length > 0
    ? source.model
    : (typeof base.model === 'string' ? base.model : (typeof base.config_name === 'string' ? base.config_name : ''))
  if (model.length > 0) {
    body.model = model
    body.config_name = model
  }
  body.function = typeof opts.channel === 'string' && opts.channel.length > 0
    ? opts.channel
    : (typeof base.function === 'string' && base.function.length > 0 ? base.function : SOLO_DEFAULT_CHANNEL)
  return body
}

/* ==================== 二层：SSE 双向转换 ==================== */

/**
 * 一条上游 SOLO 事件 → OpenAI SSE 帧（给 bili 的返回腿）。
 *
 * 返回 null 表示「这一帧不该出现在 OpenAI 流里」：上游的 metadata / timing_cost
 * 这类私有事件对 bili 没有意义，塞进去只会让它按 OpenAI 语义误判。
 *
 * @param {string} eventName event: 行的值（output / token_usage / done / error）
 * @param {object|null} data 解析后的 data JSON
 * @returns {object|null} chat.completion.chunk；error 事件返回 {error:{...}}；
 *   其它事件返回 null
 */
export function soloSseFrameToOpenAi(eventName, data) {
  if (!isPlainObject(data)) return null
  const event = String(eventName === undefined || eventName === null ? '' : eventName).trim()
  if (event === 'output') {
    const delta = {}
    if (typeof data.response === 'string' && data.response.length > 0) delta.content = data.response
    if (typeof data.reasoning_content === 'string' && data.reasoning_content.length > 0) delta.reasoning_content = data.reasoning_content
    if (Array.isArray(data.tool_calls) && data.tool_calls.length > 0) {
      const calls = toolCallsToOpenAi(data.tool_calls)
      if (calls !== null && calls.length > 0) delta.tool_calls = calls
    }
    if (Object.keys(delta).length === 0) return null
    return { id: 'trae-shim', object: 'chat.completion.chunk', model: '', choices: [{ index: 0, delta }] }
  }
  if (event === 'token_usage') {
    return { id: 'trae-shim', object: 'chat.completion.chunk', model: '', choices: [{ index: 0, delta: {} }], usage: data }
  }
  if (event === 'done') {
    return {
      id: 'trae-shim',
      object: 'chat.completion.chunk',
      model: '',
      choices: [{ index: 0, delta: {}, finish_reason: typeof data.finish_reason === 'string' && data.finish_reason.length > 0 ? data.finish_reason : 'stop' }],
    }
  }
  if (event === 'error') {
    // bili 认 OpenAI 的 error 帧形态；用 code/message 原样转述，不伪造正文。
    const error = { message: typeof data.message === 'string' ? data.message : 'upstream error' }
    if (typeof data.code === 'number' || typeof data.code === 'string') error.code = data.code
    return { error }
  }
  return null
}

/**
 * 一条 OpenAI SSE 帧 → SOLO 事件（给 trae adapter）。
 *
 * 这里刻意**不合并** content 与 reasoning：一个 OpenAI 帧里同时带两者时拆成两条
 * output 事件。adapter 按事件分发，逐条下发与上游语义等价；合并反而要依赖它
 * 「同一帧里先处理 response 再处理 reasoning」的实现细节。
 *
 * 没有 choices 也没有 usage 的帧（心跳之类）返回空数组：adapter 分不出它们，
 * 发下去只会多解析一条无用事件。
 *
 * @param {object|null} frame 解析后的 OpenAI chunk
 * @returns {{event: string, data: object}[]} SOLO 事件（顺序与 SOLO 协议一致）
 */
export function openAiSseFrameToSolo(frame) {
  const events = []
  if (!isPlainObject(frame)) return events
  if (isPlainObject(frame.error)) {
    const error = frame.error
    return [{ event: 'error', data: { code: typeof error.code === 'number' ? error.code : -1, message: typeof error.message === 'string' ? error.message : 'upstream error' } }]
  }
  const choice = Array.isArray(frame.choices) && isPlainObject(frame.choices[0]) ? frame.choices[0] : undefined
  const delta = choice !== undefined && isPlainObject(choice.delta) ? choice.delta : {}
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    events.push({ event: 'output', data: { response: delta.content } })
  }
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    events.push({ event: 'output', data: { reasoning_content: delta.reasoning_content } })
  }
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    const calls = toolCallsToSolo(delta.tool_calls)
    if (calls !== null && calls.length > 0) events.push({ event: 'output', data: { tool_calls: calls } })
  }
  if (isPlainObject(frame.usage)) events.push({ event: 'token_usage', data: frame.usage })
  const finish = choice !== undefined && typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0 ? choice.finish_reason : undefined
  if (finish !== undefined) {
    // SOLO 的 finish_reason 只有 stop / length 这些；OpenAI 的 'error' 不是 SOLO
    // 事件值，映射成 stop 避免 adapter 把它当成未知结束原因丢掉。
    events.push({ event: 'done', data: { finish_reason: finish === 'error' ? 'stop' : finish } })
  }
  return events
}

/**
 * 一条 SOLO 事件序列化成 SSE 文本。
 *
 * @param {{event: string, data: object}} event SOLO 事件
 * @returns {string} 形如 "event: output\ndata: {...}\n\n" 的文本
 */
function soloLines(event) {
  return 'event: ' + event.event + '\ndata: ' + JSON.stringify(event.data) + '\n\n'
}

/* ==================== 三层：诊断小工具 ==================== */

/**
 * 消息正文长度（用于「压缩是否真的发生」的判定，不把 JSON 外壳算进去）。
 *
 * 只算 content 与工具参数：bili 注入系统提示与压缩工具定义会让 JSON 长度**变长**，
 * 那不是压缩。只有正文真的变短、或条数变少，才说明上下文被压下来了。
 *
 * @param {unknown[]} messages 消息数组
 * @returns {number} 正文字符数
 */
function contentCharsOf(messages) {
  let total = 0
  for (const message of messages) {
    if (!isPlainObject(message)) continue
    const content = message.content
    if (typeof content === 'string') total += content.length
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (isPlainObject(part) && typeof part.text === 'string') total += part.text.length
      }
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const fn = !isPlainObject(call) ? undefined : (call.function !== undefined ? call.function : call.function_call)
        if (isPlainObject(fn) && typeof fn.arguments === 'string') total += fn.arguments.length
      }
    }
  }
  return total
}

/**
 * 一条消息的正文文本（诊断用：见 diffMessages 的 peek 字段）。
 *
 * @param {unknown} message 一条 OpenAI/SOLO 消息
 * @returns {string} 该条消息的正文（content 与工具参数都摊平进来）
 */
function messageTextOf(message) {
  if (!isPlainObject(message)) return ''
  let out = contentToTextOf(message.content)
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const fn = !isPlainObject(call) ? undefined : (call.function !== undefined ? call.function : call.function_call)
      if (isPlainObject(fn) && typeof fn.arguments === 'string') out += fn.arguments
    }
  }
  return out
}

/**
 * content 摊平成文本（上面 messageTextOf 的公用腿）。
 *
 * @param {unknown} content 字符串或 parts 数组
 * @returns {string} 文本
 */
function contentToTextOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    if (isPlainObject(part) && typeof part.text === 'string') out += part.text
  }
  return out
}

/**
 * 短哈希：只用于比对压缩前后同一段正文有没有被改写（不是安全用途）。
 *
 * @param {string} text 正文
 * @returns {string} 十进制哈希
 */
function hashOf(text) {
  let hash = 0
  const value = String(text)
  for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) | 0
  return String(hash)
}

/**
 * 逐条比对压缩前后的正文，给出人可读的差异摘要（最多 8 条）。
 *
 * @param {{role: string, len: number, hash: string}[]} before 发出前留存的指纹
 * @param {unknown[]} after 回来后解析出的消息
 * @returns {object[]} 差异条目
 */
function diffMessages(before, after) {
  const out = []
  const count = Math.max(before.length, after.length)
  for (let index = 0; index < count && out.length < 8; index++) {
    const a = before[index]
    const b = after[index]
    if (a === undefined || b === undefined) continue
    // 回来后那条是**原始消息对象**，长度必须现算 —— 直接读 b.len 拿到的永远是
    // undefined（症状是 kind 恒为 rewritten、afterLen 恒缺席，看起来像「没被改写」）。
    const afterText = messageTextOf(b)
    const afterLen = afterText.length
    // 指纹相同 = 这一条没被改写，不必进诊断环。
    if (a.len === afterLen && a.hash === hashOf(afterText)) continue
    out.push({
      index,
      // 三种「变了」分开写：变短通常是折叠/摘要替换，变长是 bili 追加了指令或
      // 占位标记 —— 后者不是压缩，混成一种会让 folded 判定被稀释。
      kind: a.len > afterLen ? 'shrunk' : (a.len < afterLen ? 'grown' : 'rewritten'),
      role: typeof b.role === 'string' ? b.role : (a.role ?? ''),
      beforeLen: a.len,
      afterLen,
      // 「被折叠成什么」的唯一线索：给它正文片段，否则诊断环只能看到长度差。
      peek: afterText.slice(0, 60),
    })
  }
  return out
}

/**
 * bili 侧注入的压缩工具名（诊断用）。
 *
 * bili 的工具叫 acp_status / acp_cache / search_context / compress / decompress，
 * **名字里没有 "bili"** —— 按品牌名匹配永远为空，会被误读成「bili 没注入工具」。
 *
 * @param {unknown} tools OpenAI tools 数组
 * @returns {string[]} 命中的工具名
 */
function biliToolNames(tools) {
  if (!Array.isArray(tools)) return []
  const names = []
  for (const tool of tools) {
    const name = isPlainObject(tool) ? String(isPlainObject(tool.function) ? tool.function.name ?? '' : tool.name ?? '') : ''
    if (name.length > 0 && /^(acp_|compress$|decompress$|search_context$)/.test(name)) names.push(name)
  }
  return names
}

/* ==================== 四层：shim 实现 ==================== */

/**
 * 造一份实现：持有一轮装载的 pending 表，负责两条腿的转换与转发。
 *
 * stats 与 pending 都由调用方传入：pending 在热替换时必须**沿用上一轮**，否则
 * 在途请求的 rid 全部命中 410（一次插件重载就会打断正在跑的会话）。
 *
 * @param {{port: number, stats: object, pending?: Map<string, object>}} context
 * @returns {{origin: string, prepare: Function, handle: Function, rebuildReturnLeg: Function, pending: Map}}
 */
function createImpl(context) {
  const origin = 'http://127.0.0.1:' + context.port
  const stats = context.stats
  const pending = context.pending instanceof Map ? context.pending : new Map()

  /** 清掉过期与超量的条目；每次登记后跑一次，正常路径下只是空转。 */
  const sweep = () => {
    const now = Date.now()
    for (const rid of pending.keys()) {
      const entry = pending.get(rid)
      if (entry !== undefined && now - entry.at > PENDING_TTL_MS) pending.delete(rid)
    }
    while (pending.size > PENDING_MAX) {
      const oldest = pending.keys().next()
      if (oldest.done === true) break
      pending.delete(oldest.value)
    }
  }

  /** 上游 SOLO SSE → OpenAI SSE 文本。逐行状态机，跨块拼接由 buffer 兜住。 */
  const soloToOpenAiStream = (state, chunk) => {
    state.buffer += chunk
    let out = ''
    let newline
    while ((newline = state.buffer.indexOf('\n')) !== -1) {
      const line = state.buffer.slice(0, newline).replace(/\r$/, '')
      state.buffer = state.buffer.slice(newline + 1)
      if (line.trim().length === 0) {
        // 空行 = 一帧结束：把累积的 event + data 解析成 OpenAI 帧。
        if (state.event.length === 0 && state.data.length === 0) continue
        let data = null
        try { data = state.data.length > 0 ? JSON.parse(state.data) : null } catch { data = null }
        const frame = soloSseFrameToOpenAi(state.event, data)
        if (frame !== null) out += 'data: ' + JSON.stringify(frame) + '\n\n'
        state.event = ''
        state.data = ''
        continue
      }
      if (line.startsWith('event:')) { state.event = line.slice(6).trim(); continue }
      if (line.startsWith('data:')) { state.data += line.slice(5).replace(/^ /, ''); continue }
      // 注释行与其他行：SOLO 帧只由 event:/data: 构成，其余丢弃。
    }
    return out
  }

  /**
   * 包装器：把一次 SOLO 调用换成「指向本机 shim 的明文 OpenAI 调用」。
   *
   * 返回 undefined 表示**不接管**，调用方应当原样交给原始 fetchImpl。这里刻意
   * 只返回「没有接管的理由」，把「调用原实现」这件事留给调用方，避免两条路都
   * 发一次请求（重复计费且会让上游看到两次同样的对话）。
   *
   * @param {object} self adapter 实例
   * @param {string} url 原始上游 URL
   * @param {unknown} init 原始 fetch init
   * @param {Function} original 被替换前的 fetchImpl
   * @returns {Promise<Response|undefined>} Response 表示已接管；undefined 表示透传
   */
  const prepare = async (self, url, init, original) => {
    if (!isPlainObject(init) || typeof init.body !== 'string') return undefined
    let soloBody = null
    try { soloBody = JSON.parse(init.body) } catch { return undefined }
    const folded = soloBodyToOpenAi(soloBody)
    if (!folded.ok) {
      stats.fallback += 1
      stats.lastError = 'SOLO 请求不能折成 OpenAI：' + folded.reason
      return undefined
    }
    let rid = null
    let loopUrl = ''
    let loopInit = null
    try {
      rid = randomUUID()
      const messages = folded.body.messages
      pending.set(rid, {
        at: Date.now(),
        url,
        headers: init.headers,
        used: 0,
        soloBody,
        channel: typeof soloBody.function === 'string' && soloBody.function.length > 0 ? soloBody.function : SOLO_DEFAULT_CHANNEL,
        sentCount: messages.length,
        sentChars: JSON.stringify(messages).length,
        sentContent: contentCharsOf(messages),
        // 只留指纹（长度 + 哈希）与正文片段：诊断环要能回答「哪一条被折成了什么」，
        // 又不能把整段上下文再存一份（大请求会把进程内存翻倍）。
        sentList: messages.map((message) => {
          const text = messageTextOf(message)
          return { role: isPlainObject(message) ? message.role : '', len: text.length, hash: hashOf(text), peek: text.slice(0, 60) }
        }),
      })
      sweep()
      stats.intercepted += 1
      stats.lastAt = Date.now()
      stats.lastPreparedTools = Array.isArray(folded.body.tools) ? folded.body.tools.map((tool) => String(isPlainObject(tool) && isPlainObject(tool.function) ? tool.function.name ?? '' : '')).slice(0, 12) : []
      stats.lastPreparedBiliTools = biliToolNames(folded.body.tools)
      loopUrl = origin + '/trae/' + rid + '/chat/completions'
      loopInit = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(folded.body),
        // 调用方信号原样透传：用户在界面点「停止」时这条回环请求要一起断。
        ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
      }
    } catch (err) {
      if (rid !== null) pending.delete(rid)
      stats.fallback += 1
      stats.lastError = '接管失败：' + describeError(err)
      return undefined
    }
    try {
      return await original.call(self, loopUrl, loopInit)
    } catch (err) {
      // 回环请求失败（还没拿到任何响应头）：这条回环**没有**出去过，所以清掉
      // pending 并让调用方回退到原始直发是安全的，也是唯一不让 TRAE 变砖的选择
      // —— 若在这里抛出，adapter 会把每次调用都当成 TRANSPORT 失败并重试，
      // 而重试还是会走同一个已经坏掉的回环。
      //
      // ⚠️ 只在这一段回退。拿到响应头之后再出错（例如流中途断）绝不重发：那时
      // 上游可能已经收下请求，重发等于同一个对话被计费两次。
      pending.delete(rid)
      stats.fallback += 1
      stats.lastError = '回环请求失败（已回退直发）：' + describeError(err)
      return undefined
    }
  }

  /**
   * 返回腿：把代理回来的 OpenAI SSE 重建为 SOLO SSE 交给 adapter。
   *
   * bili 的返回腿按 OpenAI 协议解析并重写上游响应，SOLO 的 event: 行会被整段丢弃
   * （实测）。所以这里必须**本地**重建：adapter 只认 SOLO 事件，一个都收不到就会抛
   * TRANSPORT（upstream returned no events）。
   *
   * 非 SSE / 非 2xx 一律原样返回：那是上游的错误体，伪造事件流会把真实错误码盖掉。
   *
   * @param {Response} response 代理返回的 Response
   * @returns {Response} SOLO SSE 流；不需要重建时就是入参本身
   */
  const rebuildReturnLeg = (response) => {
    if (!isPlainObject(response) || response.ok !== true) return response
    const contentType = String(response.headers?.get?.('content-type') ?? '')
    if (!contentType.includes('text/event-stream')) return response
    const body = response.body
    if (body === null || body === undefined || typeof body.getReader !== 'function') return response
    const decoder = new TextDecoder()
    const state = { buffer: '', usage: null, finishReason: null, sawFinish: false, pushed: 0 }
    const leg = stats.returnLeg
    const stream = new ReadableStream({
      async start(controller) {
        const reader = body.getReader()
        // 调用方（adapter / 用户点停止）先关掉流之后，这里再 push 会抛
        // 「Controller is already closed」。那是一次正常的提前收尾，不是重建失败，
        // 所以既不计 rebuildErrors 也不覆盖 lastError —— 否则诊断环会被中断噪声
        // 淹没，真正的重建故障反而看不出来。
        let closed = false
        const push = (text) => {
          if (text.length === 0 || closed) return
          try {
            controller.enqueue(new TextEncoder().encode(text))
          } catch (err) {
            if (isClosedController(err)) { closed = true; return }
            throw err
          }
        }
        const emit = (events) => {
          for (const event of events) {
            leg.soloFrames += 1
            if (event.event === 'token_usage') {
              // 真实用量优先：bili 在没有上游 finish 时会补一帧全 0 的 usage，
              // 那是它的占位，不是计费口径 —— 用它会让缓存命中率与用量归零。
              // 后到的非 0 用量覆盖先到的占位值；先到的真实用量不会被 0 值盖掉。
              if (state.usage === null || isZeroUsage(state.usage)) state.usage = event.data
              continue
            }
            if (event.event === 'done') {
              // done **不在这里写**：SOLO 的收尾顺序是 usage → done，而 adapter 收到
              // done 就置 streamEnded、不再分发后续帧。中途写出去的话，前面攒下的
              // 真实用量（见上面那条）就再也送不到了。
              if (!state.sawFinish) {
                state.sawFinish = true
                state.finishReason = typeof event.data.finish_reason === 'string' ? event.data.finish_reason : null
              }
              continue
            }
            state.pushed += 1
            push(soloLines(event))
          }
        }
        try {
          for (;;) {
            const result = await reader.read()
            if (result.done === true) break
            state.buffer += decoder.decode(result.value, { stream: true })
            let newline
            while ((newline = state.buffer.indexOf('\n')) !== -1) {
              const line = state.buffer.slice(0, newline).replace(/\r$/, '')
              state.buffer = state.buffer.slice(newline + 1)
              if (line.trim().length === 0) continue
              // SSE 注释（bili 在静默期发的 keep-alive）。adapter 的空闲计时是落在
              // reader.read() 上的：一个字节都不来就判 chunk timeout（线上实测
              // 120s 一条）。注释行它按协议忽略正文，但只要**读到了**就会重置计时，
              // 所以这里原样透传，别让它被当成噪声丢掉。
              if (line.startsWith(':')) {
                leg.keepAlives += 1
                push(line + '\n\n')
                continue
              }
              if (!line.startsWith('data:')) continue
              const payload = line.slice(5).trim()
              if (payload === '' || payload === '[DONE]') continue
              leg.openAiFrames += 1
              let frame = null
              try { frame = JSON.parse(payload) } catch {
                leg.rebuildErrors += 1
                continue
              }
              emit(openAiSseFrameToSolo(frame))
            }
          }
          // 收尾：残留的半个 data 行也过一遍（有些代理不发末尾空行）。
          const tail = state.buffer.startsWith('data:') ? state.buffer.slice(5).trim() : ''
          if (tail.length > 0 && tail !== '[DONE]') {
            leg.openAiFrames += 1
            try { emit(openAiSseFrameToSolo(JSON.parse(tail))) } catch { leg.rebuildErrors += 1 }
          }
          // 收尾顺序固定为 usage → done（见 emit 里那条注释）。
          if (state.usage !== null) {
            push(soloLines({ event: 'token_usage', data: state.usage }))
            state.pushed += 1
          }
          // done 一定写、且只写一条：adapter 靠它结束流；没有任何 done 的流会被
          // 判成截断（即便正文已经到齐）。
          push(soloLines({ event: 'done', data: { finish_reason: state.finishReason === null ? 'stop' : state.finishReason } }))
          // 一条正文/工具/用量都没重建出来（代理回了空流或只回 finish）：记一笔，
          // 这是排查「模型没说话」与「代理把内容丢了」的区分点。
          if (state.pushed === 0) stats.returnLeg.emptyRebuilds += 1
        } catch (err) {
          leg.rebuildErrors += 1
          stats.lastError = '返回腿重建：' + describeError(err)
        } finally {
          try { reader.releaseLock() } catch { /* 已释放 */ }
          try { controller.close() } catch { /* 已关闭 */ }
        }
      },
    })
    const headers = new Headers()
    headers.set('content-type', 'text/event-stream')
    headers.set('cache-control', 'no-cache')
    return new Response(stream, { status: response.status, statusText: response.statusText, headers })
  }

  /**
   * 直发上游：用原始 URL 与原始请求头，避免代理再按 OpenAI 协议改写一次。
   *
   * 头必须**原样继承**：Authorization / X-Ide-Token / X-Machine-Id 等凭据与风控
   * 字段都在里面，重算要么漏字段、要么拿到过期令牌。但要按**新 body 重算**
   * content-length，并去掉 content-encoding / transfer-encoding：它们是按旧 body
   * 算的，留着会让上游按原长度读、读到一半截断。
   *
   * @param {object} entry pending 条目（含 url / headers / soloBody）
   * @param {object} soloBody 还原后的 SOLO body
   * @param {http.ServerResponse} res 回给调用方的响应
   */
  const forward = (entry, soloBody, res) => {
    let target = null
    try {
      target = new URL(entry.url)
    } catch (err) {
      stats.lastError = '上游 URL 不可用：' + describeError(err)
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'trae_shim_url', message: stats.lastError } }))
      return
    }
    let payload = ''
    try { payload = JSON.stringify(soloBody) } catch (err) {
      stats.lastError = 'SOLO body 序列化失败：' + describeError(err)
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'trae_shim_body', message: stats.lastError } }))
      return
    }
    const transport = target.protocol === 'https:' ? https : http
    const headers = headersForUpstream(entry.headers, Buffer.byteLength(payload, 'utf8'))
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers,
    }, (upstream) => {
      const status = upstream.statusCode === undefined ? 502 : upstream.statusCode
      const contentType = String(upstream.headers['content-type'] ?? '')
      const isStream = status >= 200 && status < 300 && contentType.includes('text/event-stream')
      const outHeaders = headersForClient(upstream.headers)
      if (!isStream) {
        // 错误回包（JSON/HTML）与任何非流式正文本原样穿回：它们没有 SOLO 帧，
        // 翻译一遍反而会把错误正文改坏；包装器看到非 SSE 会把整个 Response 交回
        // adapter，由它走自己的 httpErrorCode 路径。
        res.writeHead(status, outHeaders)
        upstream.pipe(res)
        upstream.on('error', () => res.destroy())
        return
      }
      res.writeHead(status, outHeaders)
      upstream.setEncoding('utf8')
      const state = { buffer: '', event: '', data: '' }
      let tail = ''
      upstream.on('data', (chunk) => {
        const out = soloToOpenAiStream(state, chunk)
        if (out.length === 0) return
        tail = (tail + out).slice(-512)
        if (!res.write(out)) { upstream.pause(); res.once('drain', () => upstream.resume()) }
      })
      upstream.on('end', () => {
        // 收尾：缓冲区里残留的半帧也过一遍，别把最后一帧吞掉。补**两个换行**：
        // 一个把最后那条没有换行结尾的 data 行切成完整行，另一个才是帧分隔的空行
        // —— 只补一个的话，「event:/data: 都在、只缺末尾空行」的最后一帧不会被刷出。
        const rest = soloToOpenAiStream(state, '\n\n')
        if (rest.length > 0) { tail = (tail + rest).slice(-512); res.write(rest) }
        // 无论上游有没有给 [DONE]，收尾都给 bili 一份标准终止帧 —— 它靠这个判断
        // 流是否完整，缺了就会判 upstream stream truncated 并替换成错误。
        res.write('data: [DONE]\n\n')
        stats.lastUpstreamTail = tail
        res.end()
      })
      upstream.on('error', () => res.destroy())
    })
    request.on('error', (err) => {
      stats.lastError = '上游失败：' + describeError(err)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'trae_shim_upstream', message: stats.lastError } }))
      } else {
        res.destroy()
      }
    })
    res.on('close', () => request.destroy())
    request.end(payload)
  }

  /** 接住压缩后的明文请求：还原 SOLO → 直发上游 → 转回 OpenAI SSE。 */
  const handle = (req, res) => {
    const requestUrl = new URL(req.url === undefined ? '/' : req.url, origin)
    if (req.method !== 'POST' || !requestUrl.pathname.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":{"type":"trae_shim_not_found"}}')
      return
    }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const segments = requestUrl.pathname.split('/')
      const rid = segments.length >= 3 ? segments[segments.length - 3] : ''
      const entry = rid.length > 0 ? pending.get(rid) : undefined
      if (entry === undefined) {
        stats.fallback += 1
        stats.lastError = 'rid 不存在或已过期：' + String(rid)
        res.writeHead(410, { 'content-type': 'application/json' })
        res.end('{"error":{"type":"trae_shim_rid_expired"}}')
        return
      }
      // 不删条目：adapter 遇到 401 刷新/换号会原样重发，rid 必须还能命中。
      entry.used += 1
      let body = null
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { body = null }
      const messages = body !== null && Array.isArray(body.messages) ? body.messages : null
      const gotCount = messages === null ? 0 : messages.length
      const gotChars = messages === null ? 0 : JSON.stringify(messages).length
      const gotContent = messages === null ? 0 : contentCharsOf(messages)
      // 「压缩过」= bili 真的改写了 messages。留一份可核对的样本，否则看不出
      // 是压缩接上了，还是 bili 只是原样透传。
      const changed = messages !== null && (gotCount !== entry.sentCount || gotChars !== entry.sentChars)
      // 「变短」必须在**解析出 messages** 的前提下才成立：解析失败时 gotContent 是 0，
      // 拿它比大小会把每一次畸形请求都记成「压缩成功」，诊断环从此失去意义。
      const shrank = messages !== null && gotContent < entry.sentContent
      if (changed) stats.compacted += 1
      // 两种「改动」要分开计：bili 注入系统提示也会让 messages 变，那不是压缩。
      // 只有正文真的变短（folded）才说明上下文被压下来了。
      if (shrank) stats.folded += 1
      stats.lastExchange = {
        rid,
        at: Date.now(),
        changed,
        beforeCount: entry.sentCount,
        afterCount: gotCount,
        // 这四个是**字符数**，不是正文。旧名 beforeContent/afterContent 容易
        // 被读成「正文内容」，故主名带 Chars 后缀，旧名保留为别名（有界面或探针
        // 已经在读它，改名会静默把那些读取变成 undefined）。
        beforeContentChars: entry.sentContent,
        afterContentChars: gotContent,
        beforeContent: entry.sentContent,
        afterContent: gotContent,
        contentShrank: shrank,
        diff: messages === null ? [] : diffMessages(entry.sentList, messages),
      }
      stats.lastCompactedTools = Array.isArray(body?.tools) ? body.tools.map((tool) => String(isPlainObject(tool) && isPlainObject(tool.function) ? tool.function.name ?? '' : '')).slice(0, 12) : []
      stats.lastCompactedBiliTools = biliToolNames(body?.tools)
      if (body === null) {
        stats.fallback += 1
        stats.lastError = '压缩后的请求体不是 JSON'
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'trae_shim_body', message: stats.lastError } }))
        return
      }
      const soloBody = openAiBodyToSolo(body, { base: entry.soloBody, channel: entry.channel })
      stats.forwarded += 1
      stats.lastAt = Date.now()
      forward(entry, soloBody, res)
    })
  }

  // stats 与 pending 一起挂到实现上：热替换后 portal 拿到的是新实现，它必须能
  // 改到同一份计数（闭包里的 stats 也是同一对象，但显式挂出更不容易被改丢）。
  return { origin, prepare, handle, rebuildReturnLeg, pending, stats }
}

/**
 * 请求头：把 Headers / 数组 / 普通对象三种形态摊平成小写键的对象。
 *
 * 三种都是真实存在的：adapter 的 send() 传的是 new Headers(...)，测试与探针
 * 常用普通对象，中间层可能用 [[k, v]] 数组。
 *
 * @param {unknown} source 头源
 * @returns {Record<string, string>} 小写键的头对象
 */
function headersToRecord(source) {
  const out = {}
  if (source === null || source === undefined) return out
  try {
    if (typeof source.forEach === 'function' && !Array.isArray(source)) {
      source.forEach((value, key) => { out[String(key).toLowerCase()] = String(value) })
      return out
    }
    if (Array.isArray(source)) {
      for (const pair of source) {
        if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1])
      }
      return out
    }
    for (const key of Object.keys(source)) out[String(key).toLowerCase()] = String(source[key])
  } catch { /* 头取不出来时按空处理，转发时只补 content-type */ }
  return out
}

/**
 * 上游请求头：继承全部原头，去掉「按旧 body 算」的那些，再按新 body 重算长度。
 *
 * @param {unknown} source pending 里留存的原始头
 * @param {number} bodyLength 新 body 的字节数
 * @returns {Record<string, string>} 可直接交给 node:http/https 的头对象
 */
function headersForUpstream(source, bodyLength) {
  const record = headersToRecord(source)
  const out = {}
  for (const key of Object.keys(record)) {
    if (key === 'content-length' || key === 'content-encoding' || key === 'transfer-encoding') continue
    // host / connection / accept-encoding / expect / te 属于 node 自己要管的传输层
    // 头：带上会让上游按错误的 host 或已压缩的编码回包，而我们无法逐帧解析。
    if (key === 'host' || key === 'connection' || key === 'accept-encoding' || key === 'expect' || key === 'te') continue
    out[key] = record[key]
  }
  if (out['content-type'] === undefined) out['content-type'] = 'application/json'
  out['content-length'] = String(bodyLength)
  return out
}

/**
 * 客户端响应头：去掉长度/编码/连接类，流式正文的边界由我们自己写。
 *
 * @param {Record<string, unknown>} raw 上游 response.headers
 * @returns {Record<string, string>} 头对象
 */
function headersForClient(raw) {
  const out = {}
  if (raw === null || raw === undefined) return out
  for (const key of Object.keys(raw)) {
    const lower = key.toLowerCase()
    if (lower === 'content-length' || lower === 'content-encoding' || lower === 'transfer-encoding') continue
    if (lower === 'connection' || lower === 'keep-alive') continue
    out[lower] = String(raw[key])
  }
  return out
}

/**
 * 一次 usage 是不是「全 0 的空壳」。
 *
 * bili 在没有见到上游 finish 时会自己补一帧 finish+usage，值通常是全 0。那是它的
 * 占位，不是真实用量；把它当成 token_usage 会让缓存命中率与计费归零。
 *
 * @param {object} usage OpenAI usage 对象
 * @returns {boolean} 所有计数都为 0 则为 true
 */
function isZeroUsage(usage) {
  if (!isPlainObject(usage)) return false
  let seen = false
  for (const key of Object.keys(usage)) {
    const value = usage[key]
    if (typeof value === 'number') {
      seen = true
      if (value !== 0) return false
      continue
    }
    if (isPlainObject(value)) {
      for (const inner of Object.keys(value)) {
        if (typeof value[inner] === 'number') {
          seen = true
          if (value[inner] !== 0) return false
        }
      }
    }
  }
  return seen
}

/* ==================== 五层：接管与生命周期 ==================== */

/**
 * 收集注册表里的活 TRAE adapter。
 *
 * 多前缀下同一个裸名可能有多条在线（ofm-trae、ct-trae、caa-trae 各注册一条），
 * 必须逐个全收：只包一条会让另一条静默直发，而 /status 仍显示已接管。
 *
 * @param {object} ctx Cordis 上下文
 * @returns {{adapters: Array<{id: string, adapter: object}>, notes: string[], registeredIds: string[]}}
 */
function collectAdapters(ctx) {
  const notes = []
  let registry = null
  try { registry = ctx?.get?.('llm')?.adapters ?? null } catch { registry = null }
  if (registry === null || registry === undefined) {
    notes.push('ctx.get("llm").adapters 不可用')
    return { adapters: [], notes, registeredIds: [] }
  }
  const registeredIds = []
  if (typeof registry.forEach === 'function') {
    try { registry.forEach((_value, key) => registeredIds.push(String(key))) } catch { /* 不可枚举 */ }
  }
  const adapters = []
  for (const id of registeredIds) {
    if (!isTraeShimProvider(id)) continue
    let registration = null
    try { registration = registry.get?.(id) ?? null } catch { registration = null }
    const adapter = registration === null || registration === undefined ? null : (registration.adapter ?? registration)
    if (adapter === null || !isPlainObject(adapter)) { notes.push(id + ' 取不到 adapter'); continue }
    adapters.push({ id, adapter })
  }
  if (adapters.length === 0) {
    notes.push('注册表里没有 trae 系 adapter（已判定 ' + registeredIds.length + ' 个键）')
  }
  return { adapters, notes, registeredIds }
}

/**
 * 启动 trae 压缩 shim。同端口重复调用是**热替换**：端口、已装的包装与计数保持
 * 不动，只把请求处理换成新实现，所以改完 shim 代码重载插件即可生效，也不会打断
 * 既有连接（在途请求的 rid 属于上一轮实现，pending 表必须沿用）。
 *
 * @param {{ctx: object, logger?: object, port?: number}} options
 * @returns {Promise<{status: () => object, stop: () => Promise<void>}>} 句柄；
 *   stop 幂等，可安全重复调用
 */
export async function startTraeCompressShim(options) {
  const opts = options === undefined || options === null ? {} : options
  const ctx = opts.ctx
  const logger = opts.logger
  const port = Number.isInteger(opts.port) && opts.port > 0 && opts.port < 65536 ? opts.port : 47011
  const info = (text) => { if (logger !== null && logger !== undefined && typeof logger.info === 'function') logger.info(text) }
  const warn = (text) => { if (logger !== null && logger !== undefined && typeof logger.warn === 'function') logger.warn(text) }

  const previous = globalThis[STATE_KEY]
  const stats = previous !== undefined && previous.stats !== undefined
    ? previous.stats
    : {
        enabled: true, installed: true, effective: false, port,
        intercepted: 0, forwarded: 0, compacted: 0, folded: 0, fallback: 0,
        // lastExchange 起步就是 null 而不是缺席：读 /status 的界面不必再判
        // 「这个键有没有出现过」，形状从第一次装载起就稳定。
        lastError: null, lastAt: null, lastExchange: null, targets: [], notes: [], pendingCount: 0,
      }
  for (const key of ['intercepted', 'forwarded', 'compacted', 'folded', 'fallback']) {
    if (typeof stats[key] !== 'number') stats[key] = 0
  }
  // 回程诊断：bili 回了几帧 OpenAI、我们重建出几帧 SOLO、重建里丢了几帧。
  // 排障时这三者一起看才知道是「bili 没回」还是「回了但我们没转出来」。
  if (!isPlainObject(stats.returnLeg)) stats.returnLeg = { openAiFrames: 0, soloFrames: 0, rebuildErrors: 0, emptyRebuilds: 0, keepAlives: 0 }
  for (const key of ['openAiFrames', 'soloFrames', 'rebuildErrors', 'emptyRebuilds', 'keepAlives']) {
    if (typeof stats.returnLeg[key] !== 'number') stats.returnLeg[key] = 0
  }
  stats.enabled = true
  stats.installed = true
  stats.port = port

  const impl = createImpl({ port, stats, pending: previous !== undefined && previous.impl !== undefined ? previous.impl.pending : null })

  /**
   * 每个 adapter 实例只包一次 fetchImpl，记下原始实现以便还原。
   *
   * 用 WeakMap 而不是数组：adapter 被 fiber 重启换掉后旧实例会被回收，数组会留
   * 一堆强引用既占内存、又让 stop() 去还原早已不在注册表里的对象。
   */
  const wrapped = previous !== undefined && previous.wrapped instanceof WeakMap ? previous.wrapped : new WeakMap()

  /**
   * 包一个 adapter。返回 false 表示这次没有新装（已包过 / 没有 fetchImpl）。
   *
   * 接管条件写得很窄：只有「url 以 TRAE_CHAT_PATH 结尾 + method 为 POST」才进
   * prepare；其余请求一律原样透传 —— 适配器还会用 fetchImpl 拉模型目录、
   * 刷新凭据，那些不能被这条旁路碰到。
   *
   * @param {{id: string, adapter: object}} item 注册表条目
   * @returns {boolean} 本次是否新装了包装
   */
  const wrapAdapter = (item) => {
    const adapter = item.adapter
    if (wrapped.has(adapter)) return false
    let original = null
    try { original = adapter.fetchImpl } catch { original = null }
    if (typeof original !== 'function') return false
    const portal = async function mfTraeShimPortal(input, init) {
      // fetch 的 input 既可以是 URL 字符串，也可以是 Request：adapter 现在只传
      // 字符串，但第三方包装层可能换成 Request，取错会让端点判断永远不命中。
      const url = typeof input === 'string'
        ? input
        : isPlainObject(input) && typeof input.url === 'string' ? input.url : String(input)
      const requestMethod = isPlainObject(input) && typeof input.method === 'string' ? input.method : undefined
      const method = isPlainObject(init) && typeof init.method === 'string' ? init.method : requestMethod
      // 端点判断放在最前面：拉目录、刷新凭据都走同一个 fetchImpl，不能被接管。
      if (!url.endsWith(TRAE_CHAT_PATH)) return original.call(this, input, init)
      if (method === undefined || method.toUpperCase() !== 'POST') return original.call(this, input, init)
      // 用**状态槽里的实现**而不是闭包里的那个：热替换只换 slot.impl，闭包里仍是
      // 上一轮模块的代码 —— 走闭包会让「改完代码重载插件」实际不生效。
      const slot = globalThis[STATE_KEY]
      const current = slot !== undefined && slot.impl !== undefined ? slot.impl : impl
      let response = undefined
      try {
        response = await current.prepare(this, url, init, original)
      } catch (err) {
        // prepare 只在「回环请求本身失败」时抛：那是网络层错误，必须让 adapter
        // 走它的 TRANSPORT 分支（里面有重试与换号），不能在这里吞掉。
        current.stats.fallback += 1
        current.stats.lastError = 'portal 透传：' + describeError(err)
        throw err
      }
      if (response === undefined || response === null) return original.call(this, input, init)
      current.stats.seenRequests = (typeof current.stats.seenRequests === 'number' ? current.stats.seenRequests : 0) + 1
      // 410 = shim 那边没有这条 rid（pending 被重载换掉、或超过 TTL）。它明确说明
      // 请求**没有**被转发给上游，所以这里回退直发是安全的；不处理的话 adapter
      // 会把 410 当成不可重试的 HTTP_410，整轮对话直接失败。
      if (response.status === 410) {
        current.stats.fallback += 1
        current.stats.lastError = 'rid 失效，已回退直发'
        return original.call(this, input, init)
      }
      try {
        return current.rebuildReturnLeg(response)
      } catch (err) {
        // 重建失败：把 bili 的原样响应交回（至少 adapter 还能看到帧，只是没有
        // event: 外壳）；绝不再发一次请求。
        current.stats.returnLeg.rebuildErrors += 1
        current.stats.lastError = 'portal 重建失败：' + describeError(err)
        return response
      }
    }
    portal.__mfTraeShimPortal = true
    try {
      adapter.fetchImpl = portal
    } catch {
      warn('[model-failover] trae 压缩 shim 无法替换 ' + item.id + ' 的 fetchImpl')
      return false
    }
    wrapped.set(adapter, original)
    stats.targets = [...new Set([...(Array.isArray(stats.targets) ? stats.targets : []), item.id])]
    return true
  }

  /**
   * 对账：重新扫一遍注册表，把新冒出来的活 adapter 补上包装。
   *
   * adapter 被它自己的 fiber 重启替换成新实例后，包装随旧实例一起消失，而
   * /status 仍报已接管 —— 只有重扫注册表才能发现。开销是一次 Map 遍历。
   *
   * @returns {object} collectAdapters 的结果（诊断用）
   */
  const rebind = () => {
    const collected = collectAdapters(ctx)
    let added = 0
    for (const item of collected.adapters) if (wrapAdapter(item)) added += 1
    stats.notes = collected.notes
    stats.effective = wrappedCount() > 0
    stats.rebindTicks = (typeof stats.rebindTicks === 'number' ? stats.rebindTicks : 0) + 1
    if (added > 0) info('[model-failover] trae 压缩 shim 接管 ' + added + ' 个 adapter（累计 ' + stats.targets.length + '）')
    return collected
  }

  /**
   * 当前还挂着包装的 adapter 数（诊断用）。
   *
   * WeakMap 不可枚举，所以以 targets 的长度为准：它只在装成功时增长，stop() 时
   * 随注册表一起清空。之所以不维护另一个计数器：两份计数必然漂移。
   *
   * @returns {number} 已接管的路由条数
   */
  const wrappedCount = () => (Array.isArray(stats.targets) ? stats.targets.length : 0)

  const first = rebind()
  if (wrappedCount() === 0) {
    stats.effective = false
    warn('[model-failover] trae 压缩 shim 未接管任何 adapter：' + first.notes.join('; ') + '；会继续重试')
  }

  /** 对账定时器：跨热替换共用一份，只换回调，避免层层叠加。 */
  const rebindState = previous !== undefined && previous.rebindState !== undefined ? previous.rebindState : { timer: null }
  if (rebindState.timer === null && typeof setInterval === 'function') {
    rebindState.timer = setInterval(() => {
      const slot = globalThis[STATE_KEY]
      if (slot === undefined || typeof slot.rebind !== 'function') {
        clearInterval(rebindState.timer)
        rebindState.timer = null
        return
      }
      try { slot.rebind() } catch (err) {
        slot.stats.lastError = '对账失败：' + describeError(err)
      }
    }, REBIND_INTERVAL_MS)
    if (typeof rebindState.timer.unref === 'function') rebindState.timer.unref()
  }

  if (previous !== undefined && previous.port === port && previous.server !== undefined) {
    previous.impl = impl
    previous.rebind = rebind
    previous.wrapped = wrapped
    previous.rebindState = rebindState
    previous.stats = stats
    info('[model-failover] trae 压缩 shim 已热替换实现（继续复用 127.0.0.1:' + port + '）')
    return { status: () => ({ ...stats, port, pendingCount: impl.pending.size }), stop: previous.stop }
  }
  if (previous !== undefined && typeof previous.stop === 'function') await previous.stop()

  const server = http.createServer((req, res) => {
    const slot = globalThis[STATE_KEY]
    const current = slot === undefined || slot.impl === undefined ? impl : slot.impl
    current.handle(req, res)
  })

  let stopped = false
  /** 退场：还原 fetchImpl、停定时器、停监听、清状态槽。幂等。 */
  const stop = async () => {
    if (stopped) return
    stopped = true
    if (rebindState.timer !== null) {
      try { clearInterval(rebindState.timer) } catch { /* 已停 */ }
      rebindState.timer = null
    }
    // 还原只认「还挂着我那个 portal」的实例：adapter 若已被替换成新实例，旧实例
    // 上的包装已经不生效，改写它只会把某个第三方的实现覆盖掉。
    for (const item of collectAdapters(ctx).adapters) {
      const original = wrapped.get(item.adapter)
      if (typeof original !== 'function') continue
      try {
        // 只还原**还挂着我那个 portal** 的实例：adapter 若已被第三方换掉实现，
        // 再把 our original 写回去等于覆盖别人的代码。
        if (item.adapter.fetchImpl?.__mfTraeShimPortal === true) item.adapter.fetchImpl = original
      } catch { /* 还原失败不影响退出 */ }
      try { wrapped.delete(item.adapter) } catch { /* 同上 */ }
    }
    stats.targets = []
    try {
      const slot = globalThis[STATE_KEY]
      if (slot !== undefined && slot.stop === stop) delete globalThis[STATE_KEY]
    } catch { /* 同上 */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { server.closeAllConnections?.() } catch { /* 老 Node 没有这个方法 */ }
        resolve()
      }, STOP_GRACE_MS)
      try {
        server.close(() => { clearTimeout(timer); resolve() })
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  // listen 的失败是异步 'error' 事件：没有监听器时它会成为未捕获异常，结束整个宿主
  // 进程。端口被占（旧实例还没退、或另一份部署在同一个端口上）是最常见的触发方式，
  // 而本 shim 的承诺是「装不上只告警、TRAE 照常直发」，所以这里必须折成可捕获的失败，
  // 并且把已经装上的 fetchImpl 包装还原，不留半接管的状态。
  try {
    await new Promise((done, fail) => {
      const onError = (err) => { server.removeListener('listening', onListening); fail(err) }
      const onListening = () => { server.removeListener('error', onError); done() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
  } catch (err) {
    stats.lastError = '监听 127.0.0.1:' + port + ' 失败：' + describeError(err)
    await stop()
    throw err
  }
  // 监听之后的运行时错误同样不能让进程崩：记进 /status，让每个请求各自失败。
  server.on('error', (err) => { stats.lastError = '监听期间错误：' + describeError(err) })
  globalThis[STATE_KEY] = { port, stats, impl, rebind, wrapped, rebindState, server, stop }
  info('[model-failover] trae 压缩 shim 已监听 127.0.0.1:' + port + '（SOLO 请求经 bili 压缩后还原发往上游；接管 ' + wrappedCount() + ' 条路由）')
  return { status: () => ({ ...stats, port, pendingCount: impl.pending.size }), stop }
}
