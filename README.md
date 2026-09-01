<div align="center">

# dsh-herdr-site

Reports dsh/cc-tui agent state to [Herdr](https://herdr.dev).

[English](./README.md) | 简体中文

`v0.1.0` · `MIT` · `DSH profile plugin`

</div>

---

## What it does

Herdr is a terminal workspace manager for AI coding agents. It only recognizes
agents found by its built-in detectors (opencode, claude, codex, ...);
dsh/cc-tui is not on that list, so a dsh pane shows up in Herdr as a plain
terminal process — no state, no panel jump, no `--wait` support.

This plugin reports the dsh agent's state to Herdr over the official
custom-integration protocol (`pane report-agent` / `pane release-agent`):

- `working` while a turn is running
- `idle` when no driver is active
- `blocked` when the model is parked on an `ask_user_question`, waiting for input

dsh itself only reports running/idle, so the `blocked` state is the main reason
to use this plugin: the moment the model waits on you shows up in Herdr instead
of looking like it's busy. It is derived from the session event stream
(`ask_user_question` `tool/call` / `tool/result`), keyed by `callId`, so
replayed or out-of-order events stay consistent.

With state reported this way, Herdr's panel jump and `--wait` also work for dsh
panes. An optional `blockMessage` can be attached to the `blocked` report to
show why the agent is waiting.

## Demo

Lifecycle recording (captured with [asciinema](https://asciinema.org)): the
pane shows `working` while a turn runs, flips to `blocked` when the model stops
on an `ask_user_question`, and recovers once the answer is given.

![lifecycle recording](docs/herdr-lifecycle.gif)

## State mapping

| dsh signal                                     | Herdr state |
|------------------------------------------------|-------------|
| `agent/status = running` (turn in progress)    | `working`   |
| `agent/status = idle` (no active driver)       | `idle`      |
| `ask_user_question` pending (model waits for input) | `blocked` |

## How it reports

State reports go through Herdr's custom integration protocol:

```
"$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" \
  --source custom:dsh-herdr-site --agent cc-tui --state <working|idle|blocked> \
  [--message …] [--seq N]
```

`pane release-agent` is called when the fiber is disposed, so no stale entries
remain. Reports carry a monotonic sequence number and repeated states are
deduplicated. Outside a Herdr pane the plugin is a no-op: nothing is spawned,
nothing is read.

## Compatibility

- **Herdr**: uses the official custom-integration protocol
  ([Integrate your own agent](https://herdr.dev/docs/integrations/)), tested
  against [herdrdev/herdr](https://github.com/herdrdev/herdr) **v0.8.0**. Any
  version that implements `pane report-agent` / `pane release-agent` works.
- **DSH**: works with both the `cc-tui` and `dsh-tui` profiles — the plugin
  only hooks the session event bus and is independent of the surface.

Known edges:

1. The `dsh-tui` profile does not ship the `ask_user_question` tool, so the
   `blocked` state never fires there (`working`/`idle` reporting is
   unaffected).
2. The agent label reported to Herdr is fixed at `cc-tui`.

## Install

Prerequisites: a working [dsh](https://github.com/deepseek-ai/deepseek-harness)
installation with the `dsh-cc-tui`/`dsh-base` profile. The plugin declares the
profile's packages (`@deepseek-ai/cordis` at `^4`, `dsh-session`,
`dsh-agent`) as peer dependencies, supplied by the host profile.

```bash
dsh plugin --profile cc-tui add git+http://192.168.4.77:3000/dsh-plugins/dsh-herdr-site.git
```

The package ships a `dsh.bundle.patch` manifest, so the installer adds it to
the profile's bundle layer stack automatically, and `cordis.patch.yml` inserts
the plugin into every surface the profile boots. Repeat for any other profile
you use (e.g. `dsh-tui`).

Verify:

```bash
dsh --profile cc-tui --dump-config | grep -A2 herdr-site
```

Installing from a local checkout also works:
`dsh plugin --profile cc-tui add /path/to/dsh-herdr-site`

## Configuration

Optional `blockMessage`, sent with the `blocked` report:

```yaml
# in the profile's cordis.patch.yml, or a --patch overlay
- id: herdr-site
  config:
    blockMessage: '模型等待你的回答'
```

## Build & test

```bash
npm install            # dev: @types/node
npm run build          # emits lib/
npm test               # behavioral assertions against a stub herdr CLI
npx tsc --noEmit       # type check
```

Git installs need no build step: `lib/` is committed. pnpm blocks `prepare`
scripts by default, so relying on an install-time build would break installs
out of the box.

`test/smoke.mjs` runs the compiled plugin through the full lifecycle on a real
cordis context — working/blocked/idle transitions, dedup, seq ordering,
unrelated tool results, release-on-dispose — asserting every emitted CLI
invocation against a stub `herdr` binary.

## Local development notes

Developing against a live profile with a plain `file:` dependency has two
gotchas (both encountered in practice):

1. A `file:` dep copies content at install time — re-run `pnpm install` in the
   profile after every rebuild, or the profile keeps running the stale copy.
2. With the dependency installed as a bundle layer *and* a manual insert row,
   bare-name activation was silently skipped; pointing the insert row's
   `name:` at the absolute `lib/index.js` path is the reliable dev-only wiring:

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

- Herdr's automatic process detection still won't recognize a dsh process as
  an agent on its own (that requires a Herdr-bundled detector update). This
  plugin reports state through the custom-integration path, which gives Herdr
  correct working/idle/blocked, panel jump, and wait without a detector.
- The optional `--agent-session-id` reference is not wired, so Herdr's
  pane/agent APIs don't expose the linked dsh session id. Automatic session
  restore would additionally require Herdr to know how to launch dsh, which is
  out of scope here. State reporting works regardless.

## License

[MIT](./LICENSE)
