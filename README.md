# model-failover-manager

DSH 插件：把 composer 的模型选择位换成带「路由分组」的选择弹窗，并在模型彻底失败后自动切换到组内下一个可用模型。

> 界面里叫「模型故障转移」。设置入口：**设置 → 模型故障转移**。

---

## 它做什么

- **接管模型选择位**：以 `priority: -1` 注册 `conversation.input.model`，遮蔽内置选择器。
  - 打开「弹窗模式」时为左右分区弹窗（左：供应商，右：模型），含「路由分组」「失败模型」两个页签。
  - 关闭时为紧凑下拉。
  - 触发按钮显示 **供应商 · 模型名 · 思考强度**；已绑定分组时另有一个分组徽标。
- **路由分组**：可建多个分组，每组是一份有序模型列表（`priority` 决定尝试顺序）。
  - 每个模型可配**生效时段**：多段，两端包含（`from` 与 `to` 都算在时段内），`from > to` 表示跨午夜（如 22 → 6）。
  - 每个模型可配**截止日**，过期后不再参与路由。
  - 时段未配置、为 `null` 或空字符串，一律视为「全天」。
- **两种绑定模式**
  - `route`：用绑定分组里的模型（会实际改变会话当前模型）。
  - `failover`：保持会话当前模型，只有它彻底失败后才兜底切到组内下一个。
- **失败后同轮续跑**：监听 `agent/request-error`，以 prepend 注册并先 `await next()`，因此**一定是在所有重试策略都表态放弃之后**才接手（包括 `llm-error-retry` 预算耗尽后直接短路整条链的情况）。接手后标记失败、选定新模型，并让**同一轮**用新模型继续，不用你重发。
- **每轮重新路由**：每轮开始（`pre-step`、`step === 0`）重新计算，所以时段、截止日、失败状态随时间变化都会生效。
- **子代理继承**：子代理沿 `session.header.parentSession` 向上继承父会话的分组与模式。
- **默认分组**：新会话（startup/clear）自动沿用上次的选择（分组 + 模式）；`resume` / `compact` 不动，尊重旧会话既有选择。
- **失败模型记录**：按天记录失败模型，同时保存失败原因（错误码 + 最近一次错误信息）。在弹窗的「失败模型」页签里可展开查看原因，也可逐个或一键全部恢复。失败状态按天过期；会话成功完成一轮也会立即恢复对应模型。
- **交还控制权**：你手选模型、解绑分组或删除分组后，插件即不再接管该会话的模型。

## 与 Our Free Model 的配合

若失败的模型属于 `dsh-our-free-model` 提供的渠道，插件会**先尝试换账号**，而不是直接换模型：

- 不论错误类型，只要该模型还有别的可用账号，就换账号重试一轮；账号试完仍失败才交给分组路由换模型。
- 换号通过给账号写一个**池级冷却标记**实现，让该渠道适配器下次选号时跳过刚失败的账号。
- 插件**不读取也不修改**该渠道的凭据；只通过它注册的 `accountPool` 服务调用 `getAvailableAccount` / `updateModelRateLimit` / `listAccountsByProvider`。
- 未安装该插件时，这段逻辑静默跳过。

## 安装

```sh
dsh plugin add https://github.com/liaoyuqing/model-failover-manager
```

也可以手工放置：把仓库放进 `$DSH_HOME/plugins/model-failover-manager/`，然后在 `$DSH_HOME/cordis.patch.yml` 里注册：

```yaml
- insert:
    - id: model-failover-manager
      name: ./plugins/model-failover-manager/host.v6.mjs
```

## 使用

1. 打开 **设置 → 模型故障转移**：切换弹窗模式，增删改路由分组（模型优先级、生效时段、截止日），或恢复失败的模型。
2. 在会话里点模型位：选模型，并（可选）把某个分组**绑定到当前会话**，选择 `route` 或 `failover` 模式。
3. 之后该会话按绑定策略工作；绑定会落盘，重启后继续生效。

## 失败切换的判定过程

1. 一次请求失败，内层重试策略（内置 `llm-retry`、`llm-error-retry` 等）先依次表态。
2. 只有它们都放弃后，本插件才接手。
3. 若失败模型属于 Our Free Model：先换账号重试（见上一节）。
4. 否则把该模型标记为「当日失败」，然后按绑定决定目标：
   - `route`：取组内下一个可用模型；
   - `failover`：同样取组内下一个可用模型作为兜底；
   - 组内没有可用模型（都失败 / 不在时段 / 已过期）时不切换，只记录。
5. 切换成功即让同一轮继续；失败状态在当天结束或该会话成功完成一轮后清除。

## HTTP 接口

宿主半在 `/api/model-failover` 下提供（界面自身使用）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/status` | 分组、当日失败模型、会话绑定、默认分组、最近失败的判定日志、设置 |
| POST | `/settings` | 保存界面设置（`dialogMode`） |
| GET / POST / PUT | `/groups` | 读取 / 新建 / 更新分组 |
| DELETE | `/groups/:id` | 删除分组并解绑其会话 |
| GET / POST | `/session-group` | 读取 / 设置会话绑定（`groupId` + `mode`） |
| GET / POST | `/default-group` | 读取 / 设置新会话默认分组 |
| POST | `/failed/reset` | 恢复一个模型的失败状态 |

## 数据文件

默认放在 `$DSH_HOME/model-failover-manager/`：

| 文件 | 内容 |
| --- | --- |
| `groups.json` | 路由分组（模型、优先级、时段、截止日） |
| `session-bindings.json` | 会话 → 分组 + 模式的绑定 |
| `default-binding.json` | 新会话沿用的默认绑定 |
| `failed.json` | 按天的失败模型记录（含错误码与原因） |
| `settings.json` | 界面设置 |

## 配置

`cordis.patch.yml` 中该行可选配置：

| 键 | 说明 |
| --- | --- |
| `dataDir` | 上述数据文件的目录，默认 `$DSH_HOME/model-failover-manager` |

不配置即可正常工作。

## 仓库内容

| 文件 | 说明 |
| --- | --- |
| `host.v6.mjs` | 宿主半，也是 `package.json` 的 `main` |
| `client.js` | 浏览器半（DSH dynamic client bundle） |
| `cordis.patch.yml` | 安装用的 bundle patch |
| `locale/en.json`、`locale/zh.json` | 界面文案 |
| `icon.svg` | 图标 |
| `host.mjs`、`host.v2.mjs` … `host.v5.mjs` | 历史版本，仅作回溯保留；运行时只加载 `host.v6.mjs` |

## 已知限制

- 依赖 DSH 的 `slots`、`modelDirectories`、`sessions`、`remote`、`remote.session` 服务与 `agent/request-error` 事件；宿主接口变动时需同步跟进。
- 失败状态按「天」过期，没有更细粒度的退避或熔断。
- 换账号能力依赖 `dsh-our-free-model` 是否安装；未安装时只有分组换模型这一条路径。

## English

A DSH plugin that replaces the composer's model seat with a grouped model picker, and automatically fails over to the next usable model in the bound group once a model has exhausted every retry policy.

- Registers `conversation.input.model` with `priority: -1`, so it shadows the built-in selector (dialog mode or a compact dropdown).
- Routing groups hold an ordered model list; each model may declare active time windows (multiple segments, inclusive ends, midnight-crossing) and an expiry date.
- Two binding modes per session: `route` (use the group's models) and `failover` (keep the current model, switch only after it fails completely). Bindings persist across restarts.
- On `agent/request-error` — prepended, and only after every inner retry policy has declined — it marks the model failed for the day and continues the same turn on the next routable model.
- For models served by `dsh-our-free-model` it first tries another account, by writing a pool-level cooldown marker through that plugin's `accountPool` service; it never reads or modifies those credentials.
- Failed models are recorded per day together with the error code and latest message, and can be inspected and cleared from the dialog.

## License

Apache-2.0
