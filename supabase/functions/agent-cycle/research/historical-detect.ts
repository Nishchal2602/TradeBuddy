import type { AssetSymbol, NormalizedMarketData, OhlcCandle, VolumePoint } from '../../../../src/shared/market-data/types.ts'
import { TREND_MA_LOOKBACK_DAYS } from '../../../../src/shared/strategy/types.ts'
import type { IntradayLsConfig } from '../../../../src/shared/strategy/config-schema.ts'
import { computeStopLossTakeProfitPrices } from '../../../../src/shared/risk/sl-tp.ts'
import type { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'
import { calculateATRPercent, InsufficientDataError } from '../indicators/calculate.ts'
import { evaluateBias } from '../strategy/intraday-ls/bias.ts'
import type { Bias } from '../strategy/intraday-ls/bias.ts'
import { MIN_H4_CLOSES } from '../strategy/intraday-ls/bias.ts'
import { detectIntradayLsOpportunity, isOpportunityStillValid, MIN_BARS_FOR_WINDOW_SCAN } from '../strategy/intraday-ls/detectors.ts'
import type { ArmId, Direction } from '../strategy/intraday-ls/detectors.ts'
import { computeIntradayLsProtection, passesIntradayLsCostGate } from '../strategy/intraday-ls/protection.ts'
import { shouldEmitOpportunity } from '../strategy/intraday-ls/lifecycle.ts'

// RESEARCH-1 (2026-10-08, STRAT-1 P5, stage R2) — the historical
// equivalent of strategy/intraday-ls/detect-candidate.ts's detectCandidate,
// reusing every one of its constituent pure functions (evaluateBias,
// detectIntradayLsOpportunity, computeIntradayLsProtection,
// passesIntradayLsCostGate, shouldEmitOpportunity, isOpportunityStillValid,
// computeStopLossTakeProfitPrices) UNMODIFIED — "it calls the SAME pure
// functions live code already uses; it is not a second implementation of
// trading logic" (project-overview.md's own Backtest/Replay Scope text).
//
// Deliberately a SEPARATE composition from detectCandidate itself, not a
// call into it, for one load-bearing reason: detectCandidate's own
// internal `intradayFeaturesFor(intraday)` call requires a true 5-minute
// spot+volume series (IntradayMarketData.spot5m, floor 25 points) this
// engine does not have and never fetches by design (RESEARCH-1's own
// ingestion scope: 30m/1h/4h/1d native Binance klines only — see
// ingest-core.ts's own comment on why 1-minute bars were never needed).
// Synthesizing a fake spot5m series to force-fit detectCandidate's own
// shape was considered and rejected — it would manufacture data this
// engine never actually observed. Instead, the two breakout-confirmation
// features detectCandidate's call graph actually reads
// (features.ret60mPct, features.volumeTrendRatio — confirmed by reading
// detect-candidate.ts itself; no other IntradayFeatures field is consumed
// by this call path) are recomputed directly from the SAME 30m true-OHLC
// series already in scope, using the identical TIME WINDOWS
// aggressive/features.ts's own ret60mPct/volumeTrend definitions use (60
// minutes back; a 30-minute short window over a 2-hour long window for
// volume) — just measured at 30m-bar granularity instead of 5m-point
// granularity, and fed Binance's TRUE per-interval volume rather than
// CoinGecko's rolling-24h artifact (CFG-1 Stage 0's own documented
// defect) that made the live volumeTrendRatio structurally meaningless in
// the first place. This is a genuine fidelity difference from live
// behavior, stated here rather than hidden.

export interface HistoricalMarketSnapshot {
  asset: AssetSymbol
  // All four series ordered oldest -> newest, every bar already closed by
  // construction (ingest-core.ts's own "closed bars only" discipline).
  dailyCloses: { timestamp: string; close: number }[]
  h4Candles: OhlcCandle[]
  hourlyCloses: { timestamp: string; close: number }[]
  hourlyVolumes: VolumePoint[]
  bars30m: OhlcCandle[]
  // Aligned 1:1 with bars30m (same length, same order) — OhlcCandle has
  // no volume field, so this is carried as its own parallel array rather
  // than widening that shared type for one research-only consumer.
  volumes30m: number[]
  // The latest 30m bar's own close — the best available stand-in for "the
  // current live spot price" this engine has (there is no spot feed in
  // historical data). Used only where detectIntradayLsOpportunity's own
  // NormalizedMarketData parameter needs a `price` field (the fade arm's
  // calculateDistanceFromSevenDayRange) and for computeStopLossTakeProfit
  // Prices.
  price: number
  asOfIso: string
}

export interface HistoricalSufficiencyResult {
  ok: boolean
  reason: string | null
}

// Mirrors registry.ts's checkStrategyDataSufficiency 'intraday_ls' branch
// EXACTLY, minus the spot5m check (no spot5m exists here — see this
// module's own header comment on why that's a deliberate omission, not an
// oversight) and using MIN_BARS_FOR_WINDOW_SCAN rather than the bare
// MIN_BARS floor: unlike the live system (which re-scans the same
// trailing window every 15-minute cycle and so only ever needs the
// smaller MIN_BARS floor for scanForEdge's own k=0 position), this engine
// evaluates EXACTLY ONCE per new 30m bar close (see backtest-engine.ts),
// so it needs the full window-scan margin available from the first
// evaluation onward.
export function checkHistoricalDataSufficiency(snapshot: HistoricalMarketSnapshot): HistoricalSufficiencyResult {
  if (snapshot.dailyCloses.length < TREND_MA_LOOKBACK_DAYS) {
    return { ok: false, reason: `${snapshot.asset} has only ${snapshot.dailyCloses.length} daily closes, need ${TREND_MA_LOOKBACK_DAYS}` }
  }
  if (snapshot.h4Candles.length < MIN_H4_CLOSES) {
    return { ok: false, reason: `${snapshot.asset} has only ${snapshot.h4Candles.length} 4h candles, need ${MIN_H4_CLOSES}` }
  }
  if (snapshot.bars30m.length < MIN_BARS_FOR_WINDOW_SCAN) {
    return { ok: false, reason: `${snapshot.asset} has only ${snapshot.bars30m.length} 30m bars, need ${MIN_BARS_FOR_WINDOW_SCAN}` }
  }
  return { ok: true, reason: null }
}

// The SAME 60-minutes-back return definition aggressive/features.ts's
// returnPct(points, 12) computes on 5-minute points (12 x 5min = 60min) —
// here, 2 x 30min = 60min.
export function ret60mPctFrom30m(bars30m: readonly OhlcCandle[]): number {
  const n = bars30m.length
  if (n < 3) throw new InsufficientDataError('ret60m (30m-derived)', 3, n)
  const latest = bars30m[n - 1]!.close
  const earlier = bars30m[n - 3]!.close
  return ((latest - earlier) / earlier) * 100
}

// The SAME windows aggressive/features.ts's volumeTrend() uses (a
// 30-minute short window over a 2-hour long window), translated from 5m
// points (6-over-24) to 30m bars (1-over-4) — fed TRUE per-interval
// Binance volume, unlike the live CoinGecko-sourced ratio this mirrors in
// shape only.
export function volumeTrendRatioFrom30m(bars30m: readonly OhlcCandle[], volumes30m: readonly number[]): number {
  if (volumes30m.length < 4) throw new InsufficientDataError('volume trend (30m-derived)', 4, volumes30m.length)
  const meanOf = (n: number) => {
    const slice = volumes30m.slice(-n)
    return slice.reduce((sum, v) => sum + v, 0) / slice.length
  }
  const longWindowMean = meanOf(4)
  if (longWindowMean === 0) return 1
  return meanOf(1) / longWindowMean
}

export function buildNormalizedMarketDataForFade(snapshot: HistoricalMarketSnapshot): NormalizedMarketData {
  return {
    asset: snapshot.asset,
    provider: 'binance-historical',
    dataAsOf: snapshot.asOfIso,
    fetchedAt: snapshot.asOfIso,
    price: snapshot.price,
    change1hPct: null,
    change24hPct: null,
    change7dPct: null,
    candles: snapshot.h4Candles,
    closeSeries: snapshot.hourlyCloses,
    volumeSeries: snapshot.hourlyVolumes,
    dailyCloseSeries: snapshot.dailyCloses,
  }
}

export interface HistoricalDetectResult {
  regimeState: Bias | null
  eligibleArms: ArmId[] | null
  noCandidateReason: 'data_insufficient' | 'regime_null' | 'no_arm_triggered' | 'cost_gate' | 'opportunity_consumed' | 'signal_stale' | null
  opportunityContext?: { armId: ArmId; bias: Bias; direction: Direction; opportunityBarTs: string }
  candidate?: ModelDecisionProposal
  computedPrices?: { stopLossPrice: number; takeProfitPrice: number }
}

export interface DetectHistoricalCandidateInput {
  snapshot: HistoricalMarketSnapshot
  config: IntradayLsConfig
  // Mirrors detectCandidate's own lastConsumedBarTs param exactly — the
  // caller's job (backtest-engine.ts tracks this per asset across the run,
  // same discipline as the live index.ts/readLastConsumedOpportunityBarTs).
  lastConsumedBarTs: string | null
  feeBps: number
  slippageBps: number
  // RESEARCH-1 stage R4 — both injectable, both DEFAULT to the exact live
  // functions (evaluateBias, computeIntradayLsProtection), so every
  // existing call site/test is unaffected. Exists so R4's pre-registered
  // variant list (the daily-only bias leg; alternative stop/target
  // geometry) can be expressed as a DIFFERENT function passed in here,
  // never as edits to this module's own default behavior or to the live
  // strategy modules those defaults import.
  resolveBias?: (dailyCloses: HistoricalMarketSnapshot['dailyCloses'], h4Closes: number[]) => Bias | null
  computeProtection?: (armId: ArmId, atr30Pct: number) => { stopLossPct: number; takeProfitPct: number }
}

// Mirrors strategy/intraday-ls/detect-candidate.ts's own detectCandidate
// sequence EXACTLY (same branch order, same early-return reasons) — see
// this module's own header comment for the one place the two diverge
// (how breakoutConfirmation is computed) and why.
export function detectHistoricalCandidate(input: DetectHistoricalCandidateInput): HistoricalDetectResult {
  const { snapshot, config, lastConsumedBarTs, feeBps, slippageBps } = input
  const resolveBias = input.resolveBias ?? evaluateBias
  const computeProtection = input.computeProtection ?? computeIntradayLsProtection

  const sufficiency = checkHistoricalDataSufficiency(snapshot)
  if (!sufficiency.ok) {
    return { regimeState: null, eligibleArms: null, noCandidateReason: 'data_insufficient' }
  }

  const bias = resolveBias(snapshot.dailyCloses, snapshot.h4Candles.map((c) => c.close))
  if (!bias) {
    return { regimeState: null, eligibleArms: null, noCandidateReason: 'regime_null' }
  }

  const eligibleArms = config.directionPolicy[bias] ?? null
  const ret60mPct = ret60mPctFrom30m(snapshot.bars30m)
  const volumeTrendRatio = volumeTrendRatioFrom30m(snapshot.bars30m, snapshot.volumes30m)

  const detected = detectIntradayLsOpportunity(
    bias,
    snapshot.bars30m,
    { ret60mPct, volumeTrendRatio },
    buildNormalizedMarketDataForFade(snapshot),
    {
      directionPolicy: config.directionPolicy,
      arms: config.arms,
      minVolumeTrendRatio: config.breakoutMinVolumeTrendRatio,
      fadeThresholds: { oversold: config.fadeRsiOversold, overbought: config.fadeRsiOverbought, rangeAtrMultiple: config.fadeRangeAtrMultiple },
    },
  )
  if (!detected) {
    return { regimeState: bias, eligibleArms, noCandidateReason: 'no_arm_triggered' }
  }

  // ATR source matches registry.ts's managementAtrPctFor('intraday_ls', ...)
  // exactly: the 30-minute true-OHLC ATR, never the 4-hourly one.
  const atr30Pct = calculateATRPercent([...snapshot.bars30m], 14)
  const { stopLossPct, takeProfitPct } = computeProtection(detected.armId, atr30Pct)
  const estimatedRoundTripCostPct = (2 * (feeBps + slippageBps)) / 10_000
  if (!passesIntradayLsCostGate(estimatedRoundTripCostPct, stopLossPct)) {
    return { regimeState: bias, eligibleArms, noCandidateReason: 'cost_gate' }
  }

  if (!shouldEmitOpportunity(detected.detectedAtBarTs, lastConsumedBarTs)) {
    return { regimeState: bias, eligibleArms, noCandidateReason: 'opportunity_consumed' }
  }

  if (config.signalDriftRuleEnforced && !isOpportunityStillValid(detected.triggerBarClose, snapshot.price, stopLossPct, config.signalDriftMaxFraction)) {
    return { regimeState: bias, eligibleArms, noCandidateReason: 'signal_stale' }
  }

  const opportunityContext = { armId: detected.armId, bias, direction: detected.direction, opportunityBarTs: detected.detectedAtBarTs }
  const computedPrices = computeStopLossTakeProfitPrices(detected.direction, snapshot.price, stopLossPct, takeProfitPct)

  let candidate: ModelDecisionProposal | undefined
  if (!(detected.direction === 'short' && !config.shortEnabled)) {
    candidate = {
      asset: snapshot.asset,
      action: detected.direction === 'long' ? 'OPEN_LONG' : 'OPEN_SHORT',
      confidence: 1,
      horizonHours: null,
      reasons: [{ type: 'TECHNICAL', text: `intraday_ls ${detected.armId} detected under ${bias} bias (historical replay)` }],
      invalidation: [{ text: 'Managed by the deterministic exit set (stop-loss/take-profit/giveback/time-stop)' }],
      stopLossPct,
      takeProfitPct,
    }
  }

  return { regimeState: bias, eligibleArms, noCandidateReason: null, opportunityContext, candidate, computedPrices }
}
