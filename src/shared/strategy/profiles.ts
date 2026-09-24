import { z } from 'zod'

// Strategy-profile abstraction (2026-09-23) — Balanced (the live V1/Phase-2
// strategy, moved behind this interface with zero semantic change) vs
// Aggressive (a new 15-minute-decision-cadence / 30-minute-signal
// intraday strategy, pre-registered falsification hypothesis H6 — see
// context/specs/trading-strategy-aggressive-v3.md). Matches the live
// agent_settings.strategy_profile CHECK constraint — this value crosses a
// real PostgREST parse boundary (an external JSON value arriving over the
// wire), which is exactly appetite-mapping.ts's own criterion for
// z.enum + z.infer over a plain TS union (src/shared/positions/types.ts's
// PositionState comment explains the other side of that distinction).
//
// Deliberately NOT the same enum as RiskAppetite
// (src/shared/risk/appetite-mapping.ts), even though both happen to use
// the words "balanced"/"aggressive" — risk_appetite predates this file,
// maps only to riskBudgetPct, and continues to govern Balanced exactly as
// before (STRATEGY_PROFILES.balanced.risk.riskBudgetPct is null for
// precisely this reason — see below). The name collision is real and is
// called out here on purpose so it is never mistaken for one concept.
//
// 'conservative' is deliberately NOT a member here. It is not a trading
// strategy and must never silently map to one — every call site that
// reads agent_settings.strategy_profile fails closed on anything outside
// this enum, Conservative included.
export const StrategyProfile = z.enum(['balanced', 'aggressive'])
export type StrategyProfile = z.infer<typeof StrategyProfile>

// Per-profile risk-policy overrides layered on top of the existing,
// unchanged risk-gate machinery (src/shared/risk/gate.ts,
// riskAppetiteThresholds). Nothing here replaces a global safety control —
// the drawdown breaker, the portfolio-risk-ceiling multiplier, the
// minimum-trade-notional floor, and every SL/TP bound/ordering/exhaustion
// rule apply identically to both profiles. This only widens or narrows
// the SAME caps within whatever the (now-raised) agent_settings ceilings
// still allow — see build-context.ts's effective-cap resolution, which
// takes min(profileValue, ceiling), never the profile value alone.
export interface StrategyRiskPolicy {
  // null -> fall through to riskAppetiteThresholds(agent_settings.risk_appetite)
  // UNCHANGED, so risk_appetite keeps governing Balanced exactly as it
  // does today and does not become a dead dial once strategy_profile
  // exists. Aggressive overrides this with its own pre-registered value
  // (never "risk_appetite, but bigger" — the two are unrelated by design,
  // see the enum comment above).
  riskBudgetPct: number | null
  maxSingleTradePct: number
  maxTotalNotionalPct: number
  // Re-entry-block minutes are read directly from the profile, never
  // min()'d against anything — a smaller value here is LESS safety, so
  // there is no "ceiling" for this one to be clamped against the way
  // sizing caps are.
  stopOutReentryBlockMinutes: number
}

export interface StrategyDefinition {
  profile: StrategyProfile
  // Persisted verbatim to agent_decisions.strategy_version. Balanced's
  // value is the LIVE literal already in production ('v1-regime',
  // index.ts's hard-coded string before this migration) — not renamed,
  // so every existing row and domain/decisions.test.ts:175's fixture stay
  // correct without a data migration. 'v0-gemini-originated' (2 historical
  // rows, pre-dating even v1-regime) is unaffected either way — the
  // column stays free-text with no CHECK constraint, deliberately, so it
  // can keep recording exactly what actually generated a decision even
  // as the live set of profiles evolves.
  strategyVersion: string
  // The profile's INTENDED cadence — informational/UI only in this phase.
  // There is no pg_cron for agent-cycle at any cadence; V0 stays
  // manual-only regardless of which profile is selected. Named precisely
  // to avoid self-deception later: Aggressive's number here is 15
  // (decision cadence), which is NOT the same thing as its entry SIGNAL
  // timeframe (30-minute closed bars) — see strategyVersion's own
  // 'v3-jev-intraday-30m' naming, which carries the signal timeframe
  // specifically because the cadence number alone would mislead.
  decisionIntervalMinutes: number
  // NOT derived from decisionIntervalMinutes + an overlap constant the
  // way the pre-profile code did (index.ts's old
  // `decisionIntervalMinutes + newsLookbackOverlapMinutes`) — that
  // derivation would silently narrow Aggressive's news window from 195
  // to 30 minutes, starving the news-veto layer (which both profiles
  // share) of context purely as a side effect of cadence. Both profiles
  // currently use the same 195-minute window on purpose: the news that
  // matters to a 15-minute decision is not meaningfully different in
  // recency from what matters to a 3-hour one, and the RSS feed itself
  // has no finer granularity to exploit even if the window were narrower.
  newsLookbackMinutes: number
  maxDataStalenessMinutes: number
  risk: StrategyRiskPolicy
}

// Pre-registered, frozen values — not derived from a backtest, not to be
// tuned on H6's results without declaring a new profile version (V3.1).
// See context/specs/trading-strategy-aggressive-v3.md for the full
// rationale behind every number here.
export const STRATEGY_PROFILES: Record<StrategyProfile, StrategyDefinition> = {
  balanced: {
    profile: 'balanced',
    strategyVersion: 'v1-regime',
    decisionIntervalMinutes: 180,
    newsLookbackMinutes: 195,
    maxDataStalenessMinutes: 30,
    risk: {
      riskBudgetPct: null,
      maxSingleTradePct: 0.20,
      maxTotalNotionalPct: 0.30,
      stopOutReentryBlockMinutes: 360,
    },
  },
  aggressive: {
    profile: 'aggressive',
    strategyVersion: 'v3-jev-intraday-30m',
    decisionIntervalMinutes: 15,
    newsLookbackMinutes: 195,
    maxDataStalenessMinutes: 10,
    risk: {
      // Pre-registered directly (not "risk_appetite's aggressive tier,
      // doubled" or any other derivation from that unrelated enum).
      riskBudgetPct: 0.0075,
      maxSingleTradePct: 0.30,
      maxTotalNotionalPct: 0.60,
      // ~4 decision cycles at this profile's cadence, not Balanced's 360
      // (~24 cycles at ITS cadence) — the block exists to avoid
      // re-entering the same failed thesis, and a 15-60 minute thesis
      // goes stale far faster than a weeks-long one. Principled shrink,
      // not a weakened safety control: still a real cool-off, just sized
      // to this profile's own horizon.
      stopOutReentryBlockMinutes: 60,
    },
  },
}

export function strategyDefinitionFor(profile: StrategyProfile): StrategyDefinition {
  return STRATEGY_PROFILES[profile]
}
