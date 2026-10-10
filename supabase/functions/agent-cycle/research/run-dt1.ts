import { createClient } from '@supabase/supabase-js'
import { runDailyTrendBacktest } from './baseline-daily-trend.ts'
import type { DailyTrendBacktestParams } from './baseline-daily-trend.ts'
import { fetchHistoricalBarsInRange } from './db/fetch-historical-bars.ts'
import type { HistoricalBarRow } from './db/historical-bars.ts'
import type { ClosedBacktestTrade } from './backtest-engine.ts'
import { buildCpcvSplits, computePerformancePanel, deflatedSharpeRatio } from './stats.ts'
import type { StatsTrade } from './stats.ts'
import { stationaryBootstrapCI } from './dependence/block-bootstrap.ts'
import { computeE2 } from './dependence/e2-estimators.ts'
import type { TradeObservation } from './dependence/e2-estimators.ts'
import { R4_DAILY_TREND_CONFIG } from '../../../../src/shared/strategy/daily-trend-presets.ts'
import { computeDailyTrendConfigHash } from './daily-trend-config.ts'
import type { ResearchSymbol } from './types.ts'

// DT-1 Phase 5 (2026-10-09) — the actual run, executed against the
// pre-registered `dt1-v3` universe, per `context/diagnostics/dt1-pre-
// registration-2026-10-09.md`. This run is explicitly underpowered
// (Stage B's power simulation: S11 FAIL, 3-4% power at Sharpe=0.54 across
// the whole ρ̄ grid) — per the user's own decision, it proceeds anyway and
// reports E1/E2 as honest intervals. NOTHING here may earn a "Supported"
// verdict (A10) regardless of where the point estimate lands.
//
// Local script (deno run --allow-net --allow-env), reading research
// tables via the public anon key (historical_bars/research_contracts/
// research_universe_membership all carry an anon-read RLS policy) — no
// service-role key fetched or used, per this project's own secret-
// handling discipline.
//
// N single-asset sleeves (plan §5.4): each external universe asset is
// backtested on its OWN $10,000, exactly how R4 itself backtested BTC/ETH
// — never a shared-NAV combined portfolio (which would newly activate
// portfolio_risk/total_notional caps R4's own per-asset runs never
// exercised). canOpen gates entries only, from real monthly
// research_universe_membership rows — it never forces an exit.

const SUPABASE_URL = 'https://ymmegosnnywpnyafgnrk.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_Ivy16t3A_t_CDskxYP6O9A_Kemn5ZUJ'
const UNIVERSE_VERSION = 'dt1-v3'
const FROM_ISO = '2018-01-01T00:00:00.000Z' // wide enough to cover every asset's full warm-up; actual analysis window starts at the first real formation date (2018-03-01)
const TO_ISO = '2026-10-01T00:00:00.000Z' // the frozen measurement window's own end (dt1-universe-measurements: 103 months, 2018-03 through 2026-09)

function monthKey(iso: string): string {
  return iso.slice(0, 7) // YYYY-MM
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}
function sampleStdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}
function annualizedSharpeOfDailyReturns(series: readonly number[]): number {
  const sd = sampleStdev(series)
  return sd === 0 ? 0 : (mean(series) / sd) * Math.sqrt(365)
}

interface SleeveResult {
  asset: ResearchSymbol
  closedTrades: ClosedBacktestTrade[]
  rejectionsByReason: Record<string, number>
  dailyReturnByDate: Map<string, number> // 'YYYY-MM-DD' -> that day's sleeve return
  firstDate: string | null
  lastDate: string | null
  breakerTrippedOpensRejected: number
  // §5.3's "delisted_close" is a data fact, not a modeled exit reason --
  // this engine has exactly three native exits (stop/target/regime-flip).
  // When an asset's own bar series simply ends mid-position (real
  // delisting, or just "the ingested history ends here"), the backtest
  // loop stops iterating and the position survives into openAtEnd. This
  // is reported honestly as "still open when data ended", never
  // fabricated as a fourth exit type.
  stillOpenAtDataEnd: boolean
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  const configHash = await computeDailyTrendConfigHash(R4_DAILY_TREND_CONFIG)
  const expectedHash = '5641c13b3b6886aa40fab351382895a4bc2a47d9d223010031fc90536e876e11'
  if (configHash !== expectedHash) {
    throw new Error(`STOP: R4_DAILY_TREND_CONFIG hash mismatch — computed ${configHash}, pre-registered ${expectedHash}. Do not proceed.`)
  }
  console.log(`config hash verified: ${configHash}`)

  // --- 1. Universe membership (data snapshot) -----------------------------
  const membershipRows: { formation_date: string; underlying_id: string }[] = []
  {
    let from = 0
    for (;;) {
      const { data, error } = await supabase
        .from('research_universe_membership')
        .select('formation_date, underlying_id')
        .eq('universe_version', UNIVERSE_VERSION)
        .range(from, from + 999)
      if (error) throw new Error(`membership fetch failed: ${error.message}`)
      if (!data || data.length === 0) break
      membershipRows.push(...(data as { formation_date: string; underlying_id: string }[]))
      if (data.length < 1000) break
      from += 1000
    }
  }
  console.log(`membership rows: ${membershipRows.length}`)

  const membershipByMonth = new Map<string, Set<string>>() // monthKey -> set of underlying_id, EXCLUDING BTC/ETH
  const membershipByAsset = new Map<string, Set<string>>() // underlying_id -> set of monthKey, EXCLUDING BTC/ETH
  const allAssetsSeen = new Set<string>()
  for (const row of membershipRows) {
    allAssetsSeen.add(row.underlying_id)
    if (row.underlying_id === 'BTC' || row.underlying_id === 'ETH') continue
    const mk = monthKey(row.formation_date)
    if (!membershipByMonth.has(mk)) membershipByMonth.set(mk, new Set())
    membershipByMonth.get(mk)!.add(row.underlying_id)
    if (!membershipByAsset.has(row.underlying_id)) membershipByAsset.set(row.underlying_id, new Set())
    membershipByAsset.get(row.underlying_id)!.add(mk)
  }
  const externalAssets = [...membershipByAsset.keys()].sort()
  console.log(`external universe assets (excl. BTC/ETH): ${externalAssets.length}`)
  console.log(`BTC/ETH included in ranking: ${allAssetsSeen.has('BTC')}/${allAssetsSeen.has('ETH')} (A6 — ranked, excluded from primary only)`)

  // --- 2. Per-sleeve backtests ---------------------------------------------
  const sleeves: SleeveResult[] = []
  const skipped: { asset: string; reason: string }[] = []
  let processed = 0
  // A transient PostgREST statement timeout on one asset must never abort
  // the whole multi-hour run (found live, 2026-10-09, on the first real
  // attempt) -- each fetch gets a few retries, and if an asset still can't
  // be fetched it is skipped and logged, never silently dropped.
  async function fetchWithRetry(timeframe: '1d' | '4h', asset: string): Promise<HistoricalBarRow[]> {
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fetchHistoricalBarsInRange(supabase, asset as ResearchSymbol, timeframe, FROM_ISO, TO_ISO)
      } catch (e) {
        lastErr = e
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
      }
    }
    throw lastErr
  }

  for (const asset of externalAssets) {
    processed++
    let daily: HistoricalBarRow[], fourH: HistoricalBarRow[]
    try {
      ;[daily, fourH] = await Promise.all([fetchWithRetry('1d', asset), fetchWithRetry('4h', asset)])
    } catch (e) {
      skipped.push({ asset, reason: `fetch failed after retries: ${e instanceof Error ? e.message : String(e)}` })
      console.log(`[${processed}/${externalAssets.length}] ${asset}: SKIPPED — ${skipped[skipped.length - 1]!.reason}`)
      continue
    }
    if (daily.length < 50 || fourH.length < 15) {
      skipped.push({ asset, reason: `insufficient bars (daily=${daily.length}, 4h=${fourH.length})` })
      console.log(`[${processed}/${externalAssets.length}] ${asset}: SKIPPED — ${skipped[skipped.length - 1]!.reason}`)
      continue
    }
    const bars: HistoricalBarRow[] = [...daily, ...fourH]
    const memberMonths = membershipByAsset.get(asset) ?? new Set<string>()
    const canOpen = (_a: ResearchSymbol, barCloseIso: string) => memberMonths.has(monthKey(barCloseIso))

    const params: DailyTrendBacktestParams = {
      assets: [asset as ResearchSymbol],
      startingCapitalUsd: R4_DAILY_TREND_CONFIG.risk.startingCapitalUsd,
      feeBps: R4_DAILY_TREND_CONFIG.risk.feeBps,
      slippageBps: R4_DAILY_TREND_CONFIG.risk.slippageBps,
      effectiveMinConfidence: R4_DAILY_TREND_CONFIG.risk.effectiveMinConfidence,
      effectiveRiskBudgetPct: R4_DAILY_TREND_CONFIG.risk.effectiveRiskBudgetPct,
      effectiveSingleTradeCapPct: R4_DAILY_TREND_CONFIG.risk.effectiveSingleTradeCapPct,
      effectiveAssetExposureCapPct: R4_DAILY_TREND_CONFIG.risk.effectiveAssetExposureCapPct,
      maxTotalNotionalPct: R4_DAILY_TREND_CONFIG.risk.maxTotalNotionalPct,
      portfolioRiskCeilingMultiplier: R4_DAILY_TREND_CONFIG.risk.portfolioRiskCeilingMultiplier,
      drawdownBreakerFloorPct: R4_DAILY_TREND_CONFIG.risk.drawdownBreakerFloorPct,
      stopOutReentryBlockMinutes: R4_DAILY_TREND_CONFIG.risk.stopOutReentryBlockMinutes,
      slTpBounds: R4_DAILY_TREND_CONFIG.slTpBounds,
      canOpen,
    }

    let result
    try {
      result = runDailyTrendBacktest({ [asset]: bars } as Partial<Record<ResearchSymbol, readonly HistoricalBarRow[]>>, params)
    } catch (e) {
      skipped.push({ asset, reason: `backtest threw: ${e instanceof Error ? e.message : String(e)}` })
      console.log(`[${processed}/${externalAssets.length}] ${asset}: SKIPPED — ${skipped[skipped.length - 1]!.reason}`)
      continue
    }

    const dailyReturnByDate = new Map<string, number>()
    for (let i = 1; i < result.navSeries.length; i++) {
      const prev = result.navSeries[i - 1]!.nav
      const date = result.navSeries[i]!.timestamp.slice(0, 10)
      if (prev > 0) dailyReturnByDate.set(date, result.navSeries[i]!.nav / prev - 1)
    }

    const breakerRejects = result.rejectionsByReason['drawdown_breaker'] ?? 0
    sleeves.push({
      asset: asset as ResearchSymbol,
      closedTrades: result.closedTrades,
      rejectionsByReason: result.rejectionsByReason,
      dailyReturnByDate,
      firstDate: result.navSeries[0]?.timestamp.slice(0, 10) ?? null,
      lastDate: result.navSeries[result.navSeries.length - 1]?.timestamp.slice(0, 10) ?? null,
      breakerTrippedOpensRejected: breakerRejects,
      stillOpenAtDataEnd: result.openAtEnd.length > 0,
    })
    console.log(`[${processed}/${externalAssets.length}] ${asset}: ${result.closedTrades.length} trades, ${memberMonths.size} eligible months, breaker-rejects=${breakerRejects}`)
  }

  console.log(`\nsleeves run: ${sleeves.length}, skipped: ${skipped.length}`)
  if (skipped.length > 0) console.log('skipped assets:', JSON.stringify(skipped))

  // --- 2b. BTC/ETH continuity re-run (plan §4 "development/discovery",
  // reported separately, never mixed into the external-sleeve primary) --
  const continuityResults: Record<string, { tradeCount: number; sharpe: number }> = {}
  for (const asset of ['BTC', 'ETH'] as const) {
    const [daily, fourH] = await Promise.all([
      fetchHistoricalBarsInRange(supabase, asset as ResearchSymbol, '1d', FROM_ISO, TO_ISO),
      fetchHistoricalBarsInRange(supabase, asset as ResearchSymbol, '4h', FROM_ISO, TO_ISO),
    ])
    const result = runDailyTrendBacktest({ [asset]: [...daily, ...fourH] } as Partial<Record<ResearchSymbol, readonly HistoricalBarRow[]>>, {
      assets: [asset as ResearchSymbol],
      startingCapitalUsd: R4_DAILY_TREND_CONFIG.risk.startingCapitalUsd,
      feeBps: R4_DAILY_TREND_CONFIG.risk.feeBps,
      slippageBps: R4_DAILY_TREND_CONFIG.risk.slippageBps,
      effectiveMinConfidence: R4_DAILY_TREND_CONFIG.risk.effectiveMinConfidence,
      effectiveRiskBudgetPct: R4_DAILY_TREND_CONFIG.risk.effectiveRiskBudgetPct,
      effectiveSingleTradeCapPct: R4_DAILY_TREND_CONFIG.risk.effectiveSingleTradeCapPct,
      effectiveAssetExposureCapPct: R4_DAILY_TREND_CONFIG.risk.effectiveAssetExposureCapPct,
      maxTotalNotionalPct: R4_DAILY_TREND_CONFIG.risk.maxTotalNotionalPct,
      portfolioRiskCeilingMultiplier: R4_DAILY_TREND_CONFIG.risk.portfolioRiskCeilingMultiplier,
      drawdownBreakerFloorPct: R4_DAILY_TREND_CONFIG.risk.drawdownBreakerFloorPct,
      stopOutReentryBlockMinutes: R4_DAILY_TREND_CONFIG.risk.stopOutReentryBlockMinutes,
      slTpBounds: R4_DAILY_TREND_CONFIG.slTpBounds,
      // no canOpen -- BTC/ETH are never membership-gated, matching R4's own original run exactly
    })
    const panel = computePerformancePanel({ trades: [], navSeries: result.navSeries })
    continuityResults[asset] = { tradeCount: result.closedTrades.length, sharpe: panel.sharpe }
    console.log(`continuity re-run ${asset}: ${result.closedTrades.length} trades, annualized sharpe=${panel.sharpe.toFixed(3)}`)
  }

  // --- 3. Pool trades -------------------------------------------------------
  const pooledTrades: StatsTrade[] = sleeves.flatMap((s) =>
    s.closedTrades.map((t) => ({
      asset: t.asset,
      direction: t.direction,
      armId: t.armId,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      realizedPnl: t.realizedPnl,
      fee: t.fee,
      slippageCost: t.slippageCost,
      fundingCost: t.fundingCost,
      initialRiskUsd: t.initialRiskUsd,
      closeReason: t.closeReason,
    })),
  )
  console.log(`pooled closed trades (external sleeves): ${pooledTrades.length}`)

  // --- 4. Equal-weight portfolio curve (§5.4b) ------------------------------
  // Built from RETURNS only -- no sleeve NAV/position is ever touched here.
  const allDates = new Set<string>()
  for (const s of sleeves) for (const d of s.dailyReturnByDate.keys()) allDates.add(d)
  const sortedDates = [...allDates].sort()

  const portfolioDailyReturns: { date: string; r: number; nMembers: number }[] = []
  for (const date of sortedDates) {
    const mk = monthKey(date + 'T00:00:00.000Z') // monthKey expects an ISO string; a bare date slices the same way
    const members = membershipByMonth.get(mk)
    if (!members || members.size === 0) continue
    const memberReturns: number[] = []
    for (const s of sleeves) {
      if (!members.has(s.asset)) continue
      const r = s.dailyReturnByDate.get(date)
      if (r !== undefined) memberReturns.push(r)
    }
    if (memberReturns.length === 0) continue
    portfolioDailyReturns.push({ date, r: mean(memberReturns), nMembers: memberReturns.length })
  }
  console.log(`portfolio curve: ${portfolioDailyReturns.length} days, ${sortedDates.length} candidate dates`)

  const portfolioNavSeries = [{ timestamp: portfolioDailyReturns[0]?.date ?? FROM_ISO, nav: 1 }]
  for (const d of portfolioDailyReturns) {
    portfolioNavSeries.push({ timestamp: d.date, nav: portfolioNavSeries[portfolioNavSeries.length - 1]!.nav * (1 + d.r) })
  }
  const portfolioReturnsOnly = portfolioDailyReturns.map((d) => d.r)

  // --- 5. E1 -- primary: bootstrap CI on the portfolio curve's annualized Sharpe
  const e1 = stationaryBootstrapCI(portfolioReturnsOnly, annualizedSharpeOfDailyReturns, { numResamples: 10_000, alpha: 0.10 })
  console.log(`\nE1 (annualized Sharpe, 90% CI): point=${e1.pointEstimate.toFixed(3)} [${e1.ciLower.toFixed(3)}, ${e1.ciUpper.toFixed(3)}], blockLen=${e1.meanBlockLength.toFixed(1)}`)

  // --- 6. E2 -- primary: pooled expectancy, n_eff-corrected + bootstrap -----
  const e2TradeObs: TradeObservation[] = pooledTrades.map((t) => ({
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    r: t.initialRiskUsd > 0 ? (t.realizedPnl - t.fee - t.slippageCost - t.fundingCost) / t.initialRiskUsd : 0,
  }))
  const tradeCloseMonths = pooledTrades.map((t) => t.closedAt.slice(0, 7)).sort()
  const fromMonth = tradeCloseMonths[0] ?? '2018-03'
  const toMonth = tradeCloseMonths[tradeCloseMonths.length - 1] ?? '2026-09'
  const e2 = computeE2(e2TradeObs, { fromMonth, toMonth, numResamples: 10_000 })
  console.log(`\nE2 (pooled expectancy, n=${e2.n}):`)
  console.log(`  ICC:           point=${e2.icc.pointEstimate.toFixed(4)} [${e2.icc.ciLower.toFixed(4)}, ${e2.icc.ciUpper.toFixed(4)}] nEff=${e2.icc.nEff.toFixed(1)} rhoIntra=${e2.icc.rhoIntra.toFixed(4)}`)
  console.log(`  Newey-West:    point=${e2.neweyWest.pointEstimate.toFixed(4)} [${e2.neweyWest.ciLower.toFixed(4)}, ${e2.neweyWest.ciUpper.toFixed(4)}] lag=${e2.neweyWest.lag}`)
  console.log(`  Block boot:    point=${e2.blockBootstrap.pointEstimate.toFixed(4)} [${e2.blockBootstrap.ciLower.toFixed(4)}, ${e2.blockBootstrap.ciUpper.toFixed(4)}]`)
  console.log(`  Verdict:       ${JSON.stringify(e2.verdict)}`)

  // --- 7. Corrected DSR, N=1 and N=14 ---------------------------------------
  const panel = computePerformancePanel({ trades: [], navSeries: portfolioNavSeries })
  const dsrN1 = deflatedSharpeRatio({ observedSharpe: panel.sharpePerPeriod, returns: portfolioReturnsOnly, numTrials: 1, sharpeVarianceAcrossTrials: 0 })
  console.log(`\nDSR N=1:  sharpePerPeriod=${panel.sharpePerPeriod.toFixed(4)} dsr=${dsrN1.deflatedSharpeRatio.toFixed(4)}`)

  // N=14 -- the maximally-conservative cumulative bound (plan §11 item 11):
  // R4's own 13 variant trial Sharpes (daily-resampled, pooled BTC+ETH mean
  // per variant -- EXACT values from context/research/trial-registry.json,
  // reproducing registry-sharpes.ts's own pooling rule), plus DT-1 itself
  // as the 14th trial.
  const R4_13_TRIAL_SHARPES_DAILY_RESAMPLED = [
    -0.147346343442553, -0.155279189455018, -0.168757290345415, -0.148443138626864,
    -0.161691931255953, -0.070006533936722, -0.091234269575068, -0.144498085148812,
    -0.138883658953554, -0.147650863531449, -0.147790508117099, -0.127028042091005,
    0.010614006621197,
  ]
  const all14TrialSharpes = [...R4_13_TRIAL_SHARPES_DAILY_RESAMPLED, panel.sharpePerPeriod]
  const varMean = mean(all14TrialSharpes)
  const varianceAcross14 = all14TrialSharpes.reduce((a, x) => a + (x - varMean) ** 2, 0) / (all14TrialSharpes.length - 1)
  const dsrN14 = deflatedSharpeRatio({ observedSharpe: panel.sharpePerPeriod, returns: portfolioReturnsOnly, numTrials: 14, sharpeVarianceAcrossTrials: varianceAcross14 })
  console.log(`DSR N=14: sharpePerPeriod=${panel.sharpePerPeriod.toFixed(4)} dsr=${dsrN14.deflatedSharpeRatio.toFixed(4)} SR0=${dsrN14.expectedMaxSharpeUnderNull.toFixed(4)} varianceAcross14=${varianceAcross14.toFixed(6)}`)

  // --- 8. CPCV stability check (secondary diagnostic, §6.5) ----------------
  const dayIntervals = sortedDates.map((d) => ({ start: new Date(d).getTime(), end: new Date(d).getTime() }))
  const cpcvSplits = buildCpcvSplits(dayIntervals, 10, 2, 14 * 86_400_000)
  const dateToReturn = new Map(portfolioDailyReturns.map((d) => [d.date, d.r]))
  const cpcvSharpes = cpcvSplits.map((split) => {
    const testReturns = split.testIndices.map((i) => dateToReturn.get(sortedDates[i]!)).filter((r): r is number => r !== undefined)
    return annualizedSharpeOfDailyReturns(testReturns)
  })
  const cpcvMedian = [...cpcvSharpes].sort((a, b) => a - b)[Math.floor(cpcvSharpes.length / 2)] ?? 0
  console.log(`\nCPCV (${cpcvSplits.length} folds): median Sharpe=${cpcvMedian.toFixed(3)}, range=[${Math.min(...cpcvSharpes).toFixed(3)}, ${Math.max(...cpcvSharpes).toFixed(3)}]`)

  // --- 9. Secondaries: per-year breakdown + leave-one-year-out --------------
  const years = [...new Set(sortedDates.map((d) => d.slice(0, 4)))].sort()
  console.log(`\nPer-year portfolio Sharpe (${years.length} years):`)
  const perYear: Record<string, { sharpe: number; n: number }> = {}
  for (const y of years) {
    const yearReturns = portfolioDailyReturns.filter((d) => d.date.startsWith(y)).map((d) => d.r)
    perYear[y] = { sharpe: annualizedSharpeOfDailyReturns(yearReturns), n: yearReturns.length }
    console.log(`  ${y}: sharpe=${perYear[y]!.sharpe.toFixed(3)} (n=${yearReturns.length} days)`)
  }
  console.log(`\nLeave-one-year-out E1 point estimate:`)
  const leaveOneYearOut: Record<string, number> = {}
  for (const y of years) {
    const remaining = portfolioDailyReturns.filter((d) => !d.date.startsWith(y)).map((d) => d.r)
    leaveOneYearOut[y] = annualizedSharpeOfDailyReturns(remaining)
    console.log(`  excl. ${y}: sharpe=${leaveOneYearOut[y]!.toFixed(3)}`)
  }

  // --- 10. Breaker reporting (A9) -------------------------------------------
  const trippedSleeves = sleeves.filter((s) => s.breakerTrippedOpensRejected > 0)
  console.log(`\nDrawdown-breaker: ${trippedSleeves.length}/${sleeves.length} sleeves had at least one breaker-rejected open (total rejections: ${trippedSleeves.reduce((a, s) => a + s.breakerTrippedOpensRejected, 0)})`)

  // --- Output ----------------------------------------------------------------
  const output = {
    configHash,
    universeVersion: UNIVERSE_VERSION,
    generatedAt: new Date().toISOString(),
    sleevesRun: sleeves.length,
    skipped,
    pooledTradeCount: pooledTrades.length,
    portfolioCurveDays: portfolioDailyReturns.length,
    e1: { pointEstimate: e1.pointEstimate, ciLower: e1.ciLower, ciUpper: e1.ciUpper, meanBlockLength: e1.meanBlockLength, numResamples: e1.numResamples },
    e2: { n: e2.n, icc: e2.icc, neweyWest: e2.neweyWest, blockBootstrap: e2.blockBootstrap, verdict: e2.verdict },
    dsrN1: { sharpePerPeriod: panel.sharpePerPeriod, dsr: dsrN1.deflatedSharpeRatio, expectedMaxSharpeUnderNull: dsrN1.expectedMaxSharpeUnderNull },
    dsrN14: { dsr: dsrN14.deflatedSharpeRatio, expectedMaxSharpeUnderNull: dsrN14.expectedMaxSharpeUnderNull, varianceAcross14: varianceAcross14 },
    cpcv: { numFolds: cpcvSplits.length, medianSharpe: cpcvMedian, sharpes: cpcvSharpes },
    perYear,
    leaveOneYearOut,
    breaker: { trippedSleeveCount: trippedSleeves.length, totalRejections: trippedSleeves.reduce((a, s) => a + s.breakerTrippedOpensRejected, 0), sleeveDetail: trippedSleeves.map((s) => ({ asset: s.asset, rejections: s.breakerTrippedOpensRejected })) },
    perAssetTradeCounts: Object.fromEntries(sleeves.map((s) => [s.asset, s.closedTrades.length])),
    continuityResults,
    stillOpenAtDataEnd: sleeves.filter((s) => s.stillOpenAtDataEnd).map((s) => s.asset),
  }

  // decodeURIComponent needed because this project's own directory name
  // contains a space -- import.meta.url's pathname is %20-encoded, which
  // does not match the literal path --allow-write was granted against
  // (the same class of bug measure-inputs.ts hit and fixed first).
  await Deno.writeTextFile(
    decodeURIComponent(new URL('./dt1-results.json', import.meta.url).pathname),
    JSON.stringify(output, null, 2),
  )
  console.log(`\nWritten to research/dt1-results.json`)
}

if (import.meta.main) {
  await main()
}
