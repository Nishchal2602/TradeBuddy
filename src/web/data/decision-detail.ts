import { supabase } from '@/supabase'

// Extends src/features/decision-detail/queries.ts's fetchDecisionById
// (reused as-is for the base fields + parseEvidence) with every column
// that shipped AFTER that query was written — V4 opportunity provenance,
// the three Jev advisory layers, the two R metrics, and full provenance.
// A second targeted select rather than widening the shared query, since
// the extension's decision-detail screen has no use for any of these yet
// and widening it would be scope it didn't ask for.
export interface DecisionExtra {
  portfolioId: string
  strategyVersion: string
  decisionType: 'candidate' | 'management' | null
  armId: string | null
  bias: 'LONG' | 'SHORT' | 'NEUTRAL' | null
  opportunityBarTs: string | null

  jevNewsVetoProbability: number | null
  entryQuality: 'ENTER' | 'SKIP' | null
  entryQualityConfidence: number | null
  entryQualityDistribution: Record<string, number> | null
  entryGateMode: 'advisory' | 'blocking' | null
  expectedMovePct: number | null
  expectedMoveConfidence: number | null
  expectedMoveDistribution: Record<string, number> | null
  expectedMoveHorizonMinutes: number | null
  failureRisk: 'LOW' | 'MEDIUM' | 'HIGH' | null
  failureRiskConfidence: number | null
  failureRiskDistribution: Record<string, number> | null
  failureMode: string | null
  failureModeConfidence: number | null
  failureModeDistribution: Record<string, number> | null

  vetoPromptVersion: string | null
  entryPromptVersion: string | null
  adversarialPromptVersion: string | null
  jevCaseId: string | null
  jevEvaluationId: string | null

  priceR: number | null
  positionPnlR: number | null

  effectivePortfolioRiskCeilingPct: number
  effectiveMaxTotalNotionalPct: number
}

export async function loadDecisionExtra(decisionId: string): Promise<DecisionExtra | null> {
  const { data, error } = await supabase
    .from('agent_decisions')
    // A single string literal, not built via concatenation — supabase-js
    // parses the select string at the TYPE level via a template-literal
    // AST, which only works against a literal type; a runtime-concatenated
    // string widens to plain `string` and silently falls back to an
    // unhelpful error type for every field.
    .select(
      'portfolio_id, strategy_version, decision_type, arm_id, bias, opportunity_bar_ts, jev_news_veto_probability, entry_quality, entry_quality_confidence, entry_quality_distribution, entry_gate_mode, expected_move_pct, expected_move_confidence, expected_move_distribution, expected_move_horizon_minutes, failure_risk, failure_risk_confidence, failure_risk_distribution, failure_mode, failure_mode_confidence, failure_mode_distribution, veto_prompt_version, entry_prompt_version, adversarial_prompt_version, jev_case_id, jev_evaluation_id, price_r, position_pnl_r, effective_portfolio_risk_ceiling_pct, effective_max_total_notional_pct',
    )
    .eq('id', decisionId)
    .maybeSingle()
  if (error) throw new Error(`could not load decision provenance: ${error.message}`)
  if (!data) return null

  return {
    portfolioId: data.portfolio_id,
    strategyVersion: data.strategy_version,
    decisionType: data.decision_type,
    armId: data.arm_id,
    bias: data.bias,
    opportunityBarTs: data.opportunity_bar_ts,
    jevNewsVetoProbability: data.jev_news_veto_probability === null ? null : Number(data.jev_news_veto_probability),
    entryQuality: data.entry_quality,
    entryQualityConfidence: data.entry_quality_confidence === null ? null : Number(data.entry_quality_confidence),
    entryQualityDistribution: data.entry_quality_distribution,
    entryGateMode: data.entry_gate_mode,
    expectedMovePct: data.expected_move_pct === null ? null : Number(data.expected_move_pct),
    expectedMoveConfidence: data.expected_move_confidence === null ? null : Number(data.expected_move_confidence),
    expectedMoveDistribution: data.expected_move_distribution,
    expectedMoveHorizonMinutes: data.expected_move_horizon_minutes,
    failureRisk: data.failure_risk,
    failureRiskConfidence: data.failure_risk_confidence === null ? null : Number(data.failure_risk_confidence),
    failureRiskDistribution: data.failure_risk_distribution,
    failureMode: data.failure_mode,
    failureModeConfidence: data.failure_mode_confidence === null ? null : Number(data.failure_mode_confidence),
    failureModeDistribution: data.failure_mode_distribution,
    vetoPromptVersion: data.veto_prompt_version,
    entryPromptVersion: data.entry_prompt_version,
    adversarialPromptVersion: data.adversarial_prompt_version,
    jevCaseId: data.jev_case_id,
    jevEvaluationId: data.jev_evaluation_id,
    priceR: data.price_r === null ? null : Number(data.price_r),
    positionPnlR: data.position_pnl_r === null ? null : Number(data.position_pnl_r),
    effectivePortfolioRiskCeilingPct: Number(data.effective_portfolio_risk_ceiling_pct),
    effectiveMaxTotalNotionalPct: Number(data.effective_max_total_notional_pct),
  }
}
