import { z } from 'zod'

// CFG-1 (2026-10-06) — the strategy config schema. Every field here is
// EITHER a value already pre-registered and frozen in
// strategy/intraday-ls/{bias,detectors,protection}.ts and position-
// monitor/{plan,time-exits}.ts, or a NEW field this plan's investigation
// found necessary (shortEnabled, per-arm enable, givebackEnabledForIntradayLs
// — each resolving a specific, named defect; see config-presets.ts).
//
// This schema does NOT yet replace those modules' own hardcoded
// constants as their live source of truth — that threading is explicit
// FUTURE WORK (CFG-1 Stage 1A remainder / 1B), deliberately deferred
// rather than rushed, because it requires editing the signatures of
// functions ~15 test files pin by exact value, and doing that carelessly
// under time pressure is how a refactor silently changes behavior while
// claiming not to. What THIS schema + config-presets.ts + the DB loader
// DO provide, now: a single authoritative, hashable, versioned record of
// what the frozen values currently ARE, and the one new field
// (`strategyConfigHash`) persisted on every decision so a future change
// is attributable rather than a silent edit. See CFG-1 plan for the full
// phased design.

export const ArmFamily = z.enum(['breakout', 'pullback', 'fade'])
export type ArmFamily = z.infer<typeof ArmFamily>

export const ArmId = z.enum(['breakout_long', 'breakout_short', 'pullback_long', 'pullback_short', 'fade_long', 'fade_short'])
export type ArmId = z.infer<typeof ArmId>

export const Bias = z.enum(['LONG', 'SHORT', 'NEUTRAL'])
export type Bias = z.infer<typeof Bias>

const ArmConfig = z.object({
  enabled: z.boolean(),
  // Reward:risk multiple — takeProfitPct = rewardRiskRatio * stopLossPct.
  // Today's hardcoded split (protection.ts:37) is binary by FAMILY (fade
  // arms 1.5, the four trend arms 2.0) — modeled per-ARM here, which is
  // strictly more flexible and defaults to reproduce the exact same
  // binary split.
  rewardRiskRatio: z.number().positive(),
}).strict()
export type ArmConfig = z.infer<typeof ArmConfig>

// Cross-field validation (config-validate.ts) additionally enforces:
// h4EmaFastPeriod < h4EmaSlowPeriod; minOhlc30mBars >= breakoutLookbackBars + 1;
// fadeRsiOversold < fadeRsiOverbought; minStopLossPct-equivalent floor > 0;
// maxSingleTradePct * (asset count) <= maxTotalNotionalPct (checked against
// live agent_settings.assets at validation time, not encoded in the schema
// itself, since the asset universe is a DB value, not a strategy-config one).
export const IntradayLsConfig = z.object({
  // --- identity / provenance ---
  // Not part of the hash input — this is what the hash authenticates
  // AGAINST, so including it would be circular. Set by the loader.
  presetName: z.string().min(1),

  // --- regime / bias (bias.ts) ---
  dailyRegimeLookbackDays: z.number().int().positive(), // today: 50 (TREND_MA_LOOKBACK_DAYS)
  h4EmaFastPeriod: z.number().int().positive(), // today: 20
  h4EmaSlowPeriod: z.number().int().positive(), // today: 50

  // --- direction policy (CFG-1 Layer 3 — NEW, decouples regime from
  // direction eligibility) ---
  // Which arm ids are ATTEMPTED under each bias value. Both presets ship
  // the SAME structural mapping (today's code already only ever attempts
  // breakout_long/pullback_long under LONG, the short pair under SHORT,
  // both fades under NEUTRAL — this makes that structural fact an
  // explicit, inspectable value instead of an implicit consequence of
  // detectIntradayLsOpportunity's own if/else). shortEnabled, not this
  // map, is what differs between the two presets.
  directionPolicy: z.record(Bias, z.array(ArmId)),
  // Global execution guard for the two short arms — reachable (detected,
  // logged, shadow-recorded) regardless of this flag; EXECUTED only when
  // true. v4-compat ships `true` (today's code has no such guard at all —
  // a short, if ever detected, would execute uncontested). v4.1-corrected
  // ships `false` — the explicit, deliberate safety decision this plan's
  // investigation produced, not a value that was ever actually live.
  shortEnabled: z.boolean(),

  // --- per-arm config ---
  arms: z.record(ArmId, ArmConfig),

  // --- detector thresholds (detectors.ts) ---
  breakoutLookbackBars: z.number().int().positive(), // today: 8 (aggressive/detectors.ts LOOKBACK_BARS)
  minOhlc30mBars: z.number().int().positive(), // today: 12 (aggressive/detectors.ts MIN_BARS)
  windowScanBars: z.number().int().positive(), // today: 4 (WINDOW_SCAN_BARS)
  // null = confirmation disabled entirely (CFG-1 Stage 1B correction #9 —
  // the live volumeTrendRatio field is CoinGecko rolling-24h volume, not
  // incremental, and the existing confirmation is consequently not
  // measuring what it claims; see config-presets.ts). v4-compat keeps the
  // historical 1.2 value for byte-fidelity to today's code, not because
  // it is endorsed.
  breakoutMinVolumeTrendRatio: z.number().positive().nullable(),
  fadeRsiOversold: z.number().min(0).max(100), // today: 30
  fadeRsiOverbought: z.number().min(0).max(100), // today: 70
  fadeRangeAtrMultiple: z.number().positive(), // today: 1.0
  minClosesForFade: z.number().int().positive(), // today: 16
  minCandlesForFade: z.number().int().positive(), // today: 16
  minSpot5mPoints: z.number().int().positive(), // today: 25
  rsiPeriod: z.number().int().positive(), // today: 14
  atrPeriod: z.number().int().positive(), // today: 14

  // --- protection (protection.ts) ---
  stopAtrMultiple: z.number().positive(), // today: 2.0
  stopFloorPct: z.number().positive(), // today: 0.012
  costGateMaxRatio: z.number().positive(), // today: 0.25
  // The signal-validity drift rule (isOpportunityStillValid) — specified,
  // tested, and NEVER CALLED in production (CFG-1 Stage 0 finding).
  // Exposed here so wiring it in is a config-driven activation, not a
  // silent behavior change; v4-compat sets enforced=false to match
  // today's actual (uncalled) behavior.
  signalDriftMaxFraction: z.number().positive(), // today's intended value: 0.5
  signalDriftRuleEnforced: z.boolean(),

  // --- exits (position-monitor) ---
  timeStopMinutes: z.number().int().positive(), // agent_settings.time_stop_minutes today: 480
  maxHoldMinutes: z.number().int().positive(), // agent_settings.max_hold_minutes today: 1440
  softTimeStopPnlRExemption: z.number(), // today: 0.5 (time-exits.ts inline literal)
  // Resolves the plan-vs-code contradiction found in CFG-1 Stage 0:
  // plan §4.2 lists the giveback ratchet as an active intraday_ls exit;
  // position-monitor/plan.ts:194 gates the EXIT on profile==='aggressive'
  // specifically, making it structurally impossible under intraday_ls
  // (sampling still occurs either way). v4-compat sets this `false` to
  // match what the CODE actually does today, not what the plan claimed.
  givebackEnabledForIntradayLs: z.boolean(),

  // --- risk policy (src/shared/strategy/profiles.ts's StrategyRiskPolicy) ---
  riskBudgetPct: z.number().positive().nullable(),
  maxSingleTradePct: z.number().positive().max(1),
  maxTotalNotionalPct: z.number().positive().max(1),
  stopOutReentryBlockMinutes: z.number().int().nonnegative(),
}).strict()
export type IntradayLsConfig = z.infer<typeof IntradayLsConfig>

// The hash input excludes presetName (identity, not behavior) — two
// configs with different names but identical behavioral fields hash
// identically, which is correct: the hash authenticates WHAT RAN, and a
// rename alone changed nothing about what ran.
export function configHashInput(config: IntradayLsConfig): Omit<IntradayLsConfig, 'presetName'> {
  const { presetName: _presetName, ...rest } = config
  return rest
}
