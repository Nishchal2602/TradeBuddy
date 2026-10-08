import { assertEquals } from 'jsr:@std/assert@1'
import { resampleNavToDailyCloseUtc } from './daily-resample.ts'

Deno.test('resampleNavToDailyCloseUtc: a 30-minute series collapses to one point per UTC day, keeping the LAST tick', () => {
  const navSeries = [
    { timestamp: '2024-01-01T00:00:00.000Z', nav: 100 },
    { timestamp: '2024-01-01T00:30:00.000Z', nav: 101 },
    { timestamp: '2024-01-01T23:30:00.000Z', nav: 105 }, // last tick of day 1
    { timestamp: '2024-01-02T00:00:00.000Z', nav: 106 },
    { timestamp: '2024-01-02T12:00:00.000Z', nav: 103 }, // last tick of day 2
  ]
  const resampled = resampleNavToDailyCloseUtc(navSeries)
  assertEquals(resampled, [
    { timestamp: '2024-01-01T23:30:00.000Z', nav: 105 },
    { timestamp: '2024-01-02T12:00:00.000Z', nav: 103 },
  ])
})

Deno.test('resampleNavToDailyCloseUtc: an already-daily series passes through with one point per day, unchanged in count', () => {
  const navSeries = [
    { timestamp: '2024-01-01T00:00:00.000Z', nav: 100 },
    { timestamp: '2024-01-02T00:00:00.000Z', nav: 101 },
    { timestamp: '2024-01-03T00:00:00.000Z', nav: 102 },
  ]
  const resampled = resampleNavToDailyCloseUtc(navSeries)
  assertEquals(resampled.length, 3)
  assertEquals(resampled, navSeries)
})

Deno.test('resampleNavToDailyCloseUtc: empty input returns empty output, never throws', () => {
  assertEquals(resampleNavToDailyCloseUtc([]), [])
})

Deno.test('resampleNavToDailyCloseUtc: output preserves chronological day order even with many ticks per day', () => {
  const navSeries = Array.from({ length: 300 }, (_, i) => ({
    timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + i * 30 * 60_000).toISOString(),
    nav: 10_000 + i,
  }))
  const resampled = resampleNavToDailyCloseUtc(navSeries)
  // 300 30-minute ticks = 6.25 days -> 7 distinct UTC calendar days touched
  assertEquals(resampled.length, 7)
  for (let i = 1; i < resampled.length; i++) {
    assertEquals(new Date(resampled[i]!.timestamp).getTime() > new Date(resampled[i - 1]!.timestamp).getTime(), true)
  }
})
