import { assertEquals } from 'jsr:@std/assert@1'
import { closedPoints, gridAlignedTail, reconcileClosedBar } from './closed-bars.ts'

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

// --- gridAlignedTail (2026-10-08, plan STRAT-1 P2) ------------------------

Deno.test('gridAlignedTail: a series already ending on a genuine midnight-aligned point is unchanged', () => {
  const points = [point('2026-10-05T00:00:00.000Z'), point('2026-10-06T00:00:00.000Z'), point('2026-10-07T00:00:00.000Z')]
  assertEquals(gridAlignedTail(points, DAY), points)
})

Deno.test('gridAlignedTail: the real failing case — closedPoints left a live point behind because its gap looked >= 24h', () => {
  // The exact live scenario: CoinGecko omitted today's own 00:00 point, so
  // the trailing live point's gap from yesterday's 00:00 is >24h and
  // closedPoints (gap-based) does not drop it, even though it is not
  // midnight-aligned.
  const points = [
    point('2026-10-06T00:00:00.000Z'),
    point('2026-10-07T00:00:00.000Z'),
    point('2026-10-08T05:13:10.000Z'), // live spot, mislabeled as "today's close"
  ]
  const result = gridAlignedTail(points, DAY)
  assertEquals(result.length, 2)
  assertEquals(result[result.length - 1]!.timestamp, '2026-10-07T00:00:00.000Z')
})

Deno.test('gridAlignedTail: trims more than one trailing off-grid point, defensively', () => {
  const points = [
    point('2026-10-06T00:00:00.000Z'),
    point('2026-10-07T12:00:00.000Z'), // off-grid
    point('2026-10-07T18:00:00.000Z'), // off-grid
  ]
  const result = gridAlignedTail(points, DAY)
  assertEquals(result, [point('2026-10-06T00:00:00.000Z')])
})

Deno.test('gridAlignedTail: an empty series is returned unchanged', () => {
  assertEquals(gridAlignedTail([], DAY), [])
})

Deno.test('gridAlignedTail: every point off-grid trims down to empty, never throws', () => {
  const points = [point('2026-10-07T12:00:00.000Z'), point('2026-10-08T05:13:10.000Z')]
  assertEquals(gridAlignedTail(points, DAY), [])
})

Deno.test('gridAlignedTail: does not mutate the input array', () => {
  const points = [point('2026-10-06T00:00:00.000Z'), point('2026-10-08T05:13:10.000Z')]
  const before = [...points]
  gridAlignedTail(points, DAY)
  assertEquals(points, before)
})

Deno.test('gridAlignedTail: composes with closedPoints — the real coingecko.ts call shape, end to end', () => {
  // closedPoints first drops nothing (gap looks >= 24h, its own design);
  // gridAlignedTail then catches the residual off-grid point.
  const points = [
    point('2026-10-06T00:00:00.000Z'),
    point('2026-10-07T00:00:00.000Z'),
    point('2026-10-08T05:13:10.000Z'),
  ]
  const afterClosedPoints = closedPoints(points, DAY)
  assertEquals(afterClosedPoints, points, 'precondition: closedPoints alone does not drop this point')
  const result = gridAlignedTail(afterClosedPoints, DAY)
  assertEquals(result.length, 2)
  assertEquals(result[result.length - 1]!.timestamp, '2026-10-07T00:00:00.000Z')
})

// --- reconcileClosedBar (2026-10-03, plan §5-IMPL review item 3) ----------

Deno.test('reconcileClosedBar: no candle supplied -> ok, nothing to reconcile', () => {
  const result = reconcileClosedBar(undefined, [{ timestamp: '2026-10-02T14:30:00.000Z', price: 86112.59 }], 0.005)
  assertEquals(result, { ok: true, reason: null })
})

Deno.test('reconcileClosedBar: no spot point at the candle\'s exact timestamp -> ok, cannot check so does not warn', () => {
  const candle = { timestamp: '2026-10-02T14:30:00.000Z', close: 86112.59 }
  const spotPoints = [{ timestamp: '2026-10-02T14:25:00.000Z', price: 86200 }] // 5 minutes off, no exact match
  const result = reconcileClosedBar(candle, spotPoints, 0.005)
  assertEquals(result, { ok: true, reason: null })
})

Deno.test('reconcileClosedBar: the live-verified close-stamped case — candle close matches spot at the SAME timestamp -> ok', () => {
  // The project's own 2026-10-02 reconciliation: the 30m bar stamped
  // 14:30 UTC has close=86112.59, matching stored 5m spot at 14:30
  // exactly (both are readings of the same underlying close).
  const candle = { timestamp: '2026-10-02T14:30:00.000Z', close: 86112.59 }
  const spotPoints = [
    { timestamp: '2026-10-02T14:00:00.000Z', price: 86550.63 },
    { timestamp: '2026-10-02T14:30:00.000Z', price: 86112.59 },
  ]
  const result = reconcileClosedBar(candle, spotPoints, 0.005)
  assertEquals(result, { ok: true, reason: null })
})

Deno.test('reconcileClosedBar: the adversarial open-stamped case — if timestamps meant OPEN time instead, reconciliation correctly fails', () => {
  // Same real bar as above, but checked against what an OPEN-stamped
  // interpretation would predict: the bar's close should then equal the
  // spot reading at its OWN (i.e. the bar's) timestamp read as an open —
  // which in the real data is the value recorded at 14:00, not 14:30.
  // This is the exact synthetic "wrong semantics" scenario the function
  // exists to catch.
  const candle = { timestamp: '2026-10-02T14:00:00.000Z', close: 86112.59 } // mislabeled as if 14:00 were its own close
  const spotPoints = [{ timestamp: '2026-10-02T14:00:00.000Z', price: 86550.63 }]
  const result = reconcileClosedBar(candle, spotPoints, 0.005)
  assertEquals(result.ok, false)
  assertEquals(result.reason?.includes('86112.59'), true)
  assertEquals(result.reason?.includes('86550.63'), true)
})

Deno.test('reconcileClosedBar: boundary — exactly at tolerance passes, just over it fails', () => {
  const spotPoints = [{ timestamp: '2026-10-02T14:30:00.000Z', price: 100 }]
  const atTolerance = reconcileClosedBar({ timestamp: '2026-10-02T14:30:00.000Z', close: 100.5 }, spotPoints, 0.005)
  assertEquals(atTolerance.ok, true)
  const justOver = reconcileClosedBar({ timestamp: '2026-10-02T14:30:00.000Z', close: 100.51 }, spotPoints, 0.005)
  assertEquals(justOver.ok, false)
})

Deno.test('reconcileClosedBar: matches by exact timestamp only, never by nearest — a close-but-wrong neighbor point is ignored', () => {
  const candle = { timestamp: '2026-10-02T14:30:00.000Z', close: 100 }
  const spotPoints = [
    { timestamp: '2026-10-02T14:25:00.000Z', price: 50 }, // 5 minutes off and wildly different — must never be matched
    { timestamp: '2026-10-02T14:30:00.000Z', price: 100 }, // the only exact match
  ]
  const result = reconcileClosedBar(candle, spotPoints, 0.005)
  assertEquals(result.ok, true)
})
