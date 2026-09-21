import { assertEquals } from 'jsr:@std/assert@1'
import { closedPoints } from './closed-bars.ts'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function point(iso: string) {
  return { timestamp: iso, value: 1 }
}

Deno.test('closedPoints: drops a trailing point with a gap shorter than the expected interval', () => {
  const points = [
    point('2026-09-19T00:00:00.000Z'),
    point('2026-09-20T00:00:00.000Z'),
    point('2026-09-21T00:00:00.000Z'),
    point('2026-09-21T05:43:00.000Z'), // ~5.7h gap, < 24h — the live point
  ]
  const result = closedPoints(points, DAY)
  assertEquals(result.length, 3)
  assertEquals(result[result.length - 1]!.timestamp, '2026-09-21T00:00:00.000Z')
})

Deno.test('closedPoints: keeps everything when the series already ends on a genuine full-interval point', () => {
  const points = [
    point('2026-09-19T00:00:00.000Z'),
    point('2026-09-20T00:00:00.000Z'),
    point('2026-09-21T00:00:00.000Z'),
  ]
  const result = closedPoints(points, DAY)
  assertEquals(result.length, 3)
  assertEquals(result, points)
})

Deno.test('closedPoints: a gap exactly equal to the expected interval is not dropped (boundary inclusive)', () => {
  const points = [point('2026-09-20T00:00:00.000Z'), point('2026-09-21T00:00:00.000Z')]
  const result = closedPoints(points, DAY)
  assertEquals(result.length, 2)
})

Deno.test('closedPoints: fewer than 2 points is returned unchanged, nothing to compare', () => {
  assertEquals(closedPoints([], DAY), [])
  const single = [point('2026-09-21T00:00:00.000Z')]
  assertEquals(closedPoints(single, DAY), single)
})

Deno.test('closedPoints: real live-observed hourly gap (43.8min vs 60min interval) is dropped', () => {
  const points = [
    point('2026-09-21T04:00:00.000Z'),
    point('2026-09-21T05:00:00.000Z'),
    point('2026-09-21T05:43:50.000Z'), // live-observed 43.833min gap
  ]
  const result = closedPoints(points, HOUR)
  assertEquals(result.length, 2)
})

Deno.test('closedPoints: real live-observed 5-minute gap (4.17min vs 5min interval) is dropped', () => {
  const FIVE_MIN = 5 * 60 * 1000
  const points = [
    point('2026-09-21T05:35:00.000Z'),
    point('2026-09-21T05:40:00.000Z'),
    point('2026-09-21T05:44:10.000Z'), // live-observed 4.167min gap
  ]
  const result = closedPoints(points, FIVE_MIN)
  assertEquals(result.length, 2)
})

Deno.test('closedPoints: does not mutate the input array', () => {
  const points = [
    point('2026-09-20T00:00:00.000Z'),
    point('2026-09-21T00:00:00.000Z'),
    point('2026-09-21T05:43:00.000Z'),
  ]
  const before = [...points]
  closedPoints(points, DAY)
  assertEquals(points, before)
})
