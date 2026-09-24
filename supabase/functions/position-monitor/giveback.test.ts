import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import { trackGivebackForPosition } from './giveback.ts'
import type { GivebackTrackingInput } from './giveback.ts'
import type { Position } from '../../../src/shared/positions/types.ts'

// entry 100, initialStop 92 -> riskPerUnit0 = 8, quantity 10 -> initialRiskUsd = 80.
function trackedPosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-1', portfolioId: 'pf-1', asset: 'BTC', direction: 'long',
    quantity: 10, entryPrice: 100, costBasis: 1000,
    stopLossPrice: 80, takeProfitPrice: 200, // far away — never breaches in these fixtures, isolating giveback from SL/TP
    status: 'open', openedAt: '2026-09-23T00:00:00.000Z', closedAt: null,
    realizedPnl: null, closeReason: null, openedByDecisionId: null, closedByDecisionId: null,
    initialEntryPrice: 100, initialStopLossPrice: 92, initialRiskUsd: 80,
    partialRealizedPnlUsd: 0, sampledMfeR: null, sampledMaeR: null,
    peakTotalPnlUsd: null, peakPnlAt: null, givebackFloorR: null,
    highWaterTrackedFrom: '2026-09-23T00:00:00.000Z',
    ...overrides,
  }
}

function point(price: number, tsOffsetMin: number): { timestamp: string; price: number } {
  return { timestamp: new Date(new Date('2026-09-23T00:00:00.000Z').getTime() + tsOffsetMin * 60_000).toISOString(), price }
}

const FEE_BPS = 10
const SLIPPAGE_BPS = 5 // costR at price 100, qty 10: (2*15/10000)*10*100 = 0.30 / 80 = 0.00375

function track(position: Position, points: ReturnType<typeof point>[]): ReturnType<typeof trackGivebackForPosition> {
  const input: GivebackTrackingInput = { position, feeBps: FEE_BPS, slippageBps: SLIPPAGE_BPS, points }
  return trackGivebackForPosition(input)
}

// --- Eligibility / defensive no-ops -----------------------------------

Deno.test('missing ruler (initialRiskUsd null) returns the unchanged prior state, never throws', () => {
  const result = track(trackedPosition({ initialRiskUsd: null }), [point(150, 10)])
  assertEquals(result.sampledMfeR, 0)
  assertEquals(result.exit, null)
})

Deno.test('zero points this tick returns the unchanged prior state', () => {
  const result = track(trackedPosition({ sampledMfeR: 1.2, sampledMaeR: 0.1 }), [])
  assertEquals(result.sampledMfeR, 1.2)
  assertEquals(result.sampledMaeR, 0.1)
})

// --- MFE / MAE tracking --------------------------------------------------

Deno.test('monotone rise: sampledMfeR tracks the latest point, no giveback yet', () => {
  // 100 -> 108 -> 116: positionPnlR = (price-100)*10/80 = 1.0, 2.0
  const result = track(trackedPosition(), [point(108, 5), point(116, 10)])
  assertAlmostEquals(result.sampledMfeR, 2.0, 1e-9)
  assertAlmostEquals(result.sampledMaeR, 1.0, 1e-9) // the minimum observed this window, still positive
})

Deno.test('rise then fall: sampledMfeR stays frozen at the peak, sampledMaeR captures the trough', () => {
  // 100 -> 132 (+4R) -> 108 (+1R): peak 4R, trough (this window) 1R
  const result = track(trackedPosition(), [point(132, 5), point(108, 10)])
  assertAlmostEquals(result.sampledMfeR, 4.0, 1e-9)
  assertAlmostEquals(result.sampledMaeR, 1.0, 1e-9)
})

Deno.test('sampledMfeR/MaeR persist and extend across ticks — a second call continues from the stored state', () => {
  const afterFirstTick = track(trackedPosition(), [point(132, 5)]) // +4R
  const positionAfterTick = trackedPosition({ sampledMfeR: afterFirstTick.sampledMfeR, sampledMaeR: afterFirstTick.sampledMaeR, givebackFloorR: afterFirstTick.givebackFloorR })
  // Next tick: price drops to +0.5R — should NOT raise mfeR above the stored 4.0
  const secondTick = track(positionAfterTick, [point(104, 5)])
  assertAlmostEquals(secondTick.sampledMfeR, 4.0, 1e-9)
  assertAlmostEquals(secondTick.sampledMaeR, 0.5, 1e-9)
})

Deno.test('a REDUCE (partialRealizedPnlUsd already banked) does not register as giveback — matches protection.test.ts\'s continuity proof', () => {
  // Position reduced from 20 -> 10 units at a gain, banking 100 realized.
  // Now at entry+2R price with the REMAINING 10 units: unrealized = (116-100)*10=160, +100 realized = 260/80 = 3.25R
  const reduced = trackedPosition({ quantity: 10, partialRealizedPnlUsd: 100, sampledMfeR: 3.25 })
  const result = track(reduced, [point(116, 5)]) // same price, positionPnlR should read exactly 3.25R again, not lower
  assertAlmostEquals(result.sampledMfeR, 3.25, 1e-9)
})

// --- Intra-tick extremum (multiple points replayed in one tick) ---------

Deno.test('an intra-tick spike is captured even though it is not the LAST point in the window', () => {
  // 100 -> 140 (+5R, the true peak) -> 108 (+1R, the last point) — a single
  // "latest point only" sampler would miss the +5R spike entirely.
  const result = track(trackedPosition(), [point(140, 3), point(108, 6)])
  assertAlmostEquals(result.sampledMfeR, 5.0, 1e-9)
})

Deno.test('points are processed in chronological order regardless of input array order', () => {
  const chronological = track(trackedPosition(), [point(108, 5), point(140, 3)]) // out of order in the array
  assertAlmostEquals(chronological.sampledMfeR, 5.0, 1e-9) // still finds the +5R point at t=3
})

// --- peakTotalPnlUsd / peakPnlAt ------------------------------------------

Deno.test('peakTotalPnlUsd and peakPnlAt are set to the point that produced the new peak, not just the last point', () => {
  const p1 = point(140, 3) // (140-100)*10 = 400
  const p2 = point(108, 6) // (108-100)*10 = 80, not a new peak
  const result = track(trackedPosition(), [p1, p2])
  assertAlmostEquals(result.peakTotalPnlUsd!, 400, 1e-9)
  assertEquals(result.peakPnlAt, p1.timestamp)
})

// --- The giveback ratchet, end to end -------------------------------------

Deno.test('ratchet arms at +1R and exits at the costR floor if price immediately retraces to entry in the same window', () => {
  // 100 -> 108 (+1R, arms at costR) -> 100 (0R, well below costR floor) -> exit
  const result = track(trackedPosition(), [point(108, 3), point(100, 6)])
  assertEquals(result.exit !== null, true)
  assertEquals(result.exit!.triggeredAt, point(100, 6).timestamp)
})

Deno.test('no premature exit: a small pullback below +1R (never armed) produces no exit', () => {
  // 100 -> 104 (+0.5R, unarmed) -> 101 (+0.125R) — never reaches +1R, so never arms
  const result = track(trackedPosition(), [point(104, 3), point(101, 6)])
  assertEquals(result.exit, null)
  assertEquals(result.givebackFloorR, null)
})

Deno.test('continued momentum after a large MFE does not exit — the floor only rises, it never forces an exit on its own', () => {
  // 100 -> 132 (+4R, arms 1.5R floor) -> 148 (+6R, still well above the floor)
  const result = track(trackedPosition(), [point(132, 3), point(148, 6)])
  assertEquals(result.exit, null)
  assertAlmostEquals(result.givebackFloorR!, 1.5, 1e-9)
  assertAlmostEquals(result.sampledMfeR, 6.0, 1e-9)
})

Deno.test('exit fires at the FIRST point that crosses the floor, and walking stops there — a later recovery in the same window is not observed', () => {
  // 100 -> 132 (+4R, arms 1.5R) -> 108 (+1R, crosses below 1.5 -> exit HERE) -> 140 (+5R, never reached by the walk)
  const result = track(trackedPosition(), [point(132, 3), point(108, 6), point(140, 9)])
  assertEquals(result.exit !== null, true)
  assertEquals(result.exit!.triggeredAt, point(108, 6).timestamp)
  // mfeR reflects only what was seen BEFORE the walk stopped (4.0), not the later 140 spike
  assertAlmostEquals(result.sampledMfeR, 4.0, 1e-9)
})

Deno.test('the floor never decreases across ticks even if a later tick reads a lower sampledMfeR input (defensive monotonicity)', () => {
  const armed = trackedPosition({ sampledMfeR: 3.0, givebackFloorR: 1.5 })
  // A hypothetically "lower" reading this tick — the ratchet must still respect the previously stored floor.
  const result = track(armed, [point(104, 5)]) // +0.5R this tick, raw floor for that alone would be null
  assertAlmostEquals(result.givebackFloorR!, 1.5, 1e-9)
})
