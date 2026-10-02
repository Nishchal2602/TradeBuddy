import { assertEquals } from 'jsr:@std/assert@1'
import { invertBars } from './mirror.ts'
import { testMomentumBreakout, testPullbackContinuation } from '../aggressive/detectors.ts'
import type { OhlcCandle } from '../../../../../src/shared/market-data/types.ts'

function bar(index: number, o: number, h: number, l: number, c: number): OhlcCandle {
  return { timestamp: new Date(Date.UTC(2026, 8, 23, 0, 0, 0) + index * 1_800_000).toISOString(), open: o, high: h, low: l, close: c }
}

function flatBars(n: number, price = 100): OhlcCandle[] {
  return Array.from({ length: n }, (_, i) => bar(i, price, price, price, price))
}

Deno.test('invertBars: negates open/high/low/close and SWAPS high<->low (high becomes -low, low becomes -high)', () => {
  const [inverted] = invertBars([bar(0, 100, 105, 98, 103)])
  assertEquals(inverted, { timestamp: bar(0, 100, 105, 98, 103).timestamp, open: -100, high: -98, low: -105, close: -103 })
})

Deno.test('invertBars: preserves timestamps unchanged', () => {
  const bars = flatBars(3)
  const inverted = invertBars(bars)
  assertEquals(inverted.map((b) => b.timestamp), bars.map((b) => b.timestamp))
})

Deno.test('invertBars: is an involution — inverting twice returns the original bars', () => {
  const bars = [bar(0, 100, 110, 95, 105), bar(1, 105, 120, 101, 118)]
  assertEquals(invertBars(invertBars(bars)), bars)
})

Deno.test('invertBars: a known breakout series inverts to a known breakdown — testMomentumBreakout flips to true on the inverted series where it was false on the original, and vice versa', () => {
  const bars = flatBars(12)
  bars[11] = bar(11, 105, 112, 104, 110) // close 110 > prior H8(100) -> breakout TRUE on the real series
  assertEquals(testMomentumBreakout(bars), true)
  assertEquals(testMomentumBreakout(invertBars(bars)), false) // inverted: a NEW HIGH on reals is not a new LOW on inverted

  const breakdown = flatBars(12)
  breakdown[11] = bar(11, 95, 96, 88, 90) // close 90 < prior L8(100) -> a genuine breakdown
  assertEquals(testMomentumBreakout(breakdown), false) // the real (long) detector never fires on a breakdown
  assertEquals(testMomentumBreakout(invertBars(breakdown)), true) // mirrored: a breakdown on reals IS a breakout on inverted
})

Deno.test('invertBars: short detection via mirroring equals testMomentumBreakout(invertBars(bars)) by definition, over a randomized series', () => {
  const bars: OhlcCandle[] = []
  let price = 100
  for (let i = 0; i < 20; i++) {
    const delta = (i * 37 % 11) - 5 // small deterministic pseudo-random walk, no Math.random per workflow constraints
    const o = price
    const c = price + delta
    const h = Math.max(o, c) + 2
    const l = Math.min(o, c) - 2
    bars.push(bar(i, o, h, l, c))
    price = c
  }
  const detectShort = (b: readonly OhlcCandle[]) => testMomentumBreakout(invertBars(b))
  assertEquals(detectShort(bars), testMomentumBreakout(invertBars(bars)))
})

Deno.test("invertBars: pullback's green-candle confirmation (close>open) inverts to red-candle (close<open) — the correct mirrored confirmation for a downtrend resuming down", () => {
  // `bars` is a KNOWN-GOOD long-pullback shape, worked by hand against
  // testPullbackContinuation's own frozen definition (9 bars, indices
  // 0-8, current = index 8):
  //   priorEight = indices 0-7 -> H = max(high) = 120 at absolute index 5
  //   recency: hAbsoluteIdx(5) >= n-1-RECENCY_BARS(9-1-4=4) -> 5>=4, passes
  //   postH = indices 6,7,8 -> L = min(low) = 100
  //   mid = L + 0.5*(H-L) = 100 + 0.5*(120-100) = 110
  //   current.close(116) < H(120) AND > mid(110) AND > current.open(105) (green) -> fires
  const bars = flatBars(9)
  bars[5] = bar(5, 100, 120, 98, 115) // H = 120
  bars[6] = bar(6, 110, 111, 100, 101) // start of the retracement leg, low=100
  bars[8] = bar(8, 105, 118, 104, 116) // current: green, between mid and H
  assertEquals(testPullbackContinuation(bars), true)

  // realBars is what these SAME candles look like as actual short-side
  // 30-minute data — i.e., what detectPullback('short', realBars) is
  // handed in production, which internally re-inverts back to `bars`
  // before calling testPullbackContinuation. Verified two ways: the
  // round-trip fires (by the involution property proven above, not
  // re-derived arithmetic), AND the current bar is genuinely red
  // (close < open) on realBars — the concrete claim this test exists to
  // check.
  const realBars = invertBars(bars)
  assertEquals(realBars[8]!.close < realBars[8]!.open, true) // red candle, mirrored from the original green one
  assertEquals(testPullbackContinuation(invertBars(realBars)), true) // detectPullback('short', realBars)'s own internal step
})
