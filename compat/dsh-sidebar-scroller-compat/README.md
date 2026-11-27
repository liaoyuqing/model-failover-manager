# dsh-sidebar-scroller-compat

修好第三方插件接管左侧栏后「工作区 / 会话列表整块空白」的问题。只补一个缺失的 prop 转发，不改任何第三方插件的文件，也不改 DSH。

## 症状

装好 dsh-scriptor-full（`@linfengqaqtat/dsh-scriptor@8.4.0`）后，左侧栏工作区区块不再显示工作区与会话列表，控制台报：

```
TypeError: useSectionScroller is not a function
    at WorkspaceBrowser (...)
slot entry crashed in 'webnovel.workspaces'
```

## 原因

三方各自都合理，接起来才出事。

1. `ui-sidebar` 把 `sidebar.workspaces` 声明成带 hookContext 的槽：`hookContext: SidebarSectionHookContext`，并声明 `inject: SidebarSectionInjected`，其中 `hooks.sectionScroller` 把 hookContext 里的 `useSectionScroller` 变成占用者的 `useSectionScroller` prop（`packages/client/ui-sidebar/src/client/contract/slots.ts`，PR #7337，随 `dsh-v0.2.2-rc.2` 首发）。
2. 因此**任何**占用 `sidebar.workspaces` 的条目都会收到真实的 `useSectionScroller`，包括第三方接管的组件。
3. `ui-workspace` 的 `WorkspaceBrowser` 需要这个 prop：列表区自己就是纵向滚动容器，靠 `const { bindScrollerRef } = useSectionScroller()` 把滚动权交给侧栏视口。

出事点是第二跳到第三跳之间。scriptor 接管 `sidebar.workspaces` 后，把官方条目克隆到它自己的子槽 `webnovel.workspaces` 再渲染（`renderSlot('webnovel.workspaces', { wide, expandSidebar })`）。那个子槽由它自己声明，只有 `{ kind: 'single', scope: 'root' }`，没有 hookContext，于是克隆出来的 `WorkspaceBrowser` 拿到 `useSectionScroller === undefined`，首屏即崩，错误边界把整块浏览区收成空白。

它缺的东西其实就在手上：接管组件本身**已经**收到了 `useSectionScroller`，只是在渲染子槽时没有继续往下传。

## 做法

在渲染前给「声明了子槽的 `sidebar.workspaces` 占用者」套一层外壳，把它收到的那一个 `useSectionScroller` 转发进它每一次子槽渲染的 owner props。

为什么安全：

- 只加一个 prop。不改任何插件的文件，不改 DSH，不降低鉴权或渲染约束。
- 渲染器的 props 合成顺序是 `{...kit}{...injected}{...slotInjected.props}{...contextual}{...ownerProps}`（`packages/client/ui-renderer/src/client/scoped-slots.tsx`），owner props 最后合并，所以转发值一定生效。
- 不需要该子槽声明 hookContext：只有槽自己声明了 `inject.hooks` 才会走 `bindSlotHookFactories`；否则这个 prop 就是普通 prop，对不关心它的组件无害。
- 只包装「声明了子槽」的占用者。没有子槽就没有可转发的一跳，不碰。

`entry.component` 必须只换一次：渲染器每帧读它，换新引用会让 React 卸载重挂整棵子树、丢掉滚动位置与内部状态。所以这里用 `WeakSet` 记住已包装的条目，包装器本身也按条目缓存。

## 对第三方插件的依赖

本插件是给 scriptor 8.4.0 那处漏传打补丁。它按行为识别目标，不认插件名：

- 目标槽写死为 `sidebar.workspaces`（就是那条带 sectionScroller 契约的槽）。
- 只包装声明了子槽的占用者。

所以 scriptor 修复后本插件会自动变成空操作，可以卸载。官方 `WorkspaceBrowser` 自己不声明子槽，不会被包装。

## 自检

浏览器控制台：

```js
// 目标槽现在有几个占用者、其中几个被包装
dshSidebarScrollerCompat.diagnose(ctx)   // ctx 可用时给出计数

// 手动收手（幂等）：还原所有被包装的条目
dshSidebarScrollerCompat.dispose()
```

控制台还有一行加载信息：`[dsh-sidebar-scroller-compat] active; forwards useSectionScroller into takeover child slots`。

## 文件

| 文件 | 作用 |
|---|---|
| `host.mjs` | 宿主半，空实现（只为让 Loader 有可加载入口并由 `dsh.client` 带出浏览器半） |
| `client.js` | 浏览器半，包装与转发 |
| `cordis.patch.yml` | 一行 `insert`：`sidebar-scroller-compat` |

## 何时可以删掉

scriptor 上游修好那处转发（子槽渲染时把自己的 `useSectionScroller` 一并传下去），或不再接管 `sidebar.workspaces` 之后。判断方法：停用本插件并刷新，左侧栏工作区列表仍然正常即可。
