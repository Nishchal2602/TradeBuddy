import { assertEquals } from 'jsr:@std/assert@1'
import { detectAllOpportunities } from './detect-all-opportunities.ts'
import type { OhlcCandle } from '../../../../../src/shared/market-data/types.ts'
import type { NormalizedMarketData } from '../../../../../src/shared/market-data/types.ts'

// Same bar-construction convention as detectors.test.ts (30-minute spacing
// from 2026-09-23T00:00:00Z) — kept self-contained rather than importing
// detectors.test.ts's own private fixtures.
function bar(index: number, o: number, h: number, l: number, c: number): OhlcCandle {
  return { timestamp: new Date(Date.UTC(2026, 8, 23, 0, 0, 0) + index * 1_800_000).toISOString(), open: o, high: h, low: l, close: c }
}

function flatBars(n: number, price = 100): OhlcCandle[] {
  return Array.from({ length: n }, (_, i) => bar(i, price, price, price, price))
}

const LONG_BREAKOUT_BARS = (() => {
  const bars = flatBars(16)
  bars[15] = bar(15, 105, 112, 104, 110)
  return bars
})()

const SHORT_BREAKDOWN_BARS = (() => {
  const bars = flatBars(16)
  bars[15] = bar(15, 95, 96, 88, 90)
  return bars
})()

// Minimal NormalizedMarketData — fade never fires in these fixtures (no
// test here exercises fade specifically; detectFadeOpportunity's own
// behavior is already covered by detectors.test.ts), so closeSeries/
// candles just need to be short enough to fail MIN_CLOSES_FOR_FADE
// cleanly rather than accidentally firing.
function marketData(price: number): NormalizedMarketData {
  return {
    asset: 'BTC', provider: 'coingecko', dataAsOf: '2026-09-23T08:00:00.000Z', fetchedAt: '2026-09-23T08:00:00.000Z',
    price, change1hPct: null, change24hPct: null, change7dPct: null,
    candles: [], closeSeries: [], volumeSeries: [], dailyCloseSeries: [],
  } as unknown as NormalizedMarketData
}

const CONFIRMATION = { ret60mPct: 1.5, volumeTrendRatio: 1.3 }

Deno.test('detectAllOpportunities: the real candidate\'s own armId is classified "taken"', () => {
  const result = detectAllOpportunities({
    bars30m: LONG_BREAKOUT_BARS,
    breakoutConfirmation: CONFIRMATION,
    marketData: marketData(110),
    eligibleArms: ['breakout_long', 'pullback_long'],
    shortEnabled: true,
    takenArmId: 'breakout_long',
  })
  const hit = result.find((h) => h.armId === 'breakout_long')
  assertEquals(hit?.shadowCause, 'taken')
  assertEquals(hit?.armFamily, 'breakout')
})

Deno.test('detectAllOpportunities: a hit outside the cycle\'s eligible arms is "bias_blocked"', () => {
  const result = detectAllOpportunities({
    bars30m: LONG_BREAKOUT_BARS,
    breakoutConfirmation: CONFIRMATION,
    marketData: marketData(110),
    // SHORT bias this cycle — breakout_long is NOT eligible, even though
    // it independently fired on these bars.
    eligibleArms: ['breakout_short', 'pullback_short'],
    shortEnabled: true,
  })
  const hit = result.find((h) => h.armId === 'breakout_long')
  assertEquals(hit?.shadowCause, 'bias_blocked')
})

Deno.test('detectAllOpportunities: a config-disabled arm is "arm_disabled", even when bias-eligible', () => {
  const result = detectAllOpportunities({
    bars30m: LONG_BREAKOUT_BARS,
    breakoutConfirmation: CONFIRMATION,
    marketData: marketData(110),
    eligibleArms: ['breakout_long', 'pullback_long'],
    arms: { breakout_long: { enabled: false } },
    shortEnabled: true,
  })
  const hit = result.find((h) => h.armId === 'breakout_long')
  assertEquals(hit?.shadowCause, 'arm_disabled')
})

Deno.test('detectAllOpportunities: a detected short is "direction_disabled" when shortEnabled=false, even though bias-eligible', () => {
  const result = detectAllOpportunities({
    bars30m: SHORT_BREAKDOWN_BARS,
    breakoutConfirmation: { ret60mPct: -1.2, volumeTrendRatio: 1.5 },
    marketData: marketData(90),
    eligibleArms: ['breakout_short', 'pullback_short'],
    shortEnabled: false,
  })
  const hit = result.find((h) => h.armId === 'breakout_short')
  assertEquals(hit?.shadowCause, 'direction_disabled')
})

Deno.test('detectAllOpportunities: direction_disabled takes precedence over bias_blocked for a short that is also bias-ineligible', () => {
  const result = detectAllOpportunities({
    bars30m: SHORT_BREAKDOWN_BARS,
    breakoutConfirmation: { ret60mPct: -1.2, volumeTrendRatio: 1.5 },
    marketData: marketData(90),
    eligibleArms: [], // not bias-eligible either
    shortEnabled: false,
  })
  const hit = result.find((h) => h.armId === 'breakout_short')
  assertEquals(hit?.shadowCause, 'direction_disabled')
})

Deno.test('detectAllOpportunities: eligible, enabled, and direction-allowed, yet not taken -> "lower_priority"', () => {
  // The real candidate this cycle was a DIFFERENT arm (simulating
  // detectIntradayLsOpportunity's own breakout-before-pullback priority
  // promoting a higher-priority arm instead) — this hit is fully
  // permitted and simply wasn't the one reached.
  const result = detectAllOpportunities({
    bars30m: LONG_BREAKOUT_BARS,
    breakoutConfirmation: CONFIRMATION,
    marketData: marketData(110),
    eligibleArms: ['breakout_long', 'pullback_long'],
    shortEnabled: true,
    takenArmId: 'pullback_long',
  })
  const hit = result.find((h) => h.armId === 'breakout_long')
  assertEquals(hit?.shadowCause, 'lower_priority')
})

Deno.test('detectAllOpportunities: no arm fires -> empty array', () => {
  const result = detectAllOpportunities({
    bars30m: flatBars(16),
    breakoutConfirmation: { ret60mPct: 0, volumeTrendRatio: 0 },
    marketData: marketData(100),
    eligibleArms: ['breakout_long', 'pullback_long'],
    shortEnabled: true,
  })
  assertEquals(result, [])
})

Deno.test('detectAllOpportunities: runs breakout AND pullback for BOTH directions regardless of the cycle\'s own bias', () => {
  // A SHORT-biased cycle (eligibleArms only permits the short pair) still
  // detects the independently-firing LONG breakout — ungated, per plan P3.
  const result = detectAllOpportunities({
    bars30m: LONG_BREAKOUT_BARS,
    breakoutConfirmation: CONFIRMATION,
    marketData: marketData(110),
    eligibleArms: ['breakout_short', 'pullback_short'],
    shortEnabled: true,
  })
  assertEquals(result.some((h) => h.armId === 'breakout_long'), true, 'the long breakout is still observed even under a SHORT-eligible cycle')
})
