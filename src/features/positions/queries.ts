import { supabase } from '@/supabase'
import type { AssetSymbol } from '@/shared/market-data/types.ts'
import type { Direction, PositionStatus, CloseReason } from '@/shared/positions/types.ts'

// Positions queries beyond Home's own fetchOpenPositions (which only ever
// needs currently-open rows) — Decision-detail (UI Step 3) needs to look
// up one specific position by id, open or closed, since a decision links
// to whichever position it opened, closed, or was tracking regardless of
// that position's current status.

export interface PositionDetail {
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
  openedByDecisionId: string | null
  closedByDecisionId: string | null
}

const POSITION_COLUMNS =
  'id, asset, direction, quantity, entry_price, cost_basis, stop_loss_price, take_profit_price, status, opened_at, closed_at, realized_pnl, close_reason, opened_by_decision_id, closed_by_decision_id'

// deno-lint-ignore no-explicit-any
function rowToPositionDetail(data: any): PositionDetail {
  return {
    id: data.id,
    asset: data.asset,
    direction: data.direction,
    quantity: Number(data.quantity),
    entryPrice: Number(data.entry_price),
    costBasis: Number(data.cost_basis),
    stopLossPrice: Number(data.stop_loss_price),
    takeProfitPrice: Number(data.take_profit_price),
    status: data.status,
    openedAt: data.opened_at,
    closedAt: data.closed_at,
    realizedPnl: data.realized_pnl === null ? null : Number(data.realized_pnl),
    closeReason: data.close_reason,
    openedByDecisionId: data.opened_by_decision_id,
    closedByDecisionId: data.closed_by_decision_id,
  }
}

export async function fetchPositionById(positionId: string): Promise<PositionDetail | null> {
  const { data, error } = await supabase.from('positions').select(POSITION_COLUMNS).eq('id', positionId).maybeSingle()
  if (error) throw new Error(`could not load position ${positionId}: ${error.message}`)
  return data ? rowToPositionDetail(data) : null
}

export interface AssetPositionSummary {
  asset: AssetSymbol
  /** The currently open position for this asset, if any. */
  open: PositionDetail | null
  /** The most recently closed position for this asset — only meaningful
   * (and only ever rendered) when `open` is null; kept even when an open
   * position exists so callers don't need a second query if that changes. */
  lastClosed: PositionDetail | null
}

/** One open-or-last-closed summary per requested asset — the Positions
 * screen's own per-asset need, richer than Home's fetchOpenPositions
 * (open-only) since a flat asset with real history is still worth
 * showing something about, not just "FLAT, no history." Fetches a
 * capped, recent window per portfolio (not per asset) and buckets in
 * application code — cheap for a 2-asset universe, avoids one query per
 * asset per status. */
export async function fetchPositionSummaries(portfolioId: string, assets: AssetSymbol[]): Promise<AssetPositionSummary[]> {
  const { data, error } = await supabase
    .from('positions')
    .select(POSITION_COLUMNS)
    .eq('portfolio_id', portfolioId)
    .order('opened_at', { ascending: false })
    .limit(Math.max(20, assets.length * 10))
  if (error) throw new Error(`could not load positions: ${error.message}`)

  const rows = (data ?? []).map(rowToPositionDetail)
  return assets.map((asset) => {
    const forAsset = rows.filter((p) => p.asset === asset)
    return {
      asset,
      open: forAsset.find((p) => p.status === 'open') ?? null,
      lastClosed: forAsset.find((p) => p.status === 'closed') ?? null, // already ordered newest-first
    }
  })
}
