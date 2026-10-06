import { supabase } from '@/supabase'
import type { AssetSymbol } from '@/shared/market-data/types.ts'
import type { Direction, PositionStatus, CloseReason } from '@/shared/positions/types.ts'
import type { TradeSide, TradeIntent } from '@/shared/trades/types.ts'

// trades.trigger_reason uses the identical enum as positions.close_reason
// (src/shared/trades/types.ts's own TriggerReason is a runtime alias —
// `export const TriggerReason = CloseReason` — with no matching exported
// TYPE, so CloseReason is the correct type here directly.
type TriggerReason = CloseReason

export interface PositionRow {
  id: string
  asset: AssetSymbol
  direction: Direction
  quantity: number
  entryPrice: number
  costBasis: number
  stopLossPrice: number
  takeProfitPrice: number
  status: PositionStatus
  openedAt: string
  closedAt: string | null
  realizedPnl: number | null
  closeReason: CloseReason | null
  partialRealizedPnlUsd: number
  sampledMfeR: number | null
  sampledMaeR: number | null
  highWaterTrackedFrom: string | null
  givebackFloorR: number | null
  openedUnderStrategyProfile: string | null
  // Latest R metrics from this position's most recent management decision,
  // if any exists — two separate fields, never collapsed into one "R"
  // (CLAUDE.md: "after an ADD at a worse price they can disagree").
  latestPriceR: number | null
  latestPositionPnlR: number | null
}

export interface TradeRow {
  id: string
  asset: AssetSymbol
  side: TradeSide
  intent: TradeIntent
  quantity: number
  referencePrice: number
  fillPrice: number
  fee: number
  slippageCost: number
  fundingCost: number
  realizedPnl: number | null
  cashAfter: number
  executedAt: string
  triggerReason: TriggerReason | null
  decisionId: string | null
}

export interface PositionsData {
  positions: PositionRow[]
  trades: TradeRow[]
}

export async function loadPositionsData(): Promise<PositionsData> {
  const { data: portfolio, error: portfolioError } = await supabase.from('portfolios').select('id').single()
  if (portfolioError) throw new Error(`could not load portfolio: ${portfolioError.message}`)
  const portfolioId = portfolio.id as string

  const [positionsRes, tradesRes] = await Promise.all([
    supabase
      .from('positions')
      .select(
        'id, asset, direction, quantity, entry_price, cost_basis, stop_loss_price, take_profit_price, status, opened_at, closed_at, realized_pnl, close_reason, partial_realized_pnl_usd, sampled_mfe_r, sampled_mae_r, high_water_tracked_from, giveback_floor_r, opened_under_strategy_profile',
      )
      .eq('portfolio_id', portfolioId)
      .order('opened_at', { ascending: false }),
    supabase
      .from('trades')
      .select('id, asset, side, intent, quantity, reference_price, fill_price, fee, slippage_cost, funding_cost, realized_pnl, cash_after, executed_at, trigger_reason, decision_id')
      .eq('portfolio_id', portfolioId)
      .order('executed_at', { ascending: false }),
  ])
  if (positionsRes.error) throw new Error(`could not load positions: ${positionsRes.error.message}`)
  if (tradesRes.error) throw new Error(`could not load trades: ${tradesRes.error.message}`)

  const positionIds = (positionsRes.data ?? []).map((p) => p.id)
  const latestRByPosition = new Map<string, { priceR: number | null; positionPnlR: number | null }>()
  if (positionIds.length > 0) {
    const { data: rRows, error: rError } = await supabase
      .from('agent_decisions')
      .select('position_id, price_r, position_pnl_r, decided_at')
      .in('position_id', positionIds)
      .not('position_pnl_r', 'is', null)
      .order('decided_at', { ascending: false })
    if (rError) throw new Error(`could not load R metrics: ${rError.message}`)
    for (const row of rRows ?? []) {
      if (!row.position_id || latestRByPosition.has(row.position_id)) continue
      latestRByPosition.set(row.position_id, {
        priceR: row.price_r === null ? null : Number(row.price_r),
        positionPnlR: row.position_pnl_r === null ? null : Number(row.position_pnl_r),
      })
    }
  }

  const positions: PositionRow[] = (positionsRes.data ?? []).map((p) => {
    const r = latestRByPosition.get(p.id)
    return {
      id: p.id,
      asset: p.asset as AssetSymbol,
      direction: p.direction as Direction,
      quantity: Number(p.quantity),
      entryPrice: Number(p.entry_price),
      costBasis: Number(p.cost_basis),
      stopLossPrice: Number(p.stop_loss_price),
      takeProfitPrice: Number(p.take_profit_price),
      status: p.status as PositionStatus,
      openedAt: p.opened_at,
      closedAt: p.closed_at,
      realizedPnl: p.realized_pnl === null ? null : Number(p.realized_pnl),
      closeReason: p.close_reason as CloseReason | null,
      partialRealizedPnlUsd: Number(p.partial_realized_pnl_usd),
      sampledMfeR: p.sampled_mfe_r === null ? null : Number(p.sampled_mfe_r),
      sampledMaeR: p.sampled_mae_r === null ? null : Number(p.sampled_mae_r),
      highWaterTrackedFrom: p.high_water_tracked_from,
      givebackFloorR: p.giveback_floor_r === null ? null : Number(p.giveback_floor_r),
      openedUnderStrategyProfile: p.opened_under_strategy_profile,
      latestPriceR: r?.priceR ?? null,
      latestPositionPnlR: r?.positionPnlR ?? null,
    }
  })

  const trades: TradeRow[] = (tradesRes.data ?? []).map((t) => ({
    id: t.id,
    asset: t.asset as AssetSymbol,
    side: t.side as TradeSide,
    intent: t.intent as TradeIntent,
    quantity: Number(t.quantity),
    referencePrice: Number(t.reference_price),
    fillPrice: Number(t.fill_price),
    fee: Number(t.fee),
    slippageCost: Number(t.slippage_cost),
    fundingCost: Number(t.funding_cost),
    realizedPnl: t.realized_pnl === null ? null : Number(t.realized_pnl),
    cashAfter: Number(t.cash_after),
    executedAt: t.executed_at,
    triggerReason: t.trigger_reason as TriggerReason | null,
    decisionId: t.decision_id,
  }))

  return { positions, trades }
}
