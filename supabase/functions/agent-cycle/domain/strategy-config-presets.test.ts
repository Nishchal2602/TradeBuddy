import { assertEquals } from 'jsr:@std/assert@1'
import { V4_1_CORRECTED_CONFIG, V4_COMPAT_CONFIG } from '../../../../src/shared/strategy/config-presets.ts'
import { IntradayLsConfig } from '../../../../src/shared/strategy/config-schema.ts'
import { validateIntradayLsConfig } from '../../../../src/shared/strategy/config-validate.ts'
import { STRATEGY_PROFILES } from '../../../../src/shared/strategy/profiles.ts'

// CFG-1 Stage 1A's decisive test: v4-compat must be byte-identical to
// the LIVE values this project already pre-registered and froze
// elsewhere, not re-derived or "obviously equivalent." Each assertion
// below cites the exact file/line the live value comes from, mirroring
// config-presets.ts's own per-field source comments.

Deno.test('V4_COMPAT_CONFIG: parses against the schema', () => {
  const result = IntradayLsConfig.safeParse(V4_COMPAT_CONFIG)
  assertEquals(result.success, true)
})

Deno.test('V4_COMPAT_CONFIG: risk policy matches STRATEGY_PROFILES.intraday_ls.risk exactly (profiles.ts, live)', () => {
  const live = STRATEGY_PROFILES.intraday_ls.risk
  assertEquals(V4_COMPAT_CONFIG.riskBudgetPct, live.riskBudgetPct)
  assertEquals(V4_COMPAT_CONFIG.maxSingleTradePct, live.maxSingleTradePct)
  assertEquals(V4_COMPAT_CONFIG.maxTotalNotionalPct, live.maxTotalNotionalPct)
  assertEquals(V4_COMPAT_CONFIG.stopOutReentryBlockMinutes, live.stopOutReentryBlockMinutes)
})

Deno.test('V4_COMPAT_CONFIG: bias periods match bias.ts (50-day daily floor, 20/50 4h EMA)', () => {
  assertEquals(V4_COMPAT_CONFIG.dailyRegimeLookbackDays, 50)
  assertEquals(V4_COMPAT_CONFIG.h4EmaFastPeriod, 20)
  assertEquals(V4_COMPAT_CONFIG.h4EmaSlowPeriod, 50)
})

Deno.test('V4_COMPAT_CONFIG: detector thresholds match detectors.ts / aggressive/detectors.ts exactly', () => {
  assertEquals(V4_COMPAT_CONFIG.breakoutLookbackBars, 8)
  assertEquals(V4_COMPAT_CONFIG.minOhlc30mBars, 12)
  assertEquals(V4_COMPAT_CONFIG.windowScanBars, 4)
  assertEquals(V4_COMPAT_CONFIG.breakoutMinVolumeTrendRatio, 1.2)
  assertEquals(V4_COMPAT_CONFIG.fadeRsiOversold, 30)
  assertEquals(V4_COMPAT_CONFIG.fadeRsiOverbought, 70)
  assertEquals(V4_COMPAT_CONFIG.fadeRangeAtrMultiple, 1.0)
  assertEquals(V4_COMPAT_CONFIG.minClosesForFade, 16)
  assertEquals(V4_COMPAT_CONFIG.minCandlesForFade, 16)
  assertEquals(V4_COMPAT_CONFIG.minSpot5mPoints, 25)
  assertEquals(V4_COMPAT_CONFIG.rsiPeriod, 14)
  assertEquals(V4_COMPAT_CONFIG.atrPeriod, 14)
})

Deno.test('V4_COMPAT_CONFIG: protection matches protection.ts exactly (2.0x ATR, 1.2% floor, 0.25 cost gate)', () => {
  assertEquals(V4_COMPAT_CONFIG.stopAtrMultiple, 2.0)
  assertEquals(V4_COMPAT_CONFIG.stopFloorPct, 0.012)
  assertEquals(V4_COMPAT_CONFIG.costGateMaxRatio, 0.25)
})

Deno.test('V4_COMPAT_CONFIG: per-arm reward:risk reproduces the exact binary fade/trend split (protection.ts:37)', () => {
  for (const armId of ['breakout_long', 'breakout_short', 'pullback_long', 'pullback_short'] as const) {
    assertEquals(V4_COMPAT_CONFIG.arms[armId]!.rewardRiskRatio, 2.0, `${armId} should be 2.0`)
  }
  for (const armId of ['fade_long', 'fade_short'] as const) {
    assertEquals(V4_COMPAT_CONFIG.arms[armId]!.rewardRiskRatio, 1.5, `${armId} should be 1.5`)
  }
})

Deno.test('V4_COMPAT_CONFIG: every arm enabled, short reachable (faithful to "no kill switch exists today")', () => {
  for (const arm of Object.values(V4_COMPAT_CONFIG.arms)) {
    assertEquals(arm.enabled, true)
  }
  assertEquals(V4_COMPAT_CONFIG.shortEnabled, true)
})

Deno.test('V4_COMPAT_CONFIG: the known-not-wired flags match what the CODE does, not what the plan claims', () => {
  assertEquals(V4_COMPAT_CONFIG.signalDriftRuleEnforced, false, 'isOpportunityStillValid has no production caller today')
  assertEquals(V4_COMPAT_CONFIG.givebackEnabledForIntradayLs, false, "plan.ts:194 gates the giveback EXIT on 'aggressive' only")
})

Deno.test('V4_COMPAT_CONFIG: passes its own cross-field validation at every asset count 1-4', () => {
  for (const assetCount of [1, 2, 3, 4]) {
    assertEquals(validateIntradayLsConfig(V4_COMPAT_CONFIG, assetCount), [])
  }
})

Deno.test('V4_1_CORRECTED_CONFIG: passes its own cross-field validation at every asset count 1-4', () => {
  for (const assetCount of [1, 2, 3, 4]) {
    assertEquals(validateIntradayLsConfig(V4_1_CORRECTED_CONFIG, assetCount), [])
  }
})

// --- Stage 1B differential test — "no silent extras" -----------------------
//
// Enumerates every field where v4.1-corrected differs from v4-compat and
// asserts the set is EXACTLY the documented correction list, no more, no
// fewer. This is the test that would fail if a future edit quietly
// changed a value outside what was reviewed and named.

function diffFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const diffs: string[] = []
  for (const key of keys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) diffs.push(key)
  }
  return diffs
}

Deno.test('v4.1-corrected diverges from v4-compat on EXACTLY the documented fields — no silent extras', () => {
  const diffs = diffFields(V4_COMPAT_CONFIG, V4_1_CORRECTED_CONFIG).sort()
  assertEquals(diffs, ['breakoutMinVolumeTrendRatio', 'givebackEnabledForIntradayLs', 'presetName', 'shortEnabled', 'signalDriftRuleEnforced'])
})

Deno.test('v4.1-corrected: breakoutMinVolumeTrendRatio removal is a REMOVAL (null), not a replacement value', () => {
  assertEquals(V4_1_CORRECTED_CONFIG.breakoutMinVolumeTrendRatio, null)
})

Deno.test('v4.1-corrected: every other detector/protection/risk field is untouched (identical to v4-compat)', () => {
  const untouchedFields: (keyof typeof V4_COMPAT_CONFIG)[] = [
    'dailyRegimeLookbackDays', 'h4EmaFastPeriod', 'h4EmaSlowPeriod', 'directionPolicy', 'arms',
    'breakoutLookbackBars', 'minOhlc30mBars', 'windowScanBars', 'fadeRsiOversold', 'fadeRsiOverbought',
    'fadeRangeAtrMultiple', 'minClosesForFade', 'minCandlesForFade', 'minSpot5mPoints', 'rsiPeriod', 'atrPeriod',
    'stopAtrMultiple', 'stopFloorPct', 'costGateMaxRatio', 'signalDriftMaxFraction',
    'timeStopMinutes', 'maxHoldMinutes', 'softTimeStopPnlRExemption',
    'riskBudgetPct', 'maxSingleTradePct', 'maxTotalNotionalPct', 'stopOutReentryBlockMinutes',
  ]
  for (const field of untouchedFields) {
    assertEquals(JSON.stringify(V4_1_CORRECTED_CONFIG[field]), JSON.stringify(V4_COMPAT_CONFIG[field]), `${field} must be untouched`)
  }
})
