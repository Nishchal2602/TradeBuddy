import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { MarketIndicators, RecentClose } from '../../../../src/shared/indicators/types.ts'
import type { PositionState, Direction } from '../../../../src/shared/positions/types.ts'
import type { Action, InvalidationCondition } from '../../../../src/shared/decisions/types.ts'

// The exact object passed to callModel and persisted verbatim to
// agent_decisions.input_payload (invariant 8 — replayability). Assembling
// real data into this shape is agent-cycle wiring's job (Step 7); this
// step only defines what callModel receives and can rely on being
// present.
//
// Plain TS interfaces, not Zod: this is data WE construct and send, not
// untrusted input to validate — same asymmetry as NormalizedMarketData
// (validated, inbound) vs. how coingecko.ts's outbound request URLs are
// never schema-checked.
//
// camelCase throughout, including in the raw text actually sent to
// Gemini (model/prompt.ts) — deliberately not snake_case. There is no
// functional reason to prefer one convention for what a schema-
// constrained model fills in, so using the same casing everywhere in
// this codebase removes an entire translation layer (and a class of bugs
// it could otherwise introduce) that would exist only to satisfy a
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
  // FLAT/LONG/SHORT — tells the model its valid action set directly,
  // matching trading-domain-contract.md §1. The risk gate is the actual
  // enforcement (architecture.md § Risk Gate); this is so the model isn't
  // guessing at what's structurally possible.
  state: PositionState
  market: MarketInput
  news: NewsInput[]
  position: OpenPositionInput | null
  recentDecisions: RecentDecisionInput[]
  // Which direction(s), if any, are currently blocked from re-opening on
  // this asset by the stop-out re-entry rule (trading-domain-contract.md
  // §7) — informational, so the model doesn't spend reasoning proposing
  // an open that the risk gate will reject outright. Empty when nothing
  // is blocked. The gate is still the actual enforcement regardless of
  // what this says.
  blockedDirections: Direction[]
}

export interface ModelCallPayload {
  portfolio: {
    cash: number
    nav: number
    constraints: PortfolioConstraints
  }
  assets: AssetInput[]
}
