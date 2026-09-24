-- ============================================================================
-- Aggressive V3.1 — profit recycling and giveback protection (2026-09-23).
--
-- Follows the first live Aggressive observation, which surfaced that the
-- strategy's entire profit-protection mechanism was structurally inert:
-- the pre-registered +1.5R profit-locking stop could never be persisted
-- (it requires stop_loss_price > entry_price, which
-- positions_sl_tp_ordering_valid forbids for a long), no high-water state
-- existed anywhere, and R was only ever sampled at manual decision
-- cycles. See the approved migration plan for the full diagnosis; this
-- file is the schema/RPC surface the fix requires.
--
-- Two R metrics, never conflated (plan §3.1):
--   priceR       — market-path distance from the original entry. Context
--                  only, never a profit statement.
--   positionPnlR — (unrealizedPnlUsd + partialRealizedPnlUsd) /
--                  initialRiskUsd. The ECONOMIC metric. Drives every
--                  giveback decision.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- positions — the immutable ruler triple (initial_risk_usd already exists,
-- added 2026-09-23 by 20260923150000), the resize-neutral P&L
-- accumulator, and monitor-sampled high-water state.
-- ---------------------------------------------------------------------------

alter table public.positions
  add column initial_entry_price      numeric(20, 8),
  add column initial_stop_loss_price  numeric(20, 8),
  add column partial_realized_pnl_usd numeric(20, 8) not null default 0,
  add column sampled_mfe_r            numeric(10, 4),
  add column sampled_mae_r            numeric(10, 4),
  add column peak_total_pnl_usd       numeric(20, 8),
  add column peak_pnl_at              timestamptz,
  add column giveback_floor_r         numeric(10, 4),
  add column high_water_tracked_from  timestamptz;

alter table public.positions
  add constraint positions_initial_entry_price_positive
    check (initial_entry_price is null or initial_entry_price > 0),
  add constraint positions_initial_stop_loss_price_positive
    check (initial_stop_loss_price is null or initial_stop_loss_price > 0),
  add constraint positions_sampled_mfe_mae_ordering
    check (sampled_mfe_r is null or sampled_mae_r is null or sampled_mfe_r >= sampled_mae_r),
  add constraint positions_giveback_floor_r_positive
    check (giveback_floor_r is null or giveback_floor_r > 0),
  add constraint positions_high_water_tracked_from_not_before_open
    check (high_water_tracked_from is null or high_water_tracked_from >= opened_at);

comment on column public.positions.initial_entry_price is
  'Entry price AT ORIGINAL ENTRY, captured once and never updated by ADD/REDUCE -- half of the immutable ruler (with initial_stop_loss_price) that priceR and positionPnlR are both computed against. Null for every position opened before 2026-09-23 unless guard-backfilled below.';

comment on column public.positions.initial_stop_loss_price is
  'Stop-loss price AT ORIGINAL ENTRY, captured once and never updated by ADD/REDUCE or by deterministic tightening. Together with initial_entry_price this is riskPerUnit0 = |initial_entry_price - initial_stop_loss_price|, the fixed denominator unit both R metrics use.';

comment on column public.positions.partial_realized_pnl_usd is
  'Cumulative realized P&L from every REDUCE on this position''s life, NET of the fee each reduce actually paid (slippage is already embedded via fillPrice) -- deliberately NOT the same figure as trades.realized_pnl/positions.realized_pnl, which stay gross, matching this codebase''s existing convention of reporting P&L and fees as separate line items. This column feeds positionPnlR, the economic figure the giveback ratchet protects -- a sunk, already-paid fee must reduce it, or repeated REDUCEs would silently overstate protected profit. Never from the final CLOSE, which has its own realized_pnl column. Not null, defaults 0 -- true for every position today since no REDUCE has ever executed. This is what makes positionPnlR = (unrealizedPnlUsd + partial_realized_pnl_usd) / initial_risk_usd continuous across a REDUCE: without it, a deliberate profit harvest would misreport as giveback.';

comment on column public.positions.sampled_mfe_r is
  'Running MAXIMUM of positionPnlR over the position''s life, SAMPLED at each position-monitor tick (not a guaranteed market maximum -- see sampled_mae_r and the naming discipline this mirrors, e.g. coingecko intraday sampledDayHighPct). Null until high_water_tracked_from is set. Drives the giveback ratchet (plan §5.1) -- never priceR.';

comment on column public.positions.sampled_mae_r is
  'Running MINIMUM of positionPnlR over the position''s life, sampled the same way as sampled_mfe_r. Analytics/context only -- the giveback ratchet keys on sampled_mfe_r, not this.';

comment on column public.positions.peak_total_pnl_usd is
  'USD-denominated peak of (unrealizedPnlUsd + partial_realized_pnl_usd), for portfolio analytics alongside sampled_mfe_r. Quantity-dependent (unlike the R metrics) -- not comparable across an ADD/REDUCE boundary on its own.';

comment on column public.positions.peak_pnl_at is
  'Timestamp sampled_mfe_r/peak_total_pnl_usd were last raised -- lets analysis compute time_from_peak_to_current.';

comment on column public.positions.giveback_floor_r is
  'The armed profit-giveback ratchet floor, in positionPnlR units -- null until sampled_mfe_r first reaches 1.0R. MONOTONE: only ever raised, never lowered, so a later decline in sampled_mfe_r cannot unlock it. Aggressive-only in practice (plan §3.7: the monitor gates the EXIT on the active profile, not this column), but sampled/armed identically regardless of profile so a switch back to Aggressive resumes with intact history.';

comment on column public.positions.high_water_tracked_from is
  'Timestamp high-water sampling began for this position -- set to opened_at atomically by open_position_atomic for every NEW position (2026-09-23 onward). NULL means "never tracked" and is the sole eligibility gate for profit_giveback (plan §5.5): a position whose true historical peak predates this column must never participate, since a monitor starting now would record a badly understated MFE.';

-- ---------------------------------------------------------------------------
-- agent_decisions — both R metrics (never collapsed into one column, per
-- plan §3.1/§6), profit-state fields, and the normalization-reason column
-- that resolves the four-way "did the model choose this, or did
-- deterministic code silently change it" disambiguation the diagnosis
-- showed was previously impossible without hand-parsing output_payload.
-- ---------------------------------------------------------------------------

alter table public.agent_decisions
  add column position_pnl_r             numeric(10, 4),
  add column price_r                    numeric(10, 4),
  add column sampled_mfe_r              numeric(10, 4),
  add column giveback_r                 numeric(10, 4),
  add column minutes_since_entry        numeric(10, 2),
  add column action_normalization_reason text;

alter table public.agent_decisions
  add constraint agent_decisions_giveback_r_nonneg
    check (giveback_r is null or giveback_r >= 0),
  add constraint agent_decisions_minutes_since_entry_nonneg
    check (minutes_since_entry is null or minutes_since_entry >= 0),
  add constraint agent_decisions_action_normalization_reason_valid check (
    action_normalization_reason is null or action_normalization_reason in (
      -- Jev chose MODIFY_PROTECTION but both stopIntent and targetIntent
      -- resolved to KEEP (apply-management.ts's existing normalization,
      -- now named) -- the live ETH case: proposed_action='MODIFY_PROTECTION',
      -- action='HOLD', risk_status='not_applicable', and until this column
      -- existed, indistinguishable from Jev genuinely choosing HOLD.
      'modify_protection_noop_both_intents_keep',
      -- An ADD/REDUCE the gate approved in principle but sized below the
      -- minimum trade notional floor -- pre-existing Phase 2 behavior
      -- (index.ts's not_applicable normalization), now named.
      'add_reduce_below_min_notional'
    )
  );

comment on column public.agent_decisions.position_pnl_r is
  'THE economic profit metric at decision time -- (unrealizedPnlUsd + partial_realized_pnl_usd) / initial_risk_usd. Aggressive-only, null for Balanced and for any row with no open position. Drives Jev''s reframed management question (plan §4.2) and is what the giveback ladder itself is denominated in.';

comment on column public.agent_decisions.price_r is
  'Market-path metric at decision time -- (price - initial_entry_price) / riskPerUnit0. Deliberately persisted SEPARATELY from position_pnl_r (never collapsed into one "R" column): after an ADD at a worse price the two can disagree, e.g. price_r positive while position_pnl_r is negative -- exactly the state a single conflated field would hide.';

comment on column public.agent_decisions.sampled_mfe_r is
  'positions.sampled_mfe_r as observed at decision time -- the high-water mark Jev''s reframed question quotes ("reached a best point of {sampledMfeR}R").';

comment on column public.agent_decisions.giveback_r is
  'max(0, sampled_mfe_r - position_pnl_r) at decision time -- how much of the best-ever gain has already been given back, in R units.';

comment on column public.agent_decisions.minutes_since_entry is
  'Minutes since positions.opened_at at decision time -- Aggressive-only context field (plan §4.1).';

comment on column public.agent_decisions.action_normalization_reason is
  'Why proposed_action differs from the final action, when it is not a gate rejection (risk_status already covers that case) -- the row the diagnosis showed was previously invisible. NULL means either the proposal executed as proposed, or no normalization applies (e.g. HOLD stayed HOLD).';

-- ---------------------------------------------------------------------------
-- close_reason / trigger_reason -- widen the shared vocabulary to include
-- 'profit_giveback', the new monitor-enforced exit (plan §5.1). Postgres
-- has no ALTER CONSTRAINT for a CHECK body -- drop and re-add, the same
-- pattern every prior widening in this project has used.
-- ---------------------------------------------------------------------------

alter table public.positions drop constraint positions_close_reason_valid;
alter table public.positions add constraint positions_close_reason_valid check (
  close_reason is null or close_reason in ('agent_close', 'stop_loss', 'take_profit', 'collateral_exhausted', 'profit_giveback')
);

comment on column public.positions.close_reason is
  'agent_close = closed by an OPEN_LONG/OPEN_SHORT/CLOSE decision; stop_loss/take_profit/collateral_exhausted/profit_giveback = closed automatically (stop_loss/take_profit/collateral_exhausted by the position monitor''s static bracket check; profit_giveback by the same monitor''s giveback ratchet, 2026-09-23 -- a discrete, pre-registered, monotone floor evaluated once per tick, NOT a continuously-trailing stop). Mirrors trades.trigger_reason for the trade that closed this position.';

alter table public.trades drop constraint trades_trigger_reason_valid;
alter table public.trades add constraint trades_trigger_reason_valid
  check (trigger_reason is null or trigger_reason in ('agent_close', 'stop_loss', 'take_profit', 'collateral_exhausted', 'profit_giveback'));

alter table public.trades drop constraint trades_provenance_valid;
alter table public.trades add constraint trades_provenance_valid check (
  (intent in ('OPEN_LONG', 'OPEN_SHORT', 'ADD_LONG', 'ADD_SHORT', 'REDUCE_LONG', 'REDUCE_SHORT')
     and decision_id is not null and trigger_reason is null)
  or
  (intent in ('CLOSE_LONG', 'CLOSE_SHORT')
     and decision_id is not null and trigger_reason = 'agent_close')
  or
  (intent in ('CLOSE_LONG', 'CLOSE_SHORT')
     and decision_id is null
     and trigger_reason in ('stop_loss', 'take_profit', 'collateral_exhausted', 'profit_giveback'))
);

-- ---------------------------------------------------------------------------
-- open_position_atomic -- same signature, extended body: the ruler triple
-- and high_water_tracked_from are now derived and persisted INSIDE this
-- function, atomically with position creation. Fixes the pre-existing gap
-- where initial_risk_usd was set by a follow-up UPDATE after this RPC
-- returned -- a crash between the two left a permanently null (and so
-- permanently untracked) ruler.
-- ---------------------------------------------------------------------------

create or replace function public.open_position_atomic(
  p_position_id           uuid,
  p_portfolio_id          uuid,
  p_asset                 text,
  p_direction             text,
  p_quantity              numeric,
  p_entry_price           numeric,
  p_cost_basis            numeric,
  p_stop_loss_price       numeric,
  p_take_profit_price     numeric,
  p_opened_at             timestamptz,
  p_opened_by_decision_id uuid,
  p_trade_id              uuid,
  p_side                  text,
  p_reference_price       numeric,
  p_fill_price            numeric,
  p_fee                   numeric,
  p_slippage_cost         numeric,
  p_gross_value           numeric,
  p_net_cash_delta        numeric,
  p_executed_at           timestamptz,
  p_intent                text,
  p_decision_id           uuid
)
returns table (cash_after numeric)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cash_after numeric;
begin
  insert into public.positions (
    id, portfolio_id, asset, direction, quantity, entry_price, cost_basis,
    stop_loss_price, take_profit_price, status, opened_at, opened_by_decision_id,
    initial_entry_price, initial_stop_loss_price, initial_risk_usd,
    high_water_tracked_from
  ) values (
    p_position_id, p_portfolio_id, p_asset, p_direction, p_quantity, p_entry_price, p_cost_basis,
    p_stop_loss_price, p_take_profit_price, 'open', p_opened_at, p_opened_by_decision_id,
    -- The ruler is set unconditionally for EVERY new position, Balanced or
    -- Aggressive -- plan §3.7: high-water state is sampled regardless of
    -- profile, and only the giveback EXIT is gated on the active profile
    -- at monitor-tick time. Balanced never reads any of these columns.
    p_entry_price, p_stop_loss_price, p_quantity * abs(p_entry_price - p_stop_loss_price),
    p_opened_at
  );

  update public.portfolios
  set cash       = cash + p_net_cash_delta,
      updated_at = now()
  where id = p_portfolio_id
  returning cash into v_cash_after;

  insert into public.trades (
    id, portfolio_id, decision_id, position_id, asset,
    side, quantity, reference_price, fill_price, fee,
    slippage_cost, gross_value, net_cash_delta, cash_after,
    executed_at, intent, trigger_reason
  ) values (
    p_trade_id, p_portfolio_id, p_decision_id, p_position_id, p_asset,
    p_side, p_quantity, p_reference_price, p_fill_price, p_fee,
    p_slippage_cost, p_gross_value, p_net_cash_delta, v_cash_after,
    p_executed_at, p_intent, null
  );

  return query select v_cash_after;
end;
$$;

comment on function public.open_position_atomic is
  'Atomically opens a new position and records its opening trade. No race guard needed (trading-domain-contract.md §6: the monitor never opens, and agent_runs idempotency prevents overlapping decision cycles) -- positions_one_open_per_asset_idx is a DB-level backstop, not the primary mechanism. Since 2026-09-23, also derives and persists the immutable R-ruler and high_water_tracked_from atomically with creation (aggressive profit-recycling plan §5.5).';

-- ---------------------------------------------------------------------------
-- adjust_position_atomic -- signature change (a new trailing optional
-- parameter), so this is an explicit drop + create rather than CREATE OR
-- REPLACE, which would otherwise silently create a second overloaded
-- function instead of replacing the first.
-- ---------------------------------------------------------------------------

drop function if exists public.adjust_position_atomic(
  uuid, numeric, numeric, numeric, numeric, uuid, text, numeric, numeric,
  numeric, numeric, numeric, numeric, numeric, timestamptz, text, uuid
);

create function public.adjust_position_atomic(
  p_position_id     uuid,
  p_new_quantity    numeric,
  p_new_entry_price numeric,
  p_new_cost_basis  numeric,
  -- NULL for ADD (nothing realized); populated for REDUCE (the realized
  -- portion only) -- mirrors trades.realized_pnl's own semantics exactly.
  p_realized_pnl    numeric,
  p_trade_id        uuid,
  p_side            text,
  p_trade_quantity  numeric,
  p_reference_price numeric,
  p_fill_price      numeric,
  p_fee             numeric,
  p_slippage_cost   numeric,
  p_gross_value     numeric,
  p_net_cash_delta  numeric,
  p_executed_at     timestamptz,
  p_intent          text,
  p_decision_id     uuid,
  -- Aggressive V3.1 (2026-09-23) -- NULL for ADD; the REDUCE-realized
  -- amount for REDUCE, ACCUMULATED (never replaced) into
  -- positions.partial_realized_pnl_usd, so positionPnlR stays correct
  -- across more than one partial exit over a position's life.
  p_partial_realized_pnl_delta numeric default null
)
returns table (won_race boolean, cash_after numeric)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_portfolio_id uuid;
  v_asset        text;
  v_cash_after   numeric;
begin
  update public.positions
  set quantity                 = p_new_quantity,
      entry_price              = p_new_entry_price,
      cost_basis                = p_new_cost_basis,
      partial_realized_pnl_usd  = partial_realized_pnl_usd + coalesce(p_partial_realized_pnl_delta, 0)
  where id = p_position_id
    and status = 'open'
  returning portfolio_id, asset into v_portfolio_id, v_asset;

  if not found then
    -- Lost the race: the monitor (or another path) closed this position
    -- first. No cash movement, no trade row -- the caller discards its
    -- computed adjust and logs a no-op, same as a lost close race.
    return query select false, null::numeric;
    return;
  end if;

  update public.portfolios
  set cash       = cash + p_net_cash_delta,
      updated_at = now()
  where id = v_portfolio_id
  returning cash into v_cash_after;

  insert into public.trades (
    id, portfolio_id, decision_id, position_id, asset,
    side, quantity, reference_price, fill_price, fee,
    slippage_cost, gross_value, net_cash_delta, cash_after,
    executed_at, intent, trigger_reason, realized_pnl
  ) values (
    p_trade_id, v_portfolio_id, p_decision_id, p_position_id, v_asset,
    p_side, p_trade_quantity, p_reference_price, p_fill_price, p_fee,
    p_slippage_cost, p_gross_value, p_net_cash_delta, v_cash_after,
    p_executed_at, p_intent, null, p_realized_pnl
  );

  return query select true, v_cash_after;
end;
$$;

revoke all on function public.adjust_position_atomic from public, anon, authenticated;
grant execute on function public.adjust_position_atomic to service_role;

comment on function public.adjust_position_atomic is
  'Atomically ADDs to or REDUCEs an open position (quantity/entry_price/cost_basis + cash + trade row), or reports won_race=false if the position-monitor closed it first. Never inserts a second position row -- mutates the one open row in place. Phase 2, 2026-09-22. Since 2026-09-23, a REDUCE also accumulates partial_realized_pnl_usd (p_partial_realized_pnl_delta), which is what keeps positionPnlR continuous across a partial exit.';

-- ---------------------------------------------------------------------------
-- close_position_atomic -- signature change (a new trailing optional
-- concurrency guard), so this is also an explicit drop + create.
-- ---------------------------------------------------------------------------

drop function if exists public.close_position_atomic(
  uuid, timestamptz, numeric, text, uuid, uuid, text, numeric, numeric,
  numeric, numeric, numeric, numeric, numeric, timestamptz, text, uuid, text
);

create function public.close_position_atomic(
  p_position_id           uuid,
  p_closed_at             timestamptz,
  p_realized_pnl          numeric,
  p_close_reason          text,
  p_closed_by_decision_id uuid,
  p_trade_id              uuid,
  p_side                  text,
  p_quantity              numeric,
  p_reference_price       numeric,
  p_fill_price            numeric,
  p_fee                   numeric,
  p_slippage_cost         numeric,
  p_gross_value           numeric,
  p_net_cash_delta        numeric,
  p_executed_at           timestamptz,
  p_intent                text,
  p_decision_id           uuid,
  p_trigger_reason        text,
  -- Aggressive V3.1 (2026-09-23) -- when non-null, the close is guarded on
  -- CURRENT quantity matching this value, not just status='open'. Every
  -- pre-existing caller (agent CLOSE, monitor stop_loss/take_profit)
  -- passes null and is unaffected. The one caller that passes a real
  -- value is the new profit_giveback exit (plan §5.3): between the
  -- monitor reading high-water state and this call, agent-cycle may have
  -- executed an ADD/REDUCE that changed the very quantity the giveback
  -- trigger was computed from -- status alone would not catch that, and a
  -- "deterministic protection" path must not act on stale economic state.
  p_expected_quantity     numeric default null
)
returns table (won_race boolean, cash_after numeric)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_portfolio_id uuid;
  v_asset        text;
  v_cash_after   numeric;
begin
  update public.positions
  set status                = 'closed',
      closed_at             = p_closed_at,
      realized_pnl          = p_realized_pnl,
      close_reason          = p_close_reason,
      closed_by_decision_id = p_closed_by_decision_id
  where id = p_position_id
    and status = 'open'
    and (p_expected_quantity is null or quantity = p_expected_quantity)
  returning portfolio_id, asset into v_portfolio_id, v_asset;

  if not found then
    -- Lost the race: another path already closed this position, OR (the
    -- new case) its quantity moved since the caller's snapshot. Either
    -- way: no cash movement, no trade row -- the caller is responsible
    -- for logging this as a no-op, not retrying or treating it as
    -- failure. A losing giveback race re-evaluates fresh next tick.
    return query select false, null::numeric;
    return;
  end if;

  update public.portfolios
  set cash       = cash + p_net_cash_delta,
      updated_at = now()
  where id = v_portfolio_id
  returning cash into v_cash_after;

  insert into public.trades (
    id, portfolio_id, decision_id, position_id, asset,
    side, quantity, reference_price, fill_price, fee,
    slippage_cost, gross_value, net_cash_delta, cash_after,
    executed_at, intent, trigger_reason
  ) values (
    p_trade_id, v_portfolio_id, p_decision_id, p_position_id, v_asset,
    p_side, p_quantity, p_reference_price, p_fill_price, p_fee,
    p_slippage_cost, p_gross_value, p_net_cash_delta, v_cash_after,
    p_executed_at, p_intent, p_trigger_reason
  );

  return query select true, v_cash_after;
end;
$$;

revoke all on function public.close_position_atomic from public, anon, authenticated;
grant execute on function public.close_position_atomic to service_role;

comment on function public.close_position_atomic is
  'Atomically closes an open position and records its trade, or reports won_race=false if another caller already closed it first OR (2026-09-23) its quantity no longer matches the caller''s p_expected_quantity snapshot. The sole shared persistence path for any position close -- trading-domain-contract.md §6.';

-- ---------------------------------------------------------------------------
-- One-time guarded backfill for positions opened before this migration.
-- Ruler only -- high_water_tracked_from is deliberately left NULL (plan
-- §5.5): these positions' true historical peak already happened before
-- any tracking existed, so starting a monitor today would record a
-- badly understated sampled_mfe_r and could arm or exit the giveback
-- ratchet on a false read. They remain permanently ineligible for
-- profit_giveback and continue under their existing SL/TP.
--
-- Guarded structurally, not just by out-of-band knowledge: a position is
-- only backfilled if NO agent_decisions row for it has ever recorded an
-- executed protection change (stop_loss_price_after is not null). Where
-- a stop genuinely has moved, the original entry/stop pair is
-- unrecoverable and initial_entry_price/initial_stop_loss_price/
-- initial_risk_usd must all stay NULL rather than being backfilled from
-- a value that is no longer the true origination point.
-- ---------------------------------------------------------------------------

update public.positions p
set
  initial_entry_price     = p.entry_price,
  initial_stop_loss_price = p.stop_loss_price,
  initial_risk_usd        = p.quantity * abs(p.entry_price - p.stop_loss_price)
where p.status = 'open'
  and p.initial_entry_price is null
  and not exists (
    select 1 from public.agent_decisions d
    where d.position_id = p.id
      and d.stop_loss_price_after is not null
  );
