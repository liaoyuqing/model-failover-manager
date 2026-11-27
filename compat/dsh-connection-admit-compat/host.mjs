/**
 * dsh-connection-admit-compat —— 让经 `ctx.get('connection')` 拿到的可追踪代理上
 * 调用 `admit()` 不再抛 `cannot get property "connection.authentication" without inject`。
 *
 * 背景（不改 dsh 源码，也不改任何第三方插件，只在内存里补一个方法）：
 * Cordis 把服务值包成「按访问方 scope 解析」的可追踪代理
 * （vendor/cordis/src/utils.ts:121 `getTraceable`，:173 `createTraceable`）。
 * `HostConnectionService` 带 tracker `{ associate: 'connection', property: 'ctx' }`
 * （vendor/cordis/src/service.ts:49-52），于是代理的 get trap 走
 * utils.ts:186-187：读 `this.authentication` 时被翻译成一次访问方上下文上的服务查找
 * `connection.authentication`。访问方（dsh-our-free-model、dsh-better-sidebar、
 * dshmarket 等）只 inject 了 `connection`，没 inject `connection.authentication`，
 * 于是 reflect.ts:185 抛出 `cannot get property "connection.authentication" without inject`。
 *
 * 为什么这会表现成 503：dsh-our-free-model 的门禁在 src/trust.js:110-113 把所有异常
 * 一律折算成 `{status: 503, source: 'connection', reason: 'admission-error'}`，
 * 前端于是显示「无法连接插件后端 / admission unavailable」。同一条请求打宿主自己的
 * `/api/health` 是 404（门禁放行），只有插件的路由 503 —— 差别就在这一次 admit 调用。
 *
 * 修法：在真实服务实例上定义一个自有属性 `admit`，实现是固定 `this` 的箭头函数
 * 转调原型方法。代理 get 到它时得到的是 createShadowMethod 包装，调用时
 * `Reflect.apply(箭头函数, shadow, args)` —— 箭头函数不读 thisArg，内部仍然是
 * 原型方法以真实实例为 receiver，`this.authentication` 回到原型链查找，不再触发
 * associate 服务定位。整条 admission 语义（Host/Origin 围栏 → disposed → 凭证校验）
 * 完全不变，只是把 `this` 从访问方 shadow 换回服务实例。
 *
 * 若宿主将来自己提供了自有 `admit`（例如官方修好这类重绑定），本插件自动让位。
 */

export const name = 'connection-admit-compat'

/** 依赖注入：等 connection 服务就绪后再挂载。 */
export const inject = ['connection']

/** 目标服务名。 */
const SERVICE = 'connection'

/** Cordis 可追踪代理上指回真实服务实例的符号。 */
const ORIGINAL = Symbol.for('cordis.original')

/**
 * 取出可追踪代理背后的真实服务实例。
 * @param value - `ctx.get()` / `ctx.connection` 拿到的服务值，可能是代理。
 * @returns 真实实例；不含该符号时原样返回。
 */
function rawServiceOf(value) {
  if (value === null || value === undefined) return value
  try {
    // 代理的 get trap 对该符号直接返回 target（vendor/cordis/src/utils.ts:178）。
    const original = value[ORIGINAL]
    return original === undefined ? value : original
  } catch {
    return value
  }
}

/**
 * 挂载插件。
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  const service = ctx.get(SERVICE) ?? ctx.connection
  if (service === undefined || service === null) {
    ctx.logger?.warn?.('connection-admit-compat: connection 服务不可用，未挂载')
    return
  }
  const raw = rawServiceOf(service)
  if (raw === null || typeof raw !== 'object' && typeof raw !== 'function') {
    ctx.logger?.warn?.('connection-admit-compat: 取不到 connection 真实实例，未挂载')
    return
  }
  // 本体（原型）必须带 admit；宿主若已改成自有方法，说明有人先补过，让位。
  const inner = Object.getPrototypeOf(raw)?.admit
  if (typeof inner !== 'function') {
    ctx.logger?.warn?.('connection-admit-compat: connection.admit() 不可用，未挂载')
    return
  }
  if (Object.hasOwn(raw, 'admit')) {
    ctx.logger?.info?.('connection-admit-compat: 本体已提供自有 admit()，插件让位')
    return
  }

  ctx.effect(() => {
    const previous = Object.getOwnPropertyDescriptor(raw, 'admit')
    // 箭头函数固定真实实例：代理调用时 thisArg 会被换成访问方 shadow，这里不读它。
    const bound = request => inner.call(raw, request)
    let mounted = true
    try {
      Object.defineProperty(raw, 'admit', {
        value: bound,
        configurable: true,
        writable: true,
        enumerable: false,
      })
    } catch (error) {
      mounted = false
      ctx.logger?.warn?.(`connection-admit-compat: 无法定义实例自有 admit()（${error?.message ?? error}）`)
    }
    return () => {
      if (!mounted) return
      // 只回滚自己挂的那一份，避免踩掉别人后装的实现。
      if (Object.getOwnPropertyDescriptor(raw, 'admit')?.value !== bound) return
      if (previous !== undefined) Object.defineProperty(raw, 'admit', previous)
      else delete raw.admit
    }
  }, 'connection-admit-compat: rebound admit()')

  // 从另一个上下文重新取一次服务，确认消费方（经代理）真的能调用且不再抛 inject 错误。
  const again = ctx.get(SERVICE)
  if (again === undefined || typeof again.admit !== 'function') {
    ctx.logger?.warn?.('connection-admit-compat: 未能通过代理取到 admit()，插件可能未生效')
    return
  }
  // 用 loopback Host、无凭证的探针：正常应得到 401（无提供方接受）或 403（Host 围栏）；
  // 修复前这一步会抛 cannot get property "connection.authentication" without inject。
  let probe
  try {
    probe = again.admit({ headers: { host: '127.0.0.1' } })
  } catch (error) {
    ctx.logger?.warn?.(`connection-admit-compat: 探针调用仍抛错（${error?.message ?? error}）`)
    return
  }
  const status = probe && typeof probe === 'object' ? probe.rejection : undefined
  ctx.logger?.info?.(
    `connection-admit-compat: 已给 connection 实例绑定 admit()，探针 rejection=${String(status)}`
      + '（经代理调用不再因 connection.authentication 未 inject 而抛错）',
  )
}