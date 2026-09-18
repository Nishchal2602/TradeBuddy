import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import { applySizingCaps, deriveRiskBasedNotional, type SizingCaps } from '../../../../src/shared/risk/sizing.ts'

const CAPS: SizingCaps = { maxSingleTradePct: 0.20, maxAssetExposurePct: 0.35 }
const NAV = 10000
const ENTRY = 76851

// Every expected value below was computed independently in Python before
// being transcribed here (progress-tracker.md) — the crossover behavior
// specifically, since it's the exact thing flagged as an open question:
// does the risk budget or the single-trade cap actually govern at a given
// stop distance.

Deno.test('deriveRiskBasedNotional + applySizingCaps: the plan\'s worked example — 3% stop, single-trade cap binds', () => {
  const stopLossPrice = ENTRY * 0.97 // 74545.47
  const riskBased = deriveRiskBasedNotional(NAV, 0.01, ENTRY, stopLossPrice)
  assertAlmostEquals(riskBased, 3333.33, 0.5)

  const sizing = applySizingCaps(riskBased, NAV, CAPS, 0, NAV)
  assertAlmostEquals(sizing.notionalUsd, 2000, 0.5)
  assertEquals(sizing.capApplied, 'single_trade')
  assertAlmostEquals(sizing.sizePct, 0.20, 1e-9)
})

Deno.test('applySizingCaps: at exactly the 5% crossover stop, risk budget and single-trade cap coincide — no cap recorded', () => {
  const stopLossPrice = ENTRY * 0.95
  const riskBased = deriveRiskBasedNotional(NAV, 0.01, ENTRY, stopLossPrice)
  assertAlmostEquals(riskBased, 2000, 0.5)

  const sizing = applySizingCaps(riskBased, NAV, CAPS, 0, NAV)
  assertAlmostEquals(sizing.notionalUsd, 2000, 0.5)
  // At the exact crossover the two candidates are equal — ties resolve to
  // the risk-based figure (checked first), so this is "approved", not
  // "clamped". A hair wider and it's unambiguously budget-governed; a
  // hair tighter and it's unambiguously cap-governed (next test).
  assertEquals(sizing.capApplied, null)
})

Deno.test('applySizingCaps: wider than 5% stop (8%) — risk budget governs, no cap applied', () => {
  const stopLossPrice = ENTRY * 0.92
  const riskBased = deriveRiskBasedNotional(NAV, 0.01, ENTRY, stopLossPrice)
  assertAlmostEquals(riskBased, 1250, 0.5)

  const sizing = applySizingCaps(riskBased, NAV, CAPS, 0, NAV)
  assertAlmostEquals(sizing.notionalUsd, 1250, 0.5)
  assertEquals(sizing.capApplied, null)
})

Deno.test('applySizingCaps: cash is the binding constraint when it\'s scarcer than every other candidate', () => {
  const stopLossPrice = ENTRY * 0.97
  const riskBased = deriveRiskBasedNotional(NAV, 0.01, ENTRY, stopLossPrice)
  const sizing = applySizingCaps(riskBased, NAV, CAPS, 0, 500) // only $500 cash available
  assertAlmostEquals(sizing.notionalUsd, 500, 1e-9)
  assertEquals(sizing.capApplied, 'cash')
  assertAlmostEquals(sizing.sizePct, 0.05, 1e-9)
})

Deno.test('applySizingCaps: existing asset exposure reduces the remaining asset-exposure headroom', () => {
  // Structurally inert for a NEW open in V0 (opens only happen from FLAT,
  // so currentAssetExposureUsd is always 0 in practice) — this test
  // exercises the parameter directly so the function is still proven
  // correct for the day pyramiding makes it non-zero, per its own doc
  // comment in sizing.ts.
  const sizing = applySizingCaps(5000, NAV, CAPS, 3000, NAV)
  // asset-exposure headroom = nav*0.35 - 3000 = 3500-3000 = 500
  assertAlmostEquals(sizing.notionalUsd, 500, 1e-9)
  assertEquals(sizing.capApplied, 'asset_exposure')
})

Deno.test('deriveRiskBasedNotional: short direction uses the same formula symmetrically', () => {
  const entry = 100
  const stopLossPrice = entry * 1.03 // short SL is above entry
  const riskBased = deriveRiskBasedNotional(10000, 0.01, entry, stopLossPrice)
  assertAlmostEquals(riskBased, 3333.33, 0.5)
})
