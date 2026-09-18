import { assertEquals } from 'jsr:@std/assert@1'
import { CloseReason, derivePositionState, Position } from '../../../../src/shared/positions/types.ts'

function validPosition(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    portfolioId: '22222222-2222-2222-2222-222222222222',
    asset: 'BTC',
    direction: 'long',
    quantity: 0.5,
    entryPrice: 76851,
    costBasis: 38425.5,
    stopLossPrice: 74545.47,
    takeProfitPrice: 84536.1,
    status: 'open',
    openedAt: '2026-09-18T00:00:00.000Z',
    closedAt: null,
    realizedPnl: null,
    closeReason: null,
    openedByDecisionId: '33333333-3333-3333-3333-333333333333',
    closedByDecisionId: null,
    ...overrides,
  }
}

Deno.test('Position: a valid open long position parses cleanly', () => {
  const result = Position.safeParse(validPosition())
  assertEquals(result.success, true)
})

Deno.test('Position: an invalid direction is rejected', () => {
  const result = Position.safeParse(validPosition({ direction: 'flat' }))
  assertEquals(result.success, false)
})

Deno.test('Position: a closed position with all three closed-fields present parses cleanly', () => {
  const result = Position.safeParse(validPosition({
    status: 'closed',
    closedAt: '2026-09-18T06:00:00.000Z',
    realizedPnl: 250.5,
    closeReason: 'take_profit',
    closedByDecisionId: '44444444-4444-4444-4444-444444444444',
  }))
  assertEquals(result.success, true)
})

Deno.test('Position: an invalid close reason is rejected', () => {
  const result = Position.safeParse(validPosition({ closeReason: 'margin_call' }))
  assertEquals(result.success, false)
})

Deno.test('CloseReason: exactly the four values the contract defines', () => {
  const result = CloseReason.options
  assertEquals([...result].sort(), ['agent_close', 'collateral_exhausted', 'stop_loss', 'take_profit'])
})

// --- derivePositionState --------------------------------------------------

Deno.test('derivePositionState: null position is FLAT', () => {
  assertEquals(derivePositionState(null), 'FLAT')
})

Deno.test('derivePositionState: an open long-direction position is LONG', () => {
  const position = Position.parse(validPosition({ direction: 'long' }))
  assertEquals(derivePositionState(position), 'LONG')
})

Deno.test('derivePositionState: an open short-direction position is SHORT', () => {
  const position = Position.parse(validPosition({ direction: 'short' }))
  assertEquals(derivePositionState(position), 'SHORT')
})
