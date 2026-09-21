import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import {
  aggregateOtherOpenPositionsRisk,
  buildAssetInput,
  buildOpenPositionInput,
  buildPortfolioConstraints,
  buildRiskGateContext,
  checkMarketDataFreshness,
  deriveBlockedDirections,
  toNewsInput,
} from './build-context.ts'
import type { NormalizedMarketData, OhlcCandle, VolumePoint } from '../../../../src/shared/market-data/types.ts'
import type { Position } from '../../../../src/shared/positions/types.ts'
import type { RegimeResult } from '../../../../src/shared/strategy/types.ts'

const NOW = '2026-09-19T12:00:00.000Z'

// buildAssetInput just threads regime straight onto AssetInput.regime —
// evaluateTrendRegime's own correctness is regime.test.ts's job, not
// this module's. A single static fixture is enough here.
const FIXTURE_REGIME: RegimeResult = { regime: 'UP', dailyClose: 105, dailyMa: 100, barsUsed: 50 }

// A minimal indicator-computable fixture — not testing indicator
// correctness here (calculate.test.ts already does exhaustively), just
// that this module correctly threads the computed values through.
function marketData(overrides: Partial<NormalizedMarketData> = {}): NormalizedMarketData {
  const closeSeries = Array.from({ length: 60 }, (_, i) => ({ timestamp: new Date(new Date(NOW).getTime() - (59 - i) * 3_600_000).toISOString(), close: 100 + Math.sin(i / 5) * 5 }))
  const volumeSeries: VolumePoint[] = closeSeries.map((p) => ({ timestamp: p.timestamp, volume: 1000 }))
  const candles: OhlcCandle[] = Array.from({ length: 45 }, (_, i) => {
    const ts = new Date(new Date(NOW).getTime() - (44 - i) * ((7 * 24 * 3_600_000) / 45)).toISOString()
    return { timestamp: ts, open: 100, high: 102, low: 98, close: 100 }
  })
  // 60 closed daily bars by default — comfortably over TREND_MA_LOOKBACK_
  // DAYS (50) so the sufficiency check in checkMarketDataFreshness passes
  // unless a test deliberately overrides this to exercise it.
  const dailyCloseSeries = Array.from({ length: 60 }, (_, i) => ({
    timestamp: new Date(new Date(NOW).getTime() - (59 - i) * 86_400_000).toISOString(),
    close: 100 + Math.sin(i / 10) * 5,
  }))
  return {
    asset: 'BTC',
    provider: 'test-fixture',
    dataAsOf: NOW,
    fetchedAt: NOW,
    price: 100,
    change1hPct: 0.1,
    change24hPct: 1,
    change7dPct: -1,
    candles,
    closeSeries,
    volumeSeries,
    dailyCloseSeries,
    ...overrides,
  }
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    portfolioId: '22222222-2222-2222-2222-222222222222',
    asset: 'BTC',
    direction: 'long',
    quantity: 1,
    entryPrice: 100,
    costBasis: 100,
    stopLossPrice: 95,
    takeProfitPrice: 110,
    status: 'open',
    openedAt: '2026-09-19T06:00:00.000Z', // 6h before NOW
    closedAt: null,
    realizedPnl: null,
    closeReason: null,
    openedByDecisionId: '33333333-3333-3333-3333-333333333333',
    closedByDecisionId: null,
    ...overrides,
  }
}

// --- checkMarketDataFreshness --------------------------------------------

Deno.test('checkMarketDataFreshness: fresh data for all assets passes', () => {
  const result = checkMarketDataFreshness([marketData({ dataAsOf: NOW })], 30, NOW)
  assertEquals(result.fresh, true)
})

Deno.test('checkMarketDataFreshness: one stale asset among several fails the whole check', () => {
  const fresh = marketData({ asset: 'BTC', dataAsOf: NOW })
  const stale = marketData({ asset: 'ETH', dataAsOf: '2026-09-19T11:00:00.000Z' }) // 60 min old
  const result = checkMarketDataFreshness([fresh, stale], 30, NOW)
  assertEquals(result.fresh, false)
  if (!result.fresh) assertEquals(result.reason.includes('ETH'), true)
})

Deno.test('checkMarketDataFreshness: exactly at the staleness threshold is still fresh (boundary inclusive)', () => {
  const result = checkMarketDataFreshness([marketData({ dataAsOf: '2026-09-19T11:30:00.000Z' })], 30, NOW)
  assertEquals(result.fresh, true)
})

Deno.test('checkMarketDataFreshness: fewer than TREND_MA_LOOKBACK_DAYS closed daily bars fails closed, even when dataAsOf is fresh', () => {
  const short = marketData({ dailyCloseSeries: Array.from({ length: 49 }, (_, i) => ({ timestamp: NOW, close: 100 + i })) })
  const result = checkMarketDataFreshness([short], 30, NOW)
  assertEquals(result.fresh, false)
  if (!result.fresh) {
    assertEquals(result.reason.includes('49'), true)
    assertEquals(result.reason.includes('50'), true)
  }
})

Deno.test('checkMarketDataFreshness: exactly TREND_MA_LOOKBACK_DAYS closed daily bars passes (boundary inclusive)', () => {
  const exact = marketData({ dailyCloseSeries: Array.from({ length: 50 }, (_, i) => ({ timestamp: NOW, close: 100 + i })) })
  const result = checkMarketDataFreshness([exact], 30, NOW)
  assertEquals(result.fresh, true)
})

// --- deriveBlockedDirections ----------------------------------------------

Deno.test('deriveBlockedDirections: no recent stop-loss close -> nothing blocked', () => {
  assertEquals(deriveBlockedDirections(null, 360, NOW), [])
})

Deno.test('deriveBlockedDirections: inside the block window -> that direction blocked', () => {
  const result = deriveBlockedDirections({ direction: 'long', closedAt: '2026-09-19T10:00:00.000Z' }, 360, NOW) // 120 min ago
  assertEquals(result, ['long'])
})

Deno.test('deriveBlockedDirections: outside the block window -> nothing blocked', () => {
  const result = deriveBlockedDirections({ direction: 'short', closedAt: '2026-09-19T04:00:00.000Z' }, 360, NOW) // 480 min ago
  assertEquals(result, [])
})

// --- toNewsInput / buildOpenPositionInput ---------------------------------

Deno.test('toNewsInput: computes ageMinutes from publishedAt relative to nowIso', () => {
  const result = toNewsInput({ id: 'n1', source: 'Cointelegraph', headline: 'h', summary: null, publishedAt: '2026-09-19T11:00:00.000Z' }, NOW)
  assertAlmostEquals(result.ageMinutes, 60, 1e-9)
})

Deno.test('buildOpenPositionInput: computes unrealizedPnlPct and heldHours correctly for a long', () => {
  const result = buildOpenPositionInput(position(), 110, NOW, [{ text: 'reaffirmed thesis' }])
  assertAlmostEquals(result.unrealizedPnlPct, 0.10, 1e-9) // (110-100)/100
  assertAlmostEquals(result.heldHours, 6, 1e-9)
  assertEquals(result.openInvalidation, [{ text: 'reaffirmed thesis' }])
})

Deno.test('buildOpenPositionInput: a short profits when price falls, not rises', () => {
  const short = position({ direction: 'short', entryPrice: 100 })
  const result = buildOpenPositionInput(short, 90, NOW, [])
  assertAlmostEquals(result.unrealizedPnlPct, 0.10, 1e-9) // (100-90)/100
})

// --- buildAssetInput -------------------------------------------------------

Deno.test('buildAssetInput: FLAT asset (no position) -> state FLAT, position null, indicators/news/blocked all populated', () => {
  const result = buildAssetInput({
    asset: 'BTC',
    marketData: marketData(),
    news: [{ id: 'n1', source: 'CoinDesk', headline: 'BTC rallies', summary: null, publishedAt: '2026-09-19T11:30:00.000Z' }],
    openPosition: null,
    openInvalidation: [],
    recentDecisions: [],
    recentStopLossClose: null,
    stopOutReentryBlockMinutes: 360,
    nowIso: NOW,
    regime: FIXTURE_REGIME,
  })
  assertEquals(result.state, 'FLAT')
  assertEquals(result.position, null)
  assertEquals(result.news.length, 1)
  assertEquals(result.news[0]!.id, 'n1')
  assertEquals(result.blockedDirections, [])
  assertEquals(typeof result.market.indicators.rsi14, 'number')
  assertEquals(result.regime, FIXTURE_REGIME)
})

Deno.test('buildAssetInput: LONG asset -> state LONG, position populated with SL/TP and invalidation', () => {
  const result = buildAssetInput({
    asset: 'BTC',
    marketData: marketData(),
    news: [],
    openPosition: position(),
    openInvalidation: [{ text: 'price breaks 50-EMA' }],
    recentDecisions: [],
    recentStopLossClose: null,
    stopOutReentryBlockMinutes: 360,
    nowIso: NOW,
    regime: FIXTURE_REGIME,
  })
  assertEquals(result.state, 'LONG')
  assertEquals(result.position?.stopLossPrice, 95)
  assertEquals(result.position?.openInvalidation, [{ text: 'price breaks 50-EMA' }])
})

// --- buildPortfolioConstraints / buildRiskGateContext ---------------------

Deno.test('buildPortfolioConstraints: maps appetite + bounds into the payload shape', () => {
  const result = buildPortfolioConstraints(0.65, { minStopLossPct: 0.005, maxStopLossPct: 0.15, minTakeProfitPct: 0.005, maxTakeProfitPct: 0.5 })
  assertEquals(result, { minConfidence: 0.65, minStopLossPct: 0.005, maxStopLossPct: 0.15, minTakeProfitPct: 0.005, maxTakeProfitPct: 0.5 })
})

Deno.test('buildRiskGateContext: currentAssetExposureUsd is always 0 (V0 has no pyramiding), currentState derived correctly', () => {
  const ctx = buildRiskGateContext({
    asset: 'BTC',
    entryPrice: 100,
    nav: 10_000,
    cash: 10_000,
    openPosition: position(),
    appetite: { minConfidence: 0.65, riskBudgetPct: 0.01 },
    maxSingleTradePct: 0.2,
    maxAssetExposurePct: 0.35,
    slTpBounds: { minStopLossPct: 0.005, maxStopLossPct: 0.15, minTakeProfitPct: 0.005, maxTakeProfitPct: 0.5 },
    stopOutReentryBlockMinutes: 360,
    recentStopLossClose: null,
    nowIso: NOW,
    portfolioRiskCeilingUsd: 75,
    otherOpenPositionsRiskAtStopUsd: 20,
    maxTotalNotionalUsd: 3000,
    otherSameDirectionNotionalUsd: 1500,
    peakNav: 10_000,
    drawdownBreakerFloorPct: 0.90,
  })
  assertEquals(ctx.currentState, 'LONG')
  assertEquals(ctx.currentAssetExposureUsd, 0)
  assertEquals(ctx.effectiveMinConfidence, 0.65)
})

Deno.test('buildRiskGateContext: threads every trading-strategy-v1.md §17 portfolio-risk field through unchanged', () => {
  const ctx = buildRiskGateContext({
    asset: 'BTC',
    entryPrice: 100,
    nav: 10_000,
    cash: 10_000,
    openPosition: null,
    appetite: { minConfidence: 0, riskBudgetPct: 0.005 },
    maxSingleTradePct: 0.2,
    maxAssetExposurePct: 0.35,
    slTpBounds: { minStopLossPct: 0.005, maxStopLossPct: 0.15, minTakeProfitPct: 0.005, maxTakeProfitPct: 0.9 },
    stopOutReentryBlockMinutes: 360,
    recentStopLossClose: null,
    nowIso: NOW,
    portfolioRiskCeilingUsd: 75,
    otherOpenPositionsRiskAtStopUsd: 20,
    maxTotalNotionalUsd: 3000,
    otherSameDirectionNotionalUsd: 1500,
    peakNav: 12_000,
    drawdownBreakerFloorPct: 0.90,
  })
  assertEquals(ctx.portfolioRiskCeilingUsd, 75)
  assertEquals(ctx.otherOpenPositionsRiskAtStopUsd, 20)
  assertEquals(ctx.maxTotalNotionalUsd, 3000)
  assertEquals(ctx.otherSameDirectionNotionalUsd, 1500)
  assertEquals(ctx.peakNav, 12_000)
  assertEquals(ctx.drawdownBreakerFloorPct, 0.90)
})

// --- aggregateOtherOpenPositionsRisk ---------------------------------------

Deno.test('aggregateOtherOpenPositionsRisk: excludes the candidate asset itself', () => {
  const btc = position({ asset: 'BTC', quantity: 1, entryPrice: 100, stopLossPrice: 95 })
  const result = aggregateOtherOpenPositionsRisk([btc], 'BTC', new Map())
  assertEquals(result, { otherOpenPositionsRiskAtStopUsd: 0, otherSameDirectionNotionalUsd: 0 })
})

Deno.test('aggregateOtherOpenPositionsRisk: risk-at-stop is quantity x the stop distance from entry, not notional x a re-derived pct', () => {
  const eth = position({ asset: 'ETH', quantity: 2, entryPrice: 3_000, stopLossPrice: 2_940 }) // 2 x 60 = 120
  const result = aggregateOtherOpenPositionsRisk([eth], 'BTC', new Map([['ETH', 3_050]]))
  assertAlmostEquals(result.otherOpenPositionsRiskAtStopUsd, 120, 1e-9)
})

Deno.test('aggregateOtherOpenPositionsRisk: same-direction notional values at the LIVE price, not entry price', () => {
  const eth = position({ asset: 'ETH', direction: 'long', quantity: 2, entryPrice: 3_000, stopLossPrice: 2_940 })
  const result = aggregateOtherOpenPositionsRisk([eth], 'BTC', new Map([['ETH', 3_100]]))
  assertAlmostEquals(result.otherSameDirectionNotionalUsd, 6_200, 1e-9) // 2 x 3100, not 2 x 3000
})

Deno.test('aggregateOtherOpenPositionsRisk: falls back to entryPrice when the asset is missing from latestPriceByAsset', () => {
  const eth = position({ asset: 'ETH', direction: 'long', quantity: 2, entryPrice: 3_000, stopLossPrice: 2_940 })
  const result = aggregateOtherOpenPositionsRisk([eth], 'BTC', new Map())
  assertAlmostEquals(result.otherSameDirectionNotionalUsd, 6_000, 1e-9) // 2 x 3000 (entryPrice fallback)
})

Deno.test('aggregateOtherOpenPositionsRisk: a short position counts toward risk-at-stop but NOT same-direction notional (V1 is long-only)', () => {
  const legacyShort = position({ asset: 'ETH', direction: 'short', quantity: 1, entryPrice: 3_000, stopLossPrice: 3_060 })
  const result = aggregateOtherOpenPositionsRisk([legacyShort], 'BTC', new Map([['ETH', 3_000]]))
  assertAlmostEquals(result.otherOpenPositionsRiskAtStopUsd, 60, 1e-9)
  assertEquals(result.otherSameDirectionNotionalUsd, 0)
})

Deno.test('aggregateOtherOpenPositionsRisk: no other open positions -> both aggregates zero', () => {
  const result = aggregateOtherOpenPositionsRisk([], 'BTC', new Map())
  assertEquals(result, { otherOpenPositionsRiskAtStopUsd: 0, otherSameDirectionNotionalUsd: 0 })
})
