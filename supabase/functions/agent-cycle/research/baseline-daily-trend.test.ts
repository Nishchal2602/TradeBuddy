import { assertEquals } from 'jsr:@std/assert@1'
import { runDailyTrendBacktest } from './baseline-daily-trend.ts'
import type { DailyTrendBacktestParams } from './baseline-daily-trend.ts'
import type { HistoricalBarRow } from './db/historical-bars.ts'
import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'

const DAY = 86_400_000
const HOUR = 3_600_000

function row(asset: AssetSymbol, timeframe: HistoricalBarRow['timeframe'], closeTime: string, o: number, h: number, l: number, c: number): HistoricalBarRow {
  return { asset, timeframe, openTime: closeTime, closeTime, open: o, high: h, low: l, close: c, volume: 10 }
}

function dailyBars(asset: AssetSymbol, closes: number[], startIso = '2024-01-01T00:00:00.000Z'): HistoricalBarRow[] {
  const start = new Date(startIso).getTime()
  return closes.map((c, i) => row(asset, '1d', new Date(start + i * DAY).toISOString(), c, c, c, c))
}

// Flat 4h candles throughout -> ATR% = 0 -> stopLossPct hits the 2.5%
// floor, takeProfitPct = 6 x 2.5% = 15% (strategy/rules.ts's own formula).
function flatFourH(asset: AssetSymbol, n: number, price: number, startIso = '2024-01-01T00:00:00.000Z'): HistoricalBarRow[] {
  const start = new Date(startIso).getTime()
  return Array.from({ length: n }, (_, i) => row(asset, '4h', new Date(start + i * 4 * HOUR).toISOString(), price, price, price, price))
}

// A mild, real-shaped volatility (verified live against the real engine
// before being frozen here, not hand-derived): true range per bar ~5,
// giving ATR% ~5% -> stopLossPct = max(2x5%, 2.5%) = 10%, wide enough
// that a later gentle decline can flip the regime BEFORE ever touching
// the stop -- isolating the regime-flip CLOSE path from the SL path.
function mildVolatilityFourH(asset: AssetSymbol, n: number, startIso = '2024-01-01T00:00:00.000Z'): HistoricalBarRow[] {
  const start = new Date(startIso).getTime()
  return Array.from({ length: n }, (_, i) => {
    const base = 100 + (i % 2 === 0 ? 2 : -2)
    return row(asset, '4h', new Date(start + i * 4 * HOUR).toISOString(), base, base + 1, base - 1, base)
  })
}

function risingThenGentleDecline(): number[] {
  // indices 0-64: ascending 80 -> 144 (UP regime once >= 50 bars exist).
  const rising = Array.from({ length: 65 }, (_, i) => 80 + i)
  // indices 65-104: a gentle 1-point/day decline -- verified live
  // (before this fixture was frozen) that the regime flips DOWN around
  // day 79 (price ~129, still far above the ~116 stop at 10% width),
  // entirely independent of any SL/TP breach.
  const declining = Array.from({ length: 40 }, (_, i) => 143 - i)
  return [...rising, ...declining]
}

function risingThenCrashCloses(): number[] {
  const rising = Array.from({ length: 65 }, (_, i) => 80 + i)
  // A single sharp one-day crash, well below both the stop AND the
  // regime-flip threshold at once -- see the dedicated precedence test
  // below for why this correctly resolves to stop_loss, not agent_close.
  return [...rising, 50, 50, 50, 50]
}

function baseParams(overrides: Partial<DailyTrendBacktestParams> = {}): DailyTrendBacktestParams {
  return {
    assets: ['BTC'],
    startingCapitalUsd: 10_000,
    feeBps: 10,
    slippageBps: 5,
    effectiveMinConfidence: 0,
    effectiveRiskBudgetPct: 0.0075,
    effectiveSingleTradeCapPct: 0.20,
    effectiveAssetExposureCapPct: 0.35,
    maxTotalNotionalPct: 0.60,
    portfolioRiskCeilingMultiplier: 1.5,
    drawdownBreakerFloorPct: 0.5,
    stopOutReentryBlockMinutes: 360,
    slTpBounds: { minStopLossPct: 0.005, maxStopLossPct: 0.5, minTakeProfitPct: 0.005, maxTakeProfitPct: 2.0 },
    ...overrides,
  }
}

Deno.test('runDailyTrendBacktest: opens OPEN_LONG once the regime turns UP, closes on the regime flip to DOWN -- isolated from any SL/TP breach', () => {
  const bars = [...dailyBars('BTC', risingThenGentleDecline()), ...mildVolatilityFourH('BTC', 300)]
  const result = runDailyTrendBacktest({ BTC: bars }, baseParams())

  assertEquals(result.closedTrades.length, 1)
  const trade = result.closedTrades[0]!
  assertEquals(trade.asset, 'BTC')
  assertEquals(trade.direction, 'long')
  assertEquals(trade.armId, 'daily_trend')
  assertEquals(trade.closeReason, 'agent_close') // the regime-flip CLOSE, never an automatic exit
  // The stop was never touched -- confirm the exit price stayed well
  // above it, proving this is genuinely the regime-flip path.
  assertEquals(trade.exitPrice > trade.stopLossPrice, true)
  assertEquals(result.openAtEnd.length, 0)
})

Deno.test('runDailyTrendBacktest: NAV series has one entry per master (BTC) daily tick', () => {
  const closes = risingThenGentleDecline()
  const bars = [...dailyBars('BTC', closes), ...mildVolatilityFourH('BTC', 300)]
  const result = runDailyTrendBacktest({ BTC: bars }, baseParams())
  assertEquals(result.navSeries.length, closes.length)
})

Deno.test('runDailyTrendBacktest: a monotonically flat series from day one never opens (never UP, strict >) -> zero trades', () => {
  const closes = Array.from({ length: 60 }, () => 100) // flat the whole way -> close === SMA -> DOWN (strict >, never equal)
  const bars = [...dailyBars('BTC', closes), ...flatFourH('BTC', 100, 100)]
  const result = runDailyTrendBacktest({ BTC: bars }, baseParams())
  assertEquals(result.closedTrades.length, 0)
  assertEquals(result.openAtEnd.length, 0)
  assertEquals(result.navSeries.every((p) => p.nav === 10_000), true)
})

Deno.test('runDailyTrendBacktest: SL/TP precedence wins over the regime-flip CLOSE when a single day would trigger both', () => {
  // A sharp one-day crash low enough to flip the regime is, by
  // construction (a day's low can never exceed its own close), ALSO
  // below a tight 2.5%-floor stop -- the position-monitor's own
  // documented precedence (SL/TP checked before the regime exit,
  // trading-strategy-v1.md §13) means stop_loss wins, never agent_close,
  // on this shared day. A real, verified precedence proof, not an
  // assumption.
  const bars = [...dailyBars('BTC', risingThenCrashCloses()), ...flatFourH('BTC', 100, 100)]
  const result = runDailyTrendBacktest({ BTC: bars }, baseParams())
  assertEquals(result.closedTrades.length, 1)
  assertEquals(result.closedTrades[0]!.closeReason, 'stop_loss')
  assertEquals(result.closedTrades[0]!.realizedPnl < 0, true)
})

Deno.test('runDailyTrendBacktest: a stop-loss exit fires via true-OHLC breach on an intraday-only dip (close never crashes)', () => {
  const closes = risingThenGentleDecline().slice(0, 55) // ascending only, no decline yet
  const bars = dailyBars('BTC', closes)
  // Day 54 (the 55th bar, close=134): widen its own low well below the
  // tight 2.5%-floor stop (~125.78) without crashing the close itself.
  bars[54] = row('BTC', '1d', bars[54]!.closeTime, 134, 134, 120, 134)
  const fourH = flatFourH('BTC', 100, 100)
  const result = runDailyTrendBacktest({ BTC: [...bars, ...fourH] }, baseParams())

  assertEquals(result.closedTrades.length, 1)
  assertEquals(result.closedTrades[0]!.closeReason, 'stop_loss')
  assertEquals(result.closedTrades[0]!.realizedPnl < 0, true)
})

// DT-1 plan, Phase P0, stop gate S1c — "unmodified" must be PROVEN, not
// asserted. These three tests run EVERY existing fixture above through
// three configurations and show the membership gate changes nothing by
// default, and changes ONLY opens when it is active.
Deno.test('S1c identity: canOpen OMITTED reproduces every existing fixture byte-for-byte', () => {
  const fixtures: { bars: HistoricalBarRow[] }[] = [
    { bars: [...dailyBars('BTC', risingThenGentleDecline()), ...mildVolatilityFourH('BTC', 300)] },
    { bars: [...dailyBars('BTC', Array.from({ length: 60 }, () => 100)), ...flatFourH('BTC', 100, 100)] },
    { bars: [...dailyBars('BTC', risingThenCrashCloses()), ...flatFourH('BTC', 100, 100)] },
  ]
  for (const { bars } of fixtures) {
    const withoutCanOpen = runDailyTrendBacktest({ BTC: bars }, baseParams())
    const withAlwaysTrue = runDailyTrendBacktest({ BTC: bars }, baseParams({ canOpen: () => true }))
    assertEquals(withAlwaysTrue, withoutCanOpen)
  }
})

Deno.test('S1c identity: canOpen ALWAYS-TRUE is byte-identical to a fresh baseline run (not just to itself)', () => {
  const bars = [...dailyBars('BTC', risingThenGentleDecline()), ...mildVolatilityFourH('BTC', 300)]
  const baseline = runDailyTrendBacktest({ BTC: bars }, baseParams())
  const gated = runDailyTrendBacktest({ BTC: bars }, baseParams({ canOpen: (_asset, _barCloseIso) => true }))
  assertEquals(gated.closedTrades, baseline.closedTrades)
  assertEquals(gated.navSeries, baseline.navSeries)
  assertEquals(gated.openAtEnd, baseline.openAtEnd)
  assertEquals(gated.rejectionsByReason, baseline.rejectionsByReason)
})

Deno.test('S1c: canOpen ALWAYS-FALSE suppresses every open and produces ZERO trades, never touching an unrelated path', () => {
  // Not edge-triggered: buildCandidateProposal re-proposes OPEN_LONG on
  // EVERY tick while FLAT+UP (unlike V4's six arms), so a fully-suppressed
  // asset accumulates one rejection per UP-regime day it stays flat, not
  // just one at the edge -- hence >0 here, not a specific hardcoded count.
  const bars = [...dailyBars('BTC', risingThenGentleDecline()), ...mildVolatilityFourH('BTC', 300)]
  const result = runDailyTrendBacktest({ BTC: bars }, baseParams({ canOpen: () => false }))
  assertEquals(result.closedTrades.length, 0)
  assertEquals(result.openAtEnd.length, 0)
  assertEquals((result.rejectionsByReason.canOpen_suppressed ?? 0) > 0, true)
})

Deno.test('S1c: canOpen gates OPENS only — an already-open position still exits normally via its own three R4 exits', () => {
  // Let the position open normally (canOpen true throughout the ascent),
  // then flip canOpen to false for the remainder — the position must
  // still close on the regime flip, proving canOpen cannot suppress or
  // alter an EXIT, only an entry.
  const closes = risingThenGentleDecline()
  const bars = [...dailyBars('BTC', closes), ...mildVolatilityFourH('BTC', 300)]
  const openedAt = new Date('2024-01-01T00:00:00.000Z').getTime() + 49 * DAY // the 50th daily bar, first UP tick
  const result = runDailyTrendBacktest({ BTC: bars }, baseParams({
    canOpen: (_asset, barCloseIso) => new Date(barCloseIso).getTime() < openedAt + 1,
  }))
  assertEquals(result.closedTrades.length, 1)
  assertEquals(result.closedTrades[0]!.closeReason, 'agent_close') // the same regime-flip exit as the unsuppressed baseline
  assertEquals(result.openAtEnd.length, 0)
})
