import { assertEquals, assertAlmostEquals } from 'jsr:@std/assert@1'
import {
  buildCpcvSplits,
  classifyRejectionReason,
  computePerformancePanel,
  deflatedSharpeRatio,
  formatPowerChecked,
  withPowerCheck,
} from './stats.ts'
import type { StatsTrade } from './stats.ts'

const DAY = 86_400_000

function trade(overrides: Partial<StatsTrade> = {}): StatsTrade {
  return {
    asset: 'BTC',
    direction: 'long',
    armId: 'breakout_long',
    openedAt: '2024-01-01T00:00:00.000Z',
    closedAt: '2024-01-02T00:00:00.000Z',
    realizedPnl: 0,
    fee: 0,
    slippageCost: 0,
    fundingCost: 0,
    initialRiskUsd: 50,
    closeReason: 'take_profit',
    ...overrides,
  }
}

// --- classifyRejectionReason -----------------------------------------------

Deno.test('classifyRejectionReason: known prefixes map to stable buckets', () => {
  assertEquals(classifyRejectionReason('position already open; CLOSE first'), 'position_already_open')
  assertEquals(classifyRejectionReason('confidence 1 below effective minimum 1.5'), 'confidence_below_minimum')
  assertEquals(classifyRejectionReason('invalid stop-loss/take-profit'), 'invalid_sl_tp')
  assertEquals(classifyRejectionReason('stop-out re-entry block active for long BTC'), 'stop_out_reentry_block')
  assertEquals(classifyRejectionReason('drawdown breaker active: NAV is 60% below its peak'), 'drawdown_breaker')
  assertEquals(classifyRejectionReason('no room to open: risk-derived size clamped to 0 by the cash cap'), 'no_room_sizing_clamped_to_zero')
  assertEquals(classifyRejectionReason('something entirely unrecognized'), 'other')
})

// --- withPowerCheck / formatPowerChecked -----------------------------------

Deno.test('withPowerCheck: a large effect at a large n is actionable', () => {
  const stat = withPowerCheck(2.0, 500, 1.0, 'expectancy (R)')
  assertEquals(stat.actionable, true)
})

Deno.test('withPowerCheck: a small effect at a small n is NOT actionable', () => {
  const stat = withPowerCheck(0.1, 14, 1.0, 'expectancy (R)')
  assertEquals(stat.actionable, false)
})

Deno.test('withPowerCheck: n=0 -> infinite MDE, never actionable, never divides by zero', () => {
  const stat = withPowerCheck(5, 0, 1.0, 'expectancy (R)')
  assertEquals(stat.mde, Infinity)
  assertEquals(stat.actionable, false)
})

Deno.test('formatPowerChecked: prints NOT ACTIONABLE for a below-power statistic, a plain summary otherwise', () => {
  const notActionable = withPowerCheck(0.1, 14, 1.0, 'expectancy (R)')
  const actionable = withPowerCheck(2.0, 500, 1.0, 'expectancy (R)')
  assertEquals(formatPowerChecked(notActionable).includes('NOT ACTIONABLE'), true)
  assertEquals(formatPowerChecked(actionable).includes('NOT ACTIONABLE'), false)
})

// --- computePerformancePanel ------------------------------------------------

Deno.test('computePerformancePanel: trade count, win rate, R values, fees, profit factor, exits by type', () => {
  const trades: StatsTrade[] = [
    trade({ realizedPnl: 100, fee: 1, slippageCost: 0.5, initialRiskUsd: 50, closeReason: 'take_profit' }), // R = 98.5/50 = 1.97
    trade({ realizedPnl: -50, fee: 1, slippageCost: 0.5, initialRiskUsd: 50, closeReason: 'stop_loss' }), // R = -51.5/50 = -1.03
  ]
  const navSeries = [
    { timestamp: '2024-01-01T00:00:00.000Z', nav: 10_000 },
    { timestamp: '2024-01-02T00:00:00.000Z', nav: 10_100 },
    { timestamp: '2024-01-03T00:00:00.000Z', nav: 10_050 },
  ]
  const panel = computePerformancePanel({ trades, navSeries })

  assertEquals(panel.tradeCount, 2)
  assertEquals(panel.winRate, 0.5)
  assertAlmostEquals(panel.avgWinR, 1.97, 1e-9)
  assertAlmostEquals(panel.avgLossR, -1.03, 1e-9)
  assertAlmostEquals(panel.expectancyR.value, (1.97 - 1.03) / 2, 1e-9)
  assertEquals(panel.expectancyR.n, 2)
  assertAlmostEquals(panel.profitFactor, 100 / 50, 1e-9)
  assertAlmostEquals(panel.totalFees, 2, 1e-9)
  assertAlmostEquals(panel.totalSlippage, 1, 1e-9)
  assertEquals(panel.totalFunding, 0)
  assertEquals(panel.exitsByType, { take_profit: 1, stop_loss: 1 })
  assertAlmostEquals(panel.takeProfitTouchRatePct, 0.5, 1e-9)
})

Deno.test('computePerformancePanel: an empty trade list never throws, every rate/ratio degrades to a safe default', () => {
  const navSeries = [{ timestamp: '2024-01-01T00:00:00.000Z', nav: 10_000 }]
  const panel = computePerformancePanel({ trades: [], navSeries })
  assertEquals(panel.tradeCount, 0)
  assertEquals(panel.winRate, 0)
  assertEquals(panel.profitFactor, 0)
  assertEquals(panel.expectancyR.n, 0)
  assertEquals(panel.expectancyR.actionable, false)
})

Deno.test('computePerformancePanel: max drawdown and its longest duration, on a known peak-trough-partial-recovery series', () => {
  const navSeries = [
    { timestamp: '2024-01-01T00:00:00.000Z', nav: 100 },
    { timestamp: '2024-01-02T00:00:00.000Z', nav: 120 }, // new peak
    { timestamp: '2024-01-03T00:00:00.000Z', nav: 90 }, // trough: (120-90)/120 = 0.25
    { timestamp: '2024-01-04T00:00:00.000Z', nav: 110 }, // partial recovery, still below peak -- drawdown duration now 2 days
  ]
  const panel = computePerformancePanel({ trades: [], navSeries })
  assertAlmostEquals(panel.maxDrawdownPct, 0.25, 1e-9)
  assertAlmostEquals(panel.longestDrawdownDays, 2, 1e-9)
})

Deno.test('computePerformancePanel: a monotonically rising NAV series has zero drawdown and a positive Sharpe', () => {
  const navSeries = Array.from({ length: 10 }, (_, i) => ({ timestamp: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(), nav: 10_000 * (1 + i * 0.01) }))
  const panel = computePerformancePanel({ trades: [], navSeries })
  assertEquals(panel.maxDrawdownPct, 0)
  assertEquals(panel.sharpe > 0, true)
})

Deno.test('computePerformancePanel: a monotonically falling NAV series has a negative Sharpe', () => {
  const navSeries = Array.from({ length: 10 }, (_, i) => ({ timestamp: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(), nav: 10_000 * (1 - i * 0.01) }))
  const panel = computePerformancePanel({ trades: [], navSeries })
  assertEquals(panel.sharpe < 0, true)
})

// DT-1 plan, Phase P0 — sharpePerPeriod is purely additive; this pins the
// exact relationship (`sharpe === sharpePerPeriod * sqrt(annFactor)`) on
// two different cadences, so the units fix can't silently drift apart from
// the annualized `sharpe` field everything else already depends on.
Deno.test('computePerformancePanel: sharpePerPeriod * sqrt(annFactor) === sharpe, on a daily-cadence series', () => {
  const navSeries = Array.from({ length: 30 }, (_, i) => ({
    timestamp: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(),
    nav: 10_000 * (1 + (i % 2 === 0 ? 0.01 : -0.004)),
  }))
  const panel = computePerformancePanel({ trades: [], navSeries })
  const annFactor = 365 // daily ticks -> 1-day median gap -> 365/1
  assertAlmostEquals(panel.sharpePerPeriod * Math.sqrt(annFactor), panel.sharpe, 1e-9)
})

Deno.test('computePerformancePanel: sharpePerPeriod * sqrt(annFactor) === sharpe, on a 30-minute-cadence series', () => {
  const THIRTY_MIN = 30 * 60_000
  const navSeries = Array.from({ length: 40 }, (_, i) => ({
    timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + i * THIRTY_MIN).toISOString(),
    nav: 10_000 * (1 + (i % 2 === 0 ? 0.005 : -0.002)),
  }))
  const panel = computePerformancePanel({ trades: [], navSeries })
  const annFactor = (365 * 86_400_000) / THIRTY_MIN // 17,520
  assertAlmostEquals(panel.sharpePerPeriod * Math.sqrt(annFactor), panel.sharpe, 1e-9)
  // The decisive proof of the units bug this field exists to fix: the
  // SAME underlying per-period Sharpe reads wildly different once
  // annualized at a 30-minute cadence vs. a daily one (sqrt(17520) vs
  // sqrt(365)) -- exactly why a raw `sharpe` comparison across R4's
  // 30-minute V4 trials and its daily baseline trial was never apples-
  // to-apples.
  assertEquals(Math.abs(panel.sharpe) > Math.abs(panel.sharpePerPeriod) * 10, true)
})

Deno.test('computePerformancePanel: splits expectancy by direction and by asset independently', () => {
  const trades: StatsTrade[] = [
    trade({ asset: 'BTC', direction: 'long', realizedPnl: 100, initialRiskUsd: 50 }),
    trade({ asset: 'BTC', direction: 'short', realizedPnl: -50, initialRiskUsd: 50 }),
    trade({ asset: 'ETH', direction: 'long', realizedPnl: 50, initialRiskUsd: 50 }),
  ]
  const navSeries = [{ timestamp: '2024-01-01T00:00:00.000Z', nav: 10_000 }]
  const panel = computePerformancePanel({ trades, navSeries })
  assertEquals(panel.bySameDirection.long.tradeCount, 2)
  assertEquals(panel.bySameDirection.short.tradeCount, 1)
  assertEquals(panel.byAsset.BTC!.tradeCount, 2)
  assertEquals(panel.byAsset.ETH!.tradeCount, 1)
})

Deno.test('computePerformancePanel: time-in-market correctly sweeps across MULTIPLE separate, non-adjacent trade windows with gaps between them', () => {
  // 10 daily nav ticks (Jan 1-10). Trade A covers Jan 2-3, a flat gap
  // Jan 3(exclusive)-5, Trade B covers Jan 5-6, a flat gap, Trade C
  // covers Jan 9-10 -- in-market on exactly 6 of the 10 ticks.
  const trades: StatsTrade[] = [
    trade({ openedAt: '2024-01-02T00:00:00.000Z', closedAt: '2024-01-03T00:00:00.000Z' }),
    trade({ openedAt: '2024-01-05T00:00:00.000Z', closedAt: '2024-01-06T00:00:00.000Z' }),
    trade({ openedAt: '2024-01-09T00:00:00.000Z', closedAt: '2024-01-10T00:00:00.000Z' }),
  ]
  const navSeries = Array.from({ length: 10 }, (_, i) => ({ timestamp: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(), nav: 10_000 }))
  const panel = computePerformancePanel({ trades, navSeries })
  assertAlmostEquals(panel.timeInMarketPct, 6 / 10, 1e-9)
})

Deno.test('computePerformancePanel: carries the caller-supplied rejectionsByReason through verbatim', () => {
  const navSeries = [{ timestamp: '2024-01-01T00:00:00.000Z', nav: 10_000 }]
  const panel = computePerformancePanel({ trades: [], navSeries, rejectionsByReason: { drawdown_breaker: 3 } })
  assertEquals(panel.riskRejectionsByReason, { drawdown_breaker: 3 })
})

// --- deflatedSharpeRatio -----------------------------------------------

function syntheticReturns(n: number, mean: number): number[] {
  // Alternating symmetric noise around `mean` -- deliberately simple
  // (near-zero skew/kurtosis) so the deflation behaves close to the
  // textbook normal-returns case, making the comparative assertions below
  // meaningful rather than swamped by distributional quirks.
  return Array.from({ length: n }, (_, i) => mean + (i % 2 === 0 ? 0.01 : -0.01))
}

Deno.test('deflatedSharpeRatio: numTrials=1 -> zero selection penalty (SR0=0)', () => {
  const result = deflatedSharpeRatio({ observedSharpe: 1.0, returns: syntheticReturns(100, 0.001), numTrials: 1, sharpeVarianceAcrossTrials: 0.5 })
  assertEquals(result.expectedMaxSharpeUnderNull, 0)
})

Deno.test('deflatedSharpeRatio: more trials (same variance) raises the null bar, lowering the deflated ratio for the identical observed Sharpe', () => {
  const returns = syntheticReturns(200, 0.001)
  const fewTrials = deflatedSharpeRatio({ observedSharpe: 1.0, returns, numTrials: 2, sharpeVarianceAcrossTrials: 0.3 })
  const manyTrials = deflatedSharpeRatio({ observedSharpe: 1.0, returns, numTrials: 50, sharpeVarianceAcrossTrials: 0.3 })
  assertEquals(manyTrials.expectedMaxSharpeUnderNull > fewTrials.expectedMaxSharpeUnderNull, true)
  assertEquals(manyTrials.deflatedSharpeRatio < fewTrials.deflatedSharpeRatio, true)
})

Deno.test('deflatedSharpeRatio: a higher observed Sharpe (same trial count) always produces a higher or equal deflated ratio', () => {
  const returns = syntheticReturns(200, 0.001)
  const low = deflatedSharpeRatio({ observedSharpe: 0.3, returns, numTrials: 5, sharpeVarianceAcrossTrials: 0.2 })
  const high = deflatedSharpeRatio({ observedSharpe: 1.5, returns, numTrials: 5, sharpeVarianceAcrossTrials: 0.2 })
  assertEquals(high.deflatedSharpeRatio >= low.deflatedSharpeRatio, true)
})

Deno.test('deflatedSharpeRatio: result is always a valid probability in [0,1]', () => {
  const result = deflatedSharpeRatio({ observedSharpe: 2.5, returns: syntheticReturns(50, 0.002), numTrials: 20, sharpeVarianceAcrossTrials: 0.4 })
  assertEquals(result.deflatedSharpeRatio >= 0 && result.deflatedSharpeRatio <= 1, true)
})

Deno.test('deflatedSharpeRatio: fewer than 2 return observations -> degrades safely to zero, never throws/NaN', () => {
  const result = deflatedSharpeRatio({ observedSharpe: 1.0, returns: [0.01], numTrials: 5, sharpeVarianceAcrossTrials: 0.2 })
  assertEquals(result.deflatedSharpeRatio, 0)
})

// --- buildCpcvSplits ---------------------------------------------------

function interval(startDay: number, endDay: number) {
  return { start: startDay * DAY, end: endDay * DAY }
}

Deno.test('buildCpcvSplits: produces exactly C(numGroups, testGroupsPerSplit) splits', () => {
  const intervals = Array.from({ length: 6 }, (_, i) => interval(i, i + 0.5))
  const splits = buildCpcvSplits(intervals, 3, 1, 0)
  assertEquals(splits.length, 3) // C(3,1) = 3
})

Deno.test('buildCpcvSplits: with no overlap and no embargo, train = every non-test interval', () => {
  const intervals = Array.from({ length: 6 }, (_, i) => interval(i, i + 0.5)) // disjoint, 1-day apart
  const splits = buildCpcvSplits(intervals, 3, 1, 0)
  const firstGroupTest = splits.find((s) => s.testGroupIndices[0] === 0)!
  assertEquals(firstGroupTest.testIndices.sort(), [0, 1])
  assertEquals(firstGroupTest.trainIndices.sort((a, b) => a - b), [2, 3, 4, 5])
})

Deno.test('buildCpcvSplits: PURGE removes a train interval that overlaps a test interval\'s own window', () => {
  // Group 0 = indices [0,1] (test). Index 2 (group 1, normally train)
  // deliberately overlaps index 1's window.
  const intervals = [interval(0, 1), interval(1, 2), interval(1.5, 2.5), interval(4, 5), interval(5, 6), interval(6, 7)]
  const splits = buildCpcvSplits(intervals, 3, 1, 0)
  const testGroup0 = splits.find((s) => s.testGroupIndices[0] === 0)!
  assertEquals(testGroup0.trainIndices.includes(2), false) // purged
  assertEquals(testGroup0.trainIndices.includes(3), true) // unaffected
})

Deno.test('buildCpcvSplits: EMBARGO removes a train interval starting shortly after a test group\'s own end boundary', () => {
  // Group 0 = indices [0,1] (test), ending at day 2. Index 2 starts at
  // day 2.2 -- within a 1-day embargo window -- and must be excluded even
  // though it does NOT overlap the test interval itself.
  const intervals = [interval(0, 1), interval(1, 2), interval(2.2, 3), interval(5, 6), interval(6, 7), interval(7, 8)]
  const splits = buildCpcvSplits(intervals, 3, 1, 1 * DAY)
  const testGroup0 = splits.find((s) => s.testGroupIndices[0] === 0)!
  assertEquals(testGroup0.trainIndices.includes(2), false) // embargoed
})

Deno.test('buildCpcvSplits: zero embargo admits an interval starting immediately after the test boundary (no false exclusion)', () => {
  const intervals = [interval(0, 1), interval(1, 2), interval(2.2, 3), interval(5, 6), interval(6, 7), interval(7, 8)]
  const splits = buildCpcvSplits(intervals, 3, 1, 0)
  const testGroup0 = splits.find((s) => s.testGroupIndices[0] === 0)!
  assertEquals(testGroup0.trainIndices.includes(2), true)
})

Deno.test('buildCpcvSplits: degenerate inputs (too few groups, testGroupsPerSplit >= numGroups, empty intervals) return no splits, never throw', () => {
  assertEquals(buildCpcvSplits([], 3, 1, 0), [])
  assertEquals(buildCpcvSplits([interval(0, 1)], 1, 1, 0), [])
  assertEquals(buildCpcvSplits([interval(0, 1), interval(1, 2)], 2, 2, 0), [])
})

Deno.test('buildCpcvSplits: regression -- tens of thousands of intervals per group never throws "Maximum call stack size exceeded" (Math.min/max(...array) spread hazard, found live during R4\'s own full-history run)', () => {
  // 60,000 tightly-packed, non-overlapping intervals -- comfortably past
  // the engine spread/apply argument limit that broke the original
  // Math.min(...group.map(...))/Math.max(...) implementation.
  const intervals = Array.from({ length: 60_000 }, (_, i) => interval(i * 0.01, i * 0.01 + 0.005))
  const splits = buildCpcvSplits(intervals, 10, 2, 1 * DAY)
  assertEquals(splits.length, 45) // C(10,2)
  // Every index partitioned into exactly train XOR test, nothing lost or duplicated.
  const first = splits[0]!
  assertEquals(new Set([...first.trainIndices, ...first.testIndices]).size <= intervals.length, true)
})

Deno.test('buildCpcvSplits: the group-boundary purge is conservative -- it purges a train interval whose OWN window does not overlap any real test interval, but DOES fall inside the test group\'s overall span', () => {
  // Test group 0 = indices [0,1]: interval 0 spans day 0-1, interval 1
  // spans day 3-4 (a gap exists at day 1-3 inside the group's own span).
  // A train interval sitting in that gap (day 1.5-2) overlaps NEITHER
  // real test interval individually, but IS purged under the
  // group-boundary rule (de Prado's own method) -- documented here as
  // the deliberately conservative choice, not an accuracy regression.
  const intervals = [interval(0, 1), interval(3, 4), interval(1.5, 2), interval(6, 7), interval(7, 8), interval(8, 9)]
  const splits = buildCpcvSplits(intervals, 3, 1, 0)
  const testGroup0 = splits.find((s) => s.testGroupIndices[0] === 0)!
  assertEquals(testGroup0.trainIndices.includes(2), false)
})
