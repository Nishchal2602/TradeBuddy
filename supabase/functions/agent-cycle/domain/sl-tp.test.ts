import { assertEquals, assertAlmostEquals } from 'jsr:@std/assert@1'
import {
  computeStopLossTakeProfitPrices,
  exhaustionPrice,
  validateStopLossTakeProfit,
  type SlTpBounds,
} from '../../../../src/shared/risk/sl-tp.ts'

// The bounds actually seeded in agent_settings — using the real values
// here, not arbitrary test numbers. maxTakeProfitPct raised 0.50 -> 0.90
// by the Trading Strategy V1 migration (blocker B4 in the implementation
// plan): a ~6x-stop take-profit exceeds 50% whenever atrPct > ~4.17%,
// which would otherwise silently reject opens in exactly the volatile
// conditions where the strategy needs to trade.
const SEEDED_BOUNDS: SlTpBounds = {
  minStopLossPct: 0.005,
  maxStopLossPct: 0.15,
  minTakeProfitPct: 0.005,
  maxTakeProfitPct: 0.90,
}

// --- computeStopLossTakeProfitPrices ---------------------------------

Deno.test('computeStopLossTakeProfitPrices: long, matches independently verified values', () => {
  const { stopLossPrice, takeProfitPrice } = computeStopLossTakeProfitPrices('long', 76851, 0.03, 0.10)
  assertAlmostEquals(stopLossPrice, 74545.47, 0.01)
  assertAlmostEquals(takeProfitPrice, 84536.10, 0.01)
})

Deno.test('computeStopLossTakeProfitPrices: short, SL above entry, TP below entry', () => {
  const { stopLossPrice, takeProfitPrice } = computeStopLossTakeProfitPrices('short', 100, 0.03, 0.10)
  assertAlmostEquals(stopLossPrice, 103, 1e-9)
  assertAlmostEquals(takeProfitPrice, 90, 1e-9)
})

Deno.test('exhaustionPrice: exactly 2x entry', () => {
  assertEquals(exhaustionPrice(100), 200)
  assertEquals(exhaustionPrice(76851), 153702)
})

// --- validateStopLossTakeProfit ----------------------------------------

Deno.test('validateStopLossTakeProfit: a valid long proposal passes', () => {
  const result = validateStopLossTakeProfit('long', 76851, 0.03, 0.10, SEEDED_BOUNDS)
  assertEquals(result.valid, true)
})

Deno.test('validateStopLossTakeProfit: a valid short proposal passes', () => {
  const result = validateStopLossTakeProfit('short', 100, 0.03, 0.10, SEEDED_BOUNDS)
  assertEquals(result.valid, true)
})

Deno.test('validateStopLossTakeProfit: stop-loss below the configured minimum is rejected', () => {
  const result = validateStopLossTakeProfit('long', 76851, 0.001, 0.10, SEEDED_BOUNDS)
  assertEquals(result.valid, false)
})

Deno.test('validateStopLossTakeProfit: stop-loss above the configured maximum is rejected', () => {
  const result = validateStopLossTakeProfit('long', 76851, 0.20, 0.10, SEEDED_BOUNDS)
  assertEquals(result.valid, false)
})

Deno.test('validateStopLossTakeProfit: take-profit outside configured bounds is rejected', () => {
  assertEquals(validateStopLossTakeProfit('long', 76851, 0.03, 0.001, SEEDED_BOUNDS).valid, false)
  assertEquals(validateStopLossTakeProfit('long', 76851, 0.03, 0.95, SEEDED_BOUNDS).valid, false)
})

Deno.test('validateStopLossTakeProfit: a 6R take-profit at the strategy floor stop (2.5%, -> 15% TP) passes comfortably within bounds', () => {
  // trading-strategy-v1.md §15's own worked shape: stop 2.5%, TP 6x = 15%.
  const result = validateStopLossTakeProfit('long', 76851, 0.025, 0.15, SEEDED_BOUNDS)
  assertEquals(result.valid, true)
})

Deno.test('validateStopLossTakeProfit: a 6R take-profit at a high-volatility stop (atrPct=4%, stop=8%, TP=48%) still passes under the raised 90% max', () => {
  const result = validateStopLossTakeProfit('long', 76851, 0.08, 0.48, SEEDED_BOUNDS)
  assertEquals(result.valid, true)
})

Deno.test('validateStopLossTakeProfit: a short stop at exactly 100% distance is rejected by the exhaustion ceiling EVEN when bounds would allow it', () => {
  // Bounds deliberately widened so this test isolates the exhaustion
  // check specifically — proving it's an unconditional backstop, not
  // something that only happens to work because bounds also reject it.
  const wideBounds: SlTpBounds = { ...SEEDED_BOUNDS, maxStopLossPct: 1.5 }
  const result = validateStopLossTakeProfit('short', 100, 1.0, 0.10, wideBounds)
  assertEquals(result.valid, false)
})

Deno.test('validateStopLossTakeProfit: a short stop just under 100% distance is valid (boundary is exclusive, not off-by-one)', () => {
  const wideBounds: SlTpBounds = { ...SEEDED_BOUNDS, maxStopLossPct: 1.5 }
  const result = validateStopLossTakeProfit('short', 100, 0.99, 0.10, wideBounds)
  assertEquals(result.valid, true)
})

Deno.test('validateStopLossTakeProfit: a long stop-loss cannot exceed the exhaustion-equivalent concern (sanity — longs have no exhaustion ceiling, only ordering)', () => {
  // Longs have no analogue to the short exhaustion ceiling (price floors
  // at 0, not a policy threshold) — this just confirms a reasonable long
  // proposal within bounds still passes ordering cleanly.
  const result = validateStopLossTakeProfit('long', 100, 0.10, 0.20, SEEDED_BOUNDS)
  assertEquals(result.valid, true)
})
