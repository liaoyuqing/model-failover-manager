# 模型故障转移管理

把 composer 的模型选择位换成带**路由分组**的选择弹窗，并在模型彻底失败（所有重试都放弃）后自动切到组内下一个可用模型。

一次安装带两件：依赖 [dsh-llm-error-retry](https://github.com/liaoyuqing/dsh-llm-error-retry)，并在弹窗里内嵌它的配置页 —— 重试规则不用另开一个界面改。

## 界面

![模型页签](preview-model-selection.png)

弹窗有六个页签，按你排障时的动线排列：

| 页签 | 做什么 |
| --- | --- |
| **模型** | 左栏供应商、右栏模型，点 ＋ 加进分组；顶部选路由分组、绑定模式，以及「新会话默认」 |
| **路由分组** | 每组一份有序模型清单（数字越小越先试），可配生效时段与截止日，就地 ↑ ↓ 调优先级、✕ 移出分组，逐个开关「失败」「禁用」 |
| **数据看板** | 每个模型的首字延迟、输出速度、token 用量、并发现场、成功率；可一键测速、按当前排序重设优先级 |
| **失败模型** | 当日彻底失败的模型与最近一次失败原因，逐个或一键全部恢复 |
| **错误重试** | 内嵌 dsh-llm-error-retry 自己的配置页：规则、首字超时、Retry-After 上限、最大续写，保存即生效 |
| **免费渠道** | CodeArts / WorkBuddy / Our Free Model 三个能直接补免费模型的插件，带 GitHub 地址（一键复制）与一键安装 |

![路由分组页签](preview-routing-groups.png)

![数据看板页签](preview-dashboard.png)

![失败模型页签](preview-failed-models.png)

![错误重试页签](preview-error-retry.png)

## 安装

```sh
dsh plugin add https://github.com/liaoyuqing/model-failover-manager
```

这一条会把 `dsh-llm-error-retry` 一起装上（它在 `dependencies` 里，固定到具体 commit）。装完重启 DSH，模型位就会变成弹窗；不想用弹窗可以在 **设置 → 模型故障转移** 里关掉，退回紧凑下拉。

要求 DSH `>=0.2.1-0 <0.3.0`（含 rc/alpha 等预发布）。

## 它解决什么

- **失败不再打断你**：一次失败，内层重试先按规则重试；全都放弃后本插件标记该模型当日失败、切到组内下一个可用模型，并自动续跑当前这一轮 —— 不用手动重发。
- **账号和模型分开处理**：Our Free Model 的渠道先尝试换账号，账号试完才换模型；CodeArts 池被 401/403 打成「无可用账号」时自动重启它自己的 Loader 条目自救。
- **状态看得见**：哪个模型今天失败过、为什么失败、首字多慢、并发多少、成功率如何，都在看板里，不用翻日志。
- **免费渠道一步装上**：CodeArts、WorkBuddy、Our Free Model 三个插件在页签里直接安装，走的是插件市场同一个引擎。

## 免费渠道页签

![免费渠道页签](preview-free-channels.png)

三个推荐渠道都能让模型列表多出几条可以白跑的模型：

- **CodeArts**（`dsh-codearts`）：华为云 CodeArts 账号自带的模型额度，内置 OAuth2 登录（PKCE + DPoP）。
- **WorkBuddy**（`dsh-connect-workbuddy`）：本机已登录的 WorkBuddy 账号（国内版 / 国际版），按上游目录读积分倍率，支持换号与每日签到。
- **Our Free Model**（`dsh-our-free-model`）：不登录、不填 API Key 的免费通道，含 DeepSeek V4.1 Flash、Kimi K3 等。

卡片上三件事分开写清楚：**装没装**（读 profile 依赖）、**在线渠道**（读当前 llm 注册表）、**GitHub 地址**（一键复制）。所以「装了但没登录」不会显示成「没装」。

安装按钮调的是宿主的 `pluginManager.installBundle` —— 与插件市场、`dsh plugin add` 同一条路径。需要批准构建脚本时只回报待批准项，**不代批**。装好之后它们的模型会出现在「模型」页签里，排进路由分组即可参与失败切换。

## 完整文档

配置项、`/api/model-failover` 接口、失败切换的判定顺序、qoder 压缩 shim 的取舍与排障方法，见仓库里的 [README](README.md)。
