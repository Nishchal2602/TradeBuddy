import { z } from 'zod'

// DT-1 plan, Phase P0 (2026-10-08) — a cumulative, committed record of
// every strategy evaluation ("trial") ever run under this project's
// Deflated Sharpe Ratio framework, so a trial count is never again a
// hardcoded literal nobody checks (research/run-backtest.ts's own
// `DSR_NUM_TRIALS = 13 // the pre-registration's own honest count` had
// nothing enforcing that the actual VARIANTS array still had 13 entries).
//
// Every Sharpe stored here is DAILY-RESAMPLED (research/daily-resample.ts)
// regardless of the trial's native cadence — R4 mixed twelve 30-minute V4
// trials with one daily baseline trial, and per-period Sharpes from
// different cadences are not in the same units; pooling them into a
// variance without resampling first would mix units and produce a
// meaningless SR0 inside deflatedSharpeRatio. See
// context/diagnostics/p5-historical-backtest-results-2026-10-08.md's own
// dated DSR-correction amendment for the worked consequence.

export const TrialRegistryEntry = z.object({
  // Stable, human-readable id: "<experiment>:<asset>:<variantName>".
  id: z.string().min(1),
  experiment: z.string().min(1), // e.g. "R4"
  variantName: z.string().min(1),
  asset: z.string().min(1),
  // null for a variant whose config was never given a committed,
  // content-hashed preset (today: the 11 ad hoc V4 variants built
  // in-memory by run-backtest.ts's own onlyArm/GEOMETRY_ALT_1/2/
  // resolveBias overrides — only 'v4-compat (control)' and the
  // daily-trend baseline have a real committed hash). Recording null
  // rather than a fabricated value is deliberate — never invent
  // provenance that does not exist.
  configHash: z.string().nullable(),
  // The trial's own native decision cadence, in minutes — 30 for every
  // V4-style variant (the engine's master clock walks 30-minute bars),
  // 1440 for the daily-trend baseline. Audit/context only; every Sharpe
  // below is already resampled to a common daily basis regardless.
  cadenceMinutes: z.number().int().positive(),
  computedAt: z.string(), // ISO timestamp this registry entry was generated
  trainTradeCount: z.number().int().nonnegative(),
  // THE value used for sharpeVarianceAcrossTrials and as
  // deflatedSharpeRatio's observedSharpe — per-period, daily-resampled,
  // comparable across every trial regardless of native cadence.
  trainSharpeDailyResampled: z.number(),
  // Audit only, never used in a variance/DSR calculation directly — the
  // ORIGINAL annualized Sharpe at the trial's own native cadence, exactly
  // as it was published in the primary results table. Lets a reader
  // reconcile a registry row back to the original, un-amended report.
  trainSharpeAnnualizedNativeCadenceAudit: z.number(),
}).strict()
export type TrialRegistryEntry = z.infer<typeof TrialRegistryEntry>

export const TrialRegistry = z.array(TrialRegistryEntry)
export type TrialRegistry = z.infer<typeof TrialRegistry>

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)
}

// Scoped per asset, matching R4's own original design (run-backtest.ts's
// main() computes sharpeVar separately inside its own per-asset loop,
// never pooled across assets) — a variant's Sharpe variance is measured
// against other variants run on the SAME asset, not across assets.
export function sharpeVarianceForAsset(registry: TrialRegistry, experiment: string, asset: string): number {
  const sharpes = registry.filter((e) => e.experiment === experiment && e.asset === asset).map((e) => e.trainSharpeDailyResampled)
  return variance(sharpes)
}

export function countTrialsForAsset(registry: TrialRegistry, experiment: string, asset: string): number {
  return registry.filter((e) => e.experiment === experiment && e.asset === asset).length
}
