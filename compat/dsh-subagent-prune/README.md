# dsh-subagent-prune

给 DeepSeek Harness 的会话面板「子智能体」分栏加上**清空**与**逐个删除**——删掉的子代理在会话里
调用工具也查不到。

## 为什么需要它

子代理列表来自父会话日志里只增不减的 `subagent/catalog` 事件投影（`subagentCatalog` 投影，
见 `packages/subagent/subagent/src/catalog.ts`）。宿主没有删除或清除入口，跑久了的分栏会攒下几十个
历史子代理（本机那个定时任务会话攒到 36 个）。会话日志由内核的写锁保护、回改不了，因此本插件
不删除任何会话数据，而是在**展示层与工具面**上让被删的子代理消失。

## 删除在三处生效

| 层 | 效果 | 实现位置 |
| --- | --- | --- |
| 面板 | 分栏不再列出被删的子代理；被删子代理的整棵子树一起收起 | `client.js` |
| 工具 | 会话里的模型调 `list_agents` 时结果里没有这些条目；调 `send_message` / `interrupt_agent` 指向它们时被拒绝 | `host.mjs`（`tools/post-execute`、`tools/pre-execute`） |
| 执行 | 删除时中断被删子代理及其子树的当前执行，别让它在列表外继续跑 | `host.mjs`（`subagents.interrupt`） |

删除可逆：宿主把「哪个父会话删除了哪些子代理」记在 `$DSH_HOME/dsh-subagent-prune/state.json`，
「恢复」把它们放回列表，工具面随之恢复。

## 形态

第三方插件，装在 `$DSH_HOME/plugins/dsh-subagent-prune`，不改 DSH 仓库任何源码。

| 文件 | 作用 |
| --- | --- |
| `host.mjs` | 宿主半：持久化删除集合，挂同源 HTTP 接口，并在工具面上执行删除 |
| `client.js` | 浏览器半：接管 `conversation.session.panel.section` 槽里 id 为 `subagents` 的分栏，重画成带「清空」按钮和行内「×」的列表 |
| `cordis.patch.yml` | 插件包自带的 bundle 形态（本机是由 `$DSH_HOME/cordis.patch.yml` 直接挂载的，见下） |

## 接口

同源，均返回 `{ ok: true, ... }` 或 `{ ok: false, error }`：

| 方法 | 路径 | 请求体 | 说明 |
| --- | --- | --- | --- |
| GET | `/dsh-subagent-prune/api/state` | — | 全部父会话的删除集合 |
| POST | `/dsh-subagent-prune/api/set` | `{ sessionId, childIds, hidden }` | 增加/减少删除项；`hidden: false` 表示放回 |
| POST | `/dsh-subagent-prune/api/reset` | `{ sessionId }` | 清掉一个父会话的删除集合 |
| POST | `/dsh-subagent-prune/api/reset-all` | — | 清掉全部 |

宿主路由受 webServer 的鉴权策略保护（默认 `required`），只有带同源凭据的浏览器请求才能访问；
直接用 curl 打会得到 401 `unauthorized`。

## 挂载

`$DSH_HOME/cordis.patch.yml` 末尾已经加了：

```yaml
- insert:
    - id: subagent-prune
      name: ./plugins/dsh-subagent-prune/host.mjs
```

改动后宿主会重新组装 profile，插件随之加载；浏览器半由 `dsh.client.immediately: true` 在下次页面加载时注入。

## 使用

打开有子代理的会话，会话面板的「子智能体」分栏：

- 标题行的 **清空**：把当前会话所有可见子代理一次性删除；
- 每行的 **×**：只删除这一条（它的下级子代理随之消失）；
- 出现 **恢复 N 个** 时点它，被删除的全部放回。

每行还显示该子代理的累计运行时长（取自 `subagentTiming` 投影的 `settledMs` 加上当前开启区间），
运行中的行每秒刷新；悬停可看到整秒精度的完整时长。

控制台可用 `window.dshSubagentPrune` 直接调用 `deleteChildren(sessionId, ids, deleted)` / `restoreAll(sessionId)`。

## 边界

- 被删子代理的**会话记录本身仍在**：会话日志不可回改，本插件只让它们在列表与工具面消失。
- 归档（`workspace/archiveSession`）也能挡住子代理的执行，但不会把它从 `subagentCatalog` 投影里摘掉，
  `list_agents` 仍会列出它——所以这里用工具面过滤，而不是归档。
- 恢复之后，被删子代理的历史执行不会自动续跑；要用 `send_message` 重新起一轮。

## 降级

分栏按同 id 的 list 单元格遮蔽内置注册：动态插件由 `cordis-client-runner` 分配页内优先级，负值排在前面，
因此本条目成为该单元格的赢家；若本插件加载失败或被卸载，注册表退役该条目，内置分栏立刻回填。
