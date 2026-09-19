import { assertEquals } from 'jsr:@std/assert@1'
import { citedNewsIds, derivePrimaryDriver } from './decision-record.ts'
import type { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'

type Reasons = ModelDecisionProposal['reasons']

const NEWS_ID_A = '11111111-1111-1111-1111-111111111111'
const NEWS_ID_B = '22222222-2222-2222-2222-222222222222'

Deno.test('derivePrimaryDriver: only NEWS reasons -> NEWS', () => {
  const reasons: Reasons = [{ type: 'NEWS', text: 'x', newsId: NEWS_ID_A }]
  assertEquals(derivePrimaryDriver(reasons), 'NEWS')
})

Deno.test('derivePrimaryDriver: only TECHNICAL reasons -> TECHNICAL', () => {
  const reasons: Reasons = [{ type: 'TECHNICAL', text: 'x' }]
  assertEquals(derivePrimaryDriver(reasons), 'TECHNICAL')
})

Deno.test('derivePrimaryDriver: a mix of both -> BOTH', () => {
  const reasons: Reasons = [{ type: 'NEWS', text: 'x', newsId: NEWS_ID_A }, { type: 'TECHNICAL', text: 'y' }]
  assertEquals(derivePrimaryDriver(reasons), 'BOTH')
})

Deno.test('derivePrimaryDriver: empty reasons -> NONE', () => {
  assertEquals(derivePrimaryDriver([]), 'NONE')
})

Deno.test('citedNewsIds: collects newsId from every NEWS reason, ignoring TECHNICAL ones', () => {
  const reasons: Reasons = [
    { type: 'NEWS', text: 'a', newsId: NEWS_ID_A },
    { type: 'TECHNICAL', text: 'b' },
    { type: 'NEWS', text: 'c', newsId: NEWS_ID_B },
  ]
  assertEquals(citedNewsIds(reasons), [NEWS_ID_A, NEWS_ID_B])
})

Deno.test('citedNewsIds: no NEWS reasons -> empty array', () => {
  assertEquals(citedNewsIds([{ type: 'TECHNICAL', text: 'x' }]), [])
})
