import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import { applySizingCaps, deriveRiskBasedNotional, type SizingCaps, type PortfolioRiskInputs } from '../../../../src/shared/risk/sizing.ts'

const CAPS: SizingCaps = { maxSingleTradePct: 0.20, maxAssetExposurePct: 0.35 }
const NAV = 10000
const ENTRY = 76851

// A deliberately enormous, non-binding default for the trading-strategy-
// v1.md §17 portfolio-risk candidates, used by every pre-existing test in
// this file below so they continue to exercise ONLY the 4 original
// candidates unchanged. stopLossPct=0.01 (the tightest plausible stop) x
// a $1,000,000 ceiling still resolves to a $100,000,000-equivalent
// notional — orders of magnitude above this file's $10,000 NAV regardless
// of which real stop distance a given test actually uses.
const GENEROUS_PORTFOLIO_RISK: PortfolioRiskInputs = {
  stopLossPct: 0.01,
  portfolioRiskCeilingUsd: 1_000_000,
  otherOpenPositionsRiskAtStopUsd: 0,
  maxTotalNotionalUsd: 1_000_000,
  otherSameDirectionNotionalUsd: 0,
}

// Every expected value below was computed independently in Python before
// being transcribed here (progress-tracker.md) — the crossover behavior
// specifically, since it's the exact thing flagged as an open question:
// does the risk budget or the single-trade cap actually govern at a given
// stop distance.

Deno.test('deriveRiskBasedNotional + applySizingCaps: the plan\'s worked example — 3% stop, single-trade cap binds', () => {
  const stopLossPrice = ENTRY * 0.97 // 74545.47
  const riskBased = deriveRiskBasedNotional(NAV, 0.01, ENTRY, stopLossPrice)
  assertAlmostEquals(riskBased, 3333.33, 0.5)

  const sizing = applySizingCaps(riskBased, NAV, CAPS, 0, NAV, GENEROUS_PORTFOLIO_RISK)
  assertAlmostEquals(sizing.notionalUsd, 2000, 0.5)
  assertEquals(sizing.capApplied, 'single_trade')
  assertAlmostEquals(sizing.sizePct, 0.20, 1e-9)
})

Deno.test('applySizingCaps: at exactly the 5% crossover stop, risk budget and single-trade cap coincide — no cap recorded', () => {
  const stopLossPrice = ENTRY * 0.95
  const riskBased = deriveRiskBasedNotional(NAV, 0.01, ENTRY, stopLossPrice)
  assertAlmostEquals(riskBased, 2000, 0.5)

  const sizing = applySizingCaps(riskBased, NAV, CAPS, 0, NAV, GENEROUS_PORTFOLIO_RISK)
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

  const sizing = applySizingCaps(riskBased, NAV, CAPS, 0, NAV, GENEROUS_PORTFOLIO_RISK)
  assertAlmostEquals(sizing.notionalUsd, 1250, 0.5)
  assertEquals(sizing.capApplied, null)
})

Deno.test('applySizingCaps: cash is the binding constraint when it\'s scarcer than every other candidate', () => {
  const stopLossPrice = ENTRY * 0.97
  const riskBased = deriveRiskBasedNotional(NAV, 0.01, ENTRY, stopLossPrice)
  const sizing = applySizingCaps(riskBased, NAV, CAPS, 0, 500, GENEROUS_PORTFOLIO_RISK) // only $500 cash available
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
  const sizing = applySizingCaps(5000, NAV, CAPS, 3000, NAV, GENEROUS_PORTFOLIO_RISK)
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

// --- Portfolio risk (trading-strategy-v1.md §17) --------------------------

Deno.test('applySizingCaps: portfolio_risk converts a remaining USD risk budget into an equivalent notional at the candidate\'s own stop distance', () => {
  // stopLossPct=0.025 (the strategy's own 2.5% floor), remaining ceiling
  // = 75 - 50 = 25 -> 25 / 0.025 = 1000, tighter than the 2000 single-
  // trade cap (0.20*10000 — NOT 20000; caught by this test's first,
  // wrong-by-10x draft) but looser than the huge risk-based figure this
  // test passes in directly.
  const portfolioRisk: PortfolioRiskInputs = {
    stopLossPct: 0.025,
    portfolioRiskCeilingUsd: 75,
    otherOpenPositionsRiskAtStopUsd: 50,
    maxTotalNotionalUsd: 1_000_000,
    otherSameDirectionNotionalUsd: 0,
  }
  const sizing = applySizingCaps(50_000, NAV, CAPS, 0, NAV, portfolioRisk)
  assertAlmostEquals(sizing.notionalUsd, 1000, 1e-9)
  assertEquals(sizing.capApplied, 'portfolio_risk')
})

Deno.test('applySizingCaps: total_notional caps combined exposure regardless of stop distance', () => {
  const portfolioRisk: PortfolioRiskInputs = {
    ...GENEROUS_PORTFOLIO_RISK,
    maxTotalNotionalUsd: 5000,
    otherSameDirectionNotionalUsd: 3200,
  }
  const sizing = applySizingCaps(50_000, NAV, CAPS, 0, NAV, portfolioRisk)
  assertAlmostEquals(sizing.notionalUsd, 1800, 1e-9) // 5000 - 3200
  assertEquals(sizing.capApplied, 'total_notional')
})

Deno.test('applySizingCaps: the SMALLEST candidate wins even when both new caps are tight simultaneously', () => {
  // portfolio_risk -> (57.5-20)/0.025 = 1500; total_notional -> 1200-0 =
  // 1200. Both tighter than the 2000 single-trade cap and the huge
  // risk-based figure — total_notional (1200) is the smallest of all
  // four real candidates, so it must be the one that wins.
  const portfolioRisk: PortfolioRiskInputs = {
    stopLossPct: 0.025,
    portfolioRiskCeilingUsd: 57.5,
    otherOpenPositionsRiskAtStopUsd: 20,
    maxTotalNotionalUsd: 1200,
    otherSameDirectionNotionalUsd: 0,
  }
  const sizing = applySizingCaps(50_000, NAV, CAPS, 0, NAV, portfolioRisk)
  assertAlmostEquals(sizing.notionalUsd, 1200, 1e-9)
  assertEquals(sizing.capApplied, 'total_notional')
})
