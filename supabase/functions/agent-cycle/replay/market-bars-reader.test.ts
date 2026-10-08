import { assertEquals } from 'jsr:@std/assert@1'
import { assembleAsOfCycle } from './market-bars-reader.ts'
import type { MarketBarRow } from '../db/market-bars.ts'

function row(overrides: Partial<MarketBarRow> = {}): MarketBarRow {
  return {
    asset: 'BTC',
    timeframe: '30m',
    openTime: '2026-10-06T12:00:00.000Z',
    closeTime: '2026-10-06T12:00:00.000Z',
    open: 100, high: 101, low: 99, close: 100,
    volume: null,
    isSampled: false,
    source: 'coingecko',
    ingestedAt: '2026-10-06T12:00:30.000Z',
    batchId: 'batch-1',
    dataVersion: 'v1',
    isOffGrid: false,
    ...overrides,
  }
}

// --- the per-SERIES confirming-write rule (corrected 2026-10-06) ----------
//
// NOT a per-bar ingestedAt check — see this module's own long comment on
// why. A bar's VISIBILITY depends on whether SOME bar in its own
// (asset, timeframe) series was confirmed (ingestedAt <= cutoff), and
// then on whether ITS OWN closeTime predates that confirming write.

Deno.test('assembleAsOfCycle: with only one bar, a series ingested strictly AFTER the cycle timestamp is wholly excluded', () => {
  const bars = [row({ ingestedAt: '2026-10-06T12:15:01.000Z' })]
  const result = assembleAsOfCycle('BTC', bars, '2026-10-06T12:15:00.000Z')
  assertEquals(result.ohlc30m.length, 0)
})

Deno.test('assembleAsOfCycle: a bar ingested AT EXACTLY the cycle timestamp confirms itself (inclusive, load-bearing)', () => {
  const bars = [row({ closeTime: '2026-10-06T12:15:00.000Z', ingestedAt: '2026-10-06T12:15:00.000Z' })]
  const result = assembleAsOfCycle('BTC', bars, '2026-10-06T12:15:00.000Z')
  assertEquals(result.ohlc30m.length, 1)
})

Deno.test('assembleAsOfCycle: a series with EVERY bar ingestedAt === null (every pre-Stage-0 row, before any new bar has landed) is excluded PERMANENTLY, never approximated', () => {
  const bars = [row({ ingestedAt: null })]
  const result = assembleAsOfCycle('BTC', bars, '2099-01-01T00:00:00.000Z') // even a far-future cutoff must not rescue it
  assertEquals(result.ohlc30m.length, 0)
})

// --- THE FIX ITSELF: this is the live bug this test suite caught -------
//
// Live data showed BTC's daily series at 0/125 bars with a real
// ingestedAt (filterNewBars never re-stamps an already-stored bar), which
// under a naive per-bar rule would make daily replay impossible for ~50
// days. The fix: ONE confirmed bar in a series proves the whole window
// that fetch covered was re-verified, since this provider is always
// refetched in full, never incrementally.

Deno.test('assembleAsOfCycle: a stale, never-re-stamped bar (ingestedAt null) becomes visible once a LATER bar in the SAME series is freshly confirmed', () => {
  const bars = [
    row({ closeTime: '2026-10-05T00:00:00.000Z', ingestedAt: null, close: 1 }), // pre-Stage-0, never re-written
    row({ closeTime: '2026-10-06T00:00:00.000Z', ingestedAt: '2026-10-06T12:15:00.000Z', close: 2 }), // the one fresh write
  ]
  const result = assembleAsOfCycle('BTC', bars, '2026-10-06T12:15:00.000Z')
  assertEquals(result.ohlc30m.map((b) => b.close), [1, 2], 'both bars visible — the fresh write proves the whole window, including the stale bar, was re-confirmed')
})

Deno.test('assembleAsOfCycle: a bar whose closeTime is AFTER the series\' own confirming write is excluded, even though an EARLIER bar in the same series did confirm', () => {
  const bars = [
    row({ closeTime: '2026-10-06T12:00:00.000Z', ingestedAt: '2026-10-06T12:15:00.000Z', close: 1 }), // confirms the series through 12:00
    row({ closeTime: '2026-10-06T16:00:00.000Z', ingestedAt: null, close: 2 }), // closes AFTER that confirmation — not yet known
  ]
  const result = assembleAsOfCycle('BTC', bars, '2026-10-06T16:30:00.000Z') // cutoff is late enough, but the series was never re-confirmed past 12:00
  assertEquals(result.ohlc30m.map((b) => b.close), [1])
})

// --- the closed-bar bound (closeTime), inherited from the confirming write -

Deno.test('assembleAsOfCycle: a bar whose closeTime is strictly AFTER its own confirming ingestedAt is excluded, regardless of the outer cutoff', () => {
  const bars = [row({ closeTime: '2026-10-06T12:30:00.000Z', ingestedAt: '2026-10-06T12:00:00.000Z' })]
  const result = assembleAsOfCycle('BTC', bars, '2026-10-06T12:15:00.000Z')
  assertEquals(result.ohlc30m.length, 0)
})

Deno.test('assembleAsOfCycle: a bar whose closeTime is AT EXACTLY its own confirming ingestedAt is included (inclusive)', () => {
  const bars = [row({ closeTime: '2026-10-06T12:00:00.000Z', ingestedAt: '2026-10-06T12:00:00.000Z' })]
  const result = assembleAsOfCycle('BTC', bars, '2026-10-06T12:15:00.000Z')
  assertEquals(result.ohlc30m.length, 1)
})

// --- asset filtering ---------------------------------------------------

Deno.test('assembleAsOfCycle: only the requested asset is returned, even when other assets are present', () => {
  const bars = [row({ asset: 'BTC' }), row({ asset: 'ETH' })]
  const result = assembleAsOfCycle('BTC', bars, '2026-10-06T12:15:00.000Z')
  assertEquals(result.ohlc30m.length, 1)
})

// --- timeframe separation ------------------------------------------------

Deno.test('assembleAsOfCycle: each timeframe lands in its own series, never cross-contaminated', () => {
  const bars = [
    row({ timeframe: '1d', close: 1 }),
    row({ timeframe: '4h', close: 2 }),
    row({ timeframe: '30m', close: 3 }),
    row({ timeframe: '5m', close: 4 }),
  ]
  const result = assembleAsOfCycle('BTC', bars, '2026-10-06T12:15:00.000Z')
  assertEquals(result.dailyCloseSeries.length, 1)
  assertEquals(result.dailyCloseSeries[0]!.close, 1)
  assertEquals(result.candles.length, 1)
  assertEquals(result.candles[0]!.close, 2)
  assertEquals(result.ohlc30m.length, 1)
  assertEquals(result.ohlc30m[0]!.close, 3)
  assertEquals(result.spot5m.length, 1)
  assertEquals(result.spot5m[0]!.price, 4)
})

// --- isOffGrid quarantine (plan STRAT-1 P2, 2026-10-08) -------------------

Deno.test('assembleAsOfCycle: a 1d row flagged isOffGrid is excluded from dailyCloseSeries even though it would otherwise be visible', () => {
  const bars = [row({ timeframe: '1d', close: 1, isOffGrid: true })]
  const result = assembleAsOfCycle('BTC', bars, '2026-10-06T12:15:00.000Z')
  assertEquals(result.dailyCloseSeries.length, 0)
})

Deno.test('assembleAsOfCycle: a genuine (non-off-grid) 1d row is unaffected by the isOffGrid filter', () => {
  const bars = [row({ timeframe: '1d', close: 1, isOffGrid: false })]
  const result = assembleAsOfCycle('BTC', bars, '2026-10-06T12:15:00.000Z')
  assertEquals(result.dailyCloseSeries.length, 1)
})

Deno.test('assembleAsOfCycle: one off-grid row among several genuine 1d rows is dropped, the rest survive', () => {
  const bars = [
    row({ timeframe: '1d', openTime: '2026-10-04T00:00:00.000Z', closeTime: '2026-10-04T00:00:00.000Z', close: 1, isOffGrid: false }),
    row({ timeframe: '1d', openTime: '2026-10-05T00:00:00.000Z', closeTime: '2026-10-05T00:00:00.000Z', close: 2, isOffGrid: false }),
    row({ timeframe: '1d', openTime: '2026-10-06T05:13:10.000Z', closeTime: '2026-10-06T05:13:10.000Z', close: 3, isOffGrid: true }),
  ]
  const result = assembleAsOfCycle('BTC', bars, '2026-10-06T12:15:00.000Z')
  assertEquals(result.dailyCloseSeries.length, 2)
  assertEquals(result.dailyCloseSeries.map((p) => p.close), [1, 2])
})

// --- sorting --------------------------------------------------------------

Deno.test('assembleAsOfCycle: bars arrive sorted ascending by closeTime regardless of input order', () => {
  const bars = [
    row({ timeframe: '30m', closeTime: '2026-10-06T12:00:00.000Z', close: 1 }),
    row({ timeframe: '30m', closeTime: '2026-10-06T11:00:00.000Z', close: 2 }),
    row({ timeframe: '30m', closeTime: '2026-10-06T11:30:00.000Z', close: 3 }),
  ]
  const result = assembleAsOfCycle('BTC', bars, '2026-10-06T12:15:00.000Z')
  assertEquals(result.ohlc30m.map((b) => b.close), [2, 3, 1])
})

// --- mapping correctness ----------------------------------------------

Deno.test('assembleAsOfCycle: the output timestamp is closeTime, never openTime, even when they differ', () => {
  const bars = [row({ openTime: '2026-10-06T11:30:00.000Z', closeTime: '2026-10-06T12:00:00.000Z' })]
  const result = assembleAsOfCycle('BTC', bars, '2026-10-06T12:15:00.000Z')
  assertEquals(result.ohlc30m[0]!.timestamp, '2026-10-06T12:00:00.000Z')
})

Deno.test('assembleAsOfCycle: 5m rows map close -> price and surface volume', () => {
  const bars = [row({ timeframe: '5m', close: 42, volume: 123, isSampled: true, open: null, high: null, low: null })]
  const result = assembleAsOfCycle('BTC', bars, '2026-10-06T12:15:00.000Z')
  assertEquals(result.spot5m[0]!.price, 42)
  assertEquals(result.spot5m[0]!.volume, 123)
})

// --- the two permanent, documented gaps -----------------------------------

Deno.test('assembleAsOfCycle: closeSeries/volumeSeries are ALWAYS empty — no market_bars timeframe stores the hourly series the fade arm reads', () => {
  const bars = [row({ timeframe: '1d' }), row({ timeframe: '4h' }), row({ timeframe: '30m' }), row({ timeframe: '5m' })]
  const result = assembleAsOfCycle('BTC', bars, '2026-10-06T12:15:00.000Z')
  assertEquals(result.closeSeries, [])
  assertEquals(result.volumeSeries, [])
})

Deno.test('assembleAsOfCycle: never throws on thin/empty data — detectCandidate\'s own sufficiency check is what classifies this, not this reader', () => {
  const result = assembleAsOfCycle('BTC', [], '2026-10-06T12:15:00.000Z')
  assertEquals(result.ohlc30m.length, 0)
  assertEquals(result.dailyCloseSeries.length, 0)
})
