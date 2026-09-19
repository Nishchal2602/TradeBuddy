import { Position } from '../../../../src/shared/positions/types.ts'

// Shared DB-row -> domain-type mapping, used by both the position monitor
// and the agent cycle (the two Edge Functions that read positions back
// from Postgres) — extracted here rather than duplicated a second time,
// per CLAUDE.md's "do not duplicate business logic" (this is a narrow
// helper, not a Step 5/7 redesign; behavior is unchanged from where it
// first lived, only its location moved).

// PostgREST serializes timestamptz as "...+00:00", not "...Z" — confirmed
// live against agent_settings.created_at (Step 5). Zod's
// .string().datetime() (every domain schema in src/shared/, matching
// CoinGecko's own Z-suffixed convention) rejects the +00:00 form, so
// every timestamp read back from Postgres is normalized here, at the
// DB-row boundary, rather than loosening the schemas themselves.
export function toIsoZ(pgTimestamp: string): string {
  return new Date(pgTimestamp).toISOString()
}

export function rowToPosition(row: Record<string, unknown>): Position {
  return Position.parse({
    id: row.id,
    portfolioId: row.portfolio_id,
    asset: row.asset,
    direction: row.direction,
    quantity: Number(row.quantity),
    entryPrice: Number(row.entry_price),
    costBasis: Number(row.cost_basis),
    stopLossPrice: Number(row.stop_loss_price),
    takeProfitPrice: Number(row.take_profit_price),
    status: row.status,
    openedAt: toIsoZ(row.opened_at as string),
    closedAt: row.closed_at ? toIsoZ(row.closed_at as string) : null,
    realizedPnl: row.realized_pnl === null ? null : Number(row.realized_pnl),
    closeReason: row.close_reason,
    openedByDecisionId: row.opened_by_decision_id,
    closedByDecisionId: row.closed_by_decision_id,
  })
}
