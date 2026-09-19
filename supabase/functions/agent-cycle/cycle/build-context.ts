import { calculateIndicators, getRecentCloses } from '../indicators/calculate.ts'
import { derivePositionState } from '../../../../src/shared/positions/types.ts'
import type { Direction, Position } from '../../../../src/shared/positions/types.ts'
import type { NormalizedMarketData, AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { InvalidationCondition } from '../../../../src/shared/decisions/types.ts'
import type { RiskGateContext, RecentStopLossClose } from '../../../../src/shared/risk/gate.ts'
import type { PortfolioConstraints, AssetInput, OpenPositionInput, NewsInput, RecentDecisionInput } from '../model/payload.ts'
import type { RiskAppetiteThresholds } from '../../../../src/shared/risk/appetite-mapping.ts'
import type { SlTpBounds } from '../../../../src/shared/risk/sl-tp.ts'

// Pure assembly of everything needed to build one asset's ModelCallPayload
// entry and its RiskGateContext — no I/O. index.ts's job is reading the raw
// rows/provider responses this consumes and persisting whatever the later
// stages (callModel, evaluateRiskGate, the broker) decide.

// news items must already be persisted (real news_items.id, a UUID) before
// reaching this function — reasons[].newsId (src/shared/decisions/
// types.ts) is validated as a UUID the model cites back, so the model can
// only be given news that already has a real, joinable id. Persisting is
// I/O and stays in index.ts; this function just shapes what's handed to it.
export interface PersistedNewsItem {
  id: string
  source: string
  headline: string
  summary: string | null
  publishedAt: string
}

export function toNewsInput(item: PersistedNewsItem, nowIso: string): NewsInput {
  return {
    id: item.id,
    source: item.source,
    headline: item.headline,
    summary: item.summary,
    publishedAt: item.publishedAt,
    ageMinutes: (new Date(nowIso).getTime() - new Date(item.publishedAt).getTime()) / 60_000,
  }
}

function unrealizedPnlPct(position: Position, currentPrice: number): number {
  return position.direction === 'long'
    ? (currentPrice - position.entryPrice) / position.entryPrice
    : (position.entryPrice - currentPrice) / position.entryPrice
}

// A HOLD on an open position must reaffirm-or-revise the invalidation
// conditions it's given here (prompt.ts's invalidation section; gate.ts
// now deterministically rejects an empty reaffirmation — the corrective
// fix between Steps 6 and 7). What's fed back is the invalidation from
// the most recent decision on this asset that actually set some — not
// necessarily the position's own opening decision, since a later HOLD may
// have already revised it. Resolving "which decision that is" is a DB
// query (I/O); this function takes the already-resolved conditions.
export function buildOpenPositionInput(position: Position, currentPrice: number, nowIso: string, openInvalidation: InvalidationCondition[]): OpenPositionInput {
  return {
    direction: position.direction,
    entryPrice: position.entryPrice,
    stopLossPrice: position.stopLossPrice,
    takeProfitPrice: position.takeProfitPrice,
    unrealizedPnlPct: unrealizedPnlPct(position, currentPrice),
    heldHours: (new Date(nowIso).getTime() - new Date(position.openedAt).getTime()) / 3_600_000,
    openInvalidation,
  }
}

// Informational only, for the payload the model reads — NOT the
// enforcement (gate.ts's own check against recentStopLossClose is what
// actually blocks a re-entry). A small, deliberate duplication of gate.ts's
// one-line "minutes since close" arithmetic rather than exporting a
// private helper from that closed step for a purely cosmetic consumer; a
// bug here could only make the model's own awareness of the block
// inaccurate, never bypass the real gate.
export function deriveBlockedDirections(recentStopLossClose: RecentStopLossClose | null, stopOutReentryBlockMinutes: number, nowIso: string): Direction[] {
  if (!recentStopLossClose) return []
  const minutesSince = (new Date(nowIso).getTime() - new Date(recentStopLossClose.closedAt).getTime()) / 60_000
  return minutesSince < stopOutReentryBlockMinutes ? [recentStopLossClose.direction] : []
}

export interface AssetRawInputs {
  asset: AssetSymbol
  marketData: NormalizedMarketData
  news: PersistedNewsItem[]
  openPosition: Position | null
  openInvalidation: InvalidationCondition[] // only meaningful when openPosition is non-null
  recentDecisions: RecentDecisionInput[]
  recentStopLossClose: RecentStopLossClose | null
  stopOutReentryBlockMinutes: number
  nowIso: string
}

export function buildAssetInput(inputs: AssetRawInputs): AssetInput {
  const indicators = calculateIndicators(inputs.marketData)
  const recentCloses = getRecentCloses(inputs.marketData)

  return {
    asset: inputs.asset,
    state: derivePositionState(inputs.openPosition),
    market: {
      price: inputs.marketData.price,
      change1hPct: inputs.marketData.change1hPct,
      change24hPct: inputs.marketData.change24hPct,
      change7dPct: inputs.marketData.change7dPct,
      indicators,
      recentCloses,
    },
    news: inputs.news.map((n) => toNewsInput(n, inputs.nowIso)),
    position: inputs.openPosition
      ? buildOpenPositionInput(inputs.openPosition, inputs.marketData.price, inputs.nowIso, inputs.openInvalidation)
      : null,
    recentDecisions: inputs.recentDecisions,
    blockedDirections: deriveBlockedDirections(inputs.recentStopLossClose, inputs.stopOutReentryBlockMinutes, inputs.nowIso),
  }
}

export function buildPortfolioConstraints(minConfidence: number, slTpBounds: SlTpBounds): PortfolioConstraints {
  return {
    minConfidence,
    minStopLossPct: slTpBounds.minStopLossPct,
    maxStopLossPct: slTpBounds.maxStopLossPct,
    minTakeProfitPct: slTpBounds.minTakeProfitPct,
    maxTakeProfitPct: slTpBounds.maxTakeProfitPct,
  }
}

export interface GateContextInputs {
  asset: AssetSymbol
  entryPrice: number
  nav: number
  cash: number
  openPosition: Position | null
  appetite: RiskAppetiteThresholds
  maxSingleTradePct: number
  maxAssetExposurePct: number
  slTpBounds: SlTpBounds
  stopOutReentryBlockMinutes: number
  recentStopLossClose: RecentStopLossClose | null
  nowIso: string
}

// currentAssetExposureUsd is always 0 in V0 regardless of openPosition —
// sizing.ts's own module comment: with one net position per asset and no
// ADD action, an asset either has a brand-new open being sized (exposure
// 0 so far) or already has a position and therefore can't be sized again
// (the gate's state check rejects OPEN_* before sizing ever runs). Kept
// as a real, named 0 here (not silently hardcoded inside sizing.ts) so
// this doesn't need to change the day pyramiding makes it non-zero.
export function buildRiskGateContext(inputs: GateContextInputs): RiskGateContext {
  return {
    currentState: derivePositionState(inputs.openPosition),
    entryPrice: inputs.entryPrice,
    nav: inputs.nav,
    cash: inputs.cash,
    effectiveMinConfidence: inputs.appetite.minConfidence,
    effectiveRiskBudgetPct: inputs.appetite.riskBudgetPct,
    effectiveSingleTradeCapPct: inputs.maxSingleTradePct,
    effectiveAssetExposureCapPct: inputs.maxAssetExposurePct,
    slTpBounds: inputs.slTpBounds,
    currentAssetExposureUsd: 0,
    stopOutReentryBlockMinutes: inputs.stopOutReentryBlockMinutes,
    recentStopLossClose: inputs.recentStopLossClose,
    nowIso: inputs.nowIso,
  }
}

export function checkMarketDataFreshness(
  data: NormalizedMarketData[],
  maxStalenessMinutes: number,
  nowIso: string,
): { fresh: true } | { fresh: false; reason: string } {
  const now = new Date(nowIso).getTime()
  for (const d of data) {
    const ageMinutes = (now - new Date(d.dataAsOf).getTime()) / 60_000
    if (ageMinutes > maxStalenessMinutes) {
      return { fresh: false, reason: `${d.asset} market data is ${ageMinutes.toFixed(1)} min stale (max ${maxStalenessMinutes})` }
    }
  }
  return { fresh: true }
}
