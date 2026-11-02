# Model Failover Manager

Replaces the composer's model seat with a grouped model picker that fails over to the next usable model once one has exhausted every retry.

One install brings two pieces: it depends on [dsh-llm-error-retry](https://github.com/liaoyuqing/dsh-llm-error-retry) and embeds that plugin's configuration page as a dialog tab, so retry rules are edited in one place.

## The dialog

![Models tab](preview-model-selection.png)

Six tabs, ordered the way you actually triage:

| Tab | What it does |
| --- | --- |
| **Models** | Providers on the left, models on the right; add one to a group with ＋. The top bar picks the routing group, the binding mode, and the new-session default. |
| **Routing groups** | Each group is an ordered model list (lower priority number goes first), with active time windows, an expiry date, and per-model failed/disabled switches. Move a model up or down in place, or remove it from the group. |
| **Dashboard** | First-token latency, output speed, token usage, live concurrency and success rate per model; one-click speed tests and re-prioritising by the current sort. |
| **Failed models** | Today's exhausted models with the latest failure reason; restore one or all. |
| **Error retry** | dsh-llm-error-retry's own configuration page: rules, first-token timeout, Retry-After cap, max continuations. Saving applies immediately. |
| **Free channels** | Six plugins that add free models — Our Free Model / CodeArts / WorkBuddy / Trae / Qoder / Providers Hub — with a copyable GitHub address and one-click install; Our Free Model comes first and Providers Hub last. |

![Routing groups tab](preview-routing-groups.png)

![Dashboard tab](preview-dashboard.png)

![Failed models tab](preview-failed-models.png)

![Error retry tab](preview-error-retry.png)

## Install

```sh
dsh plugin add https://github.com/liaoyuqing/model-failover-manager
```

This also installs `dsh-llm-error-retry` (a pinned dependency). Restart DSH afterwards and the model seat becomes the dialog; turn the dialog off in **Settings → Model Failover** to get the compact dropdown back.

Requires DSH `>=0.2.1-0 <0.3.0` (pre-releases such as rc/alpha included).

## What it solves

- **A failure no longer interrupts you.** Inner retry policies run first; once they all decline, the plugin records the model as failed for the day, switches to the next routable model in the group, and continues the same turn on its own — no manual resend.
- **Accounts and models are handled separately.** Our Free Model channels try another account first and only then switch models; a CodeArts pool poisoned by 401/403 is restarted through its own loader entry.
- **State is visible.** Which model failed today and why, first-token latency, concurrency, success rate — all on the dashboard, no log digging.
- **Free channels install in one click.** Our Free Model, CodeArts, WorkBuddy, Trae, Qoder and Providers Hub install from the tab through the same engine the plugin market uses.

## Free channels tab

![Free channels tab: Our Free Model first](preview-free-channels.png)

Each recommendation adds a few models you can run without paying. The card order is fixed, with Our Free Model on top — the only one that needs neither a login nor an API key — and Providers Hub last:

- **Our Free Model** (`dsh-our-free-model`): a no-login, no-API-key channel including DeepSeek V4.1 Flash and Kimi K3, which also routes Trae and Qoder accounts since 2.0.
- **CodeArts** (`dsh-codearts`): models bundled with a Huawei Cloud CodeArts account, with built-in OAuth2 login (PKCE + DPoP).
- **WorkBuddy** (`dsh-connect-workbuddy`): the WorkBuddy account already signed in on this machine (domestic / international), with per-model rate multipliers, account switching and daily check-in.
- **Trae** (`dsh-connect-trae`): the Trae desktop account already signed in on this machine; domestic, enterprise and international each register a provider, with daily check-in and credit readouts.
- **Qoder** (`@dmh2002/dsh-connect-qoder`): a Qoder account's model quota through a single PAT, with a multi-account pool and automatic switching; domestic and international can run side by side.
- **Providers Hub** (`dsh-providers-hub`, formerly `dsh-codearts-auth`): the accounts of more than twenty free channels through one plugin — Huawei Cloud CodeArts, Tencent CodeBuddy, Youdao LobsterAI, Qoder, TRAE, Cline, MiniMax, Zhipu ZCode, Gemini, Accio, iFlytek AStudio and others; one login puts that channel's models in the model list, with a multi-account pool, silent renewal and a local OpenAI-compatible gateway.

Three separate facts per card: **installed** (read from the profile dependencies), **providers online** (read from the live `llm` registry), and the **GitHub address** (one click to copy). A channel that is installed but not logged in therefore never reads as "not installed".

Trae and Qoder are dedicated connectors whose provider ids overlap with the ones the aggregators register for the same accounts: an installed connector owns them, an absent one leaves them to the aggregators, so no id is counted twice and none disappears. Providers Hub is the second aggregator: a claim goes to a dedicated connector (`codearts`, `workbuddy`, `trae`, `qoder`) first, then to the aggregators in card order — Our Free Model before Providers Hub — so Our Free Model keeps the bulk and Providers Hub gets only what nobody claimed. Its own provider pattern leaves out `codearts` and `workbuddy`, so those ids stay on their dedicated cards.

The install button calls the host's `pluginManager.installBundle` — the same path as the plugin market and `dsh plugin add`. When a package needs its install scripts approved the tab reports the pending builds and never approves on your behalf. Installed channels show up in the Models tab and can join a routing group like any other model.

Providers Hub installs under the spec `dsh-providers-hub`, the name the plugin market lists it under (its GitHub address points at the upstream `iJetLi/dsh-providers-hub` repository; the market page offers a GitHub-source command, while the tab uses the npm package of the same name). The package was renamed from `dsh-codearts-auth` at 0.2.0-rc.11 and both npm names are published at the same version; a profile that still has the old name installed is reported as installed and needs no reinstall.

Install specs are registry package names on purpose: a `github:` source pulls a whole-repository tarball (83 MB for Our Free Model) that pnpm re-fetches on every profile install, which is what drags the market's own updates past their timeout on a slow GitHub day.

## Full documentation

Configuration keys, the `/api/model-failover` endpoints, the failover decision order, and the qoder compression shim (including how to tell whether compression is actually happening) are documented in the repository [README](README.md).
