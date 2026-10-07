import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssetSymbol, NormalizedMarketData } from '../../../../src/shared/market-data/types.ts'
import type { IntradayMarketData } from '../strategy/aggressive/types.ts'
import { assembleAsOfCycle } from './market-bars-reader.ts'
import {
  fetchAccountStateAsOf,
  fetchConfigByHash,
  fetchHistoricalPrice,
  fetchLastConsumedOpportunityBarTsBefore,
  fetchOpenPositionsAsOf,
  fetchRealDecisionsInWindow,
} from './db/fetch-historical-decision-context.ts'
import type { RealDecisionRow } from './db/fetch-historical-decision-context.ts'
import { fetchMarketBarsInRange } from './db/fetch-market-bars.ts'
import { detectCandidate } from '../strategy/intraday-ls/detect-candidate.ts'

// CFG-1 Stage 2 (2026-10-06) — the golden-replay driver (gate 2C). A
// LOCAL script, deliberately NOT a deployed Edge Function (see the Stage
// 2 plan's own reasoning: this is a research/verification tool, not a
// recurring production path). Run via:
//
//   deno run --allow-net --allow-env replay/run-golden-replay.ts
//
// with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the environment —
// the SAME two values every deployed Edge Function already reads via
// Deno.env.get (see index.ts's own Deno.serve entry point), obtainable
// from the Supabase dashboard or `supabase status`. Never paste the
// service-role key into chat or a committed file — export it in your
// own shell, or pass a local --env-file to `deno run`.
//
// THE GOVERNING INVARIANT (read before touching this file): this is a
// REPRODUCTION ENGINE, not a counterfactual strategy simulator. Every
// row is replayed under the EXACT config hash it actually ran under —
// never "the currently active config" — and against the REAL historical
// account state production actually had. Passing a different config for
// a row is a bug, not a feature; there is no parameter for it.

const ASSETS: AssetSymbol[] = ['BTC', 'ETH', 'SUI', 'AVAX']

// Pre-registered BEFORE implementation (Stage 2 plan's own "golden-window
// selection" section) — the ENTIRE currently-available provenance range,
// never a hand-picked subset. GOLDEN_WINDOW_FROM is Stage 0's own deploy
// moment; there is no earlier replayable data by construction (every
// market_bars row before this has ingested_at = NULL, permanently
// excluded — see market-bars-reader.ts). GOLDEN_WINDOW_TO is read at
// run time, not frozen, so later runs see a strictly larger window.
const GOLDEN_WINDOW_FROM = '2026-10-06T12:00:00.000Z'
// Warm-up lookback for the bars fetch ONLY (not the decision window
// itself) — covers the 50-daily/50-4h/12-30m/25-5m floors
// checkStrategyDataSufficiency enforces, with generous headroom.
const WARMUP_LOOKBACK_DAYS = 90

interface FieldComparison {
  field: string
  real: unknown
  replayed: unknown
  matches: boolean
}

interface RowResult {
  decisionId: string
  asset: AssetSymbol
  decidedAt: string
  excluded: 'neutral_bias_unreplayable' | null
  comparisons: FieldComparison[]
}

function compare(field: string, real: unknown, replayed: unknown): FieldComparison {
  const matches = JSON.stringify(real) === JSON.stringify(replayed)
  return { field, real, replayed, matches }
}

async function replayOneRow(
  supabase: SupabaseClient,
  row: RealDecisionRow,
  barsByAsset: Map<AssetSymbol, Awaited<ReturnType<typeof fetchMarketBarsInRange>>>,
  portfolioId: string,
): Promise<RowResult> {
  if (row.regimeState === 'NEUTRAL') {
    return { decisionId: row.id, asset: row.asset, decidedAt: row.decidedAt, excluded: 'neutral_bias_unreplayable', comparisons: [] }
  }

  const [price, lastConsumedBarTs, config, accountState] = await Promise.all([
    fetchHistoricalPrice(supabase, row.runId, row.asset),
    fetchLastConsumedOpportunityBarTsBefore(supabase, portfolioId, row.asset, row.decidedAt),
    row.strategyConfigHash ? fetchConfigByHash(supabase, row.strategyConfigHash) : Promise.resolve(null),
    fetchAccountStateAsOf(supabase, portfolioId, row.decidedAt),
  ])
  // fetchOpenPositionsAsOf is fetched for completeness/future use (entry
  // criterion 7's "same position/account state") even though
  // detectCandidate itself never reads position state directly — it is
  // the GATE/sizing layer downstream that would need it, not detection.
  void (await fetchOpenPositionsAsOf(supabase, portfolioId, row.decidedAt))
  void accountState

  const bars = (barsByAsset.get(row.asset) ?? []).filter((b) => b.asset === row.asset)
  const assembled = assembleAsOfCycle(row.asset, bars, row.decidedAt)

  const assetMarketData: NormalizedMarketData = {
    asset: row.asset,
    provider: 'coingecko',
    dataAsOf: row.decidedAt,
    fetchedAt: row.decidedAt,
    price,
    change1hPct: null,
    change24hPct: null,
    change7dPct: null,
    candles: assembled.candles,
    closeSeries: assembled.closeSeries,
    volumeSeries: assembled.volumeSeries,
    dailyCloseSeries: assembled.dailyCloseSeries,
  }
  const intraday: IntradayMarketData = { asset: row.asset, ohlc30m: assembled.ohlc30m, spot5m: assembled.spot5m }

  const result = detectCandidate({
    assetMarketData,
    intraday,
    config: config ?? undefined,
    lastConsumedBarTs,
    // feeBps/slippageBps are config, read from agent_settings at replay
    // time would be more precise, but these are OPERATOR-ONLY settings
    // (CFG-1's own "what is and isn't configurable" tiering) that have
    // not changed across this project's entire history — using today's
    // live values is exact for the whole golden window in practice.
    feeBps: 10,
    slippageBps: 5,
  })

  return {
    decisionId: row.id,
    asset: row.asset,
    decidedAt: row.decidedAt,
    excluded: null,
    comparisons: [
      compare('regime_state', row.regimeState, result.regimeState ?? null),
      compare('eligible_arms', row.eligibleArms, result.eligibleArms ?? null),
      compare('no_candidate_reason', row.noCandidateReason, result.noCandidateReason ?? null),
      compare('arm_id', row.armId, result.opportunityContext?.armId ?? null),
      compare('direction', row.direction, result.opportunityContext?.direction ?? null),
      compare('has_candidate', row.armId !== null && row.action !== 'HOLD', result.candidate !== undefined),
    ],
  }
}

interface BranchCoverage {
  assetsPresent: Set<AssetSymbol>
  cycleCount: number
  noArmTriggeredCount: number
  opportunityConsumedCount: number
  armIdPopulatedCount: number
  costGateCount: number
  signalStaleCount: number
  dataInsufficientCount: number
  neutralExcludedCount: number
}

function computeCoverage(rows: RealDecisionRow[]): BranchCoverage {
  const coverage: BranchCoverage = {
    assetsPresent: new Set(),
    cycleCount: 0,
    noArmTriggeredCount: 0,
    opportunityConsumedCount: 0,
    armIdPopulatedCount: 0,
    costGateCount: 0,
    signalStaleCount: 0,
    dataInsufficientCount: 0,
    neutralExcludedCount: 0,
  }
  const cycleTimestamps = new Set<string>()
  for (const row of rows) {
    coverage.assetsPresent.add(row.asset)
    cycleTimestamps.add(row.decidedAt)
    if (row.noCandidateReason === 'no_arm_triggered') coverage.noArmTriggeredCount++
    if (row.noCandidateReason === 'opportunity_consumed') coverage.opportunityConsumedCount++
    if (row.noCandidateReason === 'cost_gate') coverage.costGateCount++
    if (row.noCandidateReason === 'signal_stale') coverage.signalStaleCount++
    if (row.noCandidateReason === 'data_insufficient') coverage.dataInsufficientCount++
    if (row.armId !== null) coverage.armIdPopulatedCount++
    if (row.regimeState === 'NEUTRAL') coverage.neutralExcludedCount++
  }
  coverage.cycleCount = cycleTimestamps.size
  return coverage
}

function checkRequiredCoverage(coverage: BranchCoverage): string[] {
  const failures: string[] = []
  for (const asset of ASSETS) {
    if (!coverage.assetsPresent.has(asset)) failures.push(`missing asset: ${asset}`)
  }
  if (coverage.cycleCount < 10) failures.push(`only ${coverage.cycleCount} decision cycles in window, need >= 10`)
  if (coverage.noArmTriggeredCount < 1) failures.push('zero no_arm_triggered rows — the overwhelmingly common path is unrepresented')
  if (coverage.opportunityConsumedCount < 1) failures.push('zero opportunity_consumed rows — the one DB-state-dependent branch is unexercised')
  if (coverage.armIdPopulatedCount < 1) failures.push('zero rows with a populated arm_id — the detection->protection->gate path is unexercised end-to-end')
  return failures
}

async function main() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment. See this file\'s own header comment.')
    Deno.exit(1)
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { data: portfolioRow, error: portfolioError } = await supabase.from('portfolios').select('id').limit(1).single()
  if (portfolioError || !portfolioRow) {
    console.error(`could not read portfolio: ${portfolioError?.message}`)
    Deno.exit(1)
  }
  const portfolioId: string = portfolioRow.id

  const goldenWindowTo = new Date().toISOString()
  console.log(`Golden window: ${GOLDEN_WINDOW_FROM} -> ${goldenWindowTo}`)

  const realRows = await fetchRealDecisionsInWindow(supabase, GOLDEN_WINDOW_FROM, goldenWindowTo)
  const coverage = computeCoverage(realRows)
  const failures = checkRequiredCoverage(coverage)

  console.log(`\nBranch coverage inventory:`)
  console.log(`  assets present: ${[...coverage.assetsPresent].sort().join(', ')}`)
  console.log(`  decision cycles: ${coverage.cycleCount}`)
  console.log(`  no_arm_triggered: ${coverage.noArmTriggeredCount}`)
  console.log(`  opportunity_consumed: ${coverage.opportunityConsumedCount}`)
  console.log(`  arm_id populated: ${coverage.armIdPopulatedCount}`)
  console.log(`  cost_gate (desirable, not required): ${coverage.costGateCount}`)
  console.log(`  signal_stale (desirable, not required): ${coverage.signalStaleCount}`)
  console.log(`  data_insufficient (desirable, not required): ${coverage.dataInsufficientCount}`)
  console.log(`  NEUTRAL bias, excluded from comparison: ${coverage.neutralExcludedCount}`)

  if (failures.length > 0) {
    console.error(`\nINSUFFICIENT BRANCH COVERAGE — refusing to report a pass/fail verdict:`)
    for (const f of failures) console.error(`  - ${f}`)
    console.error(`\nThe correct response is to wait for the window to grow, never to weaken this requirement.`)
    Deno.exit(1)
  }

  const warmupFrom = new Date(new Date(GOLDEN_WINDOW_FROM).getTime() - WARMUP_LOOKBACK_DAYS * 86_400_000).toISOString()
  const barsByAsset = new Map<AssetSymbol, Awaited<ReturnType<typeof fetchMarketBarsInRange>>>()
  for (const asset of ASSETS) {
    barsByAsset.set(asset, await fetchMarketBarsInRange(supabase, asset, warmupFrom, goldenWindowTo))
  }

  // A second, purely TEMPORAL pre-flight check, found by actually running
  // this against live data (2026-10-06) before trusting it on paper: the
  // per-series confirming-write fix (market-bars-reader.ts's own long
  // comment) only helps once at least ONE bar in a timeframe has been
  // freshly written since Stage 0. The daily close happens once per 24h —
  // immediately after Stage 0 shipped, ZERO daily bars have any
  // ingested_at at all, for ANY asset, and every row would hit
  // data_insufficient for a reason having nothing to do with this
  // harness being wrong. Checking this explicitly turns a silent,
  // confusing wall of mismatches into an honest, actionable message.
  const unconfirmedTimeframes: string[] = []
  for (const asset of ASSETS) {
    const bars = barsByAsset.get(asset) ?? []
    for (const timeframe of ['1d', '4h'] as const) {
      const hasConfirmed = bars.some((b) => b.timeframe === timeframe && b.ingestedAt !== null)
      if (!hasConfirmed) unconfirmedTimeframes.push(`${asset}/${timeframe}`)
    }
  }
  if (unconfirmedTimeframes.length > 0) {
    console.error(`\nNOT YET REPLAYABLE — no bar has been confirmed since Stage 0 for: ${unconfirmedTimeframes.join(', ')}`)
    console.error(`This is a timing fact, not a bug: a daily bar lands once per 24h, a 4h bar once per 4h. Every`)
    console.error(`row would hit 'data_insufficient' for a reason unrelated to replay correctness. Wait for the`)
    console.error(`next real close of each listed timeframe, then re-run.`)
    Deno.exit(1)
  }

  const results: RowResult[] = []
  for (const row of realRows) {
    results.push(await replayOneRow(supabase, row, barsByAsset, portfolioId))
  }

  const replayed = results.filter((r) => r.excluded === null)
  const excluded = results.filter((r) => r.excluded !== null)
  const allMismatches = replayed.flatMap((r) => r.comparisons.filter((c) => !c.matches).map((c) => ({ ...c, decisionId: r.decisionId, asset: r.asset, decidedAt: r.decidedAt })))

  console.log(`\nReplayed ${replayed.length} rows (${excluded.length} excluded: NEUTRAL bias, hourly series unavailable).`)
  if (allMismatches.length === 0) {
    console.log(`\nPASSED — zero field mismatches across every replayed row, including HOLD/no-candidate cycles.`)
  } else {
    console.error(`\nFAILED — ${allMismatches.length} field mismatch(es):`)
    for (const m of allMismatches) {
      console.error(`  [${m.asset} ${m.decidedAt}] ${m.field}: real=${JSON.stringify(m.real)} replayed=${JSON.stringify(m.replayed)}`)
    }
    Deno.exit(1)
  }
}

if (import.meta.main) {
  await main()
}
