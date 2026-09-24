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
    // Strategy profiles (2026-09-23) — null for every position opened
    // before this column existed and for every non-aggressive open;
    // undefined is never produced here (row.initial_risk_usd is always at
    // least `null` on a real PostgREST response), matching the schema's
    // own `.nullable().optional()` (optional exists for object-literal
    // constructors elsewhere, not for this DB-row boundary).
    initialRiskUsd: row.initial_risk_usd === null || row.initial_risk_usd === undefined ? null : Number(row.initial_risk_usd),
    // Aggressive V3.1 profit recycling (2026-09-23) — same null-vs-Number
    // discipline as initialRiskUsd above, for the rest of the ruler triple
    // and the monitor-sampled high-water state. partialRealizedPnlUsd is
    // NOT NULL DEFAULT 0 at the DB layer, so it is always a real number
    // here — never null, matching the schema's `.optional()`-only field.
    initialEntryPrice: row.initial_entry_price === null || row.initial_entry_price === undefined ? null : Number(row.initial_entry_price),
    initialStopLossPrice: row.initial_stop_loss_price === null || row.initial_stop_loss_price === undefined ? null : Number(row.initial_stop_loss_price),
    partialRealizedPnlUsd: Number(row.partial_realized_pnl_usd ?? 0),
    sampledMfeR: row.sampled_mfe_r === null || row.sampled_mfe_r === undefined ? null : Number(row.sampled_mfe_r),
    sampledMaeR: row.sampled_mae_r === null || row.sampled_mae_r === undefined ? null : Number(row.sampled_mae_r),
    peakTotalPnlUsd: row.peak_total_pnl_usd === null || row.peak_total_pnl_usd === undefined ? null : Number(row.peak_total_pnl_usd),
    peakPnlAt: row.peak_pnl_at ? toIsoZ(row.peak_pnl_at as string) : null,
    givebackFloorR: row.giveback_floor_r === null || row.giveback_floor_r === undefined ? null : Number(row.giveback_floor_r),
    highWaterTrackedFrom: row.high_water_tracked_from ? toIsoZ(row.high_water_tracked_from as string) : null,
  })
}
