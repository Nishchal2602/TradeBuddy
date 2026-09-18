import { z } from 'zod'

// Matches the live agent_settings.risk_appetite check constraint
// (conservative/balanced/aggressive) — this is the first place a
// dedicated TS type for it is needed.
export const RiskAppetite = z.enum(['conservative', 'balanced', 'aggressive'])
export type RiskAppetite = z.infer<typeof RiskAppetite>

export interface RiskAppetiteThresholds {
  minConfidence: number
  riskBudgetPct: number
}

// Position-model plan §4 / progress-tracker.md — flagged pending three
// times before this unit existed to hold it. A pure lookup, tunable
// without a migration; the values actually in force for a given decision
// are denormalized onto AgentDecision.effectiveMinConfidence /
// effectiveRiskBudgetPct (src/shared/decisions/types.ts), so re-tuning
// this table later never makes a historical decision unreadable.
const THRESHOLDS: Record<RiskAppetite, RiskAppetiteThresholds> = {
  conservative: { minConfidence: 0.75, riskBudgetPct: 0.0075 },
  balanced: { minConfidence: 0.65, riskBudgetPct: 0.0100 },
  aggressive: { minConfidence: 0.55, riskBudgetPct: 0.0150 },
}

export function riskAppetiteThresholds(appetite: RiskAppetite): RiskAppetiteThresholds {
  return THRESHOLDS[appetite]
}
