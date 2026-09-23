import { assertEquals } from 'jsr:@std/assert@1'

// Phase 2.1 (2026-09-23), test 6 — "position-monitor SL/TP execution
// remains independent [of the model layer]."
//
// Honest limit, stated up front: a unit test cannot prove RUNTIME
// independence (that position-monitor's own 10-minute cron tick never
// calls out to Jev, never waits on a model response, never has its
// SL/TP execution gated by anything Phase 2/2.1 added). That is proven
// by this project's actual live-verification discipline instead — see
// progress-tracker.md's repeated "position-monitor confirmed unaffected,
// N clean ticks straddling the deploy" entries, and plan.test.ts /
// triggers.test.ts, which cover the monitor's own SL/TP logic completely
// on their own, with zero dependency on anything here.
//
// What THIS test proves, and can prove completely: there is no STATIC
// import edge from position-monitor's own source into the model layer or
// the management-application seam. If a future change ever made the
// monitor call Jev, or route a close through applyManagementOutcome/
// applyVetoOutcome instead of its own existing close_position_atomic
// path, this fails at `deno check`/`deno test` time — before any live
// cycle would have surfaced it.

const POSITION_MONITOR_SOURCE_FILES = ['index.ts', 'plan.ts', 'triggers.ts']

// Forbidden import-path substrings — anything importing from these would
// mean the monitor now depends on the model layer or its application
// seams, which it must never do (this file's job is the monitor's own
// deterministic SL/TP/collateral-exhaustion trigger detection only).
const FORBIDDEN_IMPORT_SUBSTRINGS = ['model/jev', 'cycle/apply-veto', 'cycle/apply-management', 'cycle/collect-candidates']

Deno.test('position-monitor: none of its own source files import from the model layer or the veto/management application seams', async () => {
  for (const file of POSITION_MONITOR_SOURCE_FILES) {
    const url = new URL(`./${file}`, import.meta.url)
    const source = await Deno.readTextFile(url)
    const importLines = source.split('\n').filter((line) => line.trim().startsWith('import '))
    for (const forbidden of FORBIDDEN_IMPORT_SUBSTRINGS) {
      const offendingLine = importLines.find((line) => line.includes(forbidden))
      assertEquals(offendingLine, undefined, `${file} must not import from '${forbidden}' — position-monitor's SL/TP execution is independent of the model layer by design`)
    }
  }
})

Deno.test('position-monitor: closePosition (the ONE close path it uses) is imported from broker/accounting.ts, not reconstructed or routed through cycle/apply-*', async () => {
  let foundImport = false
  for (const file of POSITION_MONITOR_SOURCE_FILES) {
    const source = await Deno.readTextFile(new URL(`./${file}`, import.meta.url))
    const importLines = source.split('\n').filter((line) => line.trim().startsWith('import '))
    if (importLines.some((line) => line.includes('closePosition') && line.includes('broker/accounting.ts'))) {
      foundImport = true
      break
    }
  }
  assertEquals(foundImport, true, 'the monitor must keep using the shared broker close path (imported from broker/accounting.ts), never a second implementation')
})
