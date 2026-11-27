# dsh-connection-compat

在运行时把被宿主删除的 `ctx.connection.requestRejection()` 补回去，让按旧 API 编写的插件继续工作。

## 为什么需要它

dsh `0.2.2-rc.2` 的迁移项（commit `71753fdf91`，#8266）删除了 `Connection` 的
`requestRejection()`、`authenticatedUrl()` 等成员，官方迁移说明见
`docs/upgrade-guide/v0.2.2-rc.2/connection-page-peer`：「使用 `admit` 替代 `requestRejection`」。

部分插件仍按旧 API 编写。其中 **dsh-better-sidebar 0.32.1** 是唯一没有做类型守卫的调用者：
它的 `lib/index.js:10054` 是

```js
const fence = req => ctx.connection.requestRejection(req) === void 0
```

而这段位于 11 条 `/sidebar/*` 路由（含 3 条 WebSocket upgrade）的入口。调用不存在的成员会同步抛
`TypeError`，被 `@deepseek-ai/dsh-host-webserver` 的兜底监听器接住
（`packages/host/webserver/src/index.ts:650-663`，注释为 "Per-request failures log and answer 400 —
never a process exit"），写出一份 **空 body 的 400**。

表现为：侧栏整块瘫痪（连 `GET /sidebar/api` 这种本该 405 的请求也是空 400），在书房点开 `.md`
时面板只显示 `HTTP 400`——因为客户端只有在响应体不是合法 JSON 时才会退化成这个字面量
（`lib/client-registry.js:4561`），插件自己的错误信封从未有机会写出。

## 它做什么

`host.v3.mjs` 在 `connection` 服务实例上定义 `requestRejection()`，实现与旧版一致：

```js
request => {
  const admission = raw.admit(request)
  return 'rejection' in admission ? admission.rejection : undefined
}
```

- 只回答「这个请求会不会被拒」，成功返回 `undefined`，不返回 Peer、不建立身份、不改任何状态。
- 新版 `admit()` 还会返回 `503`（认证提供者失败）；旧签名没有 503，但 503 也是「拒绝」，
  原样返回不会放松任何判定。
- 宿主将来若自己恢复该方法（原型上的实现），插件检测到后自动让位。

## 关键：必须用真实实例调 `admit()`

Cordis 把服务包成**按访问方 scope 解析**的可追踪代理（`vendor/cordis/src/utils.ts:171-215`
的 `createTraceable`）：从代理上调用方法时，`apply` trap 会把 `this` 换成**调用方的 shadow 上下文**。
`HostConnectionService.admit()` 内部读的是 `this.authentication`，于是这次读取变成一次服务查找
`connection.authentication`，而访问方（本插件、dsh-better-sidebar、dshmarket）都没有 inject
这个名字，直接抛出：

```
cannot get property "connection.authentication" without inject
```

隔离复现（`vendor/cordis` + 同样的 `Service` 子类）：

```
inject ['connection']                          -> THREW: cannot get property "connection.authentication" without inject
inject ['connection', 'connection.authentication'] -> {"peer":{"id":"p"}}
```

所以本插件用 `Symbol.for('cordis.original')` 取出代理背后的真实实例再调用 `admit()`。
这是 v1 失效的原因：v1 闭包捕获的是自己的代理，补回来的 `requestRejection()` 每次调用都抛异常 ——
书房 `.md` 依旧 400，插件市场的门禁（`dshmarket` 的 `refuseUnadmitted`，捕获异常后按 403 处理）
报出「这个请求来自不受信任的地址，已拒绝 / This request came from an untrusted origin and was refused」。
那句 403 文案是 `lib/http.js:46-72` 对**任何**非 401 状态的通用回复，并不代表真的存在来源问题。

## 配置

`cordis.patch.yml` 只有一行 insert；挂载点是 `$DSH_HOME/cordis.patch.yml`：

```yaml
- insert:
    - id: connection-compat
      name: ./plugins/dsh-connection-compat/host.v3.mjs
```

改文件名（而不是改内容）是必需的热重载手段：`vendor/hmr/src/index.ts:129-152` 只在
`loader.internal.loadCache` 命中时做 partial reload，已加载过的同一路径不会被重新求值；
换新路径（或新增 loader 行）才会真正重新 import。

## 验证

线上实测（`dsh 0.2.2-rc.3`，`127.0.0.1:3080`，带有效 cookie）：

| 请求 | 修复前 | 修复后 |
| --- | --- | --- |
| `GET /dsh-market/status` | 403 不可信来源 | **200** 正常 JSON |
| `GET /sidebar/api` | 400 空 body | **405**（围栏放行后的正常方法错误） |
| `POST /sidebar/api/session.cwd` | 400 空 body | JSON 信封（`missing or invalid "sessionId"`） |
| `GET /sidebar/file?path=…` | 400 空 body | JSON 信封（`sessionId and path are required`） |

浏览器实测：`/dsh-market/status` 直接渲染出状态 JSON，不再是 403。

## 何时可以删掉

`dsh-better-sidebar` 上游把 `fence` 改成 `ctx.connection.admit(req).rejection === undefined`
（一行改动）并发版之后。其余仍在调用 `requestRejection` 的插件
（dsh-free-search、dshmarket、@linxin666/dsh-client-ui-task-board 等）都带 `typeof` 守卫，
只是降级为 503，不会崩。

同类未做守卫、且需要 `authenticatedUrl()` 的还有 `dsh-pet`（`lib/index.js:7144`），
本插件不覆盖该成员——按需再加。

## 这是宿主侧的缺陷，不只是插件兼容问题

`admit()` 在自己的实现里读 `this.authentication`，就注定无法被「只 inject 了 `connection`」的
调用方安全调用；而 `admit()` 的契约（`packages/extensions/tool-cordis/src/api-catalog.ts:778`）
只要求调用方持有 `connection`。也就是说 `packages/client/connection/src/rpc-host.ts:117`
与 `ConnectionAuthentication` 的声明方式之间存在一个真实的可用性缺口：
任何第三方插件照着公开签名调用 `admit()` 都会拿到上面那个异常。修好一方即可——
或在 `admit()` 内部改用构造期捕获的 `auth` 引用，或让 `connection` 服务不把
`connection.authentication` 作为需要访问方 inject 的读取点。
