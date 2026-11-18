# pi-usage-status

A compact status-line extension for [Pi](https://github.com/earendil-works/pi). Adds provider quota information, system metrics, and a right-aligned working phase **without replacing the built-in footer**.

```text
5h: 51% used reset 1h 10m · 7d: 41% used reset 5d 11h · CPU: 23% · RAM: 9.5GB/15.3GB (62%)     Running tools
```

## Install

Requires Node.js 22.13+ and Pi. Developed with `@earendil-works/pi-coding-agent` 1.5.2.

### From GitHub

```sh
pi install git:github.com/itsomidho/pi-usage-status
```

### Without Git (release archive)

You can install a tagged release directly into Pi's auto-discovered extensions directory without cloning or using a Git repository.

Fish:

```fish
if not set -q PI_USAGE_STATUS_HOME
    set PI_USAGE_STATUS_HOME "$HOME/.pi/agent/extensions/pi-usage-status"
end
mkdir -p "$PI_USAGE_STATUS_HOME"
curl -L https://github.com/itsomidho/pi-usage-status/archive/refs/tags/v0.1.0.tar.gz \
  | tar -xz --strip-components=1 -C "$PI_USAGE_STATUS_HOME"
```

Bash/Zsh:

```sh
PI_USAGE_STATUS_HOME="${PI_USAGE_STATUS_HOME:-$HOME/.pi/agent/extensions/pi-usage-status}"
mkdir -p "$PI_USAGE_STATUS_HOME"
curl -L https://github.com/itsomidho/pi-usage-status/archive/refs/tags/v0.1.0.tar.gz \
  | tar -xz --strip-components=1 -C "$PI_USAGE_STATUS_HOME"
```

Then run `/reload` inside Pi or restart it.

**Already using the original standalone extension?** Disable or move `~/.pi/agent/extensions/usage-limits.ts` outside the extensions directory before enabling this package. Loading both copies creates duplicate timers and competing status updates.

To try the extension without installing:

```sh
pi -e git:github.com/itsomidho/pi-usage-status
```

## Features

- **5h / 7d quotas:** percentage consumed and time until reset, when a compatible provider supplies data.
- **Quota colors:** muted below 33%, theme `warning` from 33%, and theme `error` from 66%. Only the percentages change color.
- **CPU:** system-wide utilization sampled between updates.
- **RAM:** used/total memory and percentage, based on Node's OS memory statistics. Values use binary units despite the compact GB label; reclaimable caches may count as used.
- **Load:** one-minute OS load average, not a CPU percentage.
- **Session age:** wall-clock time since the session header timestamp, surviving reload/resume and including time while closed.
- **Working phase:** static `Thinking` / `Running tools` on the right, hidden when Pi settles. Uses the existing Pi spinner, not another animation.
- **Responsive layout:** omits load and session age when space is tight; very narrow terminals truncate remaining metrics.
- **Core footer untouched:** context usage remains in Pi's own footer, avoiding a duplicate CTX display.

Metrics/countdowns refresh every five seconds. Provider usage is requested at most once per minute per extension instance, with an immediate attempt on model changes. Requests time out after eight seconds. Old quota values expire after 68 seconds without fresh data; failed refreshes clear quota data. No notifications are shown for unavailable quota data.

## Provider support and security

The extension requests `${resolvedProviderBaseUrl}/wham/usage` using Pi-resolved authentication for the active provider. OpenAI Codex's endpoint has been verified to return the rolling windows; arbitrary proxies/providers may not support it. An OpenAI-compatible chat API alone does **not** guarantee quota support. The parser accepts primary/secondary windows, including those nested under `rate_limit`.

Quota windows are interpreted as 5h/7d. Use with providers whose primary/secondary windows have those meanings. This is not a universal quota API, and the Codex endpoint may change.

Credentials stay in memory and are sent only to the configured provider endpoint; HTTP redirects are rejected. The extension does not write credentials or session content to disk or log them. No model-generation request is needed to retrieve usage. Pi extensions run with your user account's permissions: review source before installing.

If quota information is unavailable, system metrics still appear. Optional UI/network failures are caught silently. Right alignment uses the terminal's reported width and may be affected by other extensions sharing the status row.

## Development

```sh
git clone https://github.com/itsomidho/pi-usage-status.git
cd pi-usage-status
npm test
pi -e ./extensions/usage-limits.ts
```

Pi supplies the declared peer packages at runtime; there are no bundled runtime dependencies. `npm test` checks TypeScript syntax only. Test the live UI by sending a prompt and observing the phase label, then resizing the terminal. Avoid loading a standalone copy and this package simultaneously.

## Uninstall

```sh
pi remove git:github.com/itsomidho/pi-usage-status
```

Run `/reload` afterward.
