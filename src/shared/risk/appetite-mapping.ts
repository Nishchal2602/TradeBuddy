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
//
// Trading Strategy V1 (2026-09-21) retunes both columns:
//
// minConfidence -> 0 for all three tiers. §12: an LLM's self-reported
// confidence is not a defensible gate (measured AUROC 0.55-0.61 in the
// literature reviewed — near-random ranking of correct vs. incorrect).
// Zeroed at the SOURCE, not overridden downstream at a call site, so
// there is exactly one place recording "confidence no longer gates" —
// gate.ts's own `confidence < effectiveMinConfidence` check (unedited)
// becomes vacuous as a direct, visible consequence of this table, not a
// hidden override elsewhere. Historical values, for provenance: the
// original position-model-plan numbers were conservative 0.75 / balanced
// 0.65 / aggressive 0.55.
//
// riskBudgetPct -> 0.25% / 0.50% / 0.75% (previously 0.75% / 1.00% /
// 1.50%). §4/§2.2: at any stop distance realistic for this asset class,
// the OLD budgets all cleared the 20%-of-NAV single-trade cap identically
// (cap binds below budget/0.20 -> 3.75%/5.00%/7.50% stop, comfortably
// above the ~2.5-3% stops this strategy actually proposes) — all three
// appetite tiers produced the SAME position size, so appetite governed
// nothing. These values keep the cap binding only at the tightest stops
// for the most aggressive tier (crossover 1.25%/2.50%/3.75%), restoring
// genuine separation.
const THRESHOLDS: Record<RiskAppetite, RiskAppetiteThresholds> = {
  conservative: { minConfidence: 0, riskBudgetPct: 0.0025 },
  balanced: { minConfidence: 0, riskBudgetPct: 0.0050 },
  aggressive: { minConfidence: 0, riskBudgetPct: 0.0075 },
}

export function riskAppetiteThresholds(appetite: RiskAppetite): RiskAppetiteThresholds {
  return THRESHOLDS[appetite]
}
