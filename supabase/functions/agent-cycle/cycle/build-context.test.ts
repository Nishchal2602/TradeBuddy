import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import {
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

const NOW = '2026-09-19T12:00:00.000Z'

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
  })
  assertEquals(result.state, 'FLAT')
  assertEquals(result.position, null)
  assertEquals(result.news.length, 1)
  assertEquals(result.news[0]!.id, 'n1')
  assertEquals(result.blockedDirections, [])
  assertEquals(typeof result.market.indicators.rsi14, 'number')
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
  })
  assertEquals(ctx.currentState, 'LONG')
  assertEquals(ctx.currentAssetExposureUsd, 0)
  assertEquals(ctx.effectiveMinConfidence, 0.65)
})
