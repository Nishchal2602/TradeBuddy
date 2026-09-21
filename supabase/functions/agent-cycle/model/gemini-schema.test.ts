import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { parseVetoOutput, ModelOutputShapeError } from './gemini-schema.ts'

function verdict(overrides: Record<string, unknown> = {}) {
  return {
    asset: 'BTC',
    veto: false,
    rationale: 'no news provided',
    ...overrides,
  }
}

Deno.test('parseVetoOutput: a valid single verdict round-trips cleanly', () => {
  const result = parseVetoOutput({ verdicts: [verdict()] }, ['BTC'])
  assertEquals(result.length, 1)
  assertEquals(result[0]!.asset, 'BTC')
  assertEquals(result[0]!.veto, false)
  assertEquals(result[0]!.rationale, 'no news provided')
})

Deno.test('parseVetoOutput: multiple candidates in one batched call all round-trip', () => {
  const result = parseVetoOutput(
    { verdicts: [verdict({ asset: 'BTC' }), verdict({ asset: 'ETH', veto: true, rationale: 'exchange hack reported' })] },
    ['BTC', 'ETH'],
  )
  assertEquals(result.length, 2)
  const eth = result.find((v) => v.asset === 'ETH')!
  assertEquals(eth.veto, true)
  assertEquals(eth.rationale, 'exchange hack reported')
})

Deno.test('parseVetoOutput: missing an expected asset throws', () => {
  assertThrows(
    () => parseVetoOutput({ verdicts: [verdict({ asset: 'BTC' })] }, ['BTC', 'ETH']),
    ModelOutputShapeError,
  )
})

Deno.test('parseVetoOutput: the same asset appearing twice throws (not a valid substitute for two distinct candidates)', () => {
  assertThrows(
    () => parseVetoOutput({ verdicts: [verdict({ asset: 'BTC' }), verdict({ asset: 'BTC' })] }, ['BTC', 'ETH']),
    ModelOutputShapeError,
  )
})

Deno.test('parseVetoOutput: an extra verdict for an asset that was not a candidate throws', () => {
  assertThrows(
    () => parseVetoOutput({ verdicts: [verdict({ asset: 'BTC' }), verdict({ asset: 'ETH' })] }, ['BTC']),
    ModelOutputShapeError,
  )
})

Deno.test('parseVetoOutput: a non-boolean veto value throws rather than coercing', () => {
  assertThrows(
    () => parseVetoOutput({ verdicts: [verdict({ veto: 'yes' })] }, ['BTC']),
    ModelOutputShapeError,
  )
})

Deno.test('parseVetoOutput: a missing rationale throws — every verdict must explain itself', () => {
  const noRationale = { asset: 'BTC', veto: false }
  assertThrows(
    () => parseVetoOutput({ verdicts: [noRationale] }, ['BTC']),
    ModelOutputShapeError,
  )
})

Deno.test('parseVetoOutput: an invalid asset value throws rather than passing through', () => {
  assertThrows(
    () => parseVetoOutput({ verdicts: [verdict({ asset: 'DOGE' })] }, ['BTC']),
    ModelOutputShapeError,
  )
})

Deno.test('parseVetoOutput: a response that does not even match the raw wire shape throws', () => {
  assertThrows(() => parseVetoOutput({ verdicts: 'not an array' }, ['BTC']), ModelOutputShapeError)
  assertThrows(() => parseVetoOutput({ nothing: 'here' }, ['BTC']), ModelOutputShapeError)
})

Deno.test('parseVetoOutput: empty candidates and empty verdicts is a valid degenerate case', () => {
  const result = parseVetoOutput({ verdicts: [] }, [])
  assertEquals(result, [])
})
