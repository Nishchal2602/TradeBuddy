import { z } from 'zod'
import { AssetSymbol } from '../market-data/types.ts'

// One net position per asset — FLAT/LONG/SHORT, no lots, no pyramiding, no
// partial exits (trading-domain-contract.md §1; DB-enforced by
// positions_one_open_per_asset_idx, a partial unique index on
// (portfolio_id, asset) where status='open' — this type layer doesn't
// invent that rule, it reflects one already enforced at the schema level).

export const Direction = z.enum(['long', 'short'])
export type Direction = z.infer<typeof Direction>

export const PositionStatus = z.enum(['open', 'closed'])
export type PositionStatus = z.infer<typeof PositionStatus>

// agent_close = closed by an OPEN_LONG/OPEN_SHORT/CLOSE decision;
// stop_loss/take_profit/collateral_exhausted = closed automatically by the
// position monitor. Mirrors trades.trigger_reason for the trade that
// closed this position (positions.close_reason column comment).
export const CloseReason = z.enum(['agent_close', 'stop_loss', 'take_profit', 'collateral_exhausted'])
export type CloseReason = z.infer<typeof CloseReason>

// FLAT/LONG/SHORT is never a column value — it's derived from whether an
// open Position exists for an asset, and its direction if so
// (trading-domain-contract.md §1's state table). Deliberately a plain TS
// union, not a Zod schema: nothing external ever produces raw JSON that
// needs parsing into this — it's always computed by trusted code from an
// already-validated Position, so Zod's actual job (parsing untrusted
// input) doesn't apply here. Every other type in this file guards a real
// parse boundary; this one doesn't have one.
export type PositionState = 'FLAT' | 'LONG' | 'SHORT'

// The single place "what state is this asset in" gets computed — every
// later step (risk gate, broker, monitor, agent-cycle) needs this and must
// import it rather than re-deriving "open position exists implies
// LONG/SHORT" ad hoc in more than one place.
export function derivePositionState(openPosition: Position | null): PositionState {
  if (!openPosition) return 'FLAT'
  return openPosition.direction === 'long' ? 'LONG' : 'SHORT'
}

// Mirrors the `positions` table exactly (supabase/migrations/
// ..._initial_schema.sql + ..._position_model.sql), same reasoning as
// every other normalized type in src/shared/: the persistence step should
// be a near-direct map, not a translation layer.
//
// stopLossPrice/takeProfitPrice are always present (NOT NULL in the DB) —
// every open position has a mandatory, validated stop-loss and take-profit
// (trading-domain-contract.md §3). closedAt/realizedPnl/closeReason are
// null together while open, all three non-null together once closed
// (positions_closed_fields — the DB enforces this triple, not just this
// type).
export const Position = z.object({
  id: z.string().uuid(),
  portfolioId: z.string().uuid(),
  asset: AssetSymbol,
  direction: Direction,

  quantity: z.number().positive(),
  entryPrice: z.number().positive(),
  costBasis: z.number().positive(),
  stopLossPrice: z.number().positive(),
  takeProfitPrice: z.number().positive(),

  status: PositionStatus,
  openedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  realizedPnl: z.number().nullable(),
  closeReason: CloseReason.nullable(),

  openedByDecisionId: z.string().uuid().nullable(),
  closedByDecisionId: z.string().uuid().nullable(),
})
export type Position = z.infer<typeof Position>
