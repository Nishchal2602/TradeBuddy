import { assertEquals } from 'jsr:@std/assert@1'
import { rankUniverseAtFormation } from './build-universe.ts'
import type { DailyVolumeSample } from './build-universe.ts'

const FORMATION = '2026-10-01T00:00:00.000Z'

// 200 daily bars ending the day before formation, with a constant
// quoteVolume -- plenty of history/recency to pass eligibility on its own,
// isolated from the ranking logic under test.
function barsWithVolume(volume: number, count = 200): DailyVolumeSample[] {
  const endMs = new Date('2026-09-30T00:00:00.000Z').getTime()
  return Array.from({ length: count }, (_, i) => ({
    closeTimeIso: new Date(endMs - (count - 1 - i) * 86_400_000).toISOString(),
    quoteVolume: volume,
  }))
}

Deno.test('rankUniverseAtFormation: ranks strictly descending by 30-day mean quote volume', () => {
  const byAsset = new Map([
    ['BTC', barsWithVolume(1_000_000_000)],
    ['ETH', barsWithVolume(500_000_000)],
    ['DOGE', barsWithVolume(50_000_000)],
  ])
  const result = rankUniverseAtFormation(byAsset, new Set(), FORMATION)
  assertEquals(result.members.map((m) => m.underlyingId), ['BTC', 'ETH', 'DOGE'])
  assertEquals(result.members.map((m) => m.rank), [1, 2, 3])
})

Deno.test('rankUniverseAtFormation: BTC/ETH are ranked, never excluded from the universe by this module (A6)', () => {
  const byAsset = new Map([
    ['BTC', barsWithVolume(1_000_000_000)],
    ['ETH', barsWithVolume(500_000_000)],
  ])
  const result = rankUniverseAtFormation(byAsset, new Set(), FORMATION)
  assertEquals(result.members.some((m) => m.underlyingId === 'BTC'), true)
  assertEquals(result.members.some((m) => m.underlyingId === 'ETH'), true)
})

Deno.test('rankUniverseAtFormation: caps at maxUniverseSize (default 20), ranking the overflow as excluded', () => {
  const byAsset = new Map<string, DailyVolumeSample[]>()
  for (let i = 0; i < 25; i++) byAsset.set(`ASSET${i}`, barsWithVolume(25 - i)) // descending volume
  const result = rankUniverseAtFormation(byAsset, new Set(), FORMATION)
  assertEquals(result.members.length, 20)
  assertEquals(result.members[0]!.underlyingId, 'ASSET0')
  assertEquals(result.members[19]!.underlyingId, 'ASSET19')
  assertEquals(result.excluded.some((e) => e.underlyingId === 'ASSET24' && e.reason.includes('ranked below the top 20')), true)
})

Deno.test('rankUniverseAtFormation: an asset already excluded by research_contracts never enters ranking', () => {
  const byAsset = new Map([
    ['BTC', barsWithVolume(1_000_000_000)],
    ['USDC', barsWithVolume(2_000_000_000)], // higher volume than BTC but excluded
  ])
  const result = rankUniverseAtFormation(byAsset, new Set(['USDC']), FORMATION)
  assertEquals(result.members.map((m) => m.underlyingId), ['BTC'])
  assertEquals(result.excluded.some((e) => e.underlyingId === 'USDC' && e.reason.includes('excluded asset class')), true)
})

Deno.test('rankUniverseAtFormation: an ineligible asset (insufficient history) is excluded from ranking, not ranked last', () => {
  const byAsset = new Map([
    ['BTC', barsWithVolume(1_000_000_000)],
    ['NEWCOIN', barsWithVolume(10_000_000_000, 10)], // huge volume but only 10 days of history
  ])
  const result = rankUniverseAtFormation(byAsset, new Set(), FORMATION)
  assertEquals(result.members.map((m) => m.underlyingId), ['BTC'])
  assertEquals(result.excluded.some((e) => e.underlyingId === 'NEWCOIN' && e.reason.includes('insufficient history')), true)
})

Deno.test('rankUniverseAtFormation: NaN quote volume in the ranking window excludes the asset rather than corrupting its mean', () => {
  const normalBars = barsWithVolume(100)
  const withGap: DailyVolumeSample[] = normalBars.map((b, i) => (i === normalBars.length - 1 ? { ...b, quoteVolume: Number.NaN } : b))
  const byAsset = new Map([
    ['BTC', barsWithVolume(1_000_000_000)],
    ['GAPPY', withGap],
  ])
  const result = rankUniverseAtFormation(byAsset, new Set(), FORMATION)
  assertEquals(result.members.map((m) => m.underlyingId), ['BTC'])
  assertEquals(result.excluded.some((e) => e.underlyingId === 'GAPPY' && e.reason.includes('no quote_volume')), true)
})

Deno.test('rankUniverseAtFormation: the 30-day mean only ever includes samples inside the lookback window', () => {
  const endMs = new Date('2026-09-30T00:00:00.000Z').getTime()
  // 200 days of history at volume=10, except the LAST 30 days (the
  // ranking window) are at volume=1000 -- the mean must reflect only the
  // window, not the full 200-day history.
  const bars: DailyVolumeSample[] = Array.from({ length: 200 }, (_, i) => {
    const daysBeforeEnd = 199 - i
    return {
      closeTimeIso: new Date(endMs - daysBeforeEnd * 86_400_000).toISOString(),
      quoteVolume: daysBeforeEnd < 30 ? 1000 : 10,
    }
  })
  const byAsset = new Map([['SOLO', bars]])
  const result = rankUniverseAtFormation(byAsset, new Set(), FORMATION)
  assertEquals(result.members.length, 1)
  assertEquals(result.members[0]!.advUsd30d, 1000)
})

Deno.test('rankUniverseAtFormation: an empty asset map produces an empty, non-throwing result', () => {
  const result = rankUniverseAtFormation(new Map(), new Set(), FORMATION)
  assertEquals(result.members, [])
  assertEquals(result.excluded, [])
})
