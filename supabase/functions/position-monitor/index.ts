import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchRecentPricePoints } from '../agent-cycle/providers/coingecko.ts'
import { computeNav } from '../agent-cycle/broker/accounting.ts'
import type { ClosePositionResult } from '../agent-cycle/broker/accounting.ts'
import { rowToPosition } from '../agent-cycle/db/row-mappers.ts'
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

export async function runPositionMonitor(deps: MonitorDeps): Promise<MonitorRunSummary> {
  const { supabase, nowIso, coingeckoApiKey } = deps
  const fetchImpl = deps.fetchImpl ?? fetch

  const { data: settings, error: settingsError } = await supabase
    .from('agent_settings')
    .select('monitor_interval_minutes, max_data_staleness_minutes, fee_bps, slippage_bps, strategy_profile')
    .single()
  if (settingsError || !settings) {
    return { status: 'failed', openPositionCount: 0, closedCount: 0, lostRaceCount: 0, staleAssetCount: 0, givebackClosedCount: 0, detail: `could not read agent_settings: ${settingsError?.message}` }
  }

  const { data: portfolio, error: portfolioError } = await supabase
    .from('portfolios')
    .select('id, cash')
    .single()
  if (portfolioError || !portfolio) {
    return { status: 'failed', openPositionCount: 0, closedCount: 0, lostRaceCount: 0, staleAssetCount: 0, givebackClosedCount: 0, detail: `could not read portfolio: ${portfolioError?.message}` }
  }

  // Step 1 (architecture.md): acquire idempotency. A retried invocation of
  // the same scheduled tick computes the same floored key and collides on
  // agent_runs_idempotency_key_unique — detected via the insert's own
  // unique-violation error rather than a separate pre-check, so there is
  // no read-then-write gap for a second concurrent invocation to land in.
  const idempotencyKey = `monitor-${floorToIntervalIso(nowIso, settings.monitor_interval_minutes)}`
  const { data: run, error: runInsertError } = await supabase
    .from('agent_runs')
    .insert({ portfolio_id: portfolio.id, idempotency_key: idempotencyKey, status: 'running', kind: 'monitor', started_at: nowIso })
    .select('id')
    .single()

  if (runInsertError) {
    if (runInsertError.code === '23505') {
      // The unique constraint on idempotency_key doesn't distinguish
      // "still running" from "already completed" — correctly so, since a
      // retry of the same scheduled tick must not redo the work either
      // way. Not treated as an error.
      return { status: 'duplicate_tick', openPositionCount: 0, closedCount: 0, lostRaceCount: 0, staleAssetCount: 0, givebackClosedCount: 0, detail: 'this tick was already handled by another invocation (in progress or completed)' }
    }
    return { status: 'failed', openPositionCount: 0, closedCount: 0, lostRaceCount: 0, staleAssetCount: 0, givebackClosedCount: 0, detail: `could not create agent_runs row: ${runInsertError.message}` }
  }
  const runId: string = run.id

  try {
    const { data: openRows, error: positionsError } = await supabase
      .from('positions')
      .select('*')
      .eq('status', 'open')
    if (positionsError) throw new Error(`could not read open positions: ${positionsError.message}`)

    const openPositions = (openRows ?? []).map(rowToPosition)

    // Step 1 continued: no open positions -> log and return without any
    // price fetch. The common case (V0 has 2 assets total), and the
    // reason most monitor ticks cost zero API calls.
    if (openPositions.length === 0) {
      await supabase.from('agent_runs').update({ status: 'completed', completed_at: nowIso }).eq('id', runId)
      return { status: 'completed', runId, openPositionCount: 0, closedCount: 0, lostRaceCount: 0, staleAssetCount: 0, givebackClosedCount: 0 }
    }

    // Step 2: replay every point since the last completed monitor run, not
    // a single spot snapshot. Bootstrap fallback (first-ever monitor run,
    // or the prior run failed/is missing) mirrors news_lookback_overlap_
    // minutes' own reasoning: default to a full extra interval of overlap
    // rather than risk a gap.
    const { data: lastRun } = await supabase
      .from('agent_runs')
      .select('completed_at')
      .eq('kind', 'monitor')
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const cutoffMs = lastRun?.completed_at
      ? new Date(lastRun.completed_at).getTime()
      : new Date(nowIso).getTime() - 2 * settings.monitor_interval_minutes * 60_000

    const distinctAssets = [...new Set(openPositions.map((p) => p.asset))] as AssetSymbol[]
    const pointsByAsset = await fetchRecentPricePoints(distinctAssets, fetchImpl, undefined, coingeckoApiKey)

    const latestPriceByAsset = new Map<AssetSymbol, number>()
    for (const asset of distinctAssets) {
      const points = pointsByAsset[asset] ?? []
      if (points.length > 0) latestPriceByAsset.set(asset, points[points.length - 1]!.price)
    }

    const openPositionsWithPoints = openPositions.map((position) => {
      const allPoints: PricePoint[] = pointsByAsset[position.asset] ?? []
      const sincePoints = allPoints.filter((p) => new Date(p.timestamp).getTime() > cutoffMs)
      return { position, points: sincePoints }
    })

    const plan: MonitorPlanResult = planMonitorActions({
      openPositions: openPositionsWithPoints,
      maxDataStalenessMinutes: settings.max_data_staleness_minutes,
      nowIso,
      feeBps: settings.fee_bps,
      slippageBps: settings.slippage_bps,
      startingCash: Number(portfolio.cash),
      strategyProfile: settings.strategy_profile,
    })

    // Step 5: execute through the shared broker via the conditional-update
    // RPC. A lost race (another path — the future agent cycle — already
    // closed this position first) is logged as a no-op, not an error; the
    // computed trade is discarded rather than retried, per
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
    // for the added p_expected_quantity concurrency guard (plan §5.3): if
    // agent-cycle executed an ADD/REDUCE between the ratchet's trigger
    // computation and this call, the quantity guard loses the race —
    // same no-op-not-error handling as any other lost race.
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

    // Aggressive V3.1 — high-water state for every eligible, STILL-OPEN
    // position this tick (plan §3.6: exactly one atomic update per
    // position per tick, however many price points were replayed above to
    // produce it). Pure telemetry — never touches stop_loss_price/
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
      console.log(`position-monitor: skipping trigger evaluation for ${stale.asset} (position ${stale.positionId}) — stale data (${stale.latestPointAgeMinutes ?? 'no points'} min old)`)
    }

    // Step 6: NAV snapshot. Re-read cash and open positions fresh rather
    // than projecting from in-memory plan state, so a lost race (cash
    // moved by whichever path actually won it) is reflected correctly
    // regardless of this run's own view.
    const { data: freshPortfolio } = await supabase.from('portfolios').select('cash').eq('id', portfolio.id).single()
    const { data: freshOpenRows } = await supabase.from('positions').select('*').eq('status', 'open')
    const freshOpenPositions = (freshOpenRows ?? []).map(rowToPosition)
    const cash = Number(freshPortfolio?.cash ?? portfolio.cash)
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
    const realizedPnlThisRun = [...plan.closes, ...plan.givebackCloses].reduce((sum, c) => sum + c.realizedPnl, 0)

    // realized_pnl_cum is a running total across every run that has ever
    // written a nav_snapshot for this portfolio (decision cycle or
    // monitor, either can realize P&L) — carry forward the most recent
    // prior snapshot's cumulative figure and add only this run's own
    // delta, rather than recomputing from full trade history every tick.
    const { data: priorNav } = await supabase
      .from('nav_snapshots')
      .select('realized_pnl_cum')
      .eq('portfolio_id', portfolio.id)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const realizedPnlCum = Number(priorNav?.realized_pnl_cum ?? 0) + realizedPnlThisRun

    await supabase.from('nav_snapshots').insert({
      portfolio_id: portfolio.id,
      run_id: runId,
      cash,
      positions_value: positionsValue,
      nav,
      unrealized_pnl: unrealizedPnl,
      realized_pnl_cum: realizedPnlCum,
    })

    // All-stale is a genuine skip (architecture.md step 3: "if data is
    // stale, log a skipped run and close nothing") only when EVERY open
    // position was unevaluable — a partial-stale run (some assets
    // evaluated, one didn't) is still a normal completion, just with a
    // logged per-asset gap.
    const allStale = plan.staleAssets.length === openPositions.length
    await supabase.from('agent_runs').update({
      status: allStale ? 'skipped' : 'completed',
      skip_reason: allStale ? 'all open-position assets had stale price data' : null,
      completed_at: nowIso,
    }).eq('id', runId)

    return {
      status: allStale ? 'skipped' : 'completed',
      runId,
      openPositionCount: openPositions.length,
      closedCount: plan.closes.length,
      lostRaceCount: lostRaceCount + givebackLostRaceCount,
      staleAssetCount: plan.staleAssets.length,
      givebackClosedCount: plan.givebackCloses.length,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Fail closed (CLAUDE.md invariant): an unexpected error aborts the
    // run without guessing at partial state. Positions already closed via
    // the RPC before the failure remain closed (each was its own atomic
    // transaction) — only the run's own bookkeeping is marked failed.
    await supabase.from('agent_runs').update({ status: 'failed', error_detail: message, completed_at: nowIso }).eq('id', runId)
    return { status: 'failed', runId, openPositionCount: 0, closedCount: 0, lostRaceCount: 0, staleAssetCount: 0, givebackClosedCount: 0, detail: message }
  }
}

Deno.serve(async (_req) => {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const coingeckoApiKey = Deno.env.get('COINGECKO_API_KEY') || undefined
  const summary = await runPositionMonitor({ supabase, nowIso: new Date().toISOString(), coingeckoApiKey })
  return new Response(JSON.stringify(summary), { headers: { 'content-type': 'application/json' } })
})
