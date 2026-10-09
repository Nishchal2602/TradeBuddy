import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { ResearchSymbol } from './types.ts'
import type { CloseReason, Direction, Position } from '../../../../src/shared/positions/types.ts'
import type { SlTpBounds } from '../../../../src/shared/risk/sl-tp.ts'
import type { IntradayLsConfig } from '../../../../src/shared/strategy/config-schema.ts'
import { evaluateRiskGate } from '../../../../src/shared/risk/gate.ts'
import type { RecentStopLossClose, RiskGateContext } from '../../../../src/shared/risk/gate.ts'
import { computeNav, openPosition, closePosition } from '../broker/accounting.ts'
import { findFirstTrigger, resolveFillPrice } from '../../position-monitor/triggers.ts'
import type { PricePoint } from '../../position-monitor/triggers.ts'
import { findHardMaxHoldExit, findSoftTimeStopExit } from '../../position-monitor/time-exits.ts'
import type { ArmId } from '../strategy/intraday-ls/detectors.ts'
import type { DetectHistoricalCandidateInput, HistoricalDetectResult, HistoricalMarketSnapshot } from './historical-detect.ts'
import { detectHistoricalCandidate } from './historical-detect.ts'
import type { HistoricalBarRow } from './db/historical-bars.ts'
import { classifyRejectionReason } from './stats.ts'

// RESEARCH-1 (2026-10-08, STRAT-1 P5, stage R2) — the portfolio/broker
// simulation loop. Reuses the live risk gate (evaluateRiskGate), the live
// paper broker (openPosition/closePosition/computeNav/computePositionValue),
// and the live position-monitor's own exit logic (findFirstTrigger/
// resolveFillPrice, findHardMaxHoldExit/findSoftTimeStopExit) UNMODIFIED —
// "it calls the SAME pure functions live code already uses; it is not a
// second implementation of trading logic" (project-overview.md's own
// Backtest/Replay Scope text). detectHistoricalCandidate (its own module)
// supplies the one thing this engine does not reimplement either:
// deterministic candidate origination.
//
// --- Known, STATED scope simplifications (read before trusting a result) --
//
// 1. Intrabar stop/target ambiguity resolves PESSIMISTICALLY, always — a
//    30m bar whose high crosses the target AND whose low crosses the stop
//    is resolved as "stop first," never as a [pessimistic, optimistic]
//    interval (unlike P2/P4's own diagnostic work). Tracking both bounds
//    through an entire multi-year simulation is a real engineering lift;
//    a single, always-conservative path was chosen so a backtest never
//    OVERSTATES an edge — consistent with this project's own standing
//    preference. A future enhancement could track both bounds.
// 2. The giveback ratchet is NOT simulated (it requires continuous
//    sampledMfeR/sampledMaeR high-water tracking this engine does not yet
//    build) — a config with givebackEnabledForIntradayLs=true behaves
//    identically to one with it disabled, in this engine only.
// 3. Funding is charged only at OPEN and CLOSE (via the broker's own
//    computeFundingAccrual, called exactly as live code calls it) — a
//    position held across many days accrues less funding here than a
//    continuously-settled model would. shortFundingBpsPerDayByAsset is a
//    flat, caller-supplied rate per asset (sensibly derived from the real
//    ingested historical_funding_rates, e.g. an average), not a
//    per-tick lookup of the real time-varying rate.
// 4. Cross-asset tie-breaking at a shared tick uses the CALLER-SUPPLIED
//    asset order, not the live system's deterministic rotation
//    (cycle/idempotency.ts's rotateAssetOrder) — a stated simplification,
//    immaterial except when a portfolio-wide cap binds with more
//    candidates than room, which is rare at this engine's position count.
// 5. Each series is fed to detectHistoricalCandidate as a BOUNDED trailing
//    window (matching what live code actually fetches each cycle — e.g.
//    ~120 daily closes, ~180 4h candles — never the full all-time
//    history), both for live fidelity AND because indicator functions
//    like evaluateTrendRegime/calculateEMA read only their own trailing
//    window regardless of how much more is handed to them.

const DAILY_WINDOW = 120
const FOUR_H_WINDOW = 180
const HOURLY_WINDOW = 60
const THIRTY_M_WINDOW = 60

export interface BacktestParams {
  assets: AssetSymbol[]
  config: IntradayLsConfig
  startingCapitalUsd: number
  feeBps: number
  slippageBps: number
  effectiveMinConfidence: number
  slTpBounds: SlTpBounds
  portfolioRiskCeilingMultiplier: number
  drawdownBreakerFloorPct: number
  minTradeNotionalPct: number
  minTradeNotionalUsd: number
  shortFundingBpsPerDayByAsset: Partial<Record<AssetSymbol, number>>
  // RESEARCH-1 stage R4 — passed straight through to detectHistoricalCandidate's
  // own identically-named, identically-defaulting injectables. See that
  // module's own comment: both default to the exact live functions.
  resolveBias?: DetectHistoricalCandidateInput['resolveBias']
  computeProtection?: DetectHistoricalCandidateInput['computeProtection']
  // RESEARCH-1 stage R4 — overrides the WHOLE detection call (never just
  // bias/protection), for a variant that bypasses the six-arm concept
  // entirely (the random-entry baseline, variants.ts's own
  // buildRandomEntryDetector). Defaults to calling detectHistoricalCandidate
  // with this same params object's resolveBias/computeProtection, so
  // every existing caller is unaffected.
  detectFn?: (input: DetectHistoricalCandidateInput) => HistoricalDetectResult
}

export interface ClosedBacktestTrade {
  // DT-1 (2026-10-09) — widened AssetSymbol -> ResearchSymbol (plan §5.2,
  // §9.1) so this shape is shareable with baseline-daily-trend.ts's wider
  // universe, per this file's own header comment: "both loops emit the
  // SAME ClosedBacktestTrade/OpenBacktestPosition shapes, so their results
  // are directly comparable." Type-only widening (ResearchSymbol ⊇
  // AssetSymbol as a string) — runBacktest below still only ever receives
  // AssetSymbol values via its own BacktestParams.assets: AssetSymbol[],
  // so this engine's own behavior and call surface are UNCHANGED (plan
  // §9.3: "intraday_ls and all V4 detectors and replay infrastructure"
  // stay untouched).
  asset: ResearchSymbol
  direction: Direction
  // 'daily_trend' is the baseline-daily-trend.ts strategy's own literal —
  // that strategy has no six-arm concept at all (one archetype, not six),
  // widened here (rather than kept as two separate, non-comparable
  // result shapes) so its trades are directly comparable against V4's in
  // the same downstream stats/reporting code.
  armId: ArmId | 'daily_trend'
  openedAt: string
  closedAt: string
  entryPrice: number
  exitPrice: number
  quantity: number
  stopLossPrice: number
  takeProfitPrice: number
  closeReason: CloseReason
  realizedPnl: number
  fee: number
  slippageCost: number
  fundingCost: number
  initialRiskUsd: number
}

export interface OpenBacktestPosition {
  // DT-1 (2026-10-09) — same widening and the same reasoning as
  // ClosedBacktestTrade.asset above.
  asset: ResearchSymbol
  // 'daily_trend' is the baseline-daily-trend.ts strategy's own literal —
  // that strategy has no six-arm concept at all (one archetype, not six),
  // widened here (rather than kept as two separate, non-comparable
  // result shapes) so its trades are directly comparable against V4's in
  // the same downstream stats/reporting code.
  armId: ArmId | 'daily_trend'
  position: Position
}

export interface BacktestResult {
  closedTrades: ClosedBacktestTrade[]
  navSeries: { timestamp: string; nav: number }[]
  openAtEnd: OpenBacktestPosition[]
  // Every REJECTED (never clamped/approved) risk-gate call this run made,
  // bucketed via stats.ts's own classifyRejectionReason -- real counted
  // data for the §22 "risk rejections by reason" panel row, never
  // fabricated or silently omitted.
  rejectionsByReason: Record<string, number>
}

interface AssetSeries {
  daily: HistoricalBarRow[]
  fourH: HistoricalBarRow[]
  hourly: HistoricalBarRow[]
  thirtyM: HistoricalBarRow[]
}

interface SeriesPointers {
  daily: number
  fourH: number
  hourly: number
  thirtyM: number
}

function byCloseAsc(a: HistoricalBarRow, b: HistoricalBarRow): number {
  return new Date(a.closeTime).getTime() - new Date(b.closeTime).getTime()
}

function buildSeries(bars: readonly HistoricalBarRow[]): AssetSeries {
  return {
    daily: bars.filter((b) => b.timeframe === '1d').sort(byCloseAsc),
    fourH: bars.filter((b) => b.timeframe === '4h').sort(byCloseAsc),
    hourly: bars.filter((b) => b.timeframe === '1h').sort(byCloseAsc),
    thirtyM: bars.filter((b) => b.timeframe === '30m').sort(byCloseAsc),
  }
}

// Pessimistic (stop-assumed-first) two-point ordering within one bar — see
// this module's own header comment, scope note 1.
function pessimisticPoints(direction: Direction, bar: HistoricalBarRow): PricePoint[] {
  return direction === 'long'
    ? [{ timestamp: bar.closeTime, price: bar.low }, { timestamp: bar.closeTime, price: bar.high }]
    : [{ timestamp: bar.closeTime, price: bar.high }, { timestamp: bar.closeTime, price: bar.low }]
}

interface ExitDecision {
  closeReason: CloseReason
  fillPrice: number
  triggeredAt: string
}

// Precedence matches position-monitor/plan.ts's own documented order:
// SL/TP -> hard max -> (giveback, not simulated here) -> soft time stop.
function checkExit(position: Position, bar: HistoricalBarRow, config: IntradayLsConfig): ExitDecision | null {
  const trigger = findFirstTrigger(position.direction, position.stopLossPrice, position.takeProfitPrice, pessimisticPoints(position.direction, bar))
  if (trigger.triggered) {
    return { closeReason: trigger.reason, fillPrice: resolveFillPrice(trigger), triggeredAt: trigger.triggeredAt }
  }

  const closePoint: PricePoint[] = [{ timestamp: bar.closeTime, price: bar.close }]
  const hardMax = findHardMaxHoldExit(position, closePoint, config.maxHoldMinutes)
  if (hardMax) return { closeReason: 'time_stop', fillPrice: hardMax.observedPrice, triggeredAt: hardMax.triggeredAt }

  const softTime = findSoftTimeStopExit(position, closePoint, config.timeStopMinutes)
  if (softTime) return { closeReason: 'time_stop', fillPrice: softTime.observedPrice, triggeredAt: softTime.triggeredAt }

  return null
}

function dailyCloseOf(b: HistoricalBarRow) {
  return { timestamp: b.closeTime, close: b.close }
}

function buildSnapshot(asset: AssetSymbol, series: AssetSeries, ptr: SeriesPointers, bar: HistoricalBarRow): HistoricalMarketSnapshot {
  const daily = series.daily.slice(Math.max(0, ptr.daily - DAILY_WINDOW), ptr.daily)
  const fourH = series.fourH.slice(Math.max(0, ptr.fourH - FOUR_H_WINDOW), ptr.fourH)
  const hourly = series.hourly.slice(Math.max(0, ptr.hourly - HOURLY_WINDOW), ptr.hourly)
  const thirtyM = series.thirtyM.slice(Math.max(0, ptr.thirtyM - THIRTY_M_WINDOW), ptr.thirtyM)
  return {
    asset,
    dailyCloses: daily.map(dailyCloseOf),
    h4Candles: fourH.map((b) => ({ timestamp: b.closeTime, open: b.open, high: b.high, low: b.low, close: b.close })),
    hourlyCloses: hourly.map(dailyCloseOf),
    hourlyVolumes: hourly.map((b) => ({ timestamp: b.closeTime, volume: b.volume })),
    bars30m: thirtyM.map((b) => ({ timestamp: b.closeTime, open: b.open, high: b.high, low: b.low, close: b.close })),
    volumes30m: thirtyM.map((b) => b.volume),
    price: bar.close,
    asOfIso: bar.closeTime,
  }
}

export function runBacktest(barsByAsset: Partial<Record<AssetSymbol, readonly HistoricalBarRow[]>>, params: BacktestParams): BacktestResult {
  const seriesByAsset = new Map<AssetSymbol, AssetSeries>()
  const ptrByAsset = new Map<AssetSymbol, SeriesPointers>()
  for (const asset of params.assets) {
    seriesByAsset.set(asset, buildSeries(barsByAsset[asset] ?? []))
    ptrByAsset.set(asset, { daily: 0, fourH: 0, hourly: 0, thirtyM: 0 })
  }

  // The master tick clock: the asset with the most 30m bars. Binance's 30m
  // grid is globally aligned across symbols (verified during R1 ingestion
  // — every asset's bars land on the identical :00/:30 boundaries), so
  // every other asset's own bar closeTimes are a SUBSET of this one's.
  let masterAsset = params.assets[0]!
  for (const asset of params.assets) {
    if ((seriesByAsset.get(asset)?.thirtyM.length ?? 0) > (seriesByAsset.get(masterAsset)?.thirtyM.length ?? 0)) masterAsset = asset
  }
  const masterTicks = seriesByAsset.get(masterAsset)!.thirtyM.map((b) => b.closeTime)

  let cash = params.startingCapitalUsd
  let peakNav = params.startingCapitalUsd
  const open = new Map<AssetSymbol, OpenBacktestPosition>()
  const lastConsumedBarTs = new Map<AssetSymbol, string | null>()
  const recentStopLossClose = new Map<AssetSymbol, RecentStopLossClose | null>()
  // ResearchSymbol-keyed (not AssetSymbol), since it is read via
  // OpenBacktestPosition.asset below (now ResearchSymbol-typed) — this
  // engine's own callers still only ever insert AssetSymbol values
  // (params.assets: AssetSymbol[]), so behavior is unchanged.
  const latestPrice = new Map<ResearchSymbol, number>()
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
      const ptr = ptrByAsset.get(asset)!

      while (ptr.daily < series.daily.length && series.daily[ptr.daily]!.closeTime <= tick) ptr.daily++
      while (ptr.fourH < series.fourH.length && series.fourH[ptr.fourH]!.closeTime <= tick) ptr.fourH++
      while (ptr.hourly < series.hourly.length && series.hourly[ptr.hourly]!.closeTime <= tick) ptr.hourly++
      const prevThirtyM = ptr.thirtyM
      while (ptr.thirtyM < series.thirtyM.length && series.thirtyM[ptr.thirtyM]!.closeTime <= tick) ptr.thirtyM++
      if (ptr.thirtyM === prevThirtyM) continue // this asset has no new 30m bar at this tick (history not yet started, or ended)

      const bar = series.thirtyM[ptr.thirtyM - 1]!
      latestPrice.set(asset, bar.close)

      // 1) exit check for an existing open position, against ONLY the new bar.
      const existing = open.get(asset)
      if (existing) {
        const exit = checkExit(existing.position, bar, params.config)
        if (exit) {
          const closeRes = closePosition({
            position: existing.position,
            attemptedFillPrice: exit.fillPrice,
            feeBps: params.feeBps,
            slippageBps: params.slippageBps,
            closeReason: exit.closeReason,
            decisionId: null,
            startingCash: cash,
            nowIso: exit.triggeredAt,
            shortFundingBpsPerDay: params.shortFundingBpsPerDayByAsset[asset] ?? 0,
          })
          cash = closeRes.cashAfter
          closedTrades.push({
            asset,
            direction: existing.position.direction,
            armId: existing.armId,
            openedAt: existing.position.openedAt,
            closedAt: exit.triggeredAt,
            entryPrice: existing.position.entryPrice,
            exitPrice: closeRes.trade.fillPrice,
            quantity: existing.position.quantity,
            stopLossPrice: existing.position.stopLossPrice,
            takeProfitPrice: existing.position.takeProfitPrice,
            closeReason: closeRes.closedPosition.closeReason!,
            realizedPnl: closeRes.realizedPnl,
            fee: closeRes.trade.fee,
            slippageCost: closeRes.trade.slippageCost,
            fundingCost: closeRes.fundingCost,
            initialRiskUsd: existing.position.initialRiskUsd ?? existing.position.quantity * Math.abs(existing.position.entryPrice - existing.position.stopLossPrice),
          })
          if (closeRes.closedPosition.closeReason === 'stop_loss') {
            recentStopLossClose.set(asset, { direction: existing.position.direction, closedAt: exit.triggeredAt })
          }
          open.delete(asset)
        }
      }

      // 2) detection for a new candidate, only once flat.
      if (!open.has(asset)) {
        const snapshot = buildSnapshot(asset, series, ptr, bar)
        const detectInput: DetectHistoricalCandidateInput = {
          snapshot,
          config: params.config,
          lastConsumedBarTs: lastConsumedBarTs.get(asset) ?? null,
          feeBps: params.feeBps,
          slippageBps: params.slippageBps,
          resolveBias: params.resolveBias,
          computeProtection: params.computeProtection,
        }
        const detection = (params.detectFn ?? detectHistoricalCandidate)(detectInput)
        if (detection.opportunityContext) lastConsumedBarTs.set(asset, detection.opportunityContext.opportunityBarTs)

        if (detection.candidate) {
          const direction: Direction = detection.candidate.action === 'OPEN_LONG' ? 'long' : 'short'
          const nav = computeNavNow()
          const otherOpen = [...open.entries()].filter(([a]) => a !== asset).map(([, o]) => o)
          const otherOpenPositionsRiskAtStopUsd = otherOpen.reduce((sum, o) => sum + o.position.quantity * Math.abs(o.position.entryPrice - o.position.stopLossPrice), 0)
          const otherSameDirectionNotionalUsd = otherOpen.filter((o) => o.position.direction === direction).reduce((sum, o) => sum + o.position.quantity * o.position.entryPrice, 0)
          const riskBudgetPct = params.config.riskBudgetPct ?? 0.0015

          const context: RiskGateContext = {
            currentState: 'FLAT',
            entryPrice: bar.close,
            nav,
            cash,
            effectiveMinConfidence: params.effectiveMinConfidence,
            effectiveRiskBudgetPct: riskBudgetPct,
            effectiveSingleTradeCapPct: params.config.maxSingleTradePct,
            effectiveAssetExposureCapPct: params.config.maxSingleTradePct,
            slTpBounds: params.slTpBounds,
            currentAssetExposureUsd: 0,
            stopOutReentryBlockMinutes: params.config.stopOutReentryBlockMinutes,
            recentStopLossClose: recentStopLossClose.get(asset) ?? null,
            nowIso: tick,
            portfolioRiskCeilingUsd: params.portfolioRiskCeilingMultiplier * riskBudgetPct * nav,
            otherOpenPositionsRiskAtStopUsd,
            maxTotalNotionalUsd: params.config.maxTotalNotionalPct * nav,
            otherSameDirectionNotionalUsd,
            peakNav,
            drawdownBreakerFloorPct: params.drawdownBreakerFloorPct,
            openPosition: null,
            feeBps: params.feeBps,
            slippageBps: params.slippageBps,
            minTradeNotionalPct: params.minTradeNotionalPct,
            minTradeNotionalUsd: params.minTradeNotionalUsd,
          }

          const gateResult = evaluateRiskGate(detection.candidate, context)
          if (gateResult.riskStatus === 'rejected' && gateResult.riskReason) {
            const bucket = classifyRejectionReason(gateResult.riskReason)
            rejectionsByReason[bucket] = (rejectionsByReason[bucket] ?? 0) + 1
          }
          if ((gateResult.riskStatus === 'approved' || gateResult.riskStatus === 'clamped') && gateResult.approvedSizePct !== null) {
            const notionalUsd = gateResult.approvedSizePct * nav
            const openRes = openPosition({
              asset,
              direction,
              referencePrice: bar.close,
              notionalUsd,
              stopLossPrice: gateResult.computedStopLossPrice!,
              takeProfitPrice: gateResult.computedTakeProfitPrice!,
              feeBps: params.feeBps,
              slippageBps: params.slippageBps,
              portfolioId: 'backtest',
              decisionId: crypto.randomUUID(),
              startingCash: cash,
              nowIso: tick,
              strategyProfile: 'intraday_ls',
            })
            cash = openRes.cashAfter
            // The immutable-ruler fields (initialEntryPrice/initialStop
            // LossPrice/initialRiskUsd/partialRealizedPnlUsd) are set by
            // the live RPC (open_position_atomic) at insert time, not by
            // the pure openPosition() function itself — reconstructed
            // here identically (initialRiskUsd = quantity x |entry -
            // stop|, exactly deriveRiskBasedNotional's own inverse) so
            // findSoftTimeStopExit's positionPnlR computation has the
            // ruler it needs.
            const position: Position = {
              ...openRes.position,
              initialEntryPrice: openRes.position.entryPrice,
              initialStopLossPrice: openRes.position.stopLossPrice,
              initialRiskUsd: openRes.position.quantity * Math.abs(openRes.position.entryPrice - openRes.position.stopLossPrice),
              partialRealizedPnlUsd: 0,
            }
            open.set(asset, { asset, armId: detection.opportunityContext!.armId, position })
          }
        }
      }
    }

    peakNav = Math.max(peakNav, computeNavNow())
    navSeries.push({ timestamp: tick, nav: computeNavNow() })
  }

  return { closedTrades, navSeries, openAtEnd: [...open.values()], rejectionsByReason }
}
