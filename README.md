<div align="center">

<img src="docs/logo.png?v=1" width="128" alt="dsh-herdr-site logo"/>

# dsh-herdr-site

**Teach Herdr to speak dsh.**

No more opaque black-box terminals for your dsh/cc-tui panes — `working`,
`idle`, and `blocked` land in Herdr in real time, with panel jump and `--wait`
along for the ride. And the moment the model stops to wait for *your* call,
you'll see it.

[English](./README.md) | 简体中文

`v0.1.0` · `MIT` · `DSH profile plugin`

</div>

---

## 💡 Why

> [Herdr](https://herdr.dev) ([GitHub: herdrdev/herdr](https://github.com/herdrdev/herdr))
> is a terminal workspace manager for AI coding agents: it brings agent panes
> together with a state overview, panel jumps, and `--wait` orchestration — and
> it is strict about what counts as an agent.

- **Herdr only trusts its bundled detectors**: opencode, claude, codex are on
  the list — dsh/cc-tui is not. Your agent pane shows up as a plain terminal
  process: no state, no panel jump, no waiting support.
- **Two states aren't enough**: dsh's `agent/status` is just running/idle, so
  the most important moment — the model parked on an `ask_user_question`
  waiting for you — displays as `working`. Busy-looking, actually stuck on you.
- **The goal**: your dsh agent sits in Herdr's pane/agent lists like a
  first-class citizen, and lights up `blocked` the instant it needs a human.

## 👀 See it live

Everything below was captured from one real run — nothing hand-drawn.

**Full lifecycle recording** (captured with [asciinema](https://asciinema.org),
18s GIF) — `working` while the turn drives, flips to `blocked` when the model
parks on an `ask_user_question`, recovers after the human answers:

![lifecycle recording](docs/herdr-lifecycle.gif)

The plugin reports its lifecycle to Herdr. termshot-rendered command output
records the full state machine: `working` while a turn drives → flips to
`blocked` when the model parks on an `ask_user_question` → recovers after the
human answers.

**Turn in progress** — `herdr agent list`, the cc-tui pane shows `working`:

![working state](docs/agents-live-working.png)

**Waiting on the human** — `herdr agent get`, flipped to `blocked`:

![blocked state](docs/agents-live-blocked.png)

First-class recognition means Herdr's panel jump and `--wait` work for dsh too.
The moment the model parks on an `ask_user_question`, the pane lights up as
`blocked` (optionally with your `blockMessage`) — precisely when it most needs
to be seen.

## ✨ Features

### Precise state mapping

| dsh signal                                     | Herdr state |
|------------------------------------------------|-------------|
| `agent/status = running` (driving a turn)      | `working`   |
| `agent/status = idle` (no driver active)       | `idle`      |
| `ask_user_question` open (model waits on human)| `blocked`   |

### 🚦 The blocked lift — the whole point

dsh natively has two states; Herdr has three. "Waiting for user input" is
precisely the state worth spotlighting: this plugin derives it from the
**durable session event stream** (`ask_user_question` `tool/call` /
`tool/result`) and lifts `running → blocked` — replay-safe, no UI-provider
hooks required, with an optional `blockMessage` that puts the reason right on
the Herdr pane.

### 🧱 Restrained engineering

- 🙈 **Strict no-op outside Herdr**: outside a Herdr pane nothing is spawned,
  nothing is read
- 🔁 **Replay-safe**: blocked tracking keyed by `callId`; out-of-order and
  replayed event streams stay consistent
- 📶 **Monotonic seq + dedup**: repeated states never spam; stale reports are
  dropped by Herdr
- 🧹 **Clean exit**: `pane release-agent` on fiber disposal — no stale entries

Protocol per the [official herdr docs — Integrate your own agent](https://herdr.dev/docs/integrations/):

```
"$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" \
  --source custom:dsh-herdr-site --agent cc-tui --state <working|idle|blocked> \
  [--message …] [--seq N]
…and `pane release-agent` on fiber disposal.
```

## 📦 Install

Prerequisite: a working [dsh](https://github.com/deepseek-ai/deepseek-harness)
installation with the `dsh-cc-tui`/`dsh-base` profile — this plugin declares
the profile's packages (`@deepseek-ai/cordis` at `^4`, `dsh-session`,
`dsh-agent`) as peer dependencies, supplied by the host profile.

```bash
dsh plugin --profile cc-tui add git+http://192.168.4.77:3000/dsh-plugins/dsh-herdr-site.git
```

The package declares a `dsh.bundle.patch` manifest, so the installer adds it to
the profile's bundle layer stack automatically — the bundled
`cordis.patch.yml` inserts the plugin into every surface the profile boots.
Repeat for any other profile you use (e.g. `dsh-tui`).

Verify:

```bash
dsh --profile cc-tui --dump-config | grep -A2 herdr-site
```

Installing from a local checkout works too:
`dsh plugin --profile cc-tui add /path/to/dsh-herdr-site`

## ⚙️ Configure

Optional `blockMessage` override, sent with the `blocked` report:

```yaml
# in the profile's cordis.patch.yml, or a --patch overlay
- id: herdr-site
  config:
    blockMessage: '模型等待你的回答'
```

## 🔨 Build & test

```bash
npm install            # dev: @types/node
npm run build          # emits lib/
npm test               # behavioral assertions against a stub herdr CLI
npx tsc --noEmit       # type check
```

Git installs need no build step: `lib/` is committed — pnpm blocks `prepare`
scripts by default, so depending on an install-time build would break installs
out of the box.

`test/smoke.mjs` drives the compiled plugin through the full lifecycle on a
real cordis context — working/blocked/idle transitions, dedup, seq ordering,
unrelated tool results, release-on-dispose — asserting every emitted CLI
invocation against a stub `herdr` binary.

## 🛠️ Local development notes

Developing against live profiles with a plain `file:` dependency has two
gotchas (both hit in practice):

1. A `file:` dep copies content at install time — re-run `pnpm install` in the
   profile after every rebuild, or the profile keeps running the stale copy.
2. With the dependency installed as a bundle layer *and* a manual insert row,
   bare-name activation was observed to be silently skipped; pointing the
   insert row's `name:` at the absolute `lib/index.js` path is the reliable
   dev-only wiring:

   ```yaml
   - insert:
       - id: herdr-site
         name: '/absolute/path/to/dsh-herdr-site/lib/index.js'
         config: {}
   ```

   If you take this route, also remove the package from the profile's
   `dsh.profile.bundles` list so the two inserts don't conflict.

Neither applies to the standard `dsh plugin add` flow described under Install,
which resolves the bundled patch's bare package name correctly.

## ⚠️ Limitations

- Herdr's *automatic process detection* still won't recognize a dsh process as
  an agent on its own (that needs a Herdr-bundled detector update). This
  plugin reports state, which is what Herdr's custom-integration path covers;
  combined with detectorless custom reporting, Herdr shows correct
  working/idle/blocked, panel jump, and wait.
- The optional `--agent-session-id` reference is not wired, so Herdr's
  pane/agent APIs don't expose the linked dsh session id. Automatic session
  restore additionally requires Herdr to know how to launch dsh — not covered
  here. State reporting is the unconditional win either way.

## 📄 License

[MIT](./LICENSE)
