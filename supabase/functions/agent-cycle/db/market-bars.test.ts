import { assertEquals } from 'jsr:@std/assert@1'
import {
  barsFromCloseSeries,
  barsFromOhlcCandles,
  barsFromSpotPoints,
  filterNewBars,
  marketBarsFromIntradayMarketData,
  marketBarsFromNormalizedMarketData,
} from './market-bars.ts'
import type { MarketBarRow } from './market-bars.ts'
import type { NormalizedMarketData, OhlcCandle } from '../../../../src/shared/market-data/types.ts'
import type { IntradayMarketData, IntradaySpotPoint } from '../strategy/aggressive/types.ts'

function candle(overrides: Partial<OhlcCandle> = {}): OhlcCandle {
  return { timestamp: '2026-10-01T04:00:00.000Z', open: 100, high: 105, low: 98, close: 103, ...overrides }
}

function spotPoint(overrides: Partial<IntradaySpotPoint> = {}): IntradaySpotPoint {
  return { timestamp: '2026-10-01T09:55:00.000Z', price: 83700, volume: 12.5, ...overrides }
}

Deno.test('barsFromOhlcCandles: maps every field, true OHLC, isSampled=false', () => {
  const rows = barsFromOhlcCandles('BTC', '4h', [candle()])
  assertEquals(rows, [{
    asset: 'BTC', timeframe: '4h', openTime: '2026-10-01T04:00:00.000Z',
    open: 100, high: 105, low: 98, close: 103, volume: null, isSampled: false,
  }])
})

Deno.test('barsFromCloseSeries: close only, open/high/low/volume null, isSampled=true', () => {
  const rows = barsFromCloseSeries('ETH', '1d', [{ timestamp: '2026-09-30T00:00:00.000Z', close: 2700 }])
  assertEquals(rows, [{
    asset: 'ETH', timeframe: '1d', openTime: '2026-09-30T00:00:00.000Z',
    open: null, high: null, low: null, close: 2700, volume: null, isSampled: true,
  }])
})

Deno.test('barsFromSpotPoints: price becomes close, volume carried, isSampled=true', () => {
  const rows = barsFromSpotPoints('BTC', '5m', [spotPoint()])
  assertEquals(rows, [{
    asset: 'BTC', timeframe: '5m', openTime: '2026-10-01T09:55:00.000Z',
    open: null, high: null, low: null, close: 83700, volume: 12.5, isSampled: true,
  }])
})

Deno.test('marketBarsFromNormalizedMarketData: combines candles (4h) and dailyCloseSeries (1d), nothing else', () => {
  const data = {
    asset: 'BTC',
    candles: [candle()],
    dailyCloseSeries: [{ timestamp: '2026-09-30T00:00:00.000Z', close: 83000 }],
  } as unknown as NormalizedMarketData
  const rows = marketBarsFromNormalizedMarketData(data)
  assertEquals(rows.map((r) => r.timeframe).sort(), ['1d', '4h'])
  assertEquals(rows.length, 2)
})

Deno.test('marketBarsFromIntradayMarketData: combines ohlc30m (30m) and spot5m (5m), nothing else', () => {
  const intraday: IntradayMarketData = {
    asset: 'BTC',
    ohlc30m: [candle()],
    spot5m: [spotPoint()],
  }
  const rows = marketBarsFromIntradayMarketData(intraday)
  assertEquals(rows.map((r) => r.timeframe).sort(), ['30m', '5m'])
  assertEquals(rows.length, 2)
})

function barAt(iso: string): MarketBarRow {
  return { asset: 'BTC', timeframe: '5m', openTime: iso, open: null, high: null, low: null, close: 1, volume: null, isSampled: true }
}

Deno.test('filterNewBars: null stored max -> every row passes (first fill)', () => {
  const rows = [barAt('2026-10-01T09:00:00.000Z'), barAt('2026-10-01T09:05:00.000Z')]
  assertEquals(filterNewBars(rows, null), rows)
})

Deno.test('filterNewBars: strictly newer than stored max passes, equal or older is dropped', () => {
  const rows = [barAt('2026-10-01T08:55:00.000Z'), barAt('2026-10-01T09:00:00.000Z'), barAt('2026-10-01T09:05:00.000Z')]
  const result = filterNewBars(rows, '2026-10-01T09:00:00.000Z')
  assertEquals(result, [barAt('2026-10-01T09:05:00.000Z')])
})

Deno.test('filterNewBars: every row at or before the stored max -> empty result', () => {
  const rows = [barAt('2026-10-01T08:00:00.000Z'), barAt('2026-10-01T09:00:00.000Z')]
  assertEquals(filterNewBars(rows, '2026-10-01T09:00:00.000Z'), [])
})
