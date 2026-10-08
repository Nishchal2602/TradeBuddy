import type { DailyTrendConfig } from './daily-trend-config-schema.ts'

// DT-1 plan, Phase P0 (2026-10-08) — R4_DAILY_TREND_CONFIG is the exact
// daily-trend + inverse-vol-targeting config R4's variant 13 ran, recovered
// from committed CODE, never from documentation (per the DT-1 plan's own
// stop gate S1). Every field below cites the exact file/line it was
// transcribed from. This is the ONLY source of truth DT-1 may build on —
// `R4_DAILY_TREND_CONFIG_HASH` (daily-trend-config.ts) is computed from
// THIS object, and daily-trend-config.test.ts pins every field against
// the literals one more time, independently, as a second check.

export const R4_DAILY_TREND_CONFIG: DailyTrendConfig = {
  presetName: 'r4-daily-trend',

  strategy: {
    maRegimeLookbackDays: 50, // TREND_MA_LOOKBACK_DAYS, src/shared/strategy/types.ts:18
    atrPeriod: 14, // ATR_PERIOD, research/baseline-daily-trend.ts:50
    atrTimeframe: '4h', // baseline-daily-trend.ts:52 ("Balanced's ATR is 4-hourly, never daily")
    dailyWindowBars: 120, // DAILY_WINDOW, baseline-daily-trend.ts:51
    fourHWindowBars: 180, // FOUR_H_WINDOW, baseline-daily-trend.ts:52
    stopAtrMultiple: 2.0, // strategy/rules.ts:31 — stopLossPctFor's `2.0 * (atrPct / 100)`
    stopFloorPct: 0.025, // strategy/rules.ts:31 — stopLossPctFor's floor
    takeProfitRMultiple: 6.0, // strategy/rules.ts:42 — takeProfitPctFor's `6.0 * stopLossPct`
  },

  // Transcribed verbatim from research/run-backtest.ts:111-125 (variant
  // 13's object literal) — including the undocumented aggressive-tier
  // divergence from STRATEGY_PROFILES.balanced. See
  // daily-trend-config-schema.ts's module comment for the full
  // explanation; NOT corrected here, by design.
  risk: {
    startingCapitalUsd: 10_000, // STARTING_CAPITAL, run-backtest.ts:26
    feeBps: 10, // FEE_BPS, run-backtest.ts:27
    slippageBps: 5, // SLIPPAGE_BPS, run-backtest.ts:28
    effectiveMinConfidence: 0, // run-backtest.ts:116
    effectiveRiskBudgetPct: 0.0075, // run-backtest.ts:117 — the AGGRESSIVE appetite tier, not balanced's 0.0050
    effectiveSingleTradeCapPct: 0.20, // run-backtest.ts:118
    effectiveAssetExposureCapPct: 0.35, // run-backtest.ts:119
    maxTotalNotionalPct: 0.60, // run-backtest.ts:120 — the aggressive/intraday_ls value, not balanced's 0.30
    portfolioRiskCeilingMultiplier: 1.5, // run-backtest.ts:121
    drawdownBreakerFloorPct: 0.5, // run-backtest.ts:122
    stopOutReentryBlockMinutes: 360, // run-backtest.ts:123
  },

  // SL_TP_BOUNDS, run-backtest.ts:29 — shared across every R4 variant
  // (V4 and daily-trend alike), not daily-trend-specific.
  slTpBounds: {
    minStopLossPct: 0.005,
    maxStopLossPct: 0.5,
    minTakeProfitPct: 0.005,
    maxTakeProfitPct: 2.0,
  },
}
