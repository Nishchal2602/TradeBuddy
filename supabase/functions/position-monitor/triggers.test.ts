import { assertEquals } from 'jsr:@std/assert@1'
import { findFirstTrigger, resolveFillPrice } from './triggers.ts'

// entry=100, long: SL=95, TP=110. short: SL=105, TP=90.
const LONG_SL = 95
const LONG_TP = 110
const SHORT_SL = 105
const SHORT_TP = 90

function point(ts: string, price: number) {
  return { timestamp: ts, price }
}

Deno.test('findFirstTrigger: long, no breach — flat/noisy prices within the band', () => {
  const result = findFirstTrigger('long', LONG_SL, LONG_TP, [point('2026-09-18T00:00:00.000Z', 100), point('2026-09-18T00:05:00.000Z', 102)])
  assertEquals(result.triggered, false)
})

Deno.test('findFirstTrigger: long, stop-loss breach', () => {
  const result = findFirstTrigger('long', LONG_SL, LONG_TP, [point('2026-09-18T00:00:00.000Z', 94)])
  assertEquals(result, { triggered: true, reason: 'stop_loss', triggerPrice: 95, observedPrice: 94, triggeredAt: '2026-09-18T00:00:00.000Z' })
})

Deno.test('findFirstTrigger: long, take-profit breach', () => {
  const result = findFirstTrigger('long', LONG_SL, LONG_TP, [point('2026-09-18T00:00:00.000Z', 112)])
  assertEquals(result, { triggered: true, reason: 'take_profit', triggerPrice: 110, observedPrice: 112, triggeredAt: '2026-09-18T00:00:00.000Z' })
})

Deno.test('findFirstTrigger: short, stop-loss breach (price rises above entry)', () => {
  const result = findFirstTrigger('short', SHORT_SL, SHORT_TP, [point('2026-09-18T00:00:00.000Z', 106)])
  assertEquals(result, { triggered: true, reason: 'stop_loss', triggerPrice: 105, observedPrice: 106, triggeredAt: '2026-09-18T00:00:00.000Z' })
})

Deno.test('findFirstTrigger: short, take-profit breach (price falls below entry)', () => {
  const result = findFirstTrigger('short', SHORT_SL, SHORT_TP, [point('2026-09-18T00:00:00.000Z', 88)])
  assertEquals(result, { triggered: true, reason: 'take_profit', triggerPrice: 90, observedPrice: 88, triggeredAt: '2026-09-18T00:00:00.000Z' })
})

Deno.test('findFirstTrigger: boundary is inclusive — exactly at the SL/TP level counts as a breach', () => {
  assertEquals(findFirstTrigger('long', LONG_SL, LONG_TP, [point('t', 95)]).triggered, true)
  assertEquals(findFirstTrigger('long', LONG_SL, LONG_TP, [point('t', 110)]).triggered, true)
})

// --- Chronological priority: the actual meaning of "SL wins" -------------

Deno.test('findFirstTrigger: an earlier TP breach followed by a later SL breach in the SAME window — the earlier one (TP) wins, not SL', () => {
  // Points are supplied out of chronological order deliberately, to prove
  // the function sorts rather than trusting input order.
  const result = findFirstTrigger('long', LONG_SL, LONG_TP, [
    point('2026-09-18T00:10:00.000Z', 90), // later timestamp, SL breach
    point('2026-09-18T00:05:00.000Z', 112), // earlier timestamp, TP breach
  ])
  // The EARLIER point (TP) is what would have closed the position first
  // in reality — "SL wins" only describes the reverse ordering.
  assertEquals(result.triggered, true)
  if (result.triggered) assertEquals(result.reason, 'take_profit')
})

Deno.test('findFirstTrigger: an earlier SL breach followed by a later TP breach — SL wins, matching the contract\'s stated rule', () => {
  const result = findFirstTrigger('long', LONG_SL, LONG_TP, [
    point('2026-09-18T00:05:00.000Z', 90), // earlier, SL breach
    point('2026-09-18T00:10:00.000Z', 112), // later, TP breach
  ])
  assertEquals(result.triggered, true)
  if (result.triggered) assertEquals(result.reason, 'stop_loss')
})

Deno.test('findFirstTrigger: a non-breaching point before a breaching one is correctly skipped', () => {
  const result = findFirstTrigger('long', LONG_SL, LONG_TP, [
    point('2026-09-18T00:00:00.000Z', 100),
    point('2026-09-18T00:05:00.000Z', 101),
    point('2026-09-18T00:10:00.000Z', 94), // the actual breach
  ])
  assertEquals(result.triggered, true)
  if (result.triggered) assertEquals(result.triggeredAt, '2026-09-18T00:10:00.000Z')
})

// --- No separate exhaustion branch: verified empirically, not just in theory ---

Deno.test('findFirstTrigger: a short gapping past its exhaustion price is caught as a stop_loss breach (no dedicated exhaustion path needed)', () => {
  // entry=100, exhaustion=200 (2x entry). A valid short's SL must sit
  // strictly below 200 (Step 3 enforces this unconditionally), so this
  // point is a genuine SL breach REGARDLESS of also being past
  // exhaustion — proving the "no separate exhaustion check" reasoning
  // empirically, not just trusting the theoretical argument in the
  // module comment.
  const result = findFirstTrigger('short', 150, 90, [point('2026-09-18T00:00:00.000Z', 250)])
  assertEquals(result.triggered, true)
  if (result.triggered) assertEquals(result.reason, 'stop_loss')
  // The broker (Step 4's closePosition) is what actually re-labels this
  // to 'collateral_exhausted' once the position monitor calls it with
  // this 'stop_loss' reason and the observed price — not this module.
})

// --- Fill-price resolution -------------------------------------------------

Deno.test('resolveFillPrice: a stop-loss fills at the OBSERVED price, not the stated SL level', () => {
  const trigger = findFirstTrigger('long', LONG_SL, LONG_TP, [point('t', 88)]) // observed well past the SL=95 level
  if (trigger.triggered) {
    assertEquals(resolveFillPrice(trigger), 88) // observed, not 95 — models real gap risk
  } else {
    throw new Error('expected a trigger')
  }
})

Deno.test('resolveFillPrice: a take-profit fills at the STATED TP level, not the (better) observed price', () => {
  const trigger = findFirstTrigger('long', LONG_SL, LONG_TP, [point('t', 130)]) // observed well past TP=110
  if (trigger.triggered) {
    assertEquals(resolveFillPrice(trigger), 110) // capped at TP, not 130 — no windfall from polling luck
  } else {
    throw new Error('expected a trigger')
  }
})
