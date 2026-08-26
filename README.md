# dsh-herdr-site

English | [简体中文](./README.zh.md)

DeepSeek Harness → [Herdr](https://herdr.dev) custom-agent integration.

Herdr treats a pane as a coding agent only when that agent is in its bundled
detector list (opencode, claude, codex, …) **or** when it actively reports
lifecycle state through the documented third-party protocol
(`pane report-agent`). dsh/cc-tui is *not* in Herdr's list, so without this
plugin Herdr shows a dsh/cc-tui pane as an opaque terminal process — no
working/idle/blocked state, no panel jump, no `--wait` support.

This plugin closes that gap. It is a no-op outside Herdr.

## What it reports

| dsh signal                                    | Herdr state |
|-----------------------------------------------|-------------|
| `agent/status = running` (driving a turn)     | `working`   |
| `agent/status = idle` (no driver active)      | `idle`      |
| `ask_user_question` tool open (model waits on the human) | `blocked` |

The `blocked` lift matters: dsh exposes only `idle`/`running` for
`agent/status`, and while `ask_user_question` is parked the model is still
`running`. Without the lift Herdr would show `working` even though the agent
genuinely needs a human decision. We derive it from the durable session event
stream (`tool/call` / `tool/result` of `ask_user_question`), so it survives
replay and needs no UI-provider hook.

Protocol used (per [herdr docs — Integrate your own agent](https://herdr.dev/docs/integrations/)):

```
"$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" \
  --source custom:dsh-herdr-site --agent cc-tui --state <working|idle|blocked> \
  [--message …] [--seq N]
...and `pane release-agent` on fiber disposal.
```

## How it works

A Cordis plugin (`dsh-herdr-site`) wired into the profile:

1. **No-op guard** — returns immediately unless `HERDR_ENV=1` and a pane id is
   present. Nothing is spawned or read outside Herdr panes.
2. **Agent status** — subscribes to the session surface via `session/event`
   (`agent/status`), mapping `running → working`, `idle → idle`.
3. **Blocked lift** — tracks in-flight `ask_user_question` `tool/call` entries;
   while one is open any `running` reports as `blocked`. The list is keyed by
   `callId` and drained on the matching `tool/result`, so out-of-order or
   replayed events stay consistent.
4. **Dedup & ordering** — each pane keeps a monotonic `--seq`; duplicate states
   are suppressed so we do not spam Herdr.
5. **Release** — on fiber disposal it calls `pane release-agent`, so Herdr does
   not keep a stale agent entry.

## Install

Prerequisite: a working [dsh](https://github.com/deepseek-ai/deepseek-harness)
installation with the `dsh-cc-tui`/`dsh-base` profile — this plugin declares
the profile's packages (`@deepseek-ai/cordis` at `^4`, `dsh-session`,
`dsh-agent`) as peer dependencies, supplied by the host profile.

### From git

```bash
dsh plugin --profile cc-tui add git+http://192.168.4.77:3000/dsh-plugins/dsh-herdr-site.git
```

Because the package declares a `dsh.bundle.patch` manifest, the installer adds
it to the profile's bundle layer stack automatically — its bundled
`cordis.patch.yml` inserts the plugin into every surface the profile boots.
Repeat with any other profile you use (e.g. `dsh-tui`).

Verify it is active:

```bash
dsh --profile cc-tui --dump-config | grep -A2 herdr-site
```

### From a local checkout

Any local path works too, e.g. after cloning:

```bash
dsh plugin --profile cc-tui add /path/to/dsh-herdr-site
```

## Configure

Optional `blockMessage` override sent with the `blocked` report:

```yaml
# in the profile's cordis.patch.yml, or a --patch overlay
- id: herdr-site
  config:
    blockMessage: '模型等待你的回答'
```

## Build

```bash
npm install            # dev: @types/node
npm run build          # emits lib/
```

Note for git installs: `lib/` is committed, so installing from git needs no
build step — pnpm blocks `prepare` scripts by default, and requiring one here
would make installs fail out of the box.

## Test

```bash
npm run build          # smoke test runs against lib/
npm test               # behavioral assertions against a stub herdr CLI
npx tsc --noEmit       # type check
```

`test/smoke.mjs` drives the compiled plugin through the full lifecycle on a
real cordis context — working/blocked/idle transitions, dedup, seq ordering,
unrelated tool results, and release-on-dispose — asserting every emitted CLI
invocation against a stub `herdr` binary.

## Local development notes

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

## Limitations

- Herdr *automatic process detection* still won't recognize a dsh process as
  an agent on its own (that needs a Herdr-bundled detector update). This
  plugin reports state, which is what Herdr's custom-integration path covers;
  combined with detectorless custom reporting, Herdr shows correct
  working/idle/blocked, panel jump, and wait.
- The optional `--agent-session-id` reference is not wired, so Herdr's pane/agent
  APIs don't expose the linked dsh session id. Automatic session restore
  additionally requires Herdr to know how to launch dsh — not covered here.
  State reporting is the unconditional win.

## License

[MIT](./LICENSE)
