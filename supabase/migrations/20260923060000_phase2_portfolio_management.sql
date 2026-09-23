-- ============================================================================
-- Phase 2 (2026-09-22/23) — "Jev as a portfolio-management decision layer."
--
-- Expands the model's mandate from a pure entry-veto (trading-strategy-
-- v1.md §11-12, unchanged) to managing existing BTC/ETH positions:
-- HOLD/ADD/REDUCE/CLOSE/MODIFY_PROTECTION. Deterministic code remains the
-- sole authority over final size and price — Jev proposes a bounded
-- intent/magnitude; the risk gate (src/shared/risk/gate.ts) computes and
-- validates everything that actually executes. See the approved migration
-- plan for the full design; this file is the minimum schema/RPC surface
-- it requires.
--
-- Still one net position per asset (positions_one_open_per_asset_idx,
-- untouched) — ADD/REDUCE mutate the ONE open row, never insert a second.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- agent_decisions.action / trades.intent — widen the valid-value sets.
-- Postgres has no ALTER CONSTRAINT for a CHECK body — drop and re-add,
-- same pattern position_model.sql and trading_strategy_v1.sql both used.
-- ---------------------------------------------------------------------------

alter table public.agent_decisions drop constraint agent_decisions_action_valid;
alter table public.agent_decisions add constraint agent_decisions_action_valid
  check (action in ('OPEN_LONG', 'OPEN_SHORT', 'HOLD', 'CLOSE', 'ADD', 'REDUCE', 'MODIFY_PROTECTION'));

-- CLOSE_LONG/CLOSE_SHORT stay reserved for the FINAL close of a position —
-- trades_one_close_per_position_idx (a UNIQUE index, untouched by this
-- migration) keeps its exact pre-Phase-2 meaning: at most one close-trade
-- per position, ever. A partial exit is ADD_*/REDUCE_*, never CLOSE_* —
-- this is precisely what makes partial exits representable without
-- touching that index at all.
alter table public.trades drop constraint trades_intent_valid;
alter table public.trades add constraint trades_intent_valid
  check (intent in ('OPEN_LONG', 'OPEN_SHORT', 'CLOSE_LONG', 'CLOSE_SHORT', 'ADD_LONG', 'ADD_SHORT', 'REDUCE_LONG', 'REDUCE_SHORT'));

-- ADD/REDUCE are always agent-initiated (the position monitor only ever
-- closes, never adjusts) — they share OPEN's exact provenance shape:
-- decision_id required, trigger_reason null. Never the agent-close or
-- automatic-close shapes, which stay CLOSE_*-specific.
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
     and trigger_reason in ('stop_loss', 'take_profit', 'collateral_exhausted'))
);

-- ---------------------------------------------------------------------------
-- trades.realized_pnl — closes the one genuine accounting gap Phase 2
-- surfaces: positions_closed_fields forbids realized_pnl on an OPEN
-- position, so a partial realization (a REDUCE) has nowhere to live
-- today. NULL on OPEN/ADD (nothing realized); populated on REDUCE (the
-- realized portion only) and CLOSE (the full amount — see the
-- close_position_atomic change below for why CLOSE must populate this
-- too, not just REDUCE). Lifetime realized P&L for a position becomes
-- sum(trades.realized_pnl) for that position_id — positions.realized_pnl
-- keeps its own, unchanged meaning (the position's final close).
-- ---------------------------------------------------------------------------

alter table public.trades add column realized_pnl numeric(20, 8);

-- Backfill: every historical close trade's realized_pnl is exactly its
-- position's own realized_pnl — pre-Phase-2, there was ever only one
-- close per position (trades_one_close_per_position_idx), so this join
-- is unambiguous. Populates already-recorded truth; does not restate or
-- reinterpret anything. Skipped for any trade already carrying a value
-- (none exist yet, but the guard makes this migration safe to reason
-- about in isolation).
update public.trades t
set realized_pnl = p.realized_pnl
from public.positions p
where t.position_id = p.id
  and t.intent in ('CLOSE_LONG', 'CLOSE_SHORT')
  and t.realized_pnl is null;

comment on column public.trades.realized_pnl is
  'Realized P&L this specific trade booked — NULL for OPEN/ADD (nothing realized), populated for REDUCE (the reduced portion only) and CLOSE (the full amount). sum(realized_pnl) per position_id is the trustworthy lifetime-P&L source across an open->add->reduce->close lifecycle; positions.realized_pnl is unchanged and still means only the final close.';

-- ---------------------------------------------------------------------------
-- close_position_atomic — minimal change, no signature change: populate
-- the new realized_pnl column using the EXISTING p_realized_pnl
-- parameter (already used to set positions.realized_pnl; now also written
-- onto the trade row). Both existing callers (agent-cycle, position-
-- monitor) are untouched — this is a body-only change via CREATE OR
-- REPLACE, not a new function.
-- ---------------------------------------------------------------------------

create or replace function public.close_position_atomic(
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
  p_trigger_reason        text
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
  returning portfolio_id, asset into v_portfolio_id, v_asset;

  if not found then
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
    p_side, p_quantity, p_reference_price, p_fill_price, p_fee,
    p_slippage_cost, p_gross_value, p_net_cash_delta, v_cash_after,
    p_executed_at, p_intent, p_trigger_reason, p_realized_pnl
  );

  return query select true, v_cash_after;
end;
$$;

revoke all on function public.close_position_atomic from public, anon, authenticated;
grant execute on function public.close_position_atomic to service_role;

comment on function public.close_position_atomic is
  'Atomically closes an open position and records its trade (including realized_pnl on the trade row itself, Phase 2), or reports won_race=false if another caller already closed it first. The sole shared persistence path for any position close — trading-domain-contract.md §6.';

-- ---------------------------------------------------------------------------
-- adjust_position_atomic — the new RPC for ADD and REDUCE together (both
-- mutate quantity/entry_price/cost_basis on the SAME open row; REDUCE
-- simply passes back an unchanged entry_price, since a partial exit never
-- moves the average entry — broker/accounting.ts's reducePosition already
-- guarantees this in the caller's own math, not repeated here). No
-- accounting math happens in this function, same discipline as
-- open_position_atomic/close_position_atomic: the caller (broker/
-- accounting.ts's addToPosition/reducePosition, already risk-gate-
-- approved) has done it; this is persistence only.
--
-- Conditional on status = 'open', returning won_race — the exact same
-- race-safety shape close_position_atomic already uses, needed here for
-- the identical reason: the position monitor could close this position
-- between the gate's read and this call.
-- ---------------------------------------------------------------------------

create or replace function public.adjust_position_atomic(
  p_position_id     uuid,
  p_new_quantity    numeric,
  p_new_entry_price numeric,
  p_new_cost_basis  numeric,
  -- NULL for ADD (nothing realized); populated for REDUCE (the realized
  -- portion only) — mirrors trades.realized_pnl's own semantics exactly.
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
  p_decision_id     uuid
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
  set quantity    = p_new_quantity,
      entry_price = p_new_entry_price,
      cost_basis  = p_new_cost_basis
  where id = p_position_id
    and status = 'open'
  returning portfolio_id, asset into v_portfolio_id, v_asset;

  if not found then
    -- Lost the race: the monitor (or another path) closed this position
    -- first. No cash movement, no trade row — the caller discards its
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
  'Atomically ADDs to or REDUCEs an open position (quantity/entry_price/cost_basis + cash + trade row), or reports won_race=false if the position-monitor closed it first. Never inserts a second position row — mutates the one open row in place. Phase 2, 2026-09-22.';

-- ---------------------------------------------------------------------------
-- modify_protection_atomic — MODIFY_PROTECTION has no trade/cash effect,
-- just a position-field update the risk gate already fully validated
-- (ordering, configured bounds, exhaustion, and — for the stop — that it
-- never widens). No trade row: nothing was bought, sold, or realized.
-- ---------------------------------------------------------------------------

create or replace function public.modify_protection_atomic(
  p_position_id       uuid,
  p_stop_loss_price   numeric,
  p_take_profit_price numeric
)
returns table (won_race boolean)
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.positions
  set stop_loss_price   = p_stop_loss_price,
      take_profit_price = p_take_profit_price
  where id = p_position_id
    and status = 'open';

  if not found then
    return query select false;
    return;
  end if;

  return query select true;
end;
$$;

revoke all on function public.modify_protection_atomic from public, anon, authenticated;
grant execute on function public.modify_protection_atomic to service_role;

comment on function public.modify_protection_atomic is
  'Atomically updates an open position''s stop-loss/take-profit prices (both already validated by the risk gate — ordering, configured bounds, exhaustion, and that a stop never widens), or reports won_race=false if the position-monitor closed it first. No trade row and no cash effect. Phase 2, 2026-09-22.';

-- ---------------------------------------------------------------------------
-- agent_decisions — new provenance columns. Together with the existing
-- ones, these answer per row: what did Jev want, what did deterministic
-- code allow, and what actually happened. All nullable — null for every
-- pre-Phase-2 row and for any Phase-2 row where no management question
-- was ever asked (a FLAT asset's OPEN/HOLD path, which still uses only
-- the pre-existing veto columns).
-- ---------------------------------------------------------------------------

alter table public.agent_decisions
  add column proposed_action              text,
  add column proposed_action_confidence   numeric(5, 4),
  add column proposed_adjust_notional     numeric(20, 8),
  add column executed_adjust_notional     numeric(20, 8),
  add column stop_loss_price_before       numeric(20, 8),
  add column stop_loss_price_after        numeric(20, 8),
  add column take_profit_price_before     numeric(20, 8),
  add column take_profit_price_after      numeric(20, 8),
  add column protection_rejection_reason  text;

alter table public.agent_decisions
  add constraint agent_decisions_proposed_action_valid
    check (proposed_action is null or proposed_action in ('OPEN_LONG', 'OPEN_SHORT', 'HOLD', 'CLOSE', 'ADD', 'REDUCE', 'MODIFY_PROTECTION')),
  add constraint agent_decisions_proposed_action_confidence_range
    check (proposed_action_confidence is null or (proposed_action_confidence >= 0 and proposed_action_confidence <= 1)),
  add constraint agent_decisions_proposed_adjust_notional_nonneg
    check (proposed_adjust_notional is null or proposed_adjust_notional >= 0),
  add constraint agent_decisions_executed_adjust_notional_nonneg
    check (executed_adjust_notional is null or executed_adjust_notional >= 0),
  add constraint agent_decisions_stop_loss_price_before_positive
    check (stop_loss_price_before is null or stop_loss_price_before > 0),
  add constraint agent_decisions_stop_loss_price_after_positive
    check (stop_loss_price_after is null or stop_loss_price_after > 0),
  add constraint agent_decisions_take_profit_price_before_positive
    check (take_profit_price_before is null or take_profit_price_before > 0),
  add constraint agent_decisions_take_profit_price_after_positive
    check (take_profit_price_after is null or take_profit_price_after > 0);

-- ---------------------------------------------------------------------------
-- agent_settings — the provisional minimum-trade-notional floor (§4 of
-- the migration plan). Applies to ADD and a PARTIAL reduce only, never to
-- a full CLOSE. Both seeded PROVISIONAL, matching this project's
-- established pattern for un-tuned values (e.g. the original SL/TP
-- distance bounds, position_model.sql) — never described as validated.
-- min_trade_notional_usd = 25.00 per the migration plan's own proposal
-- (§18): the 1%-of-NAV floor binds at current NAV; this absolute
-- backstop only matters if NAV ever falls well below it.
-- ---------------------------------------------------------------------------

alter table public.agent_settings
  add column min_trade_notional_pct numeric(6, 4) not null default 0.0100,
  add column min_trade_notional_usd numeric(20, 8) not null default 25.00000000;

alter table public.agent_settings
  add constraint agent_settings_min_trade_notional_pct_range
    check (min_trade_notional_pct > 0 and min_trade_notional_pct <= 1),
  add constraint agent_settings_min_trade_notional_usd_nonneg
    check (min_trade_notional_usd >= 0);

comment on column public.agent_settings.min_trade_notional_pct is
  'PROVISIONAL (Phase 2, 2026-09-22/23) — the minimum ADD/partial-REDUCE notional, as a fraction of NAV. Never described as validated. A full CLOSE has no floor and is always permitted.';
comment on column public.agent_settings.min_trade_notional_usd is
  'PROVISIONAL (Phase 2, 2026-09-22/23) — absolute floor alongside min_trade_notional_pct; ADD requires max(pct*NAV, this), a partial REDUCE requires only pct*NAV. Seeded at $25 per the migration plan''s own proposal — confirm or adjust.';
