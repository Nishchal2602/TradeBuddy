import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { STRATEGY_PROFILES, StrategyProfile, strategyDefinitionFor } from '../../../../src/shared/strategy/profiles.ts'

// --- The enum itself --------------------------------------------------

Deno.test('StrategyProfile: accepts exactly balanced, aggressive, and intraday_ls', () => {
  assertEquals(StrategyProfile.parse('balanced'), 'balanced')
  assertEquals(StrategyProfile.parse('aggressive'), 'aggressive')
  assertEquals(StrategyProfile.parse('intraday_ls'), 'intraday_ls')
})

Deno.test("StrategyProfile: 'conservative' is rejected, never silently mapped to a real strategy", () => {
  const result = StrategyProfile.safeParse('conservative')
  assertEquals(result.success, false)
})

Deno.test('StrategyProfile: an arbitrary unrecognized string is rejected', () => {
  assertEquals(StrategyProfile.safeParse('whatever').success, false)
  assertEquals(StrategyProfile.safeParse('').success, false)
  assertEquals(StrategyProfile.safeParse(null).success, false)
  assertEquals(StrategyProfile.safeParse(undefined).success, false)
})

// --- Balanced: the live literal, not renamed ---------------------------

Deno.test("strategyDefinitionFor('balanced'): strategyVersion is the LIVE production literal 'v1-regime', not a renamed 'v2-jev-managed'", () => {
  assertEquals(strategyDefinitionFor('balanced').strategyVersion, 'v1-regime')
})

Deno.test("strategyDefinitionFor('balanced'): riskBudgetPct is null — falls through to risk_appetite, unchanged", () => {
  assertEquals(strategyDefinitionFor('balanced').risk.riskBudgetPct, null)
})

Deno.test("strategyDefinitionFor('balanced'): sizing caps and re-entry block match today's live agent_settings values exactly", () => {
  const def = strategyDefinitionFor('balanced')
  assertEquals(def.risk.maxSingleTradePct, 0.20)
  assertEquals(def.risk.maxTotalNotionalPct, 0.30)
  assertEquals(def.risk.stopOutReentryBlockMinutes, 360)
  assertEquals(def.decisionIntervalMinutes, 180)
})

// --- Aggressive: pre-registered, and named to avoid self-deception -----

Deno.test("strategyDefinitionFor('aggressive'): strategyVersion carries the SIGNAL timeframe, not just the cadence — 'v3-jev-intraday-30m'", () => {
  assertEquals(strategyDefinitionFor('aggressive').strategyVersion, 'v3-jev-intraday-30m')
})

Deno.test("strategyDefinitionFor('aggressive'): decisionIntervalMinutes (15) is the CADENCE, distinct from the 30m entry signal encoded only in strategyVersion", () => {
  assertEquals(strategyDefinitionFor('aggressive').decisionIntervalMinutes, 15)
})

Deno.test("strategyDefinitionFor('aggressive'): risk policy matches the pre-registered capital plan — wider caps, its own risk budget, a shorter re-entry block", () => {
  const def = strategyDefinitionFor('aggressive')
  assertEquals(def.risk.riskBudgetPct, 0.0075)
  assertEquals(def.risk.maxSingleTradePct, 0.30)
  assertEquals(def.risk.maxTotalNotionalPct, 0.60)
  assertEquals(def.risk.stopOutReentryBlockMinutes, 60)
})

Deno.test('all three profiles: news lookback is identical (195 min) — NOT derived from decisionIntervalMinutes, so a fast cadence never silently starves the shared news feed', () => {
  assertEquals(strategyDefinitionFor('balanced').newsLookbackMinutes, 195)
  assertEquals(strategyDefinitionFor('aggressive').newsLookbackMinutes, 195)
  assertEquals(strategyDefinitionFor('intraday_ls').newsLookbackMinutes, 195)
})

Deno.test('all three profiles: maxDataStalenessMinutes is profile-specific, not a shared global — 30 min for balanced, 10 min for aggressive and intraday_ls', () => {
  assertEquals(strategyDefinitionFor('balanced').maxDataStalenessMinutes, 30)
  assertEquals(strategyDefinitionFor('aggressive').maxDataStalenessMinutes, 10)
  assertEquals(strategyDefinitionFor('intraday_ls').maxDataStalenessMinutes, 10)
})

// --- intraday_ls (Strategy V4, 2026-10-01): long/short intraday ---------

Deno.test("strategyDefinitionFor('intraday_ls'): strategyVersion is 'v4-ls-intraday-30m'", () => {
  assertEquals(strategyDefinitionFor('intraday_ls').strategyVersion, 'v4-ls-intraday-30m')
})

Deno.test("strategyDefinitionFor('intraday_ls'): decisionIntervalMinutes matches the LIVE cron (15, changed 2026-10-03 for more data collection)", () => {
  assertEquals(strategyDefinitionFor('intraday_ls').decisionIntervalMinutes, 15)
})

Deno.test("strategyDefinitionFor('intraday_ls'): risk policy — 0.15% budget (lowered 2026-10-08, plan STRAT-1 P1, so the 15% single-trade cap stops being the thing that always binds — see profiles.ts's own comment), 15%/60% caps (single-trade halved 2026-10-03 for the 4-asset universe, plan ASSET-4), same 60-minute (one-cycle) re-entry block as its own cadence", () => {
  const def = strategyDefinitionFor('intraday_ls')
  assertEquals(def.risk.riskBudgetPct, 0.0015)
  assertEquals(def.risk.maxSingleTradePct, 0.15)
  assertEquals(def.risk.maxTotalNotionalPct, 0.60)
  assertEquals(def.risk.stopOutReentryBlockMinutes, 60)
})

// --- Registry completeness ----------------------------------------------

Deno.test('STRATEGY_PROFILES: has exactly the three enum members, no more, no fewer', () => {
  assertEquals(Object.keys(STRATEGY_PROFILES).sort(), ['aggressive', 'balanced', 'intraday_ls'])
})

Deno.test('STRATEGY_PROFILES: every entry is internally consistent — its own .profile field matches its registry key', () => {
  for (const [key, def] of Object.entries(STRATEGY_PROFILES)) {
    assertEquals(def.profile, key)
  }
})

// --- Fail-closed on an invalid profile at the lookup boundary -----------

Deno.test('strategyDefinitionFor: an unrecognized key is not silently defaulted to aggressive or anything else', () => {
  assertThrows(() => {
    // deno-lint-ignore no-explicit-any
    const bad = 'conservative' as any
    const def = strategyDefinitionFor(bad)
    if (!def) throw new Error('no definition for unrecognized profile')
  })
})
