import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { MarketIndicators, RecentClose } from '../../../../src/shared/indicators/types.ts'
import type { PositionState, Direction } from '../../../../src/shared/positions/types.ts'
import type { Action, InvalidationCondition } from '../../../../src/shared/decisions/types.ts'
import type { RegimeResult } from '../../../../src/shared/strategy/types.ts'

// The rich per-decision context, persisted verbatim to agent_decisions.
// input_payload (invariant 8 — replayability) AND read back by the
// Decision-detail UI's technical/news evidence sections. Assembling real
// data into this shape is agent-cycle wiring's job.
//
// Trading Strategy V1 (2026-09-21): this is no longer literally "what the
// model receives" — the model's role narrowed to a veto-only call on a
// separate, deliberately leaner VetoCandidateInput below (§12: RSI/MACD/
// volume/etc. are explicitly NOT decision inputs anymore, and re-showing
// them to the model would invite exactly the "do you agree with this
// trade" reasoning §12 forbids). input_payload keeps this full shape
// regardless, on purpose: it is the complete record of what informed the
// decision (the deterministic regime rule sees and uses all of it), and
// the existing Decision-detail screen's evidence display depends on it —
// changing what's stored here would be an unrelated UI-data-source
// change this phase doesn't need to make. Unaffected by the Gemini -> Jev
// migration (2026-09-22): this type is never sent to any model provider.
//
// Plain TS interfaces, not Zod: this is data WE construct and send, not
// untrusted input to validate — same asymmetry as NormalizedMarketData
// (validated, inbound) vs. how coingecko.ts's outbound request URLs are
// never schema-checked.
//
// camelCase throughout — deliberately not snake_case. There is no
// functional reason to prefer one convention for what an external
// service consumes, so using the same casing everywhere in this
// codebase removes an entire translation layer (and a class of bugs it
// could otherwise introduce) that would exist only to satisfy a
// stylistic habit.

export interface PortfolioConstraints {
  minConfidence: number
  minStopLossPct: number
  maxStopLossPct: number
  minTakeProfitPct: number
  maxTakeProfitPct: number
}

export interface MarketInput {
  price: number
  change1hPct: number | null
  change24hPct: number | null
  change7dPct: number | null
  indicators: MarketIndicators
  recentCloses: RecentClose[]
}

export interface NewsInput {
  id: string
  source: string
  headline: string
  summary: string | null
  publishedAt: string
  ageMinutes: number
}

export interface OpenPositionInput {
  direction: Direction
  entryPrice: number
  stopLossPrice: number
  takeProfitPrice: number
  unrealizedPnlPct: number
  heldHours: number
  // The invalidation conditions from the decision that opened (or most
  // recently reaffirmed/revised on) this position — fed back so the model
  // can reaffirm or explicitly revise them rather than silently forgetting
  // its own prior thesis. See prompt.ts's invalidation section.
  openInvalidation: InvalidationCondition[]
}

export interface RecentDecisionInput {
  decidedAt: string
  action: Action
  confidence: number
  invalidation: InvalidationCondition[]
}

export interface AssetInput {
  asset: AssetSymbol
  // FLAT/LONG/SHORT — the state the deterministic strategy (agent-cycle/
  // strategy/rules.ts) actually evaluated against, kept here for the
  // audit trail even though nothing reads it back out of this payload to
  // re-derive a decision (the decision was already made by the time this
  // is persisted).
  state: PositionState
  market: MarketInput
  news: NewsInput[]
  position: OpenPositionInput | null
  recentDecisions: RecentDecisionInput[]
  // Which direction(s), if any, are currently blocked from re-opening on
  // this asset by the stop-out re-entry rule (trading-domain-contract.md
  // §7) — informational, kept for the audit trail.
  blockedDirections: Direction[]
  // trading-strategy-v1.md §7 — the deterministic signal that actually
  // drove this cycle's candidate. Always present: by the time buildAssetInput
  // runs, checkMarketDataFreshness has already fail-closed the whole cycle
  // if fewer than TREND_MA_LOOKBACK_DAYS closed daily bars existed.
  regime: RegimeResult
}

export interface ModelCallPayload {
  portfolio: {
    cash: number
    nav: number
    constraints: PortfolioConstraints
  }
  assets: AssetInput[]
}

// --- Veto call (trading-strategy-v1.md §12, narrowed further for the
// Gemini -> Jev migration, 2026-09-22) --------------------------------------
//
// What the model ACTUALLY receives — deliberately narrower than
// AssetInput above, and narrower again than the Gemini-era version of
// this type. Only OPEN_LONG candidates ever reach a veto call (§9's
// entry trigger table item 5; HOLD needs no veto since it changes
// nothing, and CLOSE is never vetoable — trading-domain-contract.md §7:
// "exits must always be actionable," the exact same reasoning the risk
// gate already applies to confidence/re-entry/drawdown).
//
// `regime`/`stopLossPct`/`takeProfitPct` were dropped in the Jev
// migration (they were on this type only for Gemini's prompt, which
// spent real text telling the model to ignore them — a typed Jev
// question makes that instruction unnecessary by not sending the fields
// at all; see model/jev/question.ts). They are structurally absent here,
// not merely unused downstream, so a future candidate builder cannot
// accidentally start leaking them into a model call again.

export interface VetoCandidateInput {
  asset: AssetSymbol
  news: NewsInput[]
}
