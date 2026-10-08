import { runBacktest } from './backtest-engine.ts'
import type { BacktestParams, ClosedBacktestTrade } from './backtest-engine.ts'
import { runDailyTrendBacktest } from './baseline-daily-trend.ts'
import { buildCpcvSplits, computePerformancePanel, deflatedSharpeRatio } from './stats.ts'
import type { PerformancePanel, StatsNavPoint } from './stats.ts'
import { buildRandomEntryDetector, computeIntradayLsProtectionFromConfig, resolveDailyOnlyBias } from './variants.ts'
import { V4_COMPAT_CONFIG } from '../../../../src/shared/strategy/config-presets.ts'
import type { IntradayLsConfig } from '../../../../src/shared/strategy/config-schema.ts'
import type { ArmId } from '../strategy/intraday-ls/detectors.ts'
import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { HistoricalBarRow } from './db/historical-bars.ts'

// RESEARCH-1 (2026-10-08, STRAT-1 P5, stage R4) — executes EXACTLY the
// variant list pre-registered in context/diagnostics/p5-pre-registration-
// 2026-10-08.md. A LOCAL script (deno run --allow-read), reading a JSON
// dump of historical_bars (no service-role key available/fetched locally
// — see research/ingest-core.ts's own comment on why that's a deliberate
// choice, not a gap). Run via:
//
//   deno run --allow-read supabase/functions/agent-cycle/research/run-backtest.ts <bars.json>
//
// No ad hoc variant may be added here without a new, dated, visibly
// appended amendment to the pre-registration file itself.

const HOLDOUT_START_MS = new Date('2026-07-01T00:00:00.000Z').getTime()
const STARTING_CAPITAL = 10_000
const FEE_BPS = 10
const SLIPPAGE_BPS = 5
const SL_TP_BOUNDS = { minStopLossPct: 0.005, maxStopLossPct: 0.5, minTakeProfitPct: 0.005, maxTakeProfitPct: 2.0 }
const CPCV_NUM_GROUPS = 10
const CPCV_TEST_GROUPS = 2
const CPCV_EMBARGO_V4_MS = 2 * 86_400_000
const CPCV_EMBARGO_BASELINE_MS = 14 * 86_400_000
const DSR_NUM_TRIALS = 13 // the pre-registration's own honest count

const ALL_ARM_IDS: ArmId[] = ['breakout_long', 'breakout_short', 'pullback_long', 'pullback_short', 'fade_long', 'fade_short']

function onlyArm(armId: ArmId): IntradayLsConfig {
  const arms = Object.fromEntries(ALL_ARM_IDS.map((id) => [id, { ...V4_COMPAT_CONFIG.arms[id], enabled: id === armId }])) as IntradayLsConfig['arms']
  return { ...V4_COMPAT_CONFIG, presetName: `v4-only-${armId}`, arms }
}

const GEOMETRY_ALT_1: IntradayLsConfig = { ...V4_COMPAT_CONFIG, presetName: 'geometry-alt-1-wider-stop', stopAtrMultiple: 3.0, stopFloorPct: 0.020 }
const GEOMETRY_ALT_2: IntradayLsConfig = {
  ...V4_COMPAT_CONFIG,
  presetName: 'geometry-alt-2-higher-rr',
  arms: Object.fromEntries(ALL_ARM_IDS.map((id) => [id, { ...V4_COMPAT_CONFIG.arms[id], rewardRiskRatio: id.startsWith('fade') ? 2.0 : 3.0 }])) as IntradayLsConfig['arms'],
}

function baseV4Params(assets: AssetSymbol[], config: IntradayLsConfig): Omit<BacktestParams, 'detectFn' | 'resolveBias' | 'computeProtection'> {
  return {
    assets,
    config,
    startingCapitalUsd: STARTING_CAPITAL,
    feeBps: FEE_BPS,
    slippageBps: SLIPPAGE_BPS,
    effectiveMinConfidence: 0,
    slTpBounds: SL_TP_BOUNDS,
    portfolioRiskCeilingMultiplier: 1.5,
    drawdownBreakerFloorPct: 0.5,
    minTradeNotionalPct: 0.01,
    minTradeNotionalUsd: 25,
    shortFundingBpsPerDayByAsset: {},
  }
}

interface Variant {
  name: string
  cpcvEmbargoMs: number
  run: (asset: AssetSymbol, bars: HistoricalBarRow[]) => { closedTrades: ClosedBacktestTrade[]; navSeries: StatsNavPoint[]; rejectionsByReason: Record<string, number> }
}

const VARIANTS: Variant[] = [
  { name: 'v4-compat (control)', cpcvEmbargoMs: CPCV_EMBARGO_V4_MS, run: (a, b) => runBacktest({ [a]: b }, baseV4Params([a], V4_COMPAT_CONFIG)) },
  ...ALL_ARM_IDS.map((armId): Variant => ({
    name: `${armId} only`,
    cpcvEmbargoMs: CPCV_EMBARGO_V4_MS,
    run: (a, b) => runBacktest({ [a]: b }, baseV4Params([a], onlyArm(armId))),
  })),
  {
    name: 'random-entry baseline (long)',
    cpcvEmbargoMs: CPCV_EMBARGO_V4_MS,
    run: (a, b) => runBacktest({ [a]: b }, { ...baseV4Params([a], V4_COMPAT_CONFIG), detectFn: buildRandomEntryDetector('long', true) }),
  },
  {
    name: 'random-entry baseline (short)',
    cpcvEmbargoMs: CPCV_EMBARGO_V4_MS,
    run: (a, b) => runBacktest({ [a]: b }, { ...baseV4Params([a], V4_COMPAT_CONFIG), detectFn: buildRandomEntryDetector('short', true) }),
  },
  {
    name: 'daily-only bias',
    cpcvEmbargoMs: CPCV_EMBARGO_V4_MS,
    run: (a, b) => runBacktest({ [a]: b }, { ...baseV4Params([a], V4_COMPAT_CONFIG), resolveBias: resolveDailyOnlyBias }),
  },
  {
    name: 'geometry-alt-1 (wider stop)',
    cpcvEmbargoMs: CPCV_EMBARGO_V4_MS,
    run: (a, b) => runBacktest({ [a]: b }, { ...baseV4Params([a], GEOMETRY_ALT_1), computeProtection: computeIntradayLsProtectionFromConfig(GEOMETRY_ALT_1) }),
  },
  {
    name: 'geometry-alt-2 (higher reward:risk)',
    cpcvEmbargoMs: CPCV_EMBARGO_V4_MS,
    run: (a, b) => runBacktest({ [a]: b }, { ...baseV4Params([a], GEOMETRY_ALT_2), computeProtection: computeIntradayLsProtectionFromConfig(GEOMETRY_ALT_2) }),
  },
  {
    name: 'daily-trend + inverse-vol-targeting baseline',
    cpcvEmbargoMs: CPCV_EMBARGO_BASELINE_MS,
    run: (a, b) =>
      runDailyTrendBacktest(
        { [a]: b },
        {
          assets: [a],
          startingCapitalUsd: STARTING_CAPITAL,
          feeBps: FEE_BPS,
          slippageBps: SLIPPAGE_BPS,
          effectiveMinConfidence: 0,
          effectiveRiskBudgetPct: 0.0075,
          effectiveSingleTradeCapPct: 0.20,
          effectiveAssetExposureCapPct: 0.35,
          maxTotalNotionalPct: 0.60,
          portfolioRiskCeilingMultiplier: 1.5,
          drawdownBreakerFloorPct: 0.5,
          stopOutReentryBlockMinutes: 360,
          slTpBounds: SL_TP_BOUNDS,
        },
      ),
  },
]

function splitByHoldout<T extends { openedAt?: string; timestamp?: string }>(items: T[], holdoutMs: number): { train: T[]; holdout: T[] } {
  const train: T[] = []
  const holdout: T[] = []
  for (const item of items) {
    const ts = new Date(item.openedAt ?? item.timestamp ?? '').getTime()
    ;(ts < holdoutMs ? train : holdout).push(item)
  }
  return { train, holdout }
}

function periodicReturns(navSeries: readonly StatsNavPoint[]): number[] {
  const returns: number[] = []
  for (let i = 1; i < navSeries.length; i++) {
    const prev = navSeries[i - 1]!.nav
    if (prev > 0) returns.push(navSeries[i]!.nav / prev - 1)
  }
  return returns
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length
}
function variance(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)
}
function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}
function quartile(xs: number[], q: number): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  return sorted[base + 1] !== undefined ? sorted[base]! + rest * (sorted[base + 1]! - sorted[base]!) : sorted[base]!
}

interface VariantResult {
  name: string
  trainPanel: PerformancePanel
  holdoutPanel: PerformancePanel
  trainTradeCount: number
  holdoutTradeCount: number
  cpcvOosRatios: number[]
  trainSharpe: number
  trainReturns: number[]
}

function runVariantForAsset(variant: Variant, asset: AssetSymbol, bars: HistoricalBarRow[]): VariantResult {
  const result = variant.run(asset, bars)
  const { train: trainTrades, holdout: holdoutTrades } = splitByHoldout(result.closedTrades, HOLDOUT_START_MS)
  const { train: trainNav, holdout: holdoutNav } = splitByHoldout(result.navSeries, HOLDOUT_START_MS)

  const trainPanel = computePerformancePanel({ trades: trainTrades, navSeries: trainNav, rejectionsByReason: result.rejectionsByReason })
  const holdoutPanel = computePerformancePanel({ trades: holdoutTrades, navSeries: holdoutNav })

  const intervals = trainTrades.map((t) => ({ start: new Date(t.openedAt).getTime(), end: new Date(t.closedAt).getTime() }))
  const splits = buildCpcvSplits(intervals, CPCV_NUM_GROUPS, CPCV_TEST_GROUPS, variant.cpcvEmbargoMs)
  const cpcvOosRatios = splits.map((split) => {
    const testTrades = split.testIndices.map((i) => trainTrades[i]!)
    const rs = testTrades.map((t) => (t.initialRiskUsd > 0 ? (t.realizedPnl - t.fee - t.slippageCost - t.fundingCost) / t.initialRiskUsd : 0))
    const sd = Math.sqrt(variance(rs))
    return sd > 0 ? mean(rs) / sd : 0
  })

  return {
    name: variant.name,
    trainPanel,
    holdoutPanel,
    trainTradeCount: trainTrades.length,
    holdoutTradeCount: holdoutTrades.length,
    cpcvOosRatios,
    trainSharpe: trainPanel.sharpe,
    trainReturns: periodicReturns(trainNav),
  }
}

async function main() {
  const jsonPath = Deno.args[0]
  if (!jsonPath) {
    console.error('usage: deno run --allow-read run-backtest.ts <bars.json>')
    Deno.exit(1)
  }

  console.log(`Reading ${jsonPath}...`)
  const text = await Deno.readTextFile(jsonPath!)
  // deno-lint-ignore no-explicit-any
  const parsed: any = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  const barsByAsset = new Map<AssetSymbol, HistoricalBarRow[]>()
  // deno-lint-ignore no-explicit-any
  for (const r of parsed.rows as any[]) {
    const asset = r.asset as AssetSymbol
    if (!barsByAsset.has(asset)) barsByAsset.set(asset, [])
    barsByAsset.get(asset)!.push({
      asset,
      timeframe: r.timeframe,
      openTime: new Date(r.open_time).toISOString(),
      closeTime: new Date(r.close_time).toISOString(),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    })
  }
  console.log(`Loaded assets: ${[...barsByAsset.keys()].join(', ')}`)

  const lines: string[] = []
  lines.push(`# P5 historical backtest results — ${new Date().toISOString().slice(0, 10)}`)
  lines.push('')
  lines.push('Pre-registered in `p5-pre-registration-2026-10-08.md`. Executed by `research/run-backtest.ts`. Every number below is real output from this run — none hand-adjusted.')
  lines.push('')

  for (const [asset, bars] of barsByAsset) {
    console.log(`\n=== ${asset} ===`)
    const results: VariantResult[] = []
    for (const variant of VARIANTS) {
      console.log(`  running ${variant.name}...`)
      results.push(runVariantForAsset(variant, asset, bars))
    }

    const trainSharpes = results.map((r) => r.trainSharpe)
    const sharpeVar = variance(trainSharpes)

    lines.push(`## ${asset}`)
    lines.push('')
    lines.push('| Variant | Train trades | Expectancy (R) | n | MDE | Actionable | Train Sharpe | CPCV OOS ratio (median, IQR) | DSR (N=13) | Holdout trades | Holdout expectancy (R) |')
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
    for (const r of results) {
      const dsr = deflatedSharpeRatio({ observedSharpe: r.trainSharpe, returns: r.trainReturns, numTrials: DSR_NUM_TRIALS, sharpeVarianceAcrossTrials: sharpeVar })
      const oosMedian = median(r.cpcvOosRatios)
      const oosQ1 = quartile(r.cpcvOosRatios, 0.25)
      const oosQ3 = quartile(r.cpcvOosRatios, 0.75)
      lines.push(
        `| ${r.name} | ${r.trainTradeCount} | ${r.trainPanel.expectancyR.value.toFixed(3)} | ${r.trainPanel.expectancyR.n} | ${r.trainPanel.expectancyR.mde.toFixed(3)} | ${r.trainPanel.expectancyR.actionable} | ${r.trainSharpe.toFixed(3)} | ${oosMedian.toFixed(3)} [${oosQ1.toFixed(3)}, ${oosQ3.toFixed(3)}] | ${dsr.deflatedSharpeRatio.toFixed(3)} | ${r.holdoutTradeCount} | ${r.holdoutPanel.expectancyR.value.toFixed(3)} |`,
      )
    }
    lines.push('')
  }

  const outPath = 'context/diagnostics/p5-historical-backtest-results-2026-10-08.md'
  await Deno.writeTextFile(outPath, lines.join('\n') + '\n')
  console.log(`\nWrote ${outPath}`)
}

if (import.meta.main) {
  await main()
}
