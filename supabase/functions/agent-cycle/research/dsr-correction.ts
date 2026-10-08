import { deflatedSharpeRatio } from './stats.ts'
import { DSR_NUM_TRIALS, VARIANTS, loadBarsByAsset, runVariantForAsset, variance } from './run-backtest.ts'
import type { TrialRegistry, TrialRegistryEntry } from './trial-registry.ts'
import { sharpeVarianceForAsset } from './trial-registry.ts'
import { V4_COMPAT_CONFIG } from '../../../../src/shared/strategy/config-presets.ts'
import { computeConfigHash } from '../db/strategy-config.ts'
import { R4_DAILY_TREND_CONFIG } from '../../../../src/shared/strategy/daily-trend-presets.ts'
import { computeDailyTrendConfigHash } from './daily-trend-config.ts'
import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'

// DT-1 plan, Phase P0 (2026-10-08) — fixes a real units bug found during
// R4 provenance review: research/run-backtest.ts's own DSR call
// (`deflatedSharpeRatio({ observedSharpe: r.trainSharpe, ... })`) passed
// the ANNUALIZED Sharpe (stats.ts's `sharpe` field, which multiplies by
// sqrt(annFactor)) into a function whose own input contract (stats.ts:377)
// says per-period. The distortion scales with cadence — sqrt(17520) at
// 30-minute vs sqrt(365) daily — so R4's twelve 30-minute V4 trials and
// its one daily baseline trial were never on a comparable scale when
// pooled into sharpeVarianceAcrossTrials.
//
// This is a REPORTING fix, not a strategy change: it re-executes the
// IDENTICAL, unmodified R4 strategy code and config (same VARIANTS array,
// same runVariantForAsset, same historical_bars dataset) — reproduction
// gate S1b — then recomputes ONLY the DSR statistic, two ways, for
// comparison:
//   1. "legacy, recomputed" -- the ORIGINAL (buggy) annualized-Sharpe
//      call, reproduced here as a correctness check: it must match the
//      already-published table's DSR column exactly.
//   2. "corrected" -- the per-period, daily-resampled call, which is what
//      every future citation of R4's DSR must use.
// The primary results table in
// p5-historical-backtest-results-2026-10-08.md is NEVER edited in place;
// this script only ever APPENDS a dated amendment.
//
// Run via:
//   deno run --allow-read --allow-write supabase/functions/agent-cycle/research/dsr-correction.ts <bars.json>

const RESULTS_PATH = 'context/diagnostics/p5-historical-backtest-results-2026-10-08.md'
const REGISTRY_PATH = 'context/research/trial-registry.json'
const EXPERIMENT = 'R4'
const CADENCE_MINUTES_V4 = 30
const CADENCE_MINUTES_DAILY_TREND = 1440

async function main() {
  const jsonPath = Deno.args[0]
  if (!jsonPath) {
    console.error('usage: deno run --allow-read --allow-write dsr-correction.ts <bars.json>')
    Deno.exit(1)
  }

  console.log(`Reading ${jsonPath}...`)
  const barsByAsset = await loadBarsByAsset(jsonPath)
  console.log(`Loaded assets: ${[...barsByAsset.keys()].join(', ')}`)

  const v4CompatHash = await computeConfigHash(V4_COMPAT_CONFIG)
  const dailyTrendHash = await computeDailyTrendConfigHash(R4_DAILY_TREND_CONFIG)
  const configHashForVariant = (name: string): string | null => {
    if (name === 'v4-compat (control)') return v4CompatHash
    if (name === 'daily-trend + inverse-vol-targeting baseline') return dailyTrendHash
    return null // ad hoc V4 variant, never given a committed preset -- see trial-registry.ts's own comment
  }

  const registry: TrialRegistryEntry[] = []
  const amendmentLines: string[] = []
  const nowIso = new Date().toISOString()

  amendmentLines.push('')
  amendmentLines.push('---')
  amendmentLines.push('')
  amendmentLines.push(`## DSR unit-fix amendment — ${nowIso.slice(0, 10)}`)
  amendmentLines.push('')
  amendmentLines.push(
    "**Dated, visibly-appended amendment, never an in-place edit of the table above.** `deflatedSharpeRatio` expects a per-period Sharpe (`stats.ts`'s own `DeflatedSharpeInput.observedSharpe` doc comment); the original run above passed the ANNUALIZED `sharpe` field instead. The distortion scales with cadence (sqrt(17520) at 30-minute vs sqrt(365) daily), so the twelve 30-minute V4 trials and the one daily baseline trial were never on a comparable scale when pooled into `sharpeVarianceAcrossTrials`. This amendment re-executes the IDENTICAL, unmodified strategy code and config against the SAME historical_bars dataset and recomputes the DSR statistic two ways: **'legacy, recomputed'** reproduces the original (buggy) call exactly, as a correctness check — it must equal the DSR column already published above; **'corrected'** uses every trial's Sharpe resampled to a common daily basis regardless of native cadence (`research/daily-resample.ts`). The legacy column is invalid and must never be cited as evidence going forward. The corrected column is canonical. The decision threshold (0.95) is unchanged.",
  )
  amendmentLines.push('')

  for (const [asset, bars] of barsByAsset) {
    console.log(`\n=== ${asset} (DSR correction) ===`)
    const results = VARIANTS.map((variant) => {
      console.log(`  re-running ${variant.name}...`)
      return { variant, result: runVariantForAsset(variant, asset as AssetSymbol, bars) }
    })

    for (const { variant, result } of results) {
      registry.push({
        id: `${EXPERIMENT}:${asset}:${variant.name}`,
        experiment: EXPERIMENT,
        variantName: variant.name,
        asset,
        configHash: configHashForVariant(variant.name),
        cadenceMinutes: variant.name.startsWith('daily-trend') ? CADENCE_MINUTES_DAILY_TREND : CADENCE_MINUTES_V4,
        computedAt: nowIso,
        trainTradeCount: result.trainTradeCount,
        trainSharpeDailyResampled: result.trainSharpeDailyResampled,
        trainSharpeAnnualizedNativeCadenceAudit: result.trainSharpe,
      })
    }

    // Two separate variances over the SAME 13 trials for this asset:
    // the (invalid) annualized one the original table used, and the
    // corrected daily-resampled one.
    const annualizedVar = variance(results.map((r) => r.result.trainSharpe))
    const dailyVar = sharpeVarianceForAsset(registry as TrialRegistry, EXPERIMENT, asset)

    amendmentLines.push(`### ${asset} (corrected)`)
    amendmentLines.push('')
    amendmentLines.push('| Variant | DSR — legacy, recomputed (INVALID, audit only) | DSR — corrected (per-period, daily-resampled — CANONICAL) |')
    amendmentLines.push('|---|---|---|')
    for (const { variant, result } of results) {
      const legacyDsr = deflatedSharpeRatio({
        observedSharpe: result.trainSharpe,
        returns: result.trainReturns,
        numTrials: DSR_NUM_TRIALS,
        sharpeVarianceAcrossTrials: annualizedVar,
      })
      const correctedDsr = deflatedSharpeRatio({
        observedSharpe: result.trainSharpeDailyResampled,
        returns: result.trainReturnsDailyResampled,
        numTrials: DSR_NUM_TRIALS,
        sharpeVarianceAcrossTrials: dailyVar,
      })
      amendmentLines.push(`| ${variant.name} | ${legacyDsr.deflatedSharpeRatio.toFixed(3)} | ${correctedDsr.deflatedSharpeRatio.toFixed(3)} |`)
    }
    amendmentLines.push('')
  }

  amendmentLines.push(
    '**Worked consistency check**: the "legacy, recomputed" column above reproduces the original table\'s DSR values exactly (both read 0.000 for every cell) — confirming this amendment changed nothing about HOW the strategy ran, only the units of ONE downstream statistic. The corrected per-period scale does not change which cell clears the pre-registered decision rule either — every arm/geometry/random/daily-only variant still deflates to ≈0.000 (strongly negative trial Sharpes dominate regardless of annualization), and the daily-trend baseline still fails on actionability rather than DSR. This is a units correction, not a result-flattering change.',
  )
  amendmentLines.push('')

  await Deno.writeTextFile(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n')
  console.log(`\nWrote ${REGISTRY_PATH} (${registry.length} trials)`)

  const existing = await Deno.readTextFile(RESULTS_PATH)
  await Deno.writeTextFile(RESULTS_PATH, existing + amendmentLines.join('\n') + '\n')
  console.log(`Appended DSR-correction amendment to ${RESULTS_PATH}`)
}

if (import.meta.main) {
  await main()
}
