import { assertEquals } from 'jsr:@std/assert@1'
import { riskAppetiteThresholds } from '../../../../src/shared/risk/appetite-mapping.ts'

// Trading Strategy V1 (2026-09-21) retuned this table — see
// appetite-mapping.ts's own comment for the full rationale (confidence
// zeroed: AUROC 0.55-0.61 in the reviewed literature; budgets lowered so
// the 20%-of-NAV cap no longer binds identically across all three tiers
// at realistic stop distances).

Deno.test('riskAppetiteThresholds: exact values for all three tiers', () => {
  assertEquals(riskAppetiteThresholds('conservative'), { minConfidence: 0, riskBudgetPct: 0.0025 })
  assertEquals(riskAppetiteThresholds('balanced'), { minConfidence: 0, riskBudgetPct: 0.0050 })
  assertEquals(riskAppetiteThresholds('aggressive'), { minConfidence: 0, riskBudgetPct: 0.0075 })
})

Deno.test('riskAppetiteThresholds: confidence no longer gates for any tier — all three are zero, not a per-tier bar', () => {
  // Replaces the pre-V1 "balanced matches the seeded confidence bar" test
  // — that premise (a nonzero bar the system describes as current) no
  // longer exists to reproduce. What actually matters now, and is worth
  // guarding explicitly, is that the neutralization was applied uniformly
  // rather than accidentally left nonzero on one tier.
  const c = riskAppetiteThresholds('conservative')
  const b = riskAppetiteThresholds('balanced')
  const a = riskAppetiteThresholds('aggressive')
  assertEquals(c.minConfidence, 0)
  assertEquals(b.minConfidence, 0)
  assertEquals(a.minConfidence, 0)
})

Deno.test('riskAppetiteThresholds: risk budget is monotonic — more aggressive means a higher budget (confidence is flat, not monotonic, by design)', () => {
  const c = riskAppetiteThresholds('conservative')
  const b = riskAppetiteThresholds('balanced')
  const a = riskAppetiteThresholds('aggressive')

  assertEquals(c.riskBudgetPct < b.riskBudgetPct && b.riskBudgetPct < a.riskBudgetPct, true)
  // The old table's confidence ordering (conservative > balanced >
  // aggressive) is gone, deliberately — confidence is the same (zero)
  // everywhere now, so it is no longer a dimension appetite varies.
  assertEquals(c.minConfidence === b.minConfidence && b.minConfidence === a.minConfidence, true)
})
