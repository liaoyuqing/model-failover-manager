# Model Failover Manager

Replaces the composer's model seat with a grouped model picker that fails over to the next usable model once one has exhausted every retry.

One install brings two pieces: it depends on [dsh-llm-error-retry](https://github.com/liaoyuqing/dsh-llm-error-retry) and embeds that plugin's configuration page as a dialog tab, so retry rules are edited in one place.

## The dialog

![Model picker dialog](preview-model-selection.png)

Six tabs:

| Tab | What it does |
| --- | --- |
| Models | Providers on the left, models on the right; add one to a group with ＋. The top bar picks the group and shows the new-session default. |
| Routing groups | Each group is an ordered model list, with active time windows, an expiry date, and per-model failed/disabled switches. |
| Dashboard | First-token latency, output speed, token usage, live concurrency and success rate per model, plus one-click speed tests and re-prioritising by the current sort. |
| Failed models | Today's failures with error code and upstream message; restore one or all. |
| Error retry | dsh-llm-error-retry's own configuration page (rules, first-token timeout, Retry-After cap, max continuations); saving applies immediately. |
| Free channels | Three plugins that add free models — CodeArts / WorkBuddy / Our Free Model — with a copyable GitHub address and one-click install. |

![Routing groups tab](preview-routing-groups.png)

![Free channels tab](preview-free-channels.png)

## Install

```sh
dsh plugin add https://github.com/liaoyuqing/model-failover-manager
```

This also installs `dsh-llm-error-retry` (a pinned dependency). Restart DSH afterwards and the model seat becomes the dialog; turn the dialog off in **Settings → Model Failover** to get the compact dropdown back.

Requires DSH `>=0.2.1-0 <0.3.0` (pre-releases such as rc/alpha included).

## Free channels

Each recommendation adds a few models you can run without paying:

- **CodeArts** (`dsh-codearts`): models bundled with a Huawei Cloud CodeArts account, with built-in OAuth2 login (PKCE + DPoP).
- **WorkBuddy** (`dsh-connect-workbuddy`): the WorkBuddy account already signed in on this machine (domestic / international), with per-model rate multipliers, account switching and daily check-in.
- **Our Free Model** (`dsh-our-free-model`): a no-login, no-API-key channel including DeepSeek V4.1 Flash and Kimi K3.

The install button calls the host's `pluginManager.installBundle` — the same path as the plugin market and `dsh plugin add`; when a package needs its install scripts approved the tab reports it and never approves on your behalf. Installed channels show up in the Models tab and can be added to a routing group like any other model.

## Full documentation

Configuration keys, the `/api/model-failover` endpoints, the failover decision order, and the qoder compression shim are documented in the [README](README.md).
