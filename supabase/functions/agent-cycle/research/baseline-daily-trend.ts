import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { CloseReason, Direction, Position } from '../../../../src/shared/positions/types.ts'
import { derivePositionState } from '../../../../src/shared/positions/types.ts'
import type { SlTpBounds } from '../../../../src/shared/risk/sl-tp.ts'
import { evaluateRiskGate } from '../../../../src/shared/risk/gate.ts'
import type { RecentStopLossClose, RiskGateContext } from '../../../../src/shared/risk/gate.ts'
import { computeNav, openPosition, closePosition } from '../broker/accounting.ts'
import { findFirstTrigger, resolveFillPrice } from '../../position-monitor/triggers.ts'
import type { PricePoint } from '../../position-monitor/triggers.ts'
import { evaluateTrendRegime } from '../strategy/regime.ts'
import { buildCandidateProposal } from '../strategy/rules.ts'
import { calculateATRPercent, InsufficientDataError } from '../indicators/calculate.ts'
import { TREND_MA_LOOKBACK_DAYS } from '../../../../src/shared/strategy/types.ts'
import type { HistoricalBarRow } from './db/historical-bars.ts'
import type { ClosedBacktestTrade, OpenBacktestPosition } from './backtest-engine.ts'
import { classifyRejectionReason } from './stats.ts'

// RESEARCH-1 (2026-10-08, STRAT-1 P5, stage R2) — the daily-trend +
// inverse-vol-targeting comparison strategy named in the plan's own first
// research questions: "the daily leg should be the alpha, not a filter"
// (the literature review in STRAT-1's Context section). Deliberately NOT
// new strategy logic: `evaluateTrendRegime` (long when dailyClose >
// SMA50, flat otherwise) and `buildCandidateProposal` (the exact state
// machine already live under the 'balanced' profile — OPEN_LONG while
// FLAT+UP, CLOSE while LONG+DOWN, HOLD otherwise) are reused completely
// UNMODIFIED, never reimplemented. "Size proportional to 1/ATR%"
// (inverse-vol targeting) needs no new sizing code either:
// deriveRiskBasedNotional (src/shared/risk/sizing.ts, invoked inside
// evaluateRiskGate, reused unmodified) already produces notional inversely
// proportional to stop distance, and stopLossPctFor (strategy/rules.ts,
// also reused unmodified) sets that stop distance proportional to ATR% --
// so inverse-vol sizing is already exactly what the EXISTING Balanced
// risk path does; this module adds no new formula for it.
//
// A SEPARATE loop from backtest-engine.ts's runBacktest, not a
// parameterization of it: this strategy is DAILY-cadence and
// state-based (no six arms, no opportunity-consumption lifecycle, no
// time-stops, no giveback), whereas runBacktest is 30-minute-cadence and
// edge-triggered. Forcing one loop to cover both would blur two
// genuinely different strategies' semantics together. Both loops reuse
// the SAME underlying primitives (the risk gate, the broker, true-OHLC
// trigger detection) and both emit the SAME ClosedBacktestTrade/
// OpenBacktestPosition shapes, so their results are directly comparable.
//
// Same stated scope simplification as backtest-engine.ts: intrabar
// stop/target ambiguity (here, a single DAY whose high crosses the
// target AND low crosses the stop) resolves PESSIMISTICALLY (stop
// assumed first), never as an interval.

const ATR_PERIOD = 14
const DAILY_WINDOW = 120 // matches what live code's own daily fetch covers (~120 days)
const FOUR_H_WINDOW = 180 // matches live code's own 4h fetch (~30 days); Balanced's ATR is 4-hourly, never daily

export interface DailyTrendBacktestParams {
  assets: AssetSymbol[]
  startingCapitalUsd: number
  feeBps: number
  slippageBps: number
  effectiveMinConfidence: number
  effectiveRiskBudgetPct: number
  effectiveSingleTradeCapPct: number
  effectiveAssetExposureCapPct: number
  maxTotalNotionalPct: number
  portfolioRiskCeilingMultiplier: number
  drawdownBreakerFloorPct: number
  stopOutReentryBlockMinutes: number
  slTpBounds: SlTpBounds
  // DT-1 plan, Phase P0 (2026-10-08) — OPTIONAL, default-inert membership
  // gate. Checked at exactly ONE point, immediately before an OPEN_LONG
  // candidate acts, and nowhere else: it can only ever SUPPRESS an open,
  // never force one, alter an exit, change sizing, or touch an existing
  // position. This is what lets DT-1 express "this asset may not open a
  // position this month" (a point-in-time universe gate) without forking
  // the strategy loop. The S1c identity test in
  // baseline-daily-trend.test.ts proves that omitting this parameter (or
  // always returning true) reproduces R4's exact byte-for-byte output —
  // "unmodified" is proven here, not merely asserted.
  canOpen?: (asset: AssetSymbol, barCloseIso: string) => boolean
}

export interface DailyTrendBacktestResult {
  closedTrades: ClosedBacktestTrade[]
  navSeries: { timestamp: string; nav: number }[]
  openAtEnd: OpenBacktestPosition[]
  rejectionsByReason: Record<string, number>
}

interface AssetDailySeries {
  daily: HistoricalBarRow[]
  fourH: HistoricalBarRow[]
}

function byCloseAsc(a: HistoricalBarRow, b: HistoricalBarRow): number {
  return new Date(a.closeTime).getTime() - new Date(b.closeTime).getTime()
}

function buildSeries(bars: readonly HistoricalBarRow[]): AssetDailySeries {
  return {
    daily: bars.filter((b) => b.timeframe === '1d').sort(byCloseAsc),
    fourH: bars.filter((b) => b.timeframe === '4h').sort(byCloseAsc),
  }
}

function pessimisticPoints(direction: Direction, bar: HistoricalBarRow): PricePoint[] {
  return direction === 'long'
    ? [{ timestamp: bar.closeTime, price: bar.low }, { timestamp: bar.closeTime, price: bar.high }]
    : [{ timestamp: bar.closeTime, price: bar.high }, { timestamp: bar.closeTime, price: bar.low }]
}

export function runDailyTrendBacktest(barsByAsset: Partial<Record<AssetSymbol, readonly HistoricalBarRow[]>>, params: DailyTrendBacktestParams): DailyTrendBacktestResult {
  const seriesByAsset = new Map<AssetSymbol, AssetDailySeries>()
  const dailyIdxByAsset = new Map<AssetSymbol, number>()
  const fourHIdxByAsset = new Map<AssetSymbol, number>()
  for (const asset of params.assets) {
    seriesByAsset.set(asset, buildSeries(barsByAsset[asset] ?? []))
    dailyIdxByAsset.set(asset, 0)
    fourHIdxByAsset.set(asset, 0)
  }

  let masterAsset = params.assets[0]!
  for (const asset of params.assets) {
    if ((seriesByAsset.get(asset)?.daily.length ?? 0) > (seriesByAsset.get(masterAsset)?.daily.length ?? 0)) masterAsset = asset
  }
  const masterTicks = seriesByAsset.get(masterAsset)!.daily.map((b) => b.closeTime)

  let cash = params.startingCapitalUsd
  let peakNav = params.startingCapitalUsd
  const open = new Map<AssetSymbol, OpenBacktestPosition>()
  const recentStopLossClose = new Map<AssetSymbol, RecentStopLossClose | null>()
  const latestPrice = new Map<AssetSymbol, number>()
  const closedTrades: ClosedBacktestTrade[] = []
  const rejectionsByReason: Record<string, number> = {}
  const navSeries: { timestamp: string; nav: number }[] = []

  const computeNavNow = (): number => {
    const valuations = [...open.values()].map((o) => ({
      direction: o.position.direction,
      quantity: o.position.quantity,
      entryPrice: o.position.entryPrice,
      costBasis: o.position.costBasis,
      currentPrice: latestPrice.get(o.asset) ?? o.position.entryPrice,
    }))
    return computeNav(cash, valuations)
  }

  for (const tick of masterTicks) {
    for (const asset of params.assets) {
      const series = seriesByAsset.get(asset)!
      let dailyIdx = dailyIdxByAsset.get(asset)!
      let fourHIdx = fourHIdxByAsset.get(asset)!

      const prevDailyIdx = dailyIdx
      while (dailyIdx < series.daily.length && series.daily[dailyIdx]!.closeTime <= tick) dailyIdx++
      while (fourHIdx < series.fourH.length && series.fourH[fourHIdx]!.closeTime <= tick) fourHIdx++
      dailyIdxByAsset.set(asset, dailyIdx)
      fourHIdxByAsset.set(asset, fourHIdx)
      if (dailyIdx === prevDailyIdx) continue // no new daily bar for this asset at this tick

      const bar = series.daily[dailyIdx - 1]!
      latestPrice.set(asset, bar.close)

      // 1) exit check for an existing position, against ONLY the new bar.
      // No time-stops/giveback here -- Balanced's own exit set is
      // strictly stop-loss / take-profit / regime-flip CLOSE
      // (trading-strategy-v1.md §13).
      const existing = open.get(asset)
      if (existing) {
        const trigger = findFirstTrigger(existing.position.direction, existing.position.stopLossPrice, existing.position.takeProfitPrice, pessimisticPoints(existing.position.direction, bar))
        if (trigger.triggered) {
          const fillPrice = resolveFillPrice(trigger)
          const closeRes = closePosition({
            position: existing.position,
            attemptedFillPrice: fillPrice,
            feeBps: params.feeBps,
            slippageBps: params.slippageBps,
            closeReason: trigger.reason,
            decisionId: null,
            startingCash: cash,
            nowIso: trigger.triggeredAt,
            shortFundingBpsPerDay: 0, // Balanced is long/flat only -- never a short, never funding
          })
          cash = closeRes.cashAfter
          closedTrades.push(toClosedTrade(asset, existing, closeRes, trigger.triggeredAt))
          if (closeRes.closedPosition.closeReason === 'stop_loss') {
            recentStopLossClose.set(asset, { direction: existing.position.direction, closedAt: trigger.triggeredAt })
          }
          open.delete(asset)
        }
      }

      // 2) the regime rule itself -- reused completely unmodified.
      const dailyWindow = series.daily.slice(Math.max(0, dailyIdx - DAILY_WINDOW), dailyIdx)
      const fourHWindow = series.fourH.slice(Math.max(0, fourHIdx - FOUR_H_WINDOW), fourHIdx)
      if (dailyWindow.length < TREND_MA_LOOKBACK_DAYS) continue
      let atrPct: number
      try {
        atrPct = calculateATRPercent(fourHWindow.map((b) => ({ timestamp: b.closeTime, open: b.open, high: b.high, low: b.low, close: b.close })), ATR_PERIOD)
      } catch (e) {
        if (e instanceof InsufficientDataError) continue
        throw e
      }

      const regime = evaluateTrendRegime(dailyWindow.map((b) => ({ timestamp: b.closeTime, close: b.close })))
      const currentState = derivePositionState(open.get(asset)?.position ?? null)
      const candidate = buildCandidateProposal({ asset, currentState, regime, atrPct })

      if (candidate.action === 'CLOSE') {
        const position = open.get(asset)!.position
        const closeRes = closePosition({
          position,
          attemptedFillPrice: bar.close,
          feeBps: params.feeBps,
          slippageBps: params.slippageBps,
          closeReason: 'agent_close',
          decisionId: crypto.randomUUID(),
          startingCash: cash,
          nowIso: tick,
          shortFundingBpsPerDay: 0,
        })
        cash = closeRes.cashAfter
        closedTrades.push(toClosedTrade(asset, open.get(asset)!, closeRes, tick))
        open.delete(asset)
      } else if (candidate.action === 'OPEN_LONG' && params.canOpen && !params.canOpen(asset, tick)) {
        // Membership gate suppressed this open — the ONLY effect
        // canOpen may ever have. No gate evaluation, no sizing, no
        // state mutation of any kind; the asset simply stays FLAT this
        // tick, exactly as if the regime itself had not turned UP.
        rejectionsByReason['canOpen_suppressed'] = (rejectionsByReason['canOpen_suppressed'] ?? 0) + 1
      } else if (candidate.action === 'OPEN_LONG') {
        const nav = computeNavNow()
        const otherOpen = [...open.values()].filter((o) => o.asset !== asset)
        const otherOpenPositionsRiskAtStopUsd = otherOpen.reduce((sum, o) => sum + o.position.quantity * Math.abs(o.position.entryPrice - o.position.stopLossPrice), 0)
        const otherSameDirectionNotionalUsd = otherOpen.filter((o) => o.position.direction === 'long').reduce((sum, o) => sum + o.position.quantity * o.position.entryPrice, 0)

        const context: RiskGateContext = {
          currentState: 'FLAT',
          entryPrice: bar.close,
          nav,
          cash,
          effectiveMinConfidence: params.effectiveMinConfidence,
          effectiveRiskBudgetPct: params.effectiveRiskBudgetPct,
          effectiveSingleTradeCapPct: params.effectiveSingleTradeCapPct,
          effectiveAssetExposureCapPct: params.effectiveAssetExposureCapPct,
          slTpBounds: params.slTpBounds,
          currentAssetExposureUsd: 0,
          stopOutReentryBlockMinutes: params.stopOutReentryBlockMinutes,
          recentStopLossClose: recentStopLossClose.get(asset) ?? null,
          nowIso: tick,
          portfolioRiskCeilingUsd: params.portfolioRiskCeilingMultiplier * params.effectiveRiskBudgetPct * nav,
          otherOpenPositionsRiskAtStopUsd,
          maxTotalNotionalUsd: params.maxTotalNotionalPct * nav,
          otherSameDirectionNotionalUsd,
          peakNav,
          drawdownBreakerFloorPct: params.drawdownBreakerFloorPct,
          openPosition: null,
          feeBps: params.feeBps,
          slippageBps: params.slippageBps,
          minTradeNotionalPct: 0,
          minTradeNotionalUsd: 0,
        }

        const gateResult = evaluateRiskGate(candidate, context)
        if (gateResult.riskStatus === 'rejected' && gateResult.riskReason) {
          const bucket = classifyRejectionReason(gateResult.riskReason)
          rejectionsByReason[bucket] = (rejectionsByReason[bucket] ?? 0) + 1
        }
        if ((gateResult.riskStatus === 'approved' || gateResult.riskStatus === 'clamped') && gateResult.approvedSizePct !== null) {
          const notionalUsd = gateResult.approvedSizePct * nav
          const openRes = openPosition({
            asset,
            direction: 'long',
            referencePrice: bar.close,
            notionalUsd,
            stopLossPrice: gateResult.computedStopLossPrice!,
            takeProfitPrice: gateResult.computedTakeProfitPrice!,
            feeBps: params.feeBps,
            slippageBps: params.slippageBps,
            portfolioId: 'daily-trend-baseline',
            decisionId: crypto.randomUUID(),
            startingCash: cash,
            nowIso: tick,
            strategyProfile: 'balanced',
          })
          cash = openRes.cashAfter
          const position: Position = {
            ...openRes.position,
            initialEntryPrice: openRes.position.entryPrice,
            initialStopLossPrice: openRes.position.stopLossPrice,
            initialRiskUsd: openRes.position.quantity * Math.abs(openRes.position.entryPrice - openRes.position.stopLossPrice),
            partialRealizedPnlUsd: 0,
          }
          // armId has no meaning for this strategy (one archetype, not six
          // arms) -- recorded as the dedicated 'daily_trend' literal
          // (backtest-engine.ts's own ClosedBacktestTrade/
          // OpenBacktestPosition types are widened to admit it) so
          // downstream analysis can tell the two strategies' trades apart
          // at a glance without a separate "strategy" column.
          open.set(asset, { asset, armId: 'daily_trend', position })
        }
      }
    }

    peakNav = Math.max(peakNav, computeNavNow())
    navSeries.push({ timestamp: tick, nav: computeNavNow() })
  }

  return { closedTrades, navSeries, openAtEnd: [...open.values()], rejectionsByReason }
}

function toClosedTrade(
  asset: AssetSymbol,
  existing: OpenBacktestPosition,
  closeRes: { closedPosition: Position; trade: { fillPrice: number; fee: number; slippageCost: number }; realizedPnl: number; fundingCost: number },
  closedAt: string,
): ClosedBacktestTrade {
  return {
    asset,
    direction: existing.position.direction,
    armId: existing.armId,
    openedAt: existing.position.openedAt,
    closedAt,
    entryPrice: existing.position.entryPrice,
    exitPrice: closeRes.trade.fillPrice,
    quantity: existing.position.quantity,
    stopLossPrice: existing.position.stopLossPrice,
    takeProfitPrice: existing.position.takeProfitPrice,
    closeReason: closeRes.closedPosition.closeReason as CloseReason,
    realizedPnl: closeRes.realizedPnl,
    fee: closeRes.trade.fee,
    slippageCost: closeRes.trade.slippageCost,
    fundingCost: closeRes.fundingCost,
    initialRiskUsd: existing.position.initialRiskUsd ?? existing.position.quantity * Math.abs(existing.position.entryPrice - existing.position.stopLossPrice),
  }
}
