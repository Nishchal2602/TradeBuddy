import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { parseModelOutput, ModelOutputShapeError } from './gemini-schema.ts'

function holdDecision(overrides: Record<string, unknown> = {}) {
  return {
    asset: 'BTC',
    action: 'HOLD',
    confidence: 0.4,
    stopLossPct: null,
    takeProfitPct: null,
    horizonHours: null,
    reasons: [{ type: 'TECHNICAL', text: 'RSI neutral at 50', newsId: null }],
    invalidation: [],
    ...overrides,
  }
}

function openDecision(overrides: Record<string, unknown> = {}) {
  return {
    asset: 'ETH',
    action: 'OPEN_LONG',
    confidence: 0.7,
    stopLossPct: 0.03,
    takeProfitPct: 0.06,
    horizonHours: 12,
    reasons: [{ type: 'TECHNICAL', text: 'EMA20 crossed above EMA50', newsId: null }],
    invalidation: [{ text: 'EMA20 crosses back below EMA50' }],
    ...overrides,
  }
}

Deno.test('parseModelOutput: valid HOLD + OPEN_LONG round-trip into ModelDecisionProposal[]', () => {
  const result = parseModelOutput({ decisions: [holdDecision(), openDecision()] }, ['BTC', 'ETH'])
  assertEquals(result.length, 2)
  const hold = result.find((r) => r.asset === 'BTC')!
  assertEquals(hold.action, 'HOLD')
  assertEquals('stopLossPct' in hold, false)
  const open = result.find((r) => r.asset === 'ETH')!
  assertEquals(open.action, 'OPEN_LONG')
  if (open.action === 'OPEN_LONG') {
    assertEquals(open.stopLossPct, 0.03)
    assertEquals(open.takeProfitPct, 0.06)
  }
})

Deno.test('parseModelOutput: a NEWS reason correctly carries its newsId through', () => {
  const newsId = '11111111-1111-1111-1111-111111111111'
  const result = parseModelOutput(
    { decisions: [holdDecision({ reasons: [{ type: 'NEWS', text: 'ETF approval headline', newsId }] })] },
    ['BTC'],
  )
  const reason = result[0]!.reasons[0]!
  assertEquals(reason.type, 'NEWS')
  if (reason.type === 'NEWS') assertEquals(reason.newsId, newsId)
})

Deno.test('parseModelOutput: OPEN_LONG missing stopLossPct throws ModelOutputShapeError, not a silent default', () => {
  assertThrows(
    () => parseModelOutput({ decisions: [openDecision({ stopLossPct: null })] }, ['ETH']),
    ModelOutputShapeError,
  )
})

Deno.test('parseModelOutput: OPEN_SHORT missing takeProfitPct throws', () => {
  assertThrows(
    () => parseModelOutput({ decisions: [openDecision({ action: 'OPEN_SHORT', takeProfitPct: null })] }, ['ETH']),
    ModelOutputShapeError,
  )
})

Deno.test('parseModelOutput: HOLD carrying a stray stopLossPct is REJECTED, not silently stripped', () => {
  assertThrows(
    () => parseModelOutput({ decisions: [holdDecision({ stopLossPct: 0.05 })] }, ['BTC']),
    ModelOutputShapeError,
  )
})

Deno.test('parseModelOutput: CLOSE carrying a stray takeProfitPct is REJECTED', () => {
  assertThrows(
    () => parseModelOutput({ decisions: [holdDecision({ action: 'CLOSE', takeProfitPct: 0.1 })] }, ['BTC']),
    ModelOutputShapeError,
  )
})

Deno.test('parseModelOutput: a NEWS reason missing newsId throws (cannot cite nothing)', () => {
  assertThrows(
    () => parseModelOutput({ decisions: [holdDecision({ reasons: [{ type: 'NEWS', text: 'some headline', newsId: null }] })] }, ['BTC']),
    ModelOutputShapeError,
  )
})

Deno.test('parseModelOutput: OPEN with empty invalidation throws (an open always needs a thesis)', () => {
  assertThrows(
    () => parseModelOutput({ decisions: [openDecision({ invalidation: [] })] }, ['ETH']),
    ModelOutputShapeError,
  )
})

Deno.test('parseModelOutput: missing an expected asset throws', () => {
  assertThrows(
    () => parseModelOutput({ decisions: [holdDecision({ asset: 'BTC' })] }, ['BTC', 'ETH']),
    ModelOutputShapeError,
  )
})

Deno.test('parseModelOutput: the same asset appearing twice throws (not a valid substitute for two distinct assets)', () => {
  assertThrows(
    () => parseModelOutput({ decisions: [holdDecision({ asset: 'BTC' }), holdDecision({ asset: 'BTC' })] }, ['BTC', 'ETH']),
    ModelOutputShapeError,
  )
})

Deno.test('parseModelOutput: a response that does not even match the raw wire shape throws', () => {
  assertThrows(() => parseModelOutput({ decisions: 'not an array' }, ['BTC']), ModelOutputShapeError)
  assertThrows(() => parseModelOutput({ nothing: 'here' }, ['BTC']), ModelOutputShapeError)
})

Deno.test('parseModelOutput: an invalid action value throws rather than passing through', () => {
  assertThrows(
    () => parseModelOutput({ decisions: [holdDecision({ action: 'BUY' })] }, ['BTC']),
    ModelOutputShapeError,
  )
})
