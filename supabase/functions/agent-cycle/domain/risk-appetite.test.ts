import { assertEquals } from 'jsr:@std/assert@1'
import { riskAppetiteThresholds } from '../../../../src/shared/risk/appetite-mapping.ts'

Deno.test('riskAppetiteThresholds: exact values for all three tiers', () => {
  assertEquals(riskAppetiteThresholds('conservative'), { minConfidence: 0.75, riskBudgetPct: 0.0075 })
  assertEquals(riskAppetiteThresholds('balanced'), { minConfidence: 0.65, riskBudgetPct: 0.0100 })
  assertEquals(riskAppetiteThresholds('aggressive'), { minConfidence: 0.55, riskBudgetPct: 0.0150 })
})

Deno.test('riskAppetiteThresholds: balanced reproduces the value already seeded in agent_settings', () => {
  // agent_settings.risk_appetite was seeded 'balanced' in Unit 2, before
  // this mapping existed. The mapping's balanced tier must agree with
  // whatever confidence bar the system has been describing as current —
  // 0.65 is that value (progress-tracker.md).
  assertEquals(riskAppetiteThresholds('balanced').minConfidence, 0.65)
})

Deno.test('riskAppetiteThresholds: ordering is monotonic — more aggressive means lower confidence bar, higher risk budget', () => {
  const c = riskAppetiteThresholds('conservative')
  const b = riskAppetiteThresholds('balanced')
  const a = riskAppetiteThresholds('aggressive')

  assertEquals(c.minConfidence > b.minConfidence && b.minConfidence > a.minConfidence, true)
  assertEquals(c.riskBudgetPct < b.riskBudgetPct && b.riskBudgetPct < a.riskBudgetPct, true)
})
