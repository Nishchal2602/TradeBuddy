import { assertEquals } from 'jsr:@std/assert@1'
import { buildBaselineOpportunities } from './shadow-baseline.ts'

Deno.test('buildBaselineOpportunities: one long + one short row, both keyed on the most recent bar', () => {
  const bars = [
    { timestamp: '2026-09-23T00:00:00.000Z', close: 100 },
    { timestamp: '2026-09-23T00:30:00.000Z', close: 103 },
  ]
  const result = buildBaselineOpportunities(bars)
  assertEquals(result.length, 2)
  assertEquals(result.map((r) => r.direction).sort(), ['long', 'short'])
  for (const r of result) {
    assertEquals(r.triggerBarTs, '2026-09-23T00:30:00.000Z')
    assertEquals(r.triggerBarClose, 103)
  }
})

Deno.test('buildBaselineOpportunities: empty bars -> empty array, never throws', () => {
  assertEquals(buildBaselineOpportunities([]), [])
})

Deno.test('buildBaselineOpportunities: repeated calls on the identical trailing bar produce the identical key — the dedup contract shadow_candidates\' unique index relies on', () => {
  const bars = [{ timestamp: '2026-09-23T00:30:00.000Z', close: 103 }]
  const first = buildBaselineOpportunities(bars)
  const second = buildBaselineOpportunities(bars)
  assertEquals(first, second)
})
