import type { IntradayLsConfig } from './config-schema.ts'

// CFG-1 — the two permanent, named configs. Both are kept forever (never
// deleted), because `v4-compat` is the control a replay harness needs to
// reproduce historical V4 behavior exactly, and `v4.1-corrected` must
// stay independently attributable rather than silently mutating in
// place. See CFG-1 plan's Stage 1A/1B split.

// --- v4-compat ---------------------------------------------------------
//
// Every value here is transcribed DIRECTLY from the live, deployed
// constant it mirrors — not re-derived, not rounded, not "obviously
// equivalent." Each line cites its exact source. This is the config a
// golden test asserts is byte-identical to today's hardcoded behavior.
export const V4_COMPAT_CONFIG: IntradayLsConfig = {
  presetName: 'v4-compat',

  // bias.ts: H4_EMA_FAST_PERIOD/H4_EMA_SLOW_PERIOD (module-private,
  // L15-16); daily floor from src/shared/strategy/types.ts's
  // TREND_MA_LOOKBACK_DAYS (50).
  dailyRegimeLookbackDays: 50,
  h4EmaFastPeriod: 20,
  h4EmaSlowPeriod: 50,

  // detectIntradayLsOpportunity's own if/else (detectors.ts:207-213) —
  // made an explicit, inspectable value here for the first time, but the
  // STRUCTURE matches that code exactly: LONG only ever attempts the two
  // long arms, SHORT only the two short arms, NEUTRAL only the two
  // fades.
  directionPolicy: {
    LONG: ['breakout_long', 'pullback_long'],
    SHORT: ['breakout_short', 'pullback_short'],
    NEUTRAL: ['fade_long', 'fade_short'],
  },
  // Today's code has NO concept of a short kill switch at all — nothing
  // currently stops a detected short from executing (bias has simply
  // never BEEN short, per CFG-1's own live measurement: 0/160 4h
  // points, BTC+ETH). `true` is the faithful mirror of "uncontested if
  // it ever fired," not an endorsement.
  shortEnabled: true,

  // protection.ts:37 — armId.startsWith('fade') ? 1.5 : 2.0. Modeled
  // per-arm here; every value below reproduces that exact binary split.
  arms: {
    breakout_long: { enabled: true, rewardRiskRatio: 2.0 },
    breakout_short: { enabled: true, rewardRiskRatio: 2.0 },
    pullback_long: { enabled: true, rewardRiskRatio: 2.0 },
    pullback_short: { enabled: true, rewardRiskRatio: 2.0 },
    fade_long: { enabled: true, rewardRiskRatio: 1.5 },
    fade_short: { enabled: true, rewardRiskRatio: 1.5 },
  },

  // aggressive/detectors.ts: LOOKBACK_BARS=8, MIN_BARS=12.
  // detectors.ts: WINDOW_SCAN_BARS=4, BREAKOUT_MIN_VOLUME_TREND_RATIO=1.2,
  // FADE_RSI_OVERSOLD=30, FADE_RSI_OVERBOUGHT=70, FADE_RANGE_ATR_MULTIPLE=1.0,
  // MIN_CLOSES_FOR_FADE=16, MIN_CANDLES_FOR_FADE=16.
  // registry.ts: spot5m floor inline literal 25 (intraday_ls branch).
  // indicators/calculate.ts calls: RSI period 14, ATR period 14
  // (detectors.ts:169-172, registry.ts:175).
  breakoutLookbackBars: 8,
  minOhlc30mBars: 12,
  windowScanBars: 4,
  breakoutMinVolumeTrendRatio: 1.2,
  fadeRsiOversold: 30,
  fadeRsiOverbought: 70,
  fadeRangeAtrMultiple: 1.0,
  minClosesForFade: 16,
  minCandlesForFade: 16,
  minSpot5mPoints: 25,
  rsiPeriod: 14,
  atrPeriod: 14,

  // protection.ts: STOP_ATR_MULTIPLE=2.0, STOP_FLOOR_PCT=0.012,
  // COST_GATE_MAX_RATIO=0.25.
  stopAtrMultiple: 2.0,
  stopFloorPct: 0.012,
  costGateMaxRatio: 0.25,

  // detectors.ts:226-228 — isOpportunityStillValid's own intended ratio
  // (0.5), but NEVER CALLED in production (CFG-1 Stage 0 finding — a
  // tested, specified rule with zero production callers). v4-compat
  // faithfully mirrors "specified but not enforced."
  signalDriftMaxFraction: 0.5,
  signalDriftRuleEnforced: false,

  // agent_settings.time_stop_minutes=480, max_hold_minutes=1440 (DB-
  // configured today, mirrored here as the current live values).
  // time-exits.ts:75 inline literal 0.5.
  timeStopMinutes: 480,
  maxHoldMinutes: 1440,
  softTimeStopPnlRExemption: 0.5,
  // position-monitor/plan.ts:194 gates the giveback EXIT on
  // strategyProfile === 'aggressive' specifically — structurally false
  // for intraday_ls today, regardless of what plan §4.2 says. v4-compat
  // mirrors what the CODE does.
  givebackEnabledForIntradayLs: false,

  // src/shared/strategy/profiles.ts STRATEGY_PROFILES.intraday_ls.risk.
  // 0.005 -> 0.0015 (2026-10-08, plan STRAT-1 P1) — see that file's own
  // comment: the 15% single-trade cap was binding on 20 of 23 real sized
  // decisions at 0.005, making every risk multiplier inert.
  riskBudgetPct: 0.0015,
  maxSingleTradePct: 0.15,
  maxTotalNotionalPct: 0.60,
  stopOutReentryBlockMinutes: 60,
}

// --- v4.1-corrected ------------------------------------------------------
//
// Every field below is IDENTICAL to v4-compat except the ones listed —
// each one a documented CFG-1 Stage 1B correction, never an unlisted
// extra (enforced by the differential test in config-presets.test.ts).
export const V4_1_CORRECTED_CONFIG: IntradayLsConfig = {
  ...V4_COMPAT_CONFIG,
  presetName: 'v4.1-corrected',

  // Correction: short reachable, not executed. Detection/shadow-logging
  // still runs under directionPolicy's SHORT mapping (unchanged above);
  // only live execution is gated. This is the "measurable, not live"
  // decision from CFG-1's own AskUserQuestion round.
  shortEnabled: false,

  // Correction #9 — REMOVAL, not replacement. strategy/aggressive/
  // features.ts's volumeTrend() computes a ratio of two windows of
  // CoinGecko's `total_volumes` field, which is ROLLING 24-HOUR
  // TRAILING volume resampled every 5 minutes (verified live, CFG-1
  // Stage 0: BTC reads ~$25-34 BILLION per 5-minute point, moving only
  // single-digit percent between samples) — not incremental per-
  // interval volume. The ratio is structurally pinned near 1.0
  // (live-measured across all four assets: 0.97-1.11), so breakout's
  // `volumeTrendRatio >= 1.2` gate has never been confirming a real
  // volume surge. null disables the confirmation outright. Deliberately
  // NOT replaced with a different signal here — that is a separate,
  // Stage-3-validated research question; shipping a replacement now
  // would smuggle an untested strategy change into a correction that
  // must stay narrowly "this was broken, now it's gone."
  breakoutMinVolumeTrendRatio: null,

  // Correction — the specified, tested drift rule now actually runs.
  signalDriftRuleEnforced: true,

  // Correction — resolves the plan-vs-code contradiction by making the
  // ratchet's own exit eligible under intraday_ls, matching plan §4.2's
  // stated design rather than leaving the code's silent override in
  // place.
  givebackEnabledForIntradayLs: true,
}
