import { calculateIndicators, getRecentCloses } from '../indicators/calculate.ts'
import { derivePositionState } from '../../../../src/shared/positions/types.ts'
import type { Direction, Position } from '../../../../src/shared/positions/types.ts'
import type { NormalizedMarketData, AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { InvalidationCondition } from '../../../../src/shared/decisions/types.ts'
import type { RiskGateContext, RecentStopLossClose } from '../../../../src/shared/risk/gate.ts'
import type { PortfolioConstraints, AssetInput, OpenPositionInput, NewsInput, RecentDecisionInput } from '../model/payload.ts'
import type { RiskAppetiteThresholds } from '../../../../src/shared/risk/appetite-mapping.ts'
import type { SlTpBounds } from '../../../../src/shared/risk/sl-tp.ts'
import { TREND_MA_LOOKBACK_DAYS } from '../../../../src/shared/strategy/types.ts'
import type { RegimeResult } from '../../../../src/shared/strategy/types.ts'

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
  // trading-strategy-v1.md §7 — the deterministic signal index.ts (Phase 5)
  // already evaluated via evaluateTrendRegime before calling this function;
  // threaded straight through onto AssetInput.regime rather than
  // re-computed here, since this function stays pure I/O-free assembly and
  // evaluateTrendRegime needs the raw dailyCloseSeries this interface
  // doesn't otherwise carry.
  regime: RegimeResult
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
    regime: inputs.regime,
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

  // trading-strategy-v1.md §17 — all six already resolved by the caller
  // (index.ts, Phase 5), same pattern as maxSingleTradePct/
  // maxAssetExposurePct above: this function only threads them through,
  // it doesn't compute anything portfolio-wide itself (it's called once
  // per asset, and "other open positions" is inherently a whole-portfolio
  // concept the per-asset loop assembles).
  portfolioRiskCeilingUsd: number
  otherOpenPositionsRiskAtStopUsd: number
  maxTotalNotionalUsd: number
  otherSameDirectionNotionalUsd: number
  peakNav: number
  drawdownBreakerFloorPct: number
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
    portfolioRiskCeilingUsd: inputs.portfolioRiskCeilingUsd,
    otherOpenPositionsRiskAtStopUsd: inputs.otherOpenPositionsRiskAtStopUsd,
    maxTotalNotionalUsd: inputs.maxTotalNotionalUsd,
    otherSameDirectionNotionalUsd: inputs.otherSameDirectionNotionalUsd,
    peakNav: inputs.peakNav,
    drawdownBreakerFloorPct: inputs.drawdownBreakerFloorPct,
  }
}

// trading-strategy-v1.md §17 — the two cross-asset aggregates
// PortfolioRiskInputs needs (sizing.ts), computed fresh per asset-call
// since they depend on which OTHER positions are currently open — a set
// that can change mid-cycle as earlier assets in the same run execute
// (index.ts, Phase 5). Pure: takes the live openPositions/prices the
// caller already holds, no I/O of its own.
export function aggregateOtherOpenPositionsRisk(
  openPositions: Position[],
  excludeAsset: AssetSymbol,
  latestPriceByAsset: Map<AssetSymbol, number>,
): { otherOpenPositionsRiskAtStopUsd: number; otherSameDirectionNotionalUsd: number } {
  let otherOpenPositionsRiskAtStopUsd = 0
  let otherSameDirectionNotionalUsd = 0
  for (const p of openPositions) {
    if (p.asset === excludeAsset) continue
    // Actual dollar loss if THIS position's own stop is hit — quantity x
    // the stop's price distance from entry — not notional x a re-derived
    // stopLossPct (an already-open position doesn't carry one; this is
    // the exact, direct figure sizing.ts's own risk-at-stop concept means).
    otherOpenPositionsRiskAtStopUsd += p.quantity * Math.abs(p.entryPrice - p.stopLossPrice)
    // trading-strategy-v1.md §5/§17 — V1 only ever opens long
    // (sizing.ts's own PortfolioRiskInputs comment: "long-only in V1, so
    // 'same direction' is every open position today"). Filtered
    // explicitly rather than assumed, so a legacy/pre-existing short
    // (buildCandidateProposal's defensive-HOLD branch — never opened by
    // V1 itself, but not database-impossible) is correctly excluded from
    // the long-side notional cap rather than silently counted toward it.
    if (p.direction === 'long') {
      otherSameDirectionNotionalUsd += p.quantity * (latestPriceByAsset.get(p.asset) ?? p.entryPrice)
    }
  }
  return { otherOpenPositionsRiskAtStopUsd, otherSameDirectionNotionalUsd }
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
    // trading-strategy-v1.md §7/§27: the regime rule needs
    // TREND_MA_LOOKBACK_DAYS closed daily bars and must fail closed below
    // that, same as indicators/calculate.ts's InsufficientDataError does
    // for the existing indicators — checked here rather than deep inside
    // the regime module so a short daily series skips the whole cycle
    // (CLAUDE.md: "stale or failed critical inputs must fail closed"),
    // not just that one asset's regime evaluation.
    if (d.dailyCloseSeries.length < TREND_MA_LOOKBACK_DAYS) {
      return {
        fresh: false,
        reason: `${d.asset} has only ${d.dailyCloseSeries.length} closed daily bars, need ${TREND_MA_LOOKBACK_DAYS} for the trend regime`,
      }
    }
  }
  return { fresh: true }
}
