/**
 * dsh-ofm-revive-compat，宿主半。
 *
 * 让「apply 中途抛错而停在 FAILED 的 Loader 条目」重新启动，并在之后再犯时自动再救一次。
 *
 * 为什么要这个插件：cordis 的 fiber 一旦在某次 apply 里抛错，就进入 FAILED，并把
 * `_error` 记下来（vendor/cordis/src/fiber.ts:604/:720）。此后 `fiber.restart()`
 * 走的是 `_refresh() → _setEpoch()`，而 `_setEpoch` 开头就是
 *
 *     // a failed fiber only recovers through update(), which clears _error
 *     if (this._error) return
 *
 * 于是 restart() 静默返回、状态永远是 FAILED —— 只有 `fiber.update()`（同文件
 * :805-830，先 `_error = undefined` 再 restart）能让它活过来。宿主本身没有提供
 * 「重启这个条目」的入口，只有插件管理器里改配置才会触发 update。
 *
 * 具体到 dsh-our-free-model：它的 apply 第 508 行注册 provider 目录，撞上
 * DUPLICATE_DIRECTORY 就整次 apply 中断，后面注册 `/api/our-free-model` 路由的
 * `ctx.inject(['webServer'], …)` 根本没执行，界面因此一直报「无法连接插件后端 /
 * not found」。目录重复的根因已在前缀门面 llm-prefix-facade.mjs 里修掉；本插件负责
 * 把已经卡死的那个 fiber 拉起来，并在以后任何一次热重载再把它弄死时再拉一次。
 *
 * 只动名字精确匹配的条目，且只在它确实处于 FAILED 时才动作；正常运行时什么都不做。
 */

import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 插件名；Loader 用它在诊断里标识本条目。 */
export const name = 'ofm-revive-compat'

/**
 * 诊断落点：宿主不会把插件 logger 输出送到 launcher 日志，只能自己留痕。
 *
 * 必须写在 HMR 监视的 plugins 目录之外（本条目目录的上级 `logs/`），否则每次写
 * 日志都会变成一次 HMR 变更事件。
 */
const TRACE_FILE = fileURLToPath(new URL('../../logs/ofm-revive.log', import.meta.url))

/**
 * 追加一行诊断。写失败不能影响自救流程，因此吞掉异常。
 *
 * @param {string} line 单行内容。
 * @returns {void}
 */
function trace(line) {
  try {
    appendFileSync(TRACE_FILE, new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch { /* 诊断写不进去也不该中断自救 */ }
}

/** 需要 loader 服务才能枚举条目并把失败条目重新启动。 */
export const inject = ['loader']

/**
 * 要救的 Loader 条目：按插件名（`entry.options.name`）与条目 id 双向精确匹配。
 *
 * 名字来自 profile 的 bundle 声明（dsh-our-free-model），id 来自 home patch 里
 * 那行 isolate 覆盖（our-free-model）；两者任一命中即可，不做模糊匹配。
 */
const TARGET_NAMES = new Set(['dsh-our-free-model'])
const TARGET_IDS = new Set(['our-free-model'])

/** `vendor/cordis/src/fiber.ts` 的 `FiberState`；常量枚举在运行时是纯数字。 */
const ACTIVE = 2
const FAILED = 3

/** 启动后第一次尝试前的等待：先让整棵树与门面把首轮注册走完。 */
const FIRST_ATTEMPT_MS = 1500

/** 启动阶段的尝试间隔与次数（热重载把条目弄死通常就在头几秒）。 */
const STARTUP_RETRY_MS = 2000
const STARTUP_ATTEMPTS = 8

/** 之后长期巡检的间隔：条目再被热重载弄死时不必等下一次重启宿主。 */
const WATCH_INTERVAL_MS = 60_000

/**
 * 找一个名字命中且确实处于 FAILED 的条目。
 *
 * @param {object} loader loader 服务。
 * @returns {object | undefined} 命中的 Loader 条目。
 */
function failedTarget(loader) {
  for (const entry of loader.entries()) {
    const name = entry?.options?.name
    const id = entry?.options?.id
    if (!TARGET_NAMES.has(name) && !TARGET_IDS.has(id)) continue
    const fiber = entry.fiber
    if (!fiber || fiber.uid === null) continue
    if (fiber.state !== FAILED) continue
    return entry
  }
  return undefined
}

/**
 * 把处于 FAILED 的目标条目拉起来。
 *
 * 用 `update(config, true)` 而不是 `restart()`：noSave 传 true 表示这只是运行时
 * 重启，不把配置写回磁盘（条目本来就没改配置，改写会污染 patch 源文件）。
 *
 * @param {object} ctx 插件上下文。
 * @param {object} logger 宿主 logger。
 * @returns {Promise<boolean>} 本次是否真的救活了一个条目。
 */
async function reviveOnce(ctx, logger) {
  const entry = failedTarget(ctx.loader)
  if (entry === undefined) return false
  const label = String(entry.options?.id ?? entry.options?.name)
  const reason = entry.fiber?._error?.message ?? entry.fiber?._error ?? '(unknown)'
  trace('revive ' + label + ' reason=' + String(reason))
  logger.warn('[ofm-revive] 条目 %s 停在 FAILED（%s），重新启动它', label, String(reason))
  try {
    await entry.fiber.update(entry.options.config, true)
  } catch (error) {
    trace('update threw ' + label + ' ' + String(error?.message ?? error))
    logger.warn('[ofm-revive] 重新启动 %s 仍然失败：%s', label, error?.message ?? String(error))
    return false
  }
  if (entry.fiber.state === FAILED) {
    trace('still failed ' + label)
    logger.warn('[ofm-revive] 重新启动 %s 后仍是 FAILED；多半是重复注册的旧登记还在，需要修门面或重启宿主', label)
    return false
  }
  if (entry.fiber.state !== ACTIVE) {
    // PENDING：依赖还没就位（例如 llm 尚未提供），cordis 会在依赖出现时自己驱动，
    // 这里不算失败，但也不能当成救活。
    trace('restarted but state=' + entry.fiber.state + ' ' + label)
    logger.warn('[ofm-revive] 条目 %s 已重新加载，但当前状态是 %s（等待依赖）', label, entry.fiber.state)
    return false
  }
  trace('revived ' + label + ' state=' + entry.fiber.state)
  logger.warn('[ofm-revive] 条目 %s 已重新启动', label)
  return true
}

/**
 * 插件入口：启动阶段重试若干次，之后每分钟巡检一次。
 *
 * @param {object} ctx 插件上下文（已注入 loader）。
 * @returns {void}
 */
export function apply(ctx) {
  const logger = ctx.logger
  let stopped = false
  let timer
  trace('apply; loader=' + (typeof ctx.loader?.entries))

  /** 启动阶段的有限次重试；成功后停止重试，交给长期巡检。 */
  const startup = (attempt) => {
    if (stopped) return
    void reviveOnce(ctx, logger).then((revived) => {
      if (stopped || revived) return
      if (attempt + 1 >= STARTUP_ATTEMPTS) return
      timer = setTimeout(() => startup(attempt + 1), STARTUP_RETRY_MS)
      timer.unref?.()
    })
  }

  timer = setTimeout(() => startup(0), FIRST_ATTEMPT_MS)
  timer.unref?.()

  const interval = setInterval(() => {
    if (stopped) return
    void reviveOnce(ctx, logger).catch((error) => {
      logger.warn('[ofm-revive] 巡检失败：%s', error?.message ?? String(error))
    })
  }, WATCH_INTERVAL_MS)
  interval.unref?.()

  ctx.effect(() => () => {
    stopped = true
    clearTimeout(timer)
    clearInterval(interval)
  }, 'ofm-revive-compat: watchdog')
}
