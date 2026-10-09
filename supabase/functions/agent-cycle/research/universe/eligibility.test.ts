import { assertEquals } from 'jsr:@std/assert@1'
import { evaluateEligibility } from './eligibility.ts'

const FORMATION = '2026-10-01T00:00:00.000Z'

// Forward-built: `count` consecutive daily bars starting at startIso.
function dailyCloses(startIso: string, count: number): string[] {
  const start = new Date(startIso).getTime()
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86_400_000).toISOString())
}

// Backward-built: `count` consecutive daily bars ENDING exactly at endIso
// (inclusive) — spans exactly (count - 1) days. Used wherever a test
// needs an exact historyDays/stalenessDays value without hand-computing a
// start date via day-of-year arithmetic.
function dailyClosesEndingAt(endIso: string, count: number): string[] {
  const end = new Date(endIso).getTime()
  return Array.from({ length: count }, (_, i) => new Date(end - (count - 1 - i) * 86_400_000).toISOString())
}

Deno.test('evaluateEligibility: zero prior bars -> ineligible, no history', () => {
  const result = evaluateEligibility([], FORMATION)
  assertEquals(result.eligible, false)
  assertEquals(result.reason, 'no daily history before formation')
  assertEquals(result.historyDays, 0)
  assertEquals(result.mostRecentBarCloseIso, null)
})

Deno.test('evaluateEligibility: exactly 180 days of history, active at formation -> eligible', () => {
  // 181 bars ending 2026-09-30 (1 day before formation) span exactly 180 days.
  const bars = dailyClosesEndingAt('2026-09-30T00:00:00.000Z', 181)
  const result = evaluateEligibility(bars, FORMATION)
  assertEquals(result.historyDays, 180)
  assertEquals(result.eligible, true)
  assertEquals(result.reason, null)
})

Deno.test('evaluateEligibility: 179 days of history -> ineligible (insufficient history)', () => {
  // 180 bars ending 2026-09-30 span exactly 179 days.
  const bars = dailyClosesEndingAt('2026-09-30T00:00:00.000Z', 180)
  const result = evaluateEligibility(bars, FORMATION)
  assertEquals(result.historyDays, 179)
  assertEquals(result.eligible, false)
  assertEquals(result.reason?.startsWith('insufficient history'), true)
})

Deno.test('evaluateEligibility: plenty of history but most recent bar is stale -> ineligible (not active)', () => {
  const bars = dailyClosesEndingAt('2026-01-01T00:00:00.000Z', 200) // ends ~9 months before formation
  const result = evaluateEligibility(bars, FORMATION)
  assertEquals(result.eligible, false)
  assertEquals(result.reason?.startsWith('not active at formation'), true)
})

Deno.test('evaluateEligibility: a bar at or after the formation instant is never counted as "prior"', () => {
  const bars = [...dailyClosesEndingAt('2026-09-30T00:00:00.000Z', 181), FORMATION, '2026-10-02T00:00:00.000Z']
  const result = evaluateEligibility(bars, FORMATION)
  assertEquals(result.mostRecentBarCloseIso, '2026-09-30T00:00:00.000Z')
  assertEquals(result.eligible, true)
})

Deno.test('evaluateEligibility: staleness boundary is exclusive of the max -- exactly maxStalenessDays is still eligible', () => {
  // 181 bars ending exactly 10 days before formation: 180 days of history, 10 days stale.
  const bars = dailyClosesEndingAt('2026-09-21T00:00:00.000Z', 181)
  const result = evaluateEligibility(bars, FORMATION, { maxStalenessDays: 10 })
  assertEquals(result.mostRecentBarCloseIso, '2026-09-21T00:00:00.000Z')
  assertEquals(result.eligible, true)
})

Deno.test('evaluateEligibility: one day past the staleness max is ineligible', () => {
  const bars = dailyClosesEndingAt('2026-09-20T00:00:00.000Z', 181) // 11 days stale
  const result = evaluateEligibility(bars, FORMATION, { maxStalenessDays: 10 })
  assertEquals(result.eligible, false)
  assertEquals(result.reason?.startsWith('not active at formation'), true)
})

Deno.test('evaluateEligibility: unordered input is handled identically to ordered input', () => {
  const ordered = dailyClosesEndingAt('2026-09-30T00:00:00.000Z', 181)
  const shuffled = [...ordered].reverse()
  assertEquals(evaluateEligibility(ordered, FORMATION), evaluateEligibility(shuffled, FORMATION))
})

Deno.test('evaluateEligibility: custom minHistoryDays/maxStalenessDays are honored', () => {
  const bars = dailyCloses('2026-09-01T00:00:00.000Z', 25) // 24 days of history, ends 2026-09-25
  assertEquals(evaluateEligibility(bars, FORMATION, { minHistoryDays: 20 }).eligible, true)
  assertEquals(evaluateEligibility(bars, FORMATION, { minHistoryDays: 30 }).eligible, false)
})
