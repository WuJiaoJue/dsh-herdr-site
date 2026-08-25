/**
 * Behavioral smoke test for dsh-herdr-site.
 *
 * Runs the compiled plugin against a real cordis Context with a stub `herdr`
 * CLI that records every invocation, then drives the documented event
 * sequences and asserts the exact CLI calls the plugin emits.
 *
 * Run with `npm test` (requires `npm run build` first, and the peer deps to be
 * installed — they are, via the local development setup).
 */
import { Context } from '@deepseek-ai/cordis'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'

// --- Herdr pane environment -------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'herdr-site-smoke-'))
const binDir = join(dir, 'bin')
mkdirSync(binDir)
writeFileSync(
  join(binDir, 'herdr'),
  '#!/bin/sh\necho "herdr $*" >> ' + JSON.stringify(join(dir, 'calls.log')) + '\n',
)
chmodSync(join(binDir, 'herdr'), 0o755)

process.env.HERDR_ENV = '1'
process.env.HERDR_PANE_ID = 'pane-1'
delete process.env.HERDR_BIN_PATH // exercise the `herdr` on PATH fallback
const realPath = process.env.PATH
process.env.PATH = binDir + ':' + realPath

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readCalls = () => {
  try {
    return readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')
  } catch {
    return []
  }
}

try {
  const ctx = new Context()
  await plugin.apply(ctx, { blockMessage: '等待输入' })

  const session = { id: 's1' }
  const fireSession = (type, data) =>
    ctx.emit('session/event', session, { type, data, time: Date.now() })
  const fireStatus = (status) => ctx.emit('agent/status', { agent: {}, status })

  let failures = 0
  const check = (label, cond) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`)
    if (!cond) failures++
  }
  const includes = (needle) => readCalls().some((l) => l.includes(needle))
  const countOf = (needle) => readCalls().filter((l) => l.includes(needle)).length

  // 1. running → working (seq 1)
  fireStatus('running')
  await sleep(80)
  check('running reports working (seq 1)', includes('--state working --seq 1'))

  // 2. ask_user_question opens → blocked with configured message (seq 2)
  fireSession('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'ask_user_question', arguments: '{}' })
  await sleep(80)
  check('ask open reports blocked (seq 2)', includes('--state blocked --seq 2'))
  check('blocked carries blockMessage', /--seq 2 .*--message 等待输入/.test(readCalls().join('\n')))

  // 3. running again while ask open → deduped, no new report
  fireStatus('running')
  await sleep(80)
  check('running while blocked is deduped', countOf('--state') === 2)

  // 4. unrelated tool result does not lift blocked
  fireSession('tool/result', {
    turn: 1, step: 1,
    message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'other', content: [] }] },
  })
  await sleep(80)
  check('unrelated tool result ignored', countOf('--state') === 2)

  // 5. ask settles → step down to working (seq 3)
  fireSession('tool/result', {
    turn: 1, step: 1,
    message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] },
  })
  await sleep(80)
  check('ask settled steps down to working (seq 3)', includes('--state working --seq 3'))

  // 6. idle → idle (seq 4); duplicate idle suppressed
  fireStatus('idle')
  await sleep(80)
  check('idle reported (seq 4)', includes('--state idle --seq 4'))
  fireStatus('idle')
  await sleep(80)
  check('duplicate idle suppressed', countOf('--state idle') === 1)

  // 7. second ask opens then agent idles anyway → blocked then idle both reported
  fireSession('tool/call', { turn: 2, step: 1, callId: 'c2', name: 'ask_user_question', arguments: '{}' })
  await sleep(80)
  check('second ask reports blocked (seq 5)', includes('--state blocked --seq 5'))
  fireStatus('idle')
  await sleep(80)
  check('idle after blocked reported (seq 6)', includes('--state idle --seq 6'))

  // 8. disposal → release-agent (seq 7)
  await ctx.fiber.dispose()
  await sleep(120)
  check('dispose releases agent (last seq)', includes('release-agent pane-1') && countOf('--seq') === 7)

  if (failures > 0) {
    console.log('--- calls ---')
    for (const line of readCalls()) console.log(line)
    console.log(`FAILURES: ${failures}`)
    process.exitCode = 1
  } else {
    console.log('ALL PASS')
  }
} finally {
  process.env.PATH = realPath
  rmSync(dir, { recursive: true, force: true })
}
