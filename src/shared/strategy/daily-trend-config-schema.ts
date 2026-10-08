import { z } from 'zod'

// DT-1 plan, Phase P0 (2026-10-08) — the daily-trend + inverse-vol-targeting
// strategy's config schema. This strategy was evaluated as R4's variant 13
// (research/baseline-daily-trend.ts + research/run-backtest.ts:105-127) but,
// unlike IntradayLsConfig, had NO schema, NO hash, and NO committed preset —
// its only record was one object literal in run-backtest.ts plus its
// duplicate in baseline-daily-trend.test.ts. This schema exists so the exact
// R4 config can be cited by content hash (daily-trend-presets.ts), per the
// DT-1 plan's own stop gate: "do not reconstruct the config from
// documentation — recover it from committed code, and if it cannot be
// matched field-for-field, STOP."
//
// Deliberately NOT merged into IntradayLsConfig: that schema is
// intraday_ls-specific (six arms, direction policy, window-scanned
// detectors) and has no field that can express this strategy's defining
// numbers (a single long/flat regime rule, a 6:1 fixed reward:risk). Two
// genuinely different strategies get two genuinely different schemas,
// mirroring the backend's own choice to give this strategy a SEPARATE
// backtest loop (baseline-daily-trend.ts) rather than a parameterization
// of the intraday_ls engine.

// --- strategy constants (research/baseline-daily-trend.ts, strategy/rules.ts,
//     src/shared/strategy/types.ts) ---
export const DailyTrendStrategyConfig = z.object({
  // today: 50 (TREND_MA_LOOKBACK_DAYS, src/shared/strategy/types.ts:18) —
  // evaluateTrendRegime's own SMA lookback. Long when dailyClose > SMA,
  // strict inequality (equality is DOWN).
  maRegimeLookbackDays: z.number().int().positive(),
  // today: 14 (ATR_PERIOD, baseline-daily-trend.ts:50)
  atrPeriod: z.number().int().positive(),
  // today: '4h' — ATR is computed on the 4-HOUR series, never the daily
  // one (baseline-daily-trend.ts:52's own comment: "Balanced's ATR is
  // 4-hourly, never daily"). Recorded as an explicit value so a future
  // reader cannot assume daily-ATR by default.
  atrTimeframe: z.enum(['4h']),
  // today: 120 (DAILY_WINDOW, baseline-daily-trend.ts:51) — trailing
  // window of daily bars fed to evaluateTrendRegime (truncated internally
  // to the last maRegimeLookbackDays for the SMA itself).
  dailyWindowBars: z.number().int().positive(),
  // today: 180 (FOUR_H_WINDOW, baseline-daily-trend.ts:52) — trailing
  // window of 4h bars fed to calculateATRPercent.
  fourHWindowBars: z.number().int().positive(),
  // today: 2.0 — stopLossPctFor's ATR multiple (strategy/rules.ts:31:
  // `Math.max(2.0 * (atrPct / 100), 0.025)`). The /100 there is a real
  // unit conversion (atrPct is a percentage-as-number; stopLossPct is a
  // fraction) — not reproduced here since this schema stores the
  // multiple, not the conversion.
  stopAtrMultiple: z.number().positive(),
  // today: 0.025 — stopLossPctFor's floor (strategy/rules.ts:31).
  stopFloorPct: z.number().positive(),
  // today: 6.0 — takeProfitPctFor's fixed reward:risk multiple
  // (strategy/rules.ts:42: `6.0 * stopLossPct`). A FIXED 6:1, not derived
  // per-arm or per-regime.
  takeProfitRMultiple: z.number().positive(),
}).strict()
export type DailyTrendStrategyConfig = z.infer<typeof DailyTrendStrategyConfig>

// --- risk envelope (research/run-backtest.ts:111-125, variant 13's own
//     object literal — the ONLY place these 11 values were ever recorded
//     before this schema existed) ---
//
// IMPORTANT, found during P0 provenance recovery and preserved exactly,
// not "corrected": this is NOT STRATEGY_PROFILES.balanced's own risk
// policy. effectiveRiskBudgetPct (0.0075) is the AGGRESSIVE risk-appetite
// tier (src/shared/risk/appetite-mapping.ts:46) — balanced resolves to
// 0.0050 (riskBudgetPct: null -> appetite lookup). maxTotalNotionalPct
// (0.60) is the aggressive/intraday_ls value — balanced is 0.30
// (src/shared/strategy/profiles.ts:110-116). Nothing in the pre-
// registration, the results doc, or progress-tracker.md documents this
// divergence or whether it was deliberate. Per the DT-1 plan's own stop
// gate (S1), this is transcribed verbatim from the code that actually
// produced R4's numbers — never "fixed" to match balanced, which would
// silently change every trade's size and make this preset no longer
// reproduce R4 at all.
export const DailyTrendRiskEnvelope = z.object({
  startingCapitalUsd: z.number().positive(),
  feeBps: z.number().nonnegative(),
  slippageBps: z.number().nonnegative(),
  effectiveMinConfidence: z.number().min(0).max(1),
  // today: 0.0075 — the AGGRESSIVE appetite tier, not balanced's 0.0050.
  // See the module-level comment above.
  effectiveRiskBudgetPct: z.number().positive(),
  effectiveSingleTradeCapPct: z.number().positive().max(1),
  effectiveAssetExposureCapPct: z.number().positive().max(1),
  // today: 0.60 — the aggressive/intraday_ls value, not balanced's 0.30.
  // See the module-level comment above.
  maxTotalNotionalPct: z.number().positive().max(1),
  portfolioRiskCeilingMultiplier: z.number().positive(),
  drawdownBreakerFloorPct: z.number().positive().max(1),
  stopOutReentryBlockMinutes: z.number().int().nonnegative(),
  // minTradeNotionalPct/Usd are hardcoded to 0 inside
  // baseline-daily-trend.ts itself (lines 241-242), never read from
  // params — so they are NOT part of this envelope; recording them here
  // would imply they are configurable when they are not.
}).strict()
export type DailyTrendRiskEnvelope = z.infer<typeof DailyTrendRiskEnvelope>

// research/run-backtest.ts:29 — SL_TP_BOUNDS, shared across every R4
// variant (V4 and daily-trend alike). These are gate-validation bounds
// (src/shared/risk/sl-tp.ts's SlTpBounds), not strategy parameters — a
// proposal outside them is REJECTED by the gate, never silently resized.
export const DailyTrendSlTpBounds = z.object({
  minStopLossPct: z.number().positive(),
  maxStopLossPct: z.number().positive(),
  minTakeProfitPct: z.number().positive(),
  maxTakeProfitPct: z.number().positive(),
}).strict()
export type DailyTrendSlTpBounds = z.infer<typeof DailyTrendSlTpBounds>

export const DailyTrendConfig = z.object({
  // Not part of the hash input — same identity/behavior split as
  // IntradayLsConfig.presetName (config-schema.ts:50-53).
  presetName: z.string().min(1),
  strategy: DailyTrendStrategyConfig,
  risk: DailyTrendRiskEnvelope,
  slTpBounds: DailyTrendSlTpBounds,
}).strict()
export type DailyTrendConfig = z.infer<typeof DailyTrendConfig>

// Mirrors configHashInput (config-schema.ts:137-140) exactly: strip
// presetName, hash everything else. The hash authenticates WHAT RAN; a
// rename alone changes nothing about that.
export function dailyTrendConfigHashInput(config: DailyTrendConfig): Omit<DailyTrendConfig, 'presetName'> {
  const { presetName: _presetName, ...rest } = config
  return rest
}
