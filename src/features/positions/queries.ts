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
}

export async function fetchPositionById(positionId: string): Promise<PositionDetail | null> {
  const { data, error } = await supabase
    .from('positions')
    .select('id, asset, direction, quantity, entry_price, cost_basis, stop_loss_price, take_profit_price, status, opened_at, closed_at, realized_pnl, close_reason')
    .eq('id', positionId)
    .maybeSingle()
  if (error) throw new Error(`could not load position ${positionId}: ${error.message}`)
  if (!data) return null
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
  }
}
