import { assertEquals } from 'jsr:@std/assert@1'
import { assembleSnapshotAsOf } from './historical-bars-reader.ts'
import type { HistoricalBarRow } from './db/historical-bars.ts'

function row(overrides: Partial<HistoricalBarRow> = {}): HistoricalBarRow {
  return {
    asset: 'BTC',
    timeframe: '30m',
    openTime: '2026-10-06T12:00:00.000Z',
    closeTime: '2026-10-06T12:30:00.000Z',
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
    ...overrides,
  }
}

Deno.test('assembleSnapshotAsOf: a bar whose closeTime is after the cutoff is excluded', () => {
  const bars = [row({ closeTime: '2026-10-06T13:00:00.000Z' })]
  const result = assembleSnapshotAsOf('BTC', bars, '2026-10-06T12:30:00.000Z')
  assertEquals(result.bars30m.length, 0)
})

Deno.test('assembleSnapshotAsOf: a bar at exactly the cutoff is included (inclusive)', () => {
  const bars = [row({ closeTime: '2026-10-06T12:30:00.000Z' })]
  const result = assembleSnapshotAsOf('BTC', bars, '2026-10-06T12:30:00.000Z')
  assertEquals(result.bars30m.length, 1)
})

Deno.test('assembleSnapshotAsOf: each timeframe lands in its own series, never cross-contaminated', () => {
  const bars = [
    row({ timeframe: '1d', close: 1 }),
    row({ timeframe: '4h', close: 2 }),
    row({ timeframe: '1h', close: 3 }),
    row({ timeframe: '30m', close: 4 }),
  ]
  const result = assembleSnapshotAsOf('BTC', bars, '2026-10-06T12:30:00.000Z')
  assertEquals(result.dailyCloses.length, 1)
  assertEquals(result.dailyCloses[0]!.close, 1)
  assertEquals(result.h4Candles.length, 1)
  assertEquals(result.h4Candles[0]!.close, 2)
  assertEquals(result.hourlyCloses.length, 1)
  assertEquals(result.hourlyCloses[0]!.close, 3)
  assertEquals(result.bars30m.length, 1)
  assertEquals(result.bars30m[0]!.close, 4)
})

Deno.test('assembleSnapshotAsOf: only the requested asset is returned, even when other assets are present', () => {
  const bars = [row({ asset: 'BTC' }), row({ asset: 'ETH' })]
  const result = assembleSnapshotAsOf('BTC', bars, '2026-10-06T12:30:00.000Z')
  assertEquals(result.bars30m.length, 1)
})

Deno.test('assembleSnapshotAsOf: bars arrive sorted ascending by closeTime regardless of input order', () => {
  const bars = [
    row({ closeTime: '2026-10-06T12:30:00.000Z', close: 1 }),
    row({ closeTime: '2026-10-06T11:30:00.000Z', close: 2 }),
    row({ closeTime: '2026-10-06T12:00:00.000Z', close: 3 }),
  ]
  const result = assembleSnapshotAsOf('BTC', bars, '2026-10-06T12:30:00.000Z')
  assertEquals(result.bars30m.map((b) => b.close), [2, 3, 1])
})

Deno.test('assembleSnapshotAsOf: price and asOfIso come from the latest visible 30m bar / the cutoff itself', () => {
  const bars = [row({ closeTime: '2026-10-06T12:00:00.000Z', close: 50 }), row({ closeTime: '2026-10-06T12:30:00.000Z', close: 55 })]
  const result = assembleSnapshotAsOf('BTC', bars, '2026-10-06T12:30:00.000Z')
  assertEquals(result.price, 55)
  assertEquals(result.asOfIso, '2026-10-06T12:30:00.000Z')
})

Deno.test('assembleSnapshotAsOf: volumes30m is aligned 1:1 with bars30m, same order', () => {
  const bars = [
    row({ closeTime: '2026-10-06T12:00:00.000Z', close: 1, volume: 7 }),
    row({ closeTime: '2026-10-06T12:30:00.000Z', close: 2, volume: 9 }),
  ]
  const result = assembleSnapshotAsOf('BTC', bars, '2026-10-06T12:30:00.000Z')
  assertEquals(result.volumes30m, [7, 9])
})

Deno.test('assembleSnapshotAsOf: hourlyVolumes carries real per-bar volume (TRUE, unlike market_bars\' rolling-24h artifact)', () => {
  const bars = [row({ timeframe: '1h', closeTime: '2026-10-06T12:00:00.000Z', volume: 123.45 })]
  const result = assembleSnapshotAsOf('BTC', bars, '2026-10-06T12:30:00.000Z')
  assertEquals(result.hourlyVolumes, [{ timestamp: '2026-10-06T12:00:00.000Z', volume: 123.45 }])
})

Deno.test('assembleSnapshotAsOf: no bars at all -> every series empty, price 0, never throws', () => {
  const result = assembleSnapshotAsOf('BTC', [], '2026-10-06T12:30:00.000Z')
  assertEquals(result.bars30m.length, 0)
  assertEquals(result.dailyCloses.length, 0)
  assertEquals(result.price, 0)
})
