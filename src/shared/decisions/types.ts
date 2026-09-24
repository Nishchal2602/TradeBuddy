import { z } from 'zod'
import { AssetSymbol } from '../market-data/types.ts'

// Not BUY/SELL — ambiguous once both directions exist
// (trading-domain-contract.md §1). State-dependent: FLAT allows
// OPEN_LONG/OPEN_SHORT/HOLD only; LONG/SHORT allow
// HOLD/ADD/REDUCE/CLOSE/MODIFY_PROTECTION only. That constraint is
// enforced by the risk gate against live position state, not encoded
// here — this type only spells out the seven values.
//
// ADD/REDUCE/MODIFY_PROTECTION added by Phase 2 (2026-09-22, "Jev as a
// portfolio-management decision layer") — direction-agnostic, matching
// CLOSE's existing convention: direction comes from the open position
// itself, never from the action literal. See gate.ts's own comment on
// why every branch below HOLD/CLOSE must derive direction per-action,
// never by a blanket `action === 'OPEN_LONG' ? 'long' : 'short'` — a
// documented past trap this migration specifically had to close before
// adding these three values.
export const Action = z.enum(['OPEN_LONG', 'OPEN_SHORT', 'HOLD', 'CLOSE', 'ADD', 'REDUCE', 'MODIFY_PROTECTION'])
export type Action = z.infer<typeof Action>

// Derived in code from reasons[]'s type distribution, never asked of the
// model directly — one less place for the model to contradict its own
// stated reasoning with a mismatched self-report. See AgentDecision below;
// absent from ModelDecisionProposal for exactly this reason.
export const PrimaryDriver = z.enum(['NEWS', 'TECHNICAL', 'BOTH', 'NONE'])
export type PrimaryDriver = z.infer<typeof PrimaryDriver>

export const ReasonType = z.enum(['NEWS', 'TECHNICAL'])
export type ReasonType = z.infer<typeof ReasonType>

// A discriminated union, not one flat object with a nullable newsId: a
// NEWS reason that cites nothing, or a TECHNICAL reason carrying a
// newsId, are both invalid states — "if you cite a news item, reference
// its id" only makes sense paired with type = NEWS. A flat
// `newsId: z.string().uuid().nullable()` would let a NEWS reason parse
// successfully with newsId: null, silently permitting exactly that. Same
// reasoning, and same .strict() justification, as ModelDecisionProposal
// below.
const NewsReason = z.object({
  type: z.literal('NEWS'),
  text: z.string().min(1),
  // References a news_items.id this reason is grounded in.
  // AgentDecision.citedNewsIds is the deduplicated collection of every
  // reason's newsId across a decision, derived the same way as
  // primaryDriver — not a second field the model has to keep in sync by
  // hand.
  newsId: z.string().uuid(),
}).strict()

const TechnicalReason = z.object({
  type: z.literal('TECHNICAL'),
  text: z.string().min(1),
}).strict()

export const Reason = z.discriminatedUnion('type', [NewsReason, TechnicalReason])
export type Reason = z.infer<typeof Reason>

// The human-readable thesis — deliberately separate from the executable
// stop-loss (Position.stopLossPrice). Conflating the two is the specific
// failure mode this split exists to prevent (trading-domain-contract.md,
// ui-context.md § Decision Card Language).
export const InvalidationCondition = z.object({
  text: z.string().min(1),
})
export type InvalidationCondition = z.infer<typeof InvalidationCondition>

// agent_decisions.risk_status — four outcomes, not a binary accept/reject.
// not_applicable is HOLD (nothing to gate); clamped means accepted but
// resized down by a cap (size_cap_applied says which one); rejected always
// carries a reason (riskReason on AgentDecision).
export const RiskStatus = z.enum(['approved', 'rejected', 'clamped', 'not_applicable'])
export type RiskStatus = z.infer<typeof RiskStatus>

// Which hard cap, if any, clamped the risk-derived size
// (trading-domain-contract.md §4 / the position-model plan's worked
// example — the single-trade cap binds before the asset-exposure cap in
// V0, since one net position per asset makes them the same number).
// `portfolio_risk`/`total_notional` added by trading-strategy-v1.md §17 —
// genuinely new cross-asset controls, not a repair of asset_exposure
// (which stays structurally inert in V0/V1 for the same one-position-
// per-asset reason as single_trade; see sizing.ts's own comment).
export const SizeCapApplied = z.enum(['single_trade', 'asset_exposure', 'cash', 'portfolio_risk', 'total_notional'])
export type SizeCapApplied = z.infer<typeof SizeCapApplied>

// --- What the model proposes ------------------------------------------
//
// A discriminated union on `action`, not one flat object with nullable
// SL/TP fields: OPEN_LONG/OPEN_SHORT structurally REQUIRE stopLossPct and
// takeProfitPct; HOLD/CLOSE structurally cannot have them. This gets
// Step 3 (risk gate) real type narrowing — `if (proposal.action ===
// 'OPEN_LONG') proposal.stopLossPct` is a `number`, not a `number | null`
// that still needs a runtime guard — rather than deferring a check that
// the type itself can rule out.
//
// Position size is deliberately NOT a field anywhere here — the model
// never proposes it. Deterministic code derives it from risk-at-stop plus
// hard caps (trading-domain-contract.md §4); confidence gates whether a
// trade happens, never how large it is.
//
// invalidation's requiredness differs by branch for a reason: an OPEN
// always represents a new thesis, so it unconditionally needs at least one
// invalidation condition. HOLD's requirement is state-dependent instead
// (non-empty only when a position is already open on that asset) — that
// depends on external state this schema doesn't have visibility into, so
// it's enforced by the risk gate (Step 3), not encoded here.

const baseProposalFields = {
  asset: AssetSymbol,
  confidence: z.number().min(0).max(1),
  horizonHours: z.number().int().positive().nullable(),
  reasons: z.array(Reason),
  invalidation: z.array(InvalidationCondition),
}

const openProposalFields = {
  stopLossPct: z.number().positive(),
  takeProfitPct: z.number().positive(),
  invalidation: z.array(InvalidationCondition).min(1),
}

// --- Phase 2 (2026-09-22) — ADD/REDUCE/MODIFY_PROTECTION fields --------
//
// Each carries a RELATIVE signal, never an absolute dollar amount or
// price — deterministic code (the risk gate) is the sole authority that
// turns a magnitude/intent into an actual notional or price, exactly the
// same split OPEN_LONG/OPEN_SHORT already use (stopLossPct/takeProfitPct
// are percentages; the gate derives the absolute notional and prices).
// This is what makes "Jev may choose a bounded adjustment magnitude;
// deterministic code remains the sole authority over final size" true
// structurally, not just by convention — there is no field anywhere on
// this type a proposal could use to name a dollar figure or a price.

const addProposalFields = {
  // Fraction of the risk-derived headroom to add (Jev's Score answer,
  // mapped to {0.25, 0.50, 1.00} in code — see model/jev/management-
  // question.ts). The gate computes the actual headroom from the
  // EXISTING position's own stop-loss, then multiplies by this fraction,
  // then applies every sizing cap on top — same three-step split as an
  // OPEN_LONG's stopLossPct → deriveRiskBasedNotional → applySizingCaps.
  addMagnitude: z.number().positive().max(1),
}

const reduceProposalFields = {
  // Fraction of the CURRENT open quantity to reduce (Jev's Score answer,
  // mapped to {0.25, 0.50, 0.75}). A magnitude that would reduce >= 100%
  // is normalized to a CLOSE proposal upstream (cycle/apply-management.ts)
  // and never reaches this variant — max(1) here is a structural ceiling,
  // not the expected range.
  reduceMagnitude: z.number().positive().max(1),
}

const modifyProtectionProposalFields = {
  // Deterministically computed ABSOLUTE prices, not intents — the intent
  // enums (KEEP/TIGHTEN_TOWARD_ENTRY, KEEP/MOVE_CLOSER/MOVE_OUT) are
  // resolved into these prices by cycle/apply-management.ts BEFORE this
  // proposal is built, the same way strategy/rules.ts resolves the
  // regime rule into stopLossPct/takeProfitPct before the gate ever sees
  // them. null means "no change requested" for that leg specifically —
  // at least one of the two is non-null by construction (a proposal
  // where both are null is normalized to HOLD upstream, never built as
  // MODIFY_PROTECTION). The gate's only job is to VALIDATE these prices
  // (ordering, configured bounds, exhaustion, and — for stop — that it
  // never widens) — never to compute them.
  proposedStopLossPrice: z.number().positive().nullable(),
  proposedTakeProfitPrice: z.number().positive().nullable(),
}

// .strict() on every branch, not Zod's default "strip" mode: this is
// parsing untrusted model output (code-standards.md "treat LLM output as
// untrusted until schema validation succeeds"), and the entire point of
// this discriminated union is the structural guarantee that HOLD/CLOSE
// cannot carry SL/TP. Under strip mode a HOLD payload with a stray
// stopLossPct would parse "successfully" with that field silently
// dropped — passing validation while hiding a real signal that something
// (the model, or the prompt/parsing code) is confused. Strict mode turns
// that into a loud rejection instead.
const OpenLongProposal = z.object({ ...baseProposalFields, ...openProposalFields, action: z.literal('OPEN_LONG') }).strict()
const OpenShortProposal = z.object({ ...baseProposalFields, ...openProposalFields, action: z.literal('OPEN_SHORT') }).strict()
const HoldProposal = z.object({ ...baseProposalFields, action: z.literal('HOLD') }).strict()
const CloseProposal = z.object({ ...baseProposalFields, action: z.literal('CLOSE') }).strict()
const AddProposal = z.object({ ...baseProposalFields, ...addProposalFields, action: z.literal('ADD') }).strict()
const ReduceProposal = z.object({ ...baseProposalFields, ...reduceProposalFields, action: z.literal('REDUCE') }).strict()
const ModifyProtectionProposal = z.object({ ...baseProposalFields, ...modifyProtectionProposalFields, action: z.literal('MODIFY_PROTECTION') }).strict()

export const ModelDecisionProposal = z.discriminatedUnion('action', [
  OpenLongProposal,
  OpenShortProposal,
  HoldProposal,
  CloseProposal,
  AddProposal,
  ReduceProposal,
  ModifyProtectionProposal,
])
export type ModelDecisionProposal = z.infer<typeof ModelDecisionProposal>

// --- The full persisted record -----------------------------------------
//
// Mirrors the `agent_decisions` table exactly (supabase/migrations/
// ..._initial_schema.sql + ..._position_model.sql), flat rather than
// nested — same reasoning as Position and every other normalized type in
// src/shared/: persistence should be a near-direct map, not a translation
// layer. Deliberately NOT a discriminated union like ModelDecisionProposal
// above: once risk-gate processing has happened, every field (proposed
// SL/TP, computed prices, approvedSizePct, sizeCapApplied) is legitimately
// nullable regardless of action — a rejected OPEN has proposed SL/TP but
// no computed prices; a HOLD has neither. One flat shape matches the
// table's own actual nullability far better than trying to force that
// onto a second discriminated union.
export const AgentDecision = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  portfolioId: z.string().uuid(),
  // The position this decision opened, closed, or (for a HOLD on an open
  // position) is currently tracking. Null for a HOLD while flat.
  positionId: z.string().uuid().nullable(),
  asset: AssetSymbol,

  // Model proposal (denormalized from ModelDecisionProposal onto the flat
  // record — see the module comment above for why nullable-not-narrowed
  // here).
  action: Action,
  confidence: z.number().min(0).max(1),
  primaryDriver: PrimaryDriver,
  proposedStopLossPct: z.number().positive().nullable(),
  proposedTakeProfitPct: z.number().positive().nullable(),
  horizonHours: z.number().int().positive().nullable(),
  reasons: z.array(Reason),
  invalidation: z.array(InvalidationCondition),
  citedNewsIds: z.array(z.string().uuid()),

  // Risk-gate outcome (architecture.md § Risk Gate — the gate records what
  // it did; it must never silently turn an invalid proposal into an
  // apparently valid one, or silently resize one without recording it).
  riskStatus: RiskStatus,
  riskReason: z.string().nullable(),
  approvedSizePct: z.number().nonnegative().nullable(),
  computedStopLossPrice: z.number().positive().nullable(),
  computedTakeProfitPrice: z.number().positive().nullable(),
  sizeCapApplied: SizeCapApplied.nullable(),

  // The risk configuration actually in force when this decision was
  // gated, denormalized directly onto the row — same reasoning as the
  // pre-existing effectiveMinConfidence pattern (progress-tracker.md):
  // re-tuning the risk-appetite mapping or the settings caps later must
  // never make a historical decision unreadable. effectiveMinConfidence
  // and effectiveRiskBudgetPct come from the risk-appetite mapping
  // (Step 3); effectiveSingleTradeCapPct and effectiveAssetExposureCapPct
  // come straight from agent_settings, unaffected by appetite.
  effectiveMinConfidence: z.number().min(0).max(1),
  effectiveRiskBudgetPct: z.number().min(0).max(1),
  effectiveSingleTradeCapPct: z.number().min(0).max(1),
  effectiveAssetExposureCapPct: z.number().min(0).max(1),
  // trading-strategy-v1.md §17 — the two new portfolio-level sizing
  // candidates, denormalized on the same terms as the four above (NOT
  // NULL, every row regardless of outcome). Historical pre-V1 rows
  // backfill to 0, a value no real computation ever legitimately
  // produces (the ceiling multiplier defaults to 1.5, never 0) — an
  // honest "this concept did not exist yet" marker, not a real 0 ceiling.
  effectivePortfolioRiskCeilingPct: z.number().nonnegative(),
  effectiveMaxTotalNotionalPct: z.number().min(0).max(1),

  // Replay (invariant 8) — genuinely unknown shape at this layer
  // deliberately: over-specifying this now would presume methodology
  // details the user has explicitly deferred to a separate review.
  inputPayload: z.unknown(),
  outputPayload: z.unknown(),
  promptVersion: z.string().min(1),
  modelVersion: z.string().min(1),
  // trading-strategy-v1.md §23 — makes the H4/H5 falsification hierarchy
  // directly queryable. strategyVersion: 'v0-gemini-originated' for the
  // pre-V1 rows Gemini originated outright, a real V1 value from here on.
  // modelVetoed: null means no model call happened this cycle (a HOLD
  // candidate never reaches the veto step, §11) — never a false default.
  strategyVersion: z.string().min(1),
  modelVetoed: z.boolean().nullable(),

  // --- Phase 2 (2026-09-22) provenance — "what did Jev want, what did
  // deterministic code allow, and what actually happened," per decision.
  // All null for every pre-Phase-2 row and for any Phase-2 row where no
  // management question was ever asked (a FLAT asset's OPEN/HOLD path,
  // which still uses only the pre-existing veto columns above).
  proposedAction: Action.nullable(),
  proposedActionConfidence: z.number().min(0).max(1).nullable(),
  proposedAdjustNotional: z.number().nonnegative().nullable(),
  executedAdjustNotional: z.number().nonnegative().nullable(),
  stopLossPriceBefore: z.number().positive().nullable(),
  stopLossPriceAfter: z.number().positive().nullable(),
  takeProfitPriceBefore: z.number().positive().nullable(),
  takeProfitPriceAfter: z.number().positive().nullable(),
  protectionRejectionReason: z.string().nullable(),

  decidedAt: z.string().datetime(),
})
export type AgentDecision = z.infer<typeof AgentDecision>
