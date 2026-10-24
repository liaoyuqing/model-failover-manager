# model-failover-manager

DSH 插件：把 composer 的模型选择位换成带「路由分组」的选择弹窗，并在模型彻底失败后自动切换到组内下一个可用模型。

> 界面里叫「模型故障转移」。设置入口：**设置 → 模型故障转移**。

![模型选择界面：左侧供应商列表，右侧「模型 / 路由分组 / 失败模型」三个页签与路由分组选择](docs/preview-model-selection.png)

![路由分组界面：已绑定「免费」分组、37 个模型按优先级排列，每个模型带失败与禁用开关](docs/preview-routing-groups.png)

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
- **失败后自动续跑**：监听 `agent/request-error`，以 prepend 注册并先 `await next()`，因此**一定是在所有重试策略都表态放弃之后**才接手（包括 `llm-error-retry` 预算耗尽后直接短路整条链的情况）。接手后标记失败、切换到组内下一个可用模型，并自动续跑，不用你重发。
  - 续跑不是「同一轮内重试」：新版 dsh 在**步骤准备（pre-step）**时就把本步用于请求的 `provider/model/effort` 固定下来，`agent/request` 已废弃，在那里改模型会让宿主直接报错并让整轮崩掉。所以失败后切换走 `agent.model.select()`（写一条 durable `model/selection`，从下一个步骤生效），并在该会话回到 `idle` 后补一条续跑消息开下一轮。
- **每轮健康检查**：每次发消息（驱动器刚启动、尚未进入 `pre-step` 的窗口）都判定一次「这个会话此刻要用的模型现在还能不能用」——仍可用就保留（不覆盖你手选的模型），只有它此刻在分组内不可用（被标记当日失败、超出北京时间时段、过了截止日）才切到组内下一个可用模型；当前模型压根不在分组里时不插手。判据都是「此刻」的，时段与截止日随时间变化、失败标记会被重置或过期。
- **子代理继承路由（默认行为）**：「子代理跑什么模型」由宿主在创建时决定——它把父会话请求头里的 `provider/model/effort` 复制成子代理的 AgentOptions。本插件**不写任何选择去覆盖它**，所以子代理天然继承父会话当前实际在用的模型（父会话切到组内第 2 个，子代理也跑第 2 个，不会被拽回第 1 个）。分组绑定同样沿 `session.header.parentSession` 向上继承；只有继承来的模型此刻不可路由（已失败/不在时段/过截止日）时才按组内优先级换一个。
- **子代理可单独选模型/分组**：子代理会话的资源位里同样能换模型、绑分组，选中即只作用于该子代理（走 `agent.model.select()`，不经宿主对子代理一律拒绝的 `sessionController.selectModel`）；它的分组选择不参与「新会话默认分组」。
- **默认分组**：新会话（startup/clear）自动沿用上次的选择（分组 + 模式）；`resume` / `compact` 不动，尊重旧会话既有选择。
- **在分组里直接停用模型**：路由分组页签里每个模型块都带两个开关——「失败」把它标记为当日失败（与自动失败共用同一份记录：日界线到期、会话成功一轮、或点「恢复」都会解除，`code=MANUAL`），「禁用」则把它**持久**挡在所有分组之外（写进分组条目的 `disabled` 字段，不随日期恢复，只由你手动「启用」解除）。两者互不覆盖：`routable()` 先判禁用再判失败。
- **失败模型记录**：按「使用日」记录失败模型（北京时间，日界线默认早上 8:00，见 `failResetHour`），同时保存失败原因（错误码 + 最近一次错误信息）。在弹窗的「失败模型」页签里可展开查看原因，也可逐个或一键全部恢复。到日界线自动过期；会话成功完成一轮也会立即恢复对应模型。所有时间口径固定按北京时间计算，与宿主机时区无关。
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
      name: ./plugins/model-failover-manager/host.v7.mjs
```

### DSH 版本要求

`package.json` 用 `engines.dsh` 声明兼容范围（当前 `>=0.2.1-0 <0.3.0`，含 rc/alpha 等预发布）。DSH 的插件管理与装载按它校验：运行时版本不落在范围内会拦下安装/激活并给出诊断；确需强装用 `dsh plugin allow-version` 对该 `name@version` + 精确运行时版本放行。宿主接口（`slots`、`modelDirectories`、`agent/request-error` 等）变动时同步更新此范围。


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
5. 切换成功即让同一轮继续；失败状态在日界线（默认北京时间 08:00）过后清除，该会话成功完成一轮时也会立即清除。

## HTTP 接口

宿主半在 `/api/model-failover` 下提供（界面自身使用）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/status` | 分组、当日失败模型、会话绑定、默认分组、最近失败的判定日志、设置、`failResetHour` |
| POST | `/settings` | 保存界面设置（`dialogMode`） |
| GET / POST / PUT | `/groups` | 读取 / 新建 / 更新分组 |
| DELETE | `/groups/:id` | 删除分组并解绑其会话 |
| GET / POST | `/session-group` | 读取 / 设置会话绑定（`groupId` + `mode`） |
| GET / POST | `/default-group` | 读取 / 设置新会话默认分组 |
| POST | `/failed/mark` | 手动把某个模型标成当日失败（`code=MANUAL`） |
| POST | `/failed/reset` | 恢复一个模型的失败状态 |
| POST | `/groups/model-disabled` | 禁用/启用某个模型参与路由（写 `disabled` 字段，覆盖所有含它的分组） |
| GET | `/session-info?sessionId=` | 单个会话解析后的有效分组、是否继承、当前模型覆盖 |
| POST | `/session-model` | 直接给某个会话定模型（子代理会话只能走这条路） |
| GET | `/debug/sessions` | 只读诊断：列出活会话的 header、覆盖、绑定与继承解析结果 |
| GET | `/debug/status-log?sessionId=&limit=` | 只读诊断：最近 200 条运行态事件（`agent/status`、转发给界面的 `api-session/status`、续跑排队与投递），带自增 `seq` 与毫秒时间戳 |

## 数据文件

默认放在 `$DSH_HOME/model-failover-manager/`：

| 文件 | 内容 |
| --- | --- |
| `groups.json` | 路由分组（模型、优先级、时段、截止日） |
| `session-bindings.json` | 会话 → 分组 + 模式的绑定 |
| `default-binding.json` | 新会话沿用的默认绑定 |
| `failed.json` | 按使用日（默认北京时间 8:00 为界）记录的失败模型（含错误码与原因） |
| `settings.json` | 界面设置 |

## 配置

`cordis.patch.yml` 中该行可选配置：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/model-failover-manager` | 上述数据文件的目录 |
| `failResetHour` | `8` | 「当日失败」的日界线小时（北京时间整点，0..23）；到点自动清除失败标记。改值后配置变化会让 Loader 重新应用，无需重启 |

所有时间口径固定按**北京时间**计算，与宿主机时区、`TZ`、`LANG` 无关。路由时段（`windows` 的 `from`/`to`）的小时也按北京时间解释；截止日 `until` 按自然日比较。

不配置即可正常工作。

## 仓库内容

| 文件 | 说明 |
| --- | --- |
| `host.v9.mjs` | 宿主半，也是 `package.json` 的 `main` |
| `client.js` | 浏览器半（DSH dynamic client bundle） |
| `cordis.patch.yml` | 安装用的 bundle patch |
| `locale/en.json`、`locale/zh.json` | 界面文案 |
| `icon.svg` | 图标 |
| `host.mjs`、`host.v2.mjs` … `host.v7.mjs` | 历史版本，只留在仓库里供回溯；不进 tarball，运行时只加载 `host.v9.mjs` |

## 已知限制

- 依赖 DSH 的 `slots`、`modelDirectories`、`sessions`、`remote`、`remote.session` 服务与 `agent/request-error` 事件；宿主接口变动时需同步跟进。
- 失败状态到日界线（默认北京时间 8:00）统一过期，没有按失败原因分级退避或熔断；同一使用日内失败得越早、被挡得越久。
- 换账号能力依赖 `dsh-our-free-model` 是否安装；未安装时只有分组换模型这一条路径。

## English

A DSH plugin that replaces the composer's model seat with a grouped model picker, and automatically fails over to the next usable model in the bound group once a model has exhausted every retry policy.

- Registers `conversation.input.model` with `priority: -1`, so it shadows the built-in selector (dialog mode or a compact dropdown).
- Routing groups hold an ordered model list; each model may declare active time windows (multiple segments, inclusive ends, midnight-crossing) and an expiry date.
- Two binding modes per session: `route` (use the group's models) and `failover` (keep the current model, switch only after it fails completely). Bindings persist across restarts.
- On `agent/request-error` — prepended, and only after every inner retry policy has declined — it marks the model failed for the current day and continues the same turn on the next routable model.
- For models served by `dsh-our-free-model` it first tries another account, by writing a pool-level cooldown marker through that plugin's `accountPool` service; it never reads or modifies those credentials.
- Failed models are recorded per day together with the error code and latest message, and can be inspected and cleared from the dialog.
- Every date and hour is computed in Beijing time (`Asia/Shanghai`), independent of the host's timezone, `TZ` and `LANG`. The fail-over day boundary defaults to 08:00 and is configurable through `failResetHour`.

## License

Apache-2.0
