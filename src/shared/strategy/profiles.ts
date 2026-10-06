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
//
// 'intraday_ls' added 2026-10-01 — Strategy V4, a long/short intraday
// profile with its own six-arm bias-gated detector set (strategy/
// intraday-ls/) and a reward loop measuring each arm's expectancy
// (falsification hypothesis H7 — H6 remains Aggressive's and never
// started). Every exhaustive profile-dispatch switch in registry.ts
// became a compile error the moment this value was added — that is the
// point: a third profile can never silently fall through into
// Aggressive's branch (strategy/registry.ts's own module comment
// explains the precedent this closes).
export const StrategyProfile = z.enum(['balanced', 'aggressive', 'intraday_ls'])
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
  intraday_ls: {
    profile: 'intraday_ls',
    strategyVersion: 'v4-ls-intraday-30m',
    // 15, matching the live cron (agent-cycle-15min, changed 2026-10-03,
    // explicit user instruction: "trade every 15 mins, precisely... I
    // need more data to test my strategy"). This field is actually read
    // now (index.ts's Phase 0 wiring fix) for idempotency-key bucket
    // width, so it must match the real cron schedule or cycles start
    // silently colliding as duplicate_tick no-ops — exactly the bug this
    // project already hit once (2026-09-24) when this value drifted from
    // the live schedule. CoinGecko quota: user explicitly accepted the
    // ~32,145 req/month this implies (3.2x the free Demo tier's 10,000
    // cap) after being shown the exact number — same call this project
    // made once before (2026-09-24, reverted 2026-09-27 for unrelated
    // cost reasons, not because the math was wrong).
    //
    // Deliberately UNCHANGED alongside this (explicit user instruction:
    // "keep 30m bars + keep 4-bar window scan + keep 10m monitor"): the
    // 30-minute signal timeframe, WINDOW_SCAN_BARS=4 in strategy/
    // intraday-ls/detectors.ts, and position-monitor's own independent
    // 10-minute cycle. The consumed-opportunity lifecycle
    // (opportunity_bar_ts tracking, strategy/intraday-ls/lifecycle.ts) is
    // bar-timestamp-based, not cycle-count-based, so it already handles
    // more cycles re-observing the same closed bar correctly with zero
    // code change — a real signal still only ever emits once per genuine
    // 30-minute bar close, regardless of how many 15-minute decision
    // cycles observe it in the meantime.
    decisionIntervalMinutes: 15,
    newsLookbackMinutes: 195,
    maxDataStalenessMinutes: 10,
    risk: {
      riskBudgetPct: 0.005,
      // 0.30 -> 0.15 (2026-10-03, plan ASSET-4, explicit user instruction:
      // 4-asset universe, same aggregate risk). At the 1.2% stop floor,
      // live-verified before this change: NAV $10,006.28, BTC $3,001.54
      // (30.0%), ETH $2,996.45 (29.9%) — the OLD 30% cap was already
      // exactly saturated at 2 positions (maxTotalNotionalPct 0.60 / 0.30
      // = 2). Without this change, a 3rd/4th asset's candidate would be
      // REJECTED outright ("no room to open... by the total_notional
      // cap"), not shrunk, and BTC/ETH would win every contested cycle by
      // agent_settings.assets array order (see the asset-rotation fix
      // below). At 0.15: 4 x 15% = 60% notional (same ceiling), 4 x
      // (15% x 1.2%) = 0.72% of NAV against the SAME 0.75%
      // portfolioRiskCeilingUsd — same gross stop-risk envelope at the
      // floor, now spread across 4 assets instead of 2. This is NOT a
      // variance-equivalent claim: the 4 assets are correlated (mean
      // pairwise daily-return rho = 0.622, live-measured 2026-10-03 —
      // see progress-tracker.md), so the four stops are not independent
      // draws, and cost drag doubles (4 round trips vs 2). Only valid AT
      // the 1.2% floor — at wider ATR-driven stops the binding cap
      // changes and positions 3-4 get clamped below 15% rather than
      // filling at it.
      maxSingleTradePct: 0.15,
      maxTotalNotionalPct: 0.60,
      stopOutReentryBlockMinutes: 60,
    },
  },
}

export function strategyDefinitionFor(profile: StrategyProfile): StrategyDefinition {
  return STRATEGY_PROFILES[profile]
}
