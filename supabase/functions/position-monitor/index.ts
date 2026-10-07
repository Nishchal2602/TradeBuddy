import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchRecentPricePoints } from '../agent-cycle/providers/coingecko.ts'
import { computeNav } from '../agent-cycle/broker/accounting.ts'
import type { ClosePositionResult } from '../agent-cycle/broker/accounting.ts'
import { rowToPosition } from '../agent-cycle/db/row-mappers.ts'
import { loadActiveIntradayLsConfig, loadConfigById } from '../agent-cycle/db/strategy-config.ts'
import { loadVariantForPortfolio } from '../agent-cycle/db/experiment-account.ts'
import type { Position } from '../../../src/shared/positions/types.ts'
import type { AssetSymbol } from '../../../src/shared/market-data/types.ts'
import type { PricePoint } from './triggers.ts'
import { planMonitorActions } from './plan.ts'
import type { MonitorPlanResult } from './plan.ts'

// The thin I/O shell around plan.ts's pure decision core — reads the
// architecture.md "Position Monitor Cycle" 6 steps from the database,
// hands already-shaped plain data to planMonitorActions, persists
// whatever it decided. No accounting math and no trigger logic lives in
// this file; see plan.ts / triggers.ts / accounting.ts for those, each
// independently fixture-tested. rowToPosition (and its +00:00-vs-Z
// timestamp normalization) moved to agent-cycle/db/row-mappers.ts in
// Step 7, once the agent cycle needed the exact same DB-row mapping —
// same behavior, shared location, not a redesign.
//
// EXP-1 Stage E3 (2026-10-07) — restructured from a single-champion
// shell into a per-portfolio loop over EVERY portfolio, not just the
// champion. One portfolio's failure, duplicate tick, or stale data never
// blocks another's — each gets its own idempotency claim, its own
// agent_runs row, its own giveback-config resolution (variant-aware,
// mirroring agent-cycle's own loadVariantForPortfolio/loadConfigById
// pattern), and its own nav_snapshot. The one genuinely SHARED step is
// the price fetch itself (step 2) — one call for the UNION of every
// open position's asset across every portfolio, preserving the exact
// flat-cost property agent-cycle's own market_ticks design depends on.
// With exactly one portfolio (today, pre-experiment), this loop runs
// once and produces byte-identical output to the prior single-portfolio
// shell.

function floorToIntervalIso(nowIso: string, intervalMinutes: number): string {
  const intervalMs = intervalMinutes * 60_000
  const floored = Math.floor(new Date(nowIso).getTime() / intervalMs) * intervalMs
  return new Date(floored).toISOString()
}

function closeResultToRpcParams(result: ClosePositionResult, expectedQuantity?: number) {
  return {
    p_position_id: result.closedPosition.id,
    p_closed_at: result.closedPosition.closedAt,
    p_realized_pnl: result.realizedPnl,
    p_close_reason: result.closedPosition.closeReason,
    p_closed_by_decision_id: result.closedPosition.closedByDecisionId,
    p_trade_id: result.trade.id,
    p_side: result.trade.side,
    p_quantity: result.trade.quantity,
    p_reference_price: result.trade.referencePrice,
    p_fill_price: result.trade.fillPrice,
    p_fee: result.trade.fee,
    p_slippage_cost: result.trade.slippageCost,
    p_gross_value: result.trade.grossValue,
    p_net_cash_delta: result.trade.netCashDelta,
    p_executed_at: result.trade.executedAt,
    p_intent: result.trade.intent,
    p_decision_id: result.trade.decisionId,
    p_trigger_reason: result.trade.triggerReason,
    // Strategy V4 (2026-10-01) — perpetual-funding cost charged on this
    // closing trade (0 for a long, or for any close where funding was
    // never wired — accounting.ts's own computeFundingAccrual already
    // defaults to 0 whenever it isn't applicable).
    p_funding_cost: result.fundingCost,
    // Aggressive V3.1 (2026-09-23) — the optimistic-concurrency guard
    // (close_position_atomic's own p_expected_quantity). Undefined for
    // every SL/TP close (the pre-existing call site below never passes
    // this), which Postgres treats as its declared default (null) —
    // status alone is still that guard's own concurrency check. Only the
    // giveback-close call site passes a real value: the quantity the
    // ratchet's trigger was actually computed from, so a same-tick
    // ADD/REDUCE that changed it loses the race rather than closing a
    // position whose economics have since moved.
    p_expected_quantity: expectedQuantity ?? null,
  }
}

export interface MonitorRunSummary {
  status: 'completed' | 'skipped' | 'duplicate_tick' | 'failed'
  runId?: string
  openPositionCount: number
  closedCount: number
  lostRaceCount: number
  staleAssetCount: number
  // Aggressive V3.1 profit recycling (2026-09-23) — kept separate from
  // closedCount so a run's log line can distinguish the two triggers at a
  // glance, matching how staleAssetCount is already its own field rather
  // than folded into closedCount.
  givebackClosedCount: number
  // Strategy V4 (2026-10-01) — the two new intraday_ls-only exits (hard
  // max hold, soft time stop), same "its own field" reasoning as
  // givebackClosedCount above.
  timeStopClosedCount: number
  detail?: string
}

export interface MonitorDeps {
  supabase: SupabaseClient
  // deno-lint-ignore no-explicit-any
  fetchImpl?: any
  nowIso: string
  // CoinGecko Demo API key (2026-09-22) — optional, same "degrade to the
  // stricter keyless rate limit rather than throw" reasoning as every
  // other optional param coingecko.ts threads this through. This
  // function's own fetchRecentPricePoints calls are real, not
  // hypothetical — it fires whenever a position is open, which is the
  // common case right now (trading-strategy-v1.md's live positions).
  coingeckoApiKey?: string
}

interface PortfolioRow {
  id: string
  cash: number
  experiment_variant_id: string | null
}

export async function runPositionMonitor(deps: MonitorDeps): Promise<MonitorRunSummary> {
  const { supabase, nowIso, coingeckoApiKey } = deps
  const fetchImpl = deps.fetchImpl ?? fetch

  const { data: settings, error: settingsError } = await supabase
    .from('agent_settings')
    .select('monitor_interval_minutes, max_data_staleness_minutes, fee_bps, slippage_bps, strategy_profile, short_funding_bps_per_day, time_stop_minutes, max_hold_minutes')
    .single()
  if (settingsError || !settings) {
    return { status: 'failed', openPositionCount: 0, closedCount: 0, lostRaceCount: 0, staleAssetCount: 0, givebackClosedCount: 0, timeStopClosedCount: 0, detail: `could not read agent_settings: ${settingsError?.message}` }
  }

  // EXP-1 Stage E3 (2026-10-07) — EVERY portfolio, not just the champion.
  // With exactly one portfolio (today), this degenerates to the old
  // single-portfolio read.
  const { data: portfolioRows, error: portfoliosError } = await supabase
    .from('portfolios')
    .select('id, cash, experiment_variant_id')
  if (portfoliosError || !portfolioRows || portfolioRows.length === 0) {
    return { status: 'failed', openPositionCount: 0, closedCount: 0, lostRaceCount: 0, staleAssetCount: 0, givebackClosedCount: 0, timeStopClosedCount: 0, detail: `could not read portfolios: ${portfoliosError?.message}` }
  }
  const portfolios = portfolioRows as unknown as PortfolioRow[]

  // Step 1 (architecture.md), done ONCE for every portfolio: read every
  // open position system-wide, then group by portfolioId (rowToPosition
  // already maps portfolio_id -> portfolioId — see row-mappers.ts).
  const { data: openRows, error: positionsError } = await supabase
    .from('positions')
    .select('*')
    .eq('status', 'open')
  if (positionsError) {
    return { status: 'failed', openPositionCount: 0, closedCount: 0, lostRaceCount: 0, staleAssetCount: 0, givebackClosedCount: 0, timeStopClosedCount: 0, detail: `could not read open positions: ${positionsError.message}` }
  }
  const allOpenPositions = (openRows ?? []).map(rowToPosition)
  const positionsByPortfolio = new Map<string, Position[]>()
  for (const position of allOpenPositions) {
    const existing = positionsByPortfolio.get(position.portfolioId)
    if (existing) existing.push(position)
    else positionsByPortfolio.set(position.portfolioId, [position])
  }

  // Step 2 — the one genuinely SHARED step: a single price fetch for the
  // UNION of every open position's asset, across EVERY portfolio. This is
  // what keeps the flat-cost property true as portfolio count grows —
  // the same property agent-cycle's own market_ticks design exists to
  // preserve (see the EXP-1 plan's "direct answer to does this increase
  // CoinGecko calls" section). Zero open positions anywhere still costs
  // zero API calls, exactly as before.
  const distinctAssets = [...new Set(allOpenPositions.map((p) => p.asset))] as AssetSymbol[]
  const pointsByAsset = distinctAssets.length > 0
    ? await fetchRecentPricePoints(distinctAssets, fetchImpl, undefined, coingeckoApiKey)
    : {}

  const latestPriceByAsset = new Map<AssetSymbol, number>()
  for (const asset of distinctAssets) {
    const points = pointsByAsset[asset] ?? []
    if (points.length > 0) latestPriceByAsset.set(asset, points[points.length - 1]!.price)
  }

  // Aggregated across every portfolio this tick. One portfolio's failure
  // or duplicate tick never blocks another's — each portfolio gets its
  // own try/catch and its own idempotency claim below.
  let anyCompleted = false
  let anySkipped = false
  let anyDuplicate = false
  let anyFailed = false
  let firstRunId: string | undefined
  let totalOpen = 0
  let totalClosed = 0
  let totalLostRace = 0
  let totalStale = 0
  let totalGiveback = 0
  let totalTimeStop = 0
  const details: string[] = []

  for (const portfolioRow of portfolios) {
    const portfolioId = portfolioRow.id
    const openPositions = positionsByPortfolio.get(portfolioId) ?? []

    // Step 1 continued: acquire idempotency, per portfolio. A retried
    // invocation of the same scheduled tick computes the same floored key
    // and collides on agent_runs_idempotency_key_unique (widened to
    // (portfolio_id, idempotency_key) in EXP-1 Stage E1) — detected via
    // the insert's own unique-violation error, no read-then-write gap.
    const idempotencyKey = `monitor-${floorToIntervalIso(nowIso, settings.monitor_interval_minutes)}`
    const { data: run, error: runInsertError } = await supabase
      .from('agent_runs')
      .insert({ portfolio_id: portfolioId, idempotency_key: idempotencyKey, status: 'running', kind: 'monitor', started_at: nowIso })
      .select('id')
      .single()

    if (runInsertError) {
      if (runInsertError.code === '23505') {
        anyDuplicate = true
        details.push(`portfolio ${portfolioId}: duplicate_tick`)
        continue
      }
      anyFailed = true
      details.push(`portfolio ${portfolioId}: could not create agent_runs row: ${runInsertError.message}`)
      continue
    }
    const runId: string = run.id
    firstRunId ??= runId

    try {
      // Step 1 continued: no open positions for THIS portfolio -> log and
      // return without any per-portfolio work. The common case (V0 has 2
      // assets total), and the reason most monitor ticks cost zero API
      // calls for a portfolio with nothing open.
      if (openPositions.length === 0) {
        await supabase.from('agent_runs').update({ status: 'completed', completed_at: nowIso }).eq('id', runId)
        anyCompleted = true
        continue
      }

      // Step 2 continued: replay every point since the LAST COMPLETED
      // MONITOR RUN FOR THIS PORTFOLIO, not a single spot snapshot and
      // not another portfolio's last run. Bootstrap fallback (first-ever
      // monitor run for this portfolio, or its prior run failed/missing)
      // mirrors news_lookback_overlap_minutes' own reasoning: default to
      // a full extra interval of overlap rather than risk a gap.
      const { data: lastRun } = await supabase
        .from('agent_runs')
        .select('completed_at')
        .eq('kind', 'monitor')
        .eq('portfolio_id', portfolioId)
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const cutoffMs = lastRun?.completed_at
        ? new Date(lastRun.completed_at).getTime()
        : new Date(nowIso).getTime() - 2 * settings.monitor_interval_minutes * 60_000

      const openPositionsWithPoints = openPositions.map((position) => {
        const allPoints: PricePoint[] = pointsByAsset[position.asset] ?? []
        const sincePoints = allPoints.filter((p) => new Date(p.timestamp).getTime() > cutoffMs)
        return { position, points: sincePoints }
      })

      // CFG-1 Stage 1B / EXP-1 (2026-10-06/07) — this portfolio's OWN
      // giveback config: a variant pins its own strategy_config_id
      // (loadConfigById, by explicit id — never "currently active"),
      // mirroring agent-cycle's own resolution exactly. The champion
      // (experiment_variant_id === null) still resolves the globally
      // active config, byte-identical to before this restructuring.
      // Skipped entirely outside intraday_ls, same "no new behavior for
      // other profiles" discipline as agent-cycle's own identical gate.
      let givebackEnabledForIntradayLs = false
      if (settings.strategy_profile === 'intraday_ls') {
        const variant = await loadVariantForPortfolio(supabase, portfolioRow.experiment_variant_id)
        const loadedConfig = variant
          ? await loadConfigById(supabase, variant.strategyConfigId)
          : await loadActiveIntradayLsConfig(supabase)
        givebackEnabledForIntradayLs = loadedConfig?.config.givebackEnabledForIntradayLs ?? false
      }

      const plan: MonitorPlanResult = planMonitorActions({
        openPositions: openPositionsWithPoints,
        maxDataStalenessMinutes: settings.max_data_staleness_minutes,
        nowIso,
        feeBps: settings.fee_bps,
        slippageBps: settings.slippage_bps,
        startingCash: Number(portfolioRow.cash),
        strategyProfile: settings.strategy_profile,
        shortFundingBpsPerDay: Number(settings.short_funding_bps_per_day),
        timeStopMinutes: settings.time_stop_minutes,
        maxHoldMinutes: settings.max_hold_minutes,
        givebackEnabledForIntradayLs,
      })

      // Step 5: execute through the shared broker via the conditional-
      // update RPC. A lost race (another path — the future agent cycle —
      // already closed this position first) is logged as a no-op, not an
      // error; the computed trade is discarded rather than retried, per
      // trading-domain-contract.md §6.
      let lostRaceCount = 0
      for (const closeResult of plan.closes) {
        const { data: rpcData, error: rpcError } = await supabase.rpc('close_position_atomic', closeResultToRpcParams(closeResult))
        if (rpcError) throw new Error(`close_position_atomic failed for position ${closeResult.closedPosition.id}: ${rpcError.message}`)
        const outcome = Array.isArray(rpcData) ? rpcData[0] : rpcData
        if (!outcome?.won_race) {
          lostRaceCount++
          console.log(`position-monitor: lost the close race for position ${closeResult.closedPosition.id} (${closeResult.closedPosition.asset}) — already closed by another path`)
        } else {
          console.log(`position-monitor: closed position ${closeResult.closedPosition.id} (${closeResult.closedPosition.asset}) via ${closeResult.trade.triggerReason}`)
        }
      }

      // Aggressive V3.1 profit recycling (2026-09-23) — the giveback
      // ratchet's own closes, executed exactly like an SL/TP close except
      // for the added p_expected_quantity concurrency guard (plan §5.3):
      // if agent-cycle executed an ADD/REDUCE between the ratchet's
      // trigger computation and this call, the quantity guard loses the
      // race — same no-op-not-error handling as any other lost race.
      let givebackLostRaceCount = 0
      for (const closeResult of plan.givebackCloses) {
        const { data: rpcData, error: rpcError } = await supabase.rpc(
          'close_position_atomic',
          closeResultToRpcParams(closeResult, closeResult.closedPosition.quantity),
        )
        if (rpcError) throw new Error(`close_position_atomic (profit_giveback) failed for position ${closeResult.closedPosition.id}: ${rpcError.message}`)
        const outcome = Array.isArray(rpcData) ? rpcData[0] : rpcData
        if (!outcome?.won_race) {
          givebackLostRaceCount++
          console.log(`position-monitor: lost the giveback-close race for position ${closeResult.closedPosition.id} (${closeResult.closedPosition.asset}) — quantity or status changed since the ratchet triggered`)
        } else {
          console.log(`position-monitor: closed position ${closeResult.closedPosition.id} (${closeResult.closedPosition.asset}) via profit_giveback`)
        }
      }

      // Strategy V4 (2026-10-01) — the two new intraday_ls-only exits
      // (hard max hold, soft time stop). Same optimistic-concurrency
      // guard as giveback above, and for the identical reason: both are
      // computed from a snapshot the monitor read at the top of this
      // tick, so an intervening ADD/REDUCE must lose the race rather than
      // close a position whose economics have since moved.
      let timeStopLostRaceCount = 0
      for (const closeResult of plan.timeStopCloses) {
        const { data: rpcData, error: rpcError } = await supabase.rpc(
          'close_position_atomic',
          closeResultToRpcParams(closeResult, closeResult.closedPosition.quantity),
        )
        if (rpcError) throw new Error(`close_position_atomic (time_stop) failed for position ${closeResult.closedPosition.id}: ${rpcError.message}`)
        const outcome = Array.isArray(rpcData) ? rpcData[0] : rpcData
        if (!outcome?.won_race) {
          timeStopLostRaceCount++
          console.log(`position-monitor: lost the time-stop-close race for position ${closeResult.closedPosition.id} (${closeResult.closedPosition.asset}) — quantity or status changed since the exit triggered`)
        } else {
          console.log(`position-monitor: closed position ${closeResult.closedPosition.id} (${closeResult.closedPosition.asset}) via time_stop`)
        }
      }

      // Aggressive V3.1 — high-water state for every eligible, STILL-OPEN
      // position this tick (plan §3.6: exactly one atomic update per
      // position per tick, however many price points were replayed above
      // to produce it). Pure telemetry — never touches stop_loss_price/
      // take_profit_price, so this never interacts with the SL/TP race.
      for (const update of plan.highWaterUpdates) {
        const { error: highWaterError } = await supabase.from('positions').update({
          sampled_mfe_r: update.sampledMfeR,
          sampled_mae_r: update.sampledMaeR,
          giveback_floor_r: update.givebackFloorR,
          peak_total_pnl_usd: update.peakTotalPnlUsd,
          peak_pnl_at: update.peakPnlAt,
        }).eq('id', update.positionId)
        if (highWaterError) throw new Error(`could not persist high-water state for position ${update.positionId}: ${highWaterError.message}`)
      }

      for (const stale of plan.staleAssets) {
        console.log(`position-monitor: skipping trigger evaluation for ${stale.asset} (position ${stale.positionId}, portfolio ${portfolioId}) — stale data (${stale.latestPointAgeMinutes ?? 'no points'} min old)`)
      }

      // Step 6: NAV snapshot, scoped to this portfolio. Re-read cash and
      // open positions fresh rather than projecting from in-memory plan
      // state, so a lost race (cash moved by whichever path actually won
      // it) is reflected correctly regardless of this run's own view.
      const { data: freshPortfolio } = await supabase.from('portfolios').select('cash').eq('id', portfolioId).single()
      const { data: freshOpenRows } = await supabase.from('positions').select('*').eq('status', 'open').eq('portfolio_id', portfolioId)
      const freshOpenPositions = (freshOpenRows ?? []).map(rowToPosition)
      const cash = Number(freshPortfolio?.cash ?? portfolioRow.cash)
      const nav = computeNav(
        cash,
        freshOpenPositions.map((p) => ({
          direction: p.direction,
          quantity: p.quantity,
          entryPrice: p.entryPrice,
          costBasis: p.costBasis,
          currentPrice: latestPriceByAsset.get(p.asset) ?? p.entryPrice,
        })),
      )
      const positionsValue = nav - cash
      const unrealizedPnl = freshOpenPositions.reduce((sum, p) => {
        const current = latestPriceByAsset.get(p.asset) ?? p.entryPrice
        return sum + (p.direction === 'long' ? (current - p.entryPrice) * p.quantity : (p.entryPrice - current) * p.quantity)
      }, 0)
      const realizedPnlThisRun = [...plan.closes, ...plan.givebackCloses, ...plan.timeStopCloses].reduce((sum, c) => sum + c.realizedPnl, 0)

      // realized_pnl_cum is a running total across every run that has
      // ever written a nav_snapshot for THIS portfolio (decision cycle or
      // monitor, either can realize P&L) — carry forward the most recent
      // prior snapshot's cumulative figure and add only this run's own
      // delta, rather than recomputing from full trade history every
      // tick.
      const { data: priorNav } = await supabase
        .from('nav_snapshots')
        .select('realized_pnl_cum')
        .eq('portfolio_id', portfolioId)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const realizedPnlCum = Number(priorNav?.realized_pnl_cum ?? 0) + realizedPnlThisRun

      await supabase.from('nav_snapshots').insert({
        portfolio_id: portfolioId,
        run_id: runId,
        cash,
        positions_value: positionsValue,
        nav,
        unrealized_pnl: unrealizedPnl,
        realized_pnl_cum: realizedPnlCum,
      })

      // All-stale is a genuine skip (architecture.md step 3: "if data is
      // stale, log a skipped run and close nothing") only when EVERY open
      // position in THIS portfolio was unevaluable — a partial-stale run
      // (some assets evaluated, one didn't) is still a normal completion,
      // just with a logged per-asset gap.
      const allStale = plan.staleAssets.length === openPositions.length
      await supabase.from('agent_runs').update({
        status: allStale ? 'skipped' : 'completed',
        skip_reason: allStale ? 'all open-position assets had stale price data' : null,
        completed_at: nowIso,
      }).eq('id', runId)

      if (allStale) anySkipped = true
      else anyCompleted = true

      totalOpen += openPositions.length
      totalClosed += plan.closes.length
      totalLostRace += lostRaceCount + givebackLostRaceCount + timeStopLostRaceCount
      totalStale += plan.staleAssets.length
      totalGiveback += plan.givebackCloses.length
      totalTimeStop += plan.timeStopCloses.length
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Fail closed (CLAUDE.md invariant): an unexpected error aborts
      // THIS portfolio's run without guessing at partial state. Positions
      // already closed via the RPC before the failure remain closed (each
      // was its own atomic transaction) — only this portfolio's own run
      // bookkeeping is marked failed, and every other portfolio keeps
      // processing independently.
      await supabase.from('agent_runs').update({ status: 'failed', error_detail: message, completed_at: nowIso }).eq('id', runId)
      anyFailed = true
      details.push(`portfolio ${portfolioId}: ${message}`)
    }
  }

  // Aggregate status, in priority order: if ANYTHING genuinely completed
  // this tick, report 'completed' — one account's failure or stale data
  // must not mask every other account's positions having been protected
  // correctly. With exactly one portfolio (today), each branch is
  // mutually exclusive with the others, so this reduces to exactly the
  // old single-portfolio status derivation.
  const status: MonitorRunSummary['status'] = anyCompleted
    ? 'completed'
    : anySkipped
    ? 'skipped'
    : anyFailed
    ? 'failed'
    : anyDuplicate
    ? 'duplicate_tick'
    : 'failed'

  return {
    status,
    runId: firstRunId,
    openPositionCount: totalOpen,
    closedCount: totalClosed,
    lostRaceCount: totalLostRace,
    staleAssetCount: totalStale,
    givebackClosedCount: totalGiveback,
    timeStopClosedCount: totalTimeStop,
    detail: details.length > 0 ? details.join('; ') : undefined,
  }
}

Deno.serve(async (_req) => {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const coingeckoApiKey = Deno.env.get('COINGECKO_API_KEY') || undefined
  const summary = await runPositionMonitor({ supabase, nowIso: new Date().toISOString(), coingeckoApiKey })
  return new Response(JSON.stringify(summary), { headers: { 'content-type': 'application/json' } })
})
