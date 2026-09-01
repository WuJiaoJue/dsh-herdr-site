/**
 * dsh-herdr-site — DeepSeek Harness → Herdr custom-agent integration.
 *
 * Herdr (herdr.dev) treats panes as coding agents when they report lifecycle
 * state through its documented third-party protocol (`pane report-agent`).
 * dsh/cc-tui agents are *not* in Herdr's bundled detector list, so without
 * this plugin Herdr shows a dsh pane as an opaque terminal process with no
 * working/idle/blocked state, no panel jump, and no wait support.
 *
 * This plugin listens on the Cordis event bus and translates dsh lifecycle
 * to Herdr's semantic states:
 *
 *   dsh `running`          → Herdr `working`   (actively driving a turn)
 *   dsh `idle`             → Herdr `idle`      (no driver active, ready)
 *   ask_user_question open → Herdr `blocked`   (model parked waiting on the
 *                             human — detected via session `tool/call` /
 *                             `tool/result` of the `ask_user_question` tool)
 *
 * It is a strict no-op outside Herdr: nothing is spawned or read unless we
 * are immediately inside a Herdr-managed pane (HERDR_ENV=1).
 *
 * Protocol (herdr.dev/docs/integrations → "Integrate your own agent"):
 *   "$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" \
 *     --source custom:dsh-herdr-site --agent cc-tui --state <working|idle|blocked> \
 *     [--message …] [--seq N]
 * …and `pane release-agent …` on host dispose.
 *
 * @module dsh-herdr-site
 */
import { spawn } from 'node:child_process'
import Schema from '@deepseek-ai/schemastery'
// Type-only side-effect imports: register the `agent/status` and
// `session/event` extensions on the Cordis event surface (the same pattern
// dsh-working-activity uses), and pull the session event payload types.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

type HerdrState = 'working' | 'idle' | 'blocked'
type AgentStatus = 'idle' | 'running'

const AGENT_LABEL = 'cc-tui'
const SOURCE = 'custom:dsh-herdr-site'
/** DSH model-facing tool that parks the agent on a human answer. */
const ASK_TOOL = 'ask_user_question'
const MESSAGE_MAX = 200
/** Fallback executable when HERDR_BIN_PATH is unset (common in plain panes). */
const FALLBACK_BIN = 'herdr'

/**
 * Resolve the Herdr client binary to call. `HERDR_BIN_PATH` is authoritative
 * (points at the running binary for the right socket/pipe); when a plain pane
 * does not export it, fall back to `herdr` on PATH.
 */
function herdrBin(env: NodeJS.ProcessEnv): string | undefined {
  return env.HERDR_BIN_PATH || FALLBACK_BIN
}

interface Runtime {
  seq: number
  last: HerdrState | undefined
  /** Number of as-yet-unanswered ask_user_question tool calls in flight. */
  openAsks: number
}

function runtime(): Runtime {
  return { seq: 0, last: undefined, openAsks: 0 }
}

/** Spawn one Herdr CLI call; failures are logged, never thrown. */
function runHerdr(bin: string, args: string[], log: (line: string) => void): void {
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(bin, args, { stdio: 'ignore', detached: false, env: process.env })
  } catch (err) {
    log(`[herdr-site] spawn failed: ${(err as Error).message}`)
    return
  }
  child.on('error', (err) => log(`[herdr-site] ${err.message}`))
  child.unref()
}

/**
 * Report the given Herdr state only when it differs from the last one, bumping
 * the perpane seq so Herdr can drop out-of-order reports.
 */
function report(
  env: NodeJS.ProcessEnv,
  pane: string,
  rt: Runtime,
  state: HerdrState,
  message: string | undefined,
  log: (line: string) => void,
): void {
  const bin = herdrBin(env)
  if (!bin) return // no Herdr client injectable — cannot report
  if (rt.last === state) return

  const args = [
    'pane', 'report-agent', pane,
    '--source', SOURCE,
    '--agent', AGENT_LABEL,
    '--state', state,
    '--seq', String(++rt.seq),
  ]
  if (state === 'blocked' && message) args.push('--message', message.slice(0, MESSAGE_MAX))

  log(`[herdr-site] → ${state}${message ? ` (${message})` : ''}`)
  runHerdr(bin, args, log)
  rt.last = state
}

export const name = 'dsh-herdr-site'
/** We only subscribe to host events; no `inject` requirement beyond the bus. */
export const inject = [] as string[]

export interface Config {
  /** Override text included with the `blocked` report. */
  blockMessage?: string
}

export const Config = Schema.object({
  blockMessage: Schema.string().required(false),
})

/**
 * dsh-herdr-site plugin entry.
 *
 * Design notes for the blocked heuristic:
 *  - dsh exposes exactly two `agent/status` values (`idle`, `running`); there
 *    is no native `blocked`. Herdr has three; we map 1:1 for the common case
 *    and *lift* `running → blocked` while an `ask_user_question` tool call is
 *    parked. The model keeps running the whole time it waits, so without this
 *    lift Herdr would show `working` even though the agent genuinely needs a
 *    human decision. The lift is derived from the durable event stream, so it
 *    survives replay and needs no UI-provider hook.
 *  - Reports are de-duplicated (`rt.last`) and seq-guarded, and release only
 *    on host dispose, matching Herdr's ownership model.
 */
export async function apply(
  ctx: import('@deepseek-ai/cordis').Context,
  config: Partial<Config>,
): Promise<void> {
  const env = process.env
  if (env.HERDR_ENV !== '1') return // no-op outside Herdr panes
  const pane = env.HERDR_PANE_ID
  if (!pane) return

  const log = (line: string) => ctx.logger('herdr-site').debug(line)
  const rt = runtime()

  // Track ask_user_question tool calls as the blocked signal, sourced from the
  // durable session event stream (safe under replay; independent of any UI).
  const byCallId = new Map<string, boolean>()
  ctx.on('session/event', (_session: Session, event: SessionEvent) => {
    if (event.type === 'tool/call' && event.data.name === ASK_TOOL) {
      rt.openAsks += 1
      byCallId.set(event.data.callId, true)
      report(env, pane, rt, 'blocked', config.blockMessage, log)
    } else if (event.type === 'tool/result') {
      // A result closes whichever call ended it; decrement the in-flight count
      // if we had previously counted that call. `tool/result` carries the
      // correlation on its single model-facing block (`content[0].toolCallId`).
      const block = event.data.message.content[0]
      const callId = block?.type === 'tool-result' ? block.toolCallId : undefined
      if (callId !== undefined && byCallId.delete(callId)) {
        rt.openAsks = Math.max(0, rt.openAsks - 1)
        // The ask just settled; the agent is still running while it finishes
        // the turn, so only step *down* from blocked to working. The real
        // idle is reported by the authoritative `agent/status` event that
        // follows when the turn closes.
        if (rt.openAsks === 0 && rt.last === 'blocked') {
          report(env, pane, rt, 'working', undefined, log)
        }
      }
    }
  })

  // The authoritative lifecycle channel: running → working, idle → idle.
  // When an ask is still open the agent is running yet blocked; `report` keeps
  // blocked on top because it is only reached when openAsks===0 otherwise.
  ctx.on('agent/status', ({ status }: { status: AgentStatus }) => {
    if (status === 'running') {
      report(env, pane, rt, rt.openAsks > 0 ? 'blocked' : 'working', rt.openAsks > 0 ? config.blockMessage : undefined, log)
    } else {
      // idle is unambiguous once every ask has settled.
      report(env, pane, rt, 'idle', undefined, log)
    }
  })

  // Release our lifecycle authority on fiber disposal so Herdr does not keep
  // a stale agent entry. `ctx.effect`'s returned disposer runs when this fiber
  // unloads — the same cleanup hook dsh-working-activity uses for its timer.
  ctx.effect(() => () => {
    const bin = herdrBin(env)
    if (!bin || rt.last === undefined) return
    runHerdr(
      bin,
      ['pane', 'release-agent', pane, '--source', SOURCE, '--agent', AGENT_LABEL, '--seq', String(++rt.seq)],
      log,
    )
  }, 'dsh-herdr-site release')
}
