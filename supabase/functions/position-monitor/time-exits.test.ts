import { assertEquals } from 'jsr:@std/assert@1'
import { findHardMaxHoldExit, findSoftTimeStopExit } from './time-exits.ts'
import type { Position } from '../../../src/shared/positions/types.ts'

const OPENED_AT = '2026-09-18T00:00:00.000Z'

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    portfolioId: '22222222-2222-2222-2222-222222222222',
    asset: 'BTC',
    direction: 'long',
    quantity: 10,
    entryPrice: 100,
    costBasis: 1000,
    stopLossPrice: 10,
    takeProfitPrice: 1000,
    status: 'open',
    openedAt: OPENED_AT,
    closedAt: null,
    realizedPnl: null,
    closeReason: null,
    openedByDecisionId: '33333333-3333-3333-3333-333333333333',
    closedByDecisionId: null,
    initialRiskUsd: 80, // riskPerUnit 8 x quantity 10
    partialRealizedPnlUsd: 0,
    ...overrides,
  }
}

function pointAt(minutesAfterOpen: number, price: number) {
  return { timestamp: new Date(new Date(OPENED_AT).getTime() + minutesAfterOpen * 60_000).toISOString(), price }
}

// --- findHardMaxHoldExit: unconditional on time, needs no ruler --------

Deno.test('findHardMaxHoldExit: fires once minutesHeld reaches the ceiling, regardless of strongly POSITIVE P&L', () => {
  const pos = position({ initialRiskUsd: undefined }) // deliberately no ruler -- must not matter
  const points = [pointAt(1440, 500)] // way past entry, huge unrealized profit
  const result = findHardMaxHoldExit(pos, points, 1440)
  assertEquals(result?.minutesHeld, 1440)
  assertEquals(result?.observedPrice, 500)
})

Deno.test('findHardMaxHoldExit: boundary is inclusive — exactly at the ceiling fires', () => {
  const pos = position()
  assertEquals(findHardMaxHoldExit(pos, [pointAt(1440, 100)], 1440) !== null, true)
})

Deno.test('findHardMaxHoldExit: one minute short of the ceiling does not fire', () => {
  const pos = position()
  assertEquals(findHardMaxHoldExit(pos, [pointAt(1439, 100)], 1440), null)
})

Deno.test('findHardMaxHoldExit: returns the FIRST (earliest) point that crosses the ceiling, not the latest', () => {
  const pos = position()
  const points = [pointAt(1500, 110), pointAt(1440, 100), pointAt(1460, 105)] // deliberately out of order
  const result = findHardMaxHoldExit(pos, points, 1440)
  assertEquals(result?.minutesHeld, 1440)
  assertEquals(result?.observedPrice, 100)
})

// --- findSoftTimeStopExit: conditional on positionPnlR < 0.5, needs a ruler

Deno.test('findSoftTimeStopExit: fires past the threshold when positionPnlR is flat (0)', () => {
  const pos = position()
  const result = findSoftTimeStopExit(pos, [pointAt(480, 100)], 480)
  assertEquals(result?.minutesHeld, 480)
})

Deno.test('findSoftTimeStopExit: does NOT fire before the threshold, regardless of P&L', () => {
  const pos = position()
  assertEquals(findSoftTimeStopExit(pos, [pointAt(479, 90)], 480), null) // underwater too, still too early
})

Deno.test('findSoftTimeStopExit: exactly 0.5R at the threshold does NOT fire — strictly less than required', () => {
  // unrealizedPnlUsd = (104-100)*10 = 40; positionPnlR = 40/80 = 0.5 exactly.
  const pos = position()
  assertEquals(findSoftTimeStopExit(pos, [pointAt(480, 104)], 480), null)
})

Deno.test('findSoftTimeStopExit: just under 0.5R past the threshold DOES fire', () => {
  // unrealizedPnlUsd = (103.9-100)*10 = 39; positionPnlR = 39/80 = 0.4875 < 0.5.
  const pos = position()
  const result = findSoftTimeStopExit(pos, [pointAt(480, 103.9)], 480)
  assertEquals(result?.minutesHeld, 480)
})

Deno.test('findSoftTimeStopExit: a position that has "proven itself" (>= 0.5R) is exempt even well past the threshold', () => {
  // unrealizedPnlUsd = (110-100)*10 = 100; positionPnlR = 100/80 = 1.25.
  const pos = position()
  assertEquals(findSoftTimeStopExit(pos, [pointAt(1000, 110)], 480), null)
})

Deno.test('findSoftTimeStopExit: missing ruler (initialRiskUsd null/undefined) never fires — defensive no-op, not a throw', () => {
  assertEquals(findSoftTimeStopExit(position({ initialRiskUsd: null }), [pointAt(1000, 90)], 480), null)
  assertEquals(findSoftTimeStopExit(position({ initialRiskUsd: undefined }), [pointAt(1000, 90)], 480), null)
})

Deno.test('findSoftTimeStopExit: accounts for partialRealizedPnlUsd and a short direction, same as the giveback ratchet', () => {
  // Short: entry 100, price drops to 95 -> unrealizedPnlUsd = (100-95)*10 = 50.
  // Plus partialRealizedPnlUsd = -60 (a prior loss-making reduce) -> total -10, positionPnlR = -10/80 = -0.125 < 0.5.
  const pos = position({ direction: 'short', partialRealizedPnlUsd: -60 })
  const result = findSoftTimeStopExit(pos, [pointAt(480, 95)], 480)
  assertEquals(result?.minutesHeld, 480)
})

Deno.test('findSoftTimeStopExit: returns the FIRST point past the threshold with positionPnlR < 0.5, walking chronologically', () => {
  const pos = position()
  // 480min: price 100 (pnlR=0, would fire) -- but listed out of order; 500min: price 90 (pnlR negative, would also fire).
  const points = [pointAt(500, 90), pointAt(480, 100)]
  const result = findSoftTimeStopExit(pos, points, 480)
  assertEquals(result?.minutesHeld, 480) // the earlier one, not the later one
  assertEquals(result?.observedPrice, 100)
})
