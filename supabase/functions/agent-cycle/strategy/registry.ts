import { strategyDefinitionFor } from '../../../../src/shared/strategy/profiles.ts'
import type { StrategyDefinition, StrategyProfile } from '../../../../src/shared/strategy/profiles.ts'
import { evaluateTrendRegime } from './regime.ts'
import type { RegimeResult } from '../../../../src/shared/strategy/types.ts'
import { detectOpportunity } from './aggressive/detectors.ts'
import type { OpportunitySignal } from './aggressive/detectors.ts'
import { aggressiveProtectionFor, clearsTradeabilityFloor } from './aggressive/protection.ts'
import { computeIntradayFeatures } from './aggressive/features.ts'
import type { IntradayFeatures } from './aggressive/features.ts'
import type { IntradayMarketData } from './aggressive/types.ts'
import { calculateATRPercent } from '../indicators/calculate.ts'
import type { NormalizedMarketData } from '../../../../src/shared/market-data/types.ts'
import { TREND_MA_LOOKBACK_DAYS } from '../../../../src/shared/strategy/types.ts'

// Strategy-profile dispatch (2026-09-23) — the one module index.ts reads
// to answer "what does the SELECTED profile want here", for every
// profile-specific decision point. Deliberately a set of small, focused,
// independently-testable functions rather than a class/interface with
// swappable implementations — this codebase has exactly one class
// anywhere (CoinGeckoMarketDataProvider, for a genuine I/O-adapter
// reason) and is otherwise consistently functional; a StrategyRuntime
// OBJECT would be indirection this module doesn't need to earn its
// keep, since every function below already takes `profile` as its own
// first argument and switches on it internally — the same shape, without
// forcing every caller to first assemble an object.
//
// Balanced's OWN behavior lives entirely in regime.ts/rules.ts, UNTOUCHED
// — every Balanced branch below is a direct, unmodified call into those
// existing, already-tested modules. This file adds NOTHING to what
// Balanced does; it only adds a second branch alongside it for
// Aggressive, per asset, per decision point.

export function strategyFor(profile: StrategyProfile): StrategyDefinition {
  return strategyDefinitionFor(profile)
}

// --- Data sufficiency --------------------------------------------------
//
// Migration plan §11 / audit finding 3: the 50-daily-bar requirement
// (cycle/build-context.ts's checkMarketDataFreshness) is a BALANCED-ONLY
// rule that today fails the WHOLE CYCLE regardless of which profile is
// selected. This function is the profile-aware replacement logic
// index.ts calls per asset — Balanced still requires the 50 daily bars
// exactly as before; Aggressive requires its own >=12 closed 30m candles
// (detectors.ts's own MIN_BARS) instead, and does NOT require the daily
// series to be long enough (the 50DMA stays available as CONTEXT for
// Aggressive when present, never a gate — see aggressive/types.ts).

export interface DataSufficiencyResult {
  ok: boolean
  reason: string | null
}

export function checkStrategyDataSufficiency(
  profile: StrategyProfile,
  marketData: NormalizedMarketData,
  intraday: IntradayMarketData | undefined,
): DataSufficiencyResult {
  if (profile === 'balanced') {
    if (marketData.dailyCloseSeries.length < TREND_MA_LOOKBACK_DAYS) {
      return { ok: false, reason: `${marketData.asset} has only ${marketData.dailyCloseSeries.length} closed daily bars, need ${TREND_MA_LOOKBACK_DAYS} for the trend regime` }
    }
    return { ok: true, reason: null }
  }
  // aggressive
  if (!intraday) {
    return { ok: false, reason: `${marketData.asset} has no intraday market data available` }
  }
  if (intraday.ohlc30m.length < 12) {
    return { ok: false, reason: `${marketData.asset} has only ${intraday.ohlc30m.length} closed 30m bars, need at least 12` }
  }
  if (intraday.spot5m.length < 25) {
    return { ok: false, reason: `${marketData.asset} has only ${intraday.spot5m.length} closed 5m points, need at least 25` }
  }
  return { ok: true, reason: null }
}

// --- Regime / opportunity context ----------------------------------------
//
// Balanced's daily regime, computed exactly as before (evaluateTrendRegime
// unchanged) whenever the daily series is long enough — returned as
// CONTEXT for Aggressive too when available (never a gate for that
// profile), null when it genuinely isn't (a short daily series on an
// Aggressive cycle is not itself a failure — see
// checkStrategyDataSufficiency above, which never blocks Aggressive on
// this).

export function regimeContextFor(marketData: NormalizedMarketData): RegimeResult | null {
  if (marketData.dailyCloseSeries.length < TREND_MA_LOOKBACK_DAYS) return null
  return evaluateTrendRegime(marketData.dailyCloseSeries)
}

// Aggressive-only entry-opportunity detection. Always null for Balanced
// (that profile's entry eligibility is entirely regime.ts's own job, via
// strategy/rules.ts's buildCandidateProposal, called directly by
// index.ts exactly as before this migration — this function is never
// even invoked on that path).
export function detectAggressiveOpportunity(intraday: IntradayMarketData): OpportunitySignal | null {
  return detectOpportunity(intraday.ohlc30m)
}

export function intradayFeaturesFor(intraday: IntradayMarketData): IntradayFeatures {
  return computeIntradayFeatures(intraday.spot5m)
}

// --- ATR selection for the management layer -------------------------------
//
// Balanced: the existing 4-hourly `candles` ATR (unchanged — this is
// exactly indicators/calculate.ts's calculateATRPercent(marketData.candles,
// 14), reused as-is). Aggressive: the 30-minute true-OHLC ATR
// (protection.ts's own sole ATR source) — NEVER the 4-hourly figure,
// which is incoherent at this profile's 15-60 minute holding horizon.
export function managementAtrPctFor(profile: StrategyProfile, marketData: NormalizedMarketData, intraday: IntradayMarketData | undefined): number {
  if (profile === 'balanced') return calculateATRPercent(marketData.candles, 14)
  if (!intraday) throw new Error('managementAtrPctFor: aggressive profile requires intraday market data')
  return calculateATRPercent(intraday.ohlc30m, 14)
}

// --- Protection at origination only ---------------------------------------
//
// Called ONLY when a strategy originates a brand-new position — NEVER
// against an already-open one (migration plan §8: "switching never
// recomputes protection... an existing position keeps its absolute SL/TP
// for life", regardless of which profile is active when a later cycle
// evaluates it). Balanced's formula (strategy/rules.ts's
// stopLossPctFor/takeProfitPctFor) is UNCHANGED; Aggressive uses its own
// ATR30-derived regime (aggressive/protection.ts), never Balanced's
// 2.5%-floor formula.

export interface ProtectionForEntry {
  stopLossPct: number
  takeProfitPct: number
}

export function protectionForEntry(profile: StrategyProfile, atrPct: number, stopLossPctFor: (atrPct: number) => number, takeProfitPctFor: (stopLossPct: number) => number): ProtectionForEntry {
  if (profile === 'balanced') {
    const stopLossPct = stopLossPctFor(atrPct)
    return { stopLossPct, takeProfitPct: takeProfitPctFor(stopLossPct) }
  }
  const { stopLossPct, takeProfitPct } = aggressiveProtectionFor(atrPct)
  return { stopLossPct, takeProfitPct }
}

// --- Tradeability floor (aggressive entries only) -------------------------
//
// Balanced has no equivalent concept — its entries are gated purely by
// the deterministic regime rule and the (unchanged) news veto. Always
// returns true for Balanced so a shared call site never needs its own
// profile branch merely to skip this check.
export function clearsEntryTradeabilityFloor(profile: StrategyProfile, atrTargetDistancePct: number, estimatedRoundTripCostPct: number): boolean {
  if (profile === 'balanced') return true
  return clearsTradeabilityFloor(atrTargetDistancePct, estimatedRoundTripCostPct)
}

// Deterministic dynamic tightening (the old two-rung, agent-cycle-only
// mechanism) was retired 2026-09-23 — its profit-locking rung was
// provably dead code (a stop above entry is unrepresentable under
// positions_sl_tp_ordering_valid) and its surviving rung only
// approximated breakeven. Superseded by the monitor-enforced giveback
// ratchet (strategy/aggressive/protection.ts's rawGivebackFloor/
// nextGivebackFloor/shouldExecuteGivebackExit, orchestrated by
// position-monitor/giveback.ts) — profile-gated at the call site
// (position-monitor reads settings.strategyProfile directly), not
// through a registry wrapper here, since high-water SAMPLING runs
// regardless of the active profile and only the EXIT is Aggressive-only
// (migration plan §3.7).
