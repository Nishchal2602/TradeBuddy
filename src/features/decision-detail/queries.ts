import { z } from 'zod'
import { supabase } from '@/supabase'
import type { AssetSymbol } from '@/shared/market-data/types.ts'
import type { Action, PrimaryDriver, Reason, InvalidationCondition, RiskStatus, SizeCapApplied } from '@/shared/decisions/types.ts'

export interface DecisionDetail {
  id: string
  runId: string
  asset: AssetSymbol
  action: Action
  confidence: number
  primaryDriver: PrimaryDriver
  reasons: Reason[]
  invalidation: InvalidationCondition[]
  proposedStopLossPct: number | null
  proposedTakeProfitPct: number | null
  horizonHours: number | null
  positionId: string | null
  riskStatus: RiskStatus
  riskReason: string | null
  approvedSizePct: number | null
  computedStopLossPrice: number | null
  computedTakeProfitPrice: number | null
  sizeCapApplied: SizeCapApplied | null
  effectiveMinConfidence: number
  effectiveRiskBudgetPct: number
  effectiveSingleTradeCapPct: number
  effectiveAssetExposureCapPct: number
  promptVersion: string
  modelVersion: string
  decidedAt: string
  /** Raw, unvalidated — evidence.ts's parseEvidence() is what safely reads
   * technical/news evidence out of this; kept on the detail record too in
   * case a future step wants the exact payload verbatim (invariant 8's
   * replayability extends to what the extension is allowed to show, not
   * just what the backend persists). */
  inputPayload: unknown
}

export async function fetchDecisionById(decisionId: string): Promise<DecisionDetail | null> {
  const { data, error } = await supabase
    .from('agent_decisions')
    .select(
      'id, run_id, asset, action, confidence, primary_driver, reasons, invalidation, proposed_stop_loss_pct, proposed_take_profit_pct, horizon_hours, position_id, risk_status, risk_reason, approved_size_pct, computed_stop_loss_price, computed_take_profit_price, size_cap_applied, effective_min_confidence, effective_risk_budget_pct, effective_single_trade_cap_pct, effective_asset_exposure_cap_pct, prompt_version, model_version, decided_at, input_payload',
    )
    .eq('id', decisionId)
    .maybeSingle()
  if (error) throw new Error(`could not load decision ${decisionId}: ${error.message}`)
  if (!data) return null
  return {
    id: data.id,
    runId: data.run_id,
    asset: data.asset,
    action: data.action,
    confidence: Number(data.confidence),
    primaryDriver: data.primary_driver,
    reasons: data.reasons,
    invalidation: data.invalidation,
    proposedStopLossPct: data.proposed_stop_loss_pct === null ? null : Number(data.proposed_stop_loss_pct),
    proposedTakeProfitPct: data.proposed_take_profit_pct === null ? null : Number(data.proposed_take_profit_pct),
    horizonHours: data.horizon_hours,
    positionId: data.position_id,
    riskStatus: data.risk_status,
    riskReason: data.risk_reason,
    approvedSizePct: data.approved_size_pct === null ? null : Number(data.approved_size_pct),
    computedStopLossPrice: data.computed_stop_loss_price === null ? null : Number(data.computed_stop_loss_price),
    computedTakeProfitPrice: data.computed_take_profit_price === null ? null : Number(data.computed_take_profit_price),
    sizeCapApplied: data.size_cap_applied,
    effectiveMinConfidence: Number(data.effective_min_confidence),
    effectiveRiskBudgetPct: Number(data.effective_risk_budget_pct),
    effectiveSingleTradeCapPct: Number(data.effective_single_trade_cap_pct),
    effectiveAssetExposureCapPct: Number(data.effective_asset_exposure_cap_pct),
    promptVersion: data.prompt_version,
    modelVersion: data.model_version,
    decidedAt: data.decided_at,
    inputPayload: data.input_payload,
  }
}

// --- Evidence extraction from input_payload -------------------------------
//
// input_payload is stored as untyped jsonb (agent_decisions.input_payload)
// — it's this system's own internally-generated record
// (agent-cycle/model/payload.ts's ModelCallPayload), not third-party
// input, but it crosses a real DB -> TypeScript boundary with no
// compile-time guarantee attached, and the backend's own payload shape
// could evolve independently of this file. A loose, tolerant Zod schema
// (not .strict(), every field optional) rather than a hard cast: a
// missing/renamed field just means that piece of evidence doesn't render,
// not a crashed detail screen. Field names mirror ModelCallPayload's
// AssetInput exactly (camelCase throughout, per that file's own
// no-case-conversion rationale) — this is genuinely parsing the same
// shape, just on the other side of the runtime boundary.

const IndicatorsSchema = z
  .object({
    rsi14: z.number(),
    ema20: z.number(),
    ema50: z.number(),
    macdHistogram: z.number(),
    atrPct: z.number(),
    volumeRatio: z.number(),
    distanceFromSevenDayHighPct: z.number(),
    distanceFromSevenDayLowPct: z.number(),
  })
  .partial()

const NewsEvidenceSchema = z.object({
  id: z.string(),
  source: z.string(),
  headline: z.string(),
  summary: z.string().nullable().optional(),
  publishedAt: z.string(),
  ageMinutes: z.number(),
})

const AssetInputSchema = z
  .object({
    asset: z.string(),
    market: z.object({ indicators: IndicatorsSchema.optional(), price: z.number().optional() }).partial().optional(),
    news: z.array(NewsEvidenceSchema).optional(),
  })
  .partial()

const InputPayloadSchema = z.object({ assets: z.array(AssetInputSchema).optional() }).partial()

export type TechnicalIndicators = z.infer<typeof IndicatorsSchema>
export type NewsEvidence = z.infer<typeof NewsEvidenceSchema>

export interface DecisionEvidence {
  indicators: TechnicalIndicators | null
  news: NewsEvidence[]
}

/** Extracts this decision's own asset's technical indicators and full
 * news list from its input_payload — the actual data the model reasoned
 * over, not just the reason text derived from it. Never throws: a
 * shape that doesn't parse (or an asset missing from a payload for any
 * reason) degrades to "no evidence available" rather than breaking the
 * detail screen — this is supplementary display, not something anything
 * downstream depends on being present. */
export function parseEvidence(inputPayload: unknown, asset: AssetSymbol): DecisionEvidence {
  const parsed = InputPayloadSchema.safeParse(inputPayload)
  if (!parsed.success) return { indicators: null, news: [] }
  const assetInput = parsed.data.assets?.find((a) => a.asset === asset)
  return {
    indicators: assetInput?.market?.indicators ?? null,
    news: assetInput?.news ?? [],
  }
}
