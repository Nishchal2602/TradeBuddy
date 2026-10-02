import { assertEquals } from 'jsr:@std/assert@1'
import { isOpportunityConsumed, shouldEmitOpportunity } from './lifecycle.ts'

Deno.test('isOpportunityConsumed: null lastConsumed -> never consumed (first-ever opportunity for this asset)', () => {
  assertEquals(isOpportunityConsumed('2026-10-01T10:00:00.000Z', null), false)
})

Deno.test('isOpportunityConsumed: detectedAtBarTs strictly newer than lastConsumed -> not consumed', () => {
  assertEquals(isOpportunityConsumed('2026-10-01T10:30:00.000Z', '2026-10-01T10:00:00.000Z'), false)
})

Deno.test('isOpportunityConsumed: detectedAtBarTs equal to lastConsumed -> consumed (the exact scenario a re-scan at the next cycle would otherwise re-emit)', () => {
  assertEquals(isOpportunityConsumed('2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z'), true)
})

Deno.test('isOpportunityConsumed: detectedAtBarTs older than lastConsumed -> consumed', () => {
  assertEquals(isOpportunityConsumed('2026-10-01T09:30:00.000Z', '2026-10-01T10:00:00.000Z'), true)
})

// The review's exact scenario: a 10:00 breakout emitted at 11:00 (window
// scan finds it), must NOT re-emit at 12:00 while the asset stays flat.
Deno.test('shouldEmitOpportunity: the review scenario — a 10:00 edge, consumed at 11:00, is not re-emitted at the 12:00 cycle', () => {
  const detectedAtBarTs = '2026-10-01T10:00:00.000Z'
  // 11:00 cycle: nothing consumed yet for this asset.
  assertEquals(shouldEmitOpportunity(detectedAtBarTs, null), true)
  // Decision persisted at 11:00 with opportunity_bar_ts = 10:00 -> that
  // IS lastConsumedOpportunityBarTs for every cycle after.
  const lastConsumedAfter1100 = detectedAtBarTs
  // 12:00 cycle: the window scan still finds the SAME 10:00 edge (price
  // never advanced far enough to produce a newer one) -> must not emit.
  assertEquals(shouldEmitOpportunity(detectedAtBarTs, lastConsumedAfter1100), false)
})

Deno.test('shouldEmitOpportunity: a genuinely new, strictly later edge is still emitted after a prior one was consumed', () => {
  const lastConsumed = '2026-10-01T10:00:00.000Z'
  const newEdge = '2026-10-01T11:30:00.000Z'
  assertEquals(shouldEmitOpportunity(newEdge, lastConsumed), true)
})

Deno.test('shouldEmitOpportunity: one market event yields exactly one emission — the same bar scanned across 3 consecutive cycles emits only on the first', () => {
  const detectedAtBarTs = '2026-10-01T10:00:00.000Z'
  let lastConsumed: string | null = null
  const emissions: boolean[] = []
  for (let cycle = 0; cycle < 3; cycle++) {
    const emit = shouldEmitOpportunity(detectedAtBarTs, lastConsumed)
    emissions.push(emit)
    // Consuming (persisting a decision row) always updates lastConsumed
    // to this opportunity's own bar, regardless of whether it emitted —
    // "consumed" means processed, not executed (lifecycle.ts's own
    // comment) — but since detectedAtBarTs never changes here (same
    // stale edge re-scanned), lastConsumed stabilizes after cycle 1.
    lastConsumed = detectedAtBarTs
  }
  assertEquals(emissions, [true, false, false])
})
