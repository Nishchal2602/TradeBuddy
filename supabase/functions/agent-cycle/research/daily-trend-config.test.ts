import { assertEquals } from 'jsr:@std/assert@1'
import { computeDailyTrendConfigHash } from './daily-trend-config.ts'
import { R4_DAILY_TREND_CONFIG } from '../../../../src/shared/strategy/daily-trend-presets.ts'
import { DailyTrendConfig } from '../../../../src/shared/strategy/daily-trend-config-schema.ts'

// DT-1 plan, Phase P0, stop gate S1 — R4_DAILY_TREND_CONFIG must match
// R4's literals field-for-field, recovered from committed code
// (research/run-backtest.ts, research/baseline-daily-trend.ts,
// strategy/rules.ts, src/shared/strategy/types.ts), never from
// documentation. Each assertion below cites the exact source line, same
// convention as domain/strategy-config-presets.test.ts's own "decisive
// test" for IntradayLsConfig.

Deno.test('R4_DAILY_TREND_CONFIG: parses against the schema', () => {
  const result = DailyTrendConfig.safeParse(R4_DAILY_TREND_CONFIG)
  assertEquals(result.success, true)
})

Deno.test('R4_DAILY_TREND_CONFIG: strategy constants match rules.ts / baseline-daily-trend.ts / types.ts exactly', () => {
  assertEquals(R4_DAILY_TREND_CONFIG.strategy.maRegimeLookbackDays, 50) // TREND_MA_LOOKBACK_DAYS, types.ts:18
  assertEquals(R4_DAILY_TREND_CONFIG.strategy.atrPeriod, 14) // ATR_PERIOD, baseline-daily-trend.ts:50
  assertEquals(R4_DAILY_TREND_CONFIG.strategy.atrTimeframe, '4h') // baseline-daily-trend.ts:52
  assertEquals(R4_DAILY_TREND_CONFIG.strategy.dailyWindowBars, 120) // DAILY_WINDOW, baseline-daily-trend.ts:51
  assertEquals(R4_DAILY_TREND_CONFIG.strategy.fourHWindowBars, 180) // FOUR_H_WINDOW, baseline-daily-trend.ts:52
  assertEquals(R4_DAILY_TREND_CONFIG.strategy.stopAtrMultiple, 2.0) // rules.ts:31
  assertEquals(R4_DAILY_TREND_CONFIG.strategy.stopFloorPct, 0.025) // rules.ts:31
  assertEquals(R4_DAILY_TREND_CONFIG.strategy.takeProfitRMultiple, 6.0) // rules.ts:42
})

Deno.test('R4_DAILY_TREND_CONFIG: risk envelope matches run-backtest.ts:111-125 exactly, INCLUDING the undocumented aggressive-tier divergence from balanced', () => {
  const r = R4_DAILY_TREND_CONFIG.risk
  assertEquals(r.startingCapitalUsd, 10_000) // STARTING_CAPITAL, run-backtest.ts:26
  assertEquals(r.feeBps, 10) // FEE_BPS, run-backtest.ts:27
  assertEquals(r.slippageBps, 5) // SLIPPAGE_BPS, run-backtest.ts:28
  assertEquals(r.effectiveMinConfidence, 0) // run-backtest.ts:116
  assertEquals(r.effectiveRiskBudgetPct, 0.0075) // run-backtest.ts:117 — NOT balanced's 0.0050
  assertEquals(r.effectiveSingleTradeCapPct, 0.20) // run-backtest.ts:118
  assertEquals(r.effectiveAssetExposureCapPct, 0.35) // run-backtest.ts:119
  assertEquals(r.maxTotalNotionalPct, 0.60) // run-backtest.ts:120 — NOT balanced's 0.30
  assertEquals(r.portfolioRiskCeilingMultiplier, 1.5) // run-backtest.ts:121
  assertEquals(r.drawdownBreakerFloorPct, 0.5) // run-backtest.ts:122
  assertEquals(r.stopOutReentryBlockMinutes, 360) // run-backtest.ts:123
})

Deno.test('R4_DAILY_TREND_CONFIG: risk envelope deliberately does NOT equal STRATEGY_PROFILES.balanced — this is the documented divergence, not a bug to "fix"', async () => {
  const { STRATEGY_PROFILES } = await import('../../../../src/shared/strategy/profiles.ts')
  const balanced = STRATEGY_PROFILES.balanced.risk
  // balanced.riskBudgetPct is null (falls through to risk-appetite lookup,
  // 0.0050 for 'balanced' appetite) — R4's literal 0.0075 matches neither
  // that resolved value nor the null itself.
  const resolvedBalancedRiskBudgetPct = 0.0050
  const r4 = R4_DAILY_TREND_CONFIG.risk
  const divergesOnRiskBudget = r4.effectiveRiskBudgetPct !== resolvedBalancedRiskBudgetPct
  const divergesOnNotionalCap = r4.maxTotalNotionalPct !== balanced.maxTotalNotionalPct
  assertEquals(divergesOnRiskBudget, true)
  assertEquals(divergesOnNotionalCap, true)
})

Deno.test('R4_DAILY_TREND_CONFIG: slTpBounds matches SL_TP_BOUNDS exactly (run-backtest.ts:29, shared across every R4 variant)', () => {
  assertEquals(R4_DAILY_TREND_CONFIG.slTpBounds, {
    minStopLossPct: 0.005,
    maxStopLossPct: 0.5,
    minTakeProfitPct: 0.005,
    maxTakeProfitPct: 2.0,
  })
})

// The hash constant below is computed by this test itself on first run and
// then hardcoded — same "pin a committed constant" discipline as every
// other hash test in this project. A drift means R4_DAILY_TREND_CONFIG
// was edited; investigate before updating this constant, never update it
// reflexively.
const R4_DAILY_TREND_CONFIG_HASH = '5641c13b3b6886aa40fab351382895a4bc2a47d9d223010031fc90536e876e11'

Deno.test('R4_DAILY_TREND_CONFIG: content hash is deterministic and matches the committed constant', async () => {
  const hash = await computeDailyTrendConfigHash(R4_DAILY_TREND_CONFIG)
  assertEquals(hash, R4_DAILY_TREND_CONFIG_HASH)
})

Deno.test('R4_DAILY_TREND_CONFIG: hash is insensitive to presetName (identity, not behavior)', async () => {
  const renamed = { ...R4_DAILY_TREND_CONFIG, presetName: 'some-other-name' }
  const hashA = await computeDailyTrendConfigHash(R4_DAILY_TREND_CONFIG)
  const hashB = await computeDailyTrendConfigHash(renamed)
  assertEquals(hashA, hashB)
})

Deno.test('R4_DAILY_TREND_CONFIG: hash changes if any behavioral field changes', async () => {
  const mutated = { ...R4_DAILY_TREND_CONFIG, risk: { ...R4_DAILY_TREND_CONFIG.risk, feeBps: 11 } }
  const hashA = await computeDailyTrendConfigHash(R4_DAILY_TREND_CONFIG)
  const hashB = await computeDailyTrendConfigHash(mutated)
  assertEquals(hashA === hashB, false)
})
