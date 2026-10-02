import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import { computeIntradayLsProtection, passesIntradayLsCostGate } from './protection.ts'

Deno.test('computeIntradayLsProtection: ATR term dominates the 1.2% floor -> stop = 2x ATR, target = 2x that (non-fade)', () => {
  const result = computeIntradayLsProtection('breakout_long', 2.0) // atr30Pct=2.0 -> 2*2.0/100=0.04 (4%) > 1.2% floor
  assertAlmostEquals(result.stopLossPct, 0.04, 1e-9)
  assertAlmostEquals(result.takeProfitPct, 0.08, 1e-9) // 2.0x stop
})

Deno.test('computeIntradayLsProtection: 1.2% floor binds when ATR term is small', () => {
  const result = computeIntradayLsProtection('pullback_long', 0.1) // 2*0.1/100=0.002 (0.2%) < 1.2% floor
  assertAlmostEquals(result.stopLossPct, 0.012, 1e-9)
  assertAlmostEquals(result.takeProfitPct, 0.024, 1e-9)
})

Deno.test('computeIntradayLsProtection: fade arms use 1.5x reward:risk, not 2.0x', () => {
  const long = computeIntradayLsProtection('fade_long', 2.0)
  const short = computeIntradayLsProtection('fade_short', 2.0)
  assertAlmostEquals(long.takeProfitPct, 0.06, 1e-9) // 1.5 * 0.04
  assertAlmostEquals(short.takeProfitPct, 0.06, 1e-9)
})

Deno.test('computeIntradayLsProtection: non-fade arms (breakout/pullback, both directions) all use 2.0x', () => {
  for (const armId of ['breakout_long', 'breakout_short', 'pullback_long', 'pullback_short'] as const) {
    const result = computeIntradayLsProtection(armId, 2.0)
    assertAlmostEquals(result.takeProfitPct, 2.0 * result.stopLossPct, 1e-9)
  }
})

Deno.test('passesIntradayLsCostGate: at the 1.2% floor, 0.30% round-trip cost clears exactly at the 0.25 boundary', () => {
  assertEquals(passesIntradayLsCostGate(0.003, 0.012), true) // 0.003/0.012 = 0.25, boundary inclusive
})

Deno.test('passesIntradayLsCostGate: cost just above the ratio fails', () => {
  assertEquals(passesIntradayLsCostGate(0.00301, 0.012), false)
})

Deno.test('passesIntradayLsCostGate: a wider stop makes the same cost clear more easily', () => {
  assertEquals(passesIntradayLsCostGate(0.003, 0.02), true)
})
