import { createClient } from '@supabase/supabase-js'
import { fetchHistoricalBarsInRange } from '../db/fetch-historical-bars.ts'
import { runDailyTrendBacktest } from '../baseline-daily-trend.ts'
import type { ClosedBacktestTrade } from '../backtest-engine.ts'
import { R4_DAILY_TREND_CONFIG } from '../../../../../src/shared/strategy/daily-trend-presets.ts'

// DT-1 (2026-10-09, Order-of-Work step 5) — measures the real-data inputs
// the power simulation's DGP needs (plan §6.7b): "Skew/kurtosis measured
// from R4's own real daily-trend trade population" and a per-sleeve daily
// return volatility figure for the equal-weight-portfolio factor model.
// A LOCAL script (same reasoning as every other heavy-computation research
// tool in this project: run-golden-replay.ts, run-backtest.ts) — reads
// via the public anon key (historical_bars has its own `anon read` RLS
// policy), no service-role key needed, writes a plain JSON file rather
// than touching any table.
//
// Re-running R4 is NOT a re-specification of anything: it calls
// runDailyTrendBacktest with the EXACT, already-hashed R4_DAILY_TREND_
// CONFIG, unmodified, over the now-available real historical_bars data
// for BTC/ETH (ingested under RESEARCH-1, backfilled with quote_volume
// under DT-1 Order-of-Work step 4) -- the identical reproduction
// discipline S1b already established, just invoked again here to recover
// the per-trade R values (realizedPnl/initialRiskUsd per trade) the
// original R4 run never persisted to a file, only to its own aggregate
// PerformancePanel.

const SUPABASE_URL = 'https://ymmegosnnywpnyafgnrk.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_Ivy16t3A_t_CDskxYP6O9A_Kemn5ZUJ'
const OUTPUT_PATH = decodeURIComponent(new URL('.', import.meta.url).pathname) + 'measured-inputs.json'

function tradeR(t: ClosedBacktestTrade): number {
  if (t.initialRiskUsd <= 0) return 0
  return (t.realizedPnl - t.fee - t.slippageCost - t.fundingCost) / t.initialRiskUsd
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}
function sampleStdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}
function sampleSkewness(xs: readonly number[]): number {
  const n = xs.length
  if (n < 3) return 0
  const m = mean(xs)
  const sd = sampleStdev(xs)
  if (sd === 0) return 0
  return (xs.reduce((s, x) => s + (x - m) ** 3, 0) / n) / sd ** 3
}
function sampleExcessKurtosis(xs: readonly number[]): number {
  const n = xs.length
  if (n < 4) return 0
  const m = mean(xs)
  const sd = sampleStdev(xs)
  if (sd === 0) return 0
  return (xs.reduce((s, x) => s + (x - m) ** 4, 0) / n) / sd ** 4 - 3
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  console.log('Fetching BTC/ETH 1d + 4h historical bars...')
  const [btc1d, btc4h, eth1d, eth4h] = await Promise.all([
    fetchHistoricalBarsInRange(supabase, 'BTC', '1d', '2017-01-01T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
    fetchHistoricalBarsInRange(supabase, 'BTC', '4h', '2017-01-01T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
    fetchHistoricalBarsInRange(supabase, 'ETH', '1d', '2017-01-01T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
    fetchHistoricalBarsInRange(supabase, 'ETH', '4h', '2017-01-01T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
  ])
  console.log(`  BTC: ${btc1d.length} daily, ${btc4h.length} 4h bars. ETH: ${eth1d.length} daily, ${eth4h.length} 4h bars.`)

  const risk = R4_DAILY_TREND_CONFIG.risk
  const params = {
    assets: ['BTC', 'ETH'],
    startingCapitalUsd: risk.startingCapitalUsd,
    feeBps: risk.feeBps,
    slippageBps: risk.slippageBps,
    effectiveMinConfidence: risk.effectiveMinConfidence,
    effectiveRiskBudgetPct: risk.effectiveRiskBudgetPct,
    effectiveSingleTradeCapPct: risk.effectiveSingleTradeCapPct,
    effectiveAssetExposureCapPct: risk.effectiveAssetExposureCapPct,
    maxTotalNotionalPct: risk.maxTotalNotionalPct,
    portfolioRiskCeilingMultiplier: risk.portfolioRiskCeilingMultiplier,
    drawdownBreakerFloorPct: risk.drawdownBreakerFloorPct,
    stopOutReentryBlockMinutes: risk.stopOutReentryBlockMinutes,
    slTpBounds: R4_DAILY_TREND_CONFIG.slTpBounds,
  }

  console.log('Running R4 (unmodified) per asset to recover per-trade R values...')
  const btcResult = runDailyTrendBacktest({ BTC: [...btc1d, ...btc4h] }, { ...params, assets: ['BTC'] })
  const ethResult = runDailyTrendBacktest({ ETH: [...eth1d, ...eth4h] }, { ...params, assets: ['ETH'] })

  const pooledTrades = [...btcResult.closedTrades, ...ethResult.closedTrades]
  console.log(`  BTC: ${btcResult.closedTrades.length} closed trades. ETH: ${ethResult.closedTrades.length} closed trades. Pooled: ${pooledTrades.length}.`)

  const rValues = pooledTrades.map(tradeR)
  const holdingDaysValues = pooledTrades.map((t) => (new Date(t.closedAt).getTime() - new Date(t.openedAt).getTime()) / 86_400_000)

  const tradeMoments = {
    n: rValues.length,
    mean: mean(rValues),
    sd: sampleStdev(rValues),
    skewness: sampleSkewness(rValues),
    excessKurtosis: sampleExcessKurtosis(rValues),
    standardizedRValues: rValues.map((r) => (sampleStdev(rValues) === 0 ? 0 : (r - mean(rValues)) / sampleStdev(rValues))),
    meanHoldingDays: mean(holdingDaysValues),
    medianHoldingDays: [...holdingDaysValues].sort((a, b) => a - b)[Math.floor(holdingDaysValues.length / 2)] ?? 0,
    // The full empirical holding-period distribution (days), for
    // resampling realistic trade durations in the power simulation's DGP
    // -- rather than assuming a parametric shape for something this
    // easy to just resample directly.
    holdingDaysValues,
  }

  // Per-sleeve daily return volatility: measured across the full external-
  // sleeve population (excluding BTC/ETH, matching A6's primary-analysis
  // scope), the same population dt1-universe-measurements-2026-10-09.md's
  // own rho-bar figure was measured over.
  console.log('Measuring per-sleeve daily return volatility across the external-sleeve population...')
  const { data: members, error: memberError } = await supabase
    .from('research_universe_membership')
    .select('underlying_id')
    .eq('universe_version', 'dt1-v3')
    .neq('underlying_id', 'BTC')
    .neq('underlying_id', 'ETH')
  if (memberError) throw new Error(`fetching universe members: ${JSON.stringify(memberError)}`)
  const distinctAssets = [...new Set((members ?? []).map((m) => m.underlying_id as string))]

  const perAssetVol: number[] = []
  const BATCH = 16
  for (let i = 0; i < distinctAssets.length; i += BATCH) {
    const batch = distinctAssets.slice(i, i + BATCH)
    const results = await Promise.all(
      batch.map(async (asset) => {
        const bars = await fetchHistoricalBarsInRange(supabase, asset, '1d', '2017-01-01T00:00:00.000Z', '2026-10-09T00:00:00.000Z')
        const sorted = [...bars].sort((a, b) => (a.closeTime < b.closeTime ? -1 : 1))
        const logReturns: number[] = []
        for (let j = 1; j < sorted.length; j++) {
          const prev = sorted[j - 1]!.close
          const cur = sorted[j]!.close
          if (prev > 0 && cur > 0) logReturns.push(Math.log(cur / prev))
        }
        return sampleStdev(logReturns)
      }),
    )
    perAssetVol.push(...results.filter((v) => v > 0))
  }
  perAssetVol.sort((a, b) => a - b)
  const medianDailyVol = perAssetVol[Math.floor(perAssetVol.length / 2)] ?? 0

  const output = {
    measuredAt: new Date().toISOString(),
    r4ConfigHash: 'see src/shared/strategy/daily-trend-presets.ts R4_DAILY_TREND_CONFIG',
    tradeMoments,
    perSleeveDailyVolatility: { medianLogReturnSd: medianDailyVol, assetsSampled: perAssetVol.length },
  }

  await Deno.writeTextFile(OUTPUT_PATH, JSON.stringify(output, null, 2))
  console.log(`\nWritten to ${OUTPUT_PATH}`)
  console.log(JSON.stringify({ tradeMoments: { ...tradeMoments, standardizedRValues: `[${tradeMoments.standardizedRValues.length} values, omitted from log]` }, perSleeveDailyVolatility: output.perSleeveDailyVolatility }, null, 2))
}

if (import.meta.main) {
  await main()
}
