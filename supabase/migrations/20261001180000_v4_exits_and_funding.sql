-- ============================================================================
-- Strategy V4 — rest of §4 (2026-10-01): the two new intraday_ls-only
-- monitor exits (hard max hold, soft time stop) and perpetual funding on
-- short positions. Builds on 20261001150000 (the intraday_ls profile +
-- opportunity tracking) and 20260923180000 (the ruler/high-water columns
-- and atomic RPCs the giveback ratchet introduced).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. New settings
-- ---------------------------------------------------------------------------

alter table public.agent_settings
  add column short_funding_bps_per_day numeric not null default 3 check (short_funding_bps_per_day >= 0),
  add column time_stop_minutes int not null default 480 check (time_stop_minutes > 0),
  add column max_hold_minutes int not null default 1440 check (max_hold_minutes > 0);

comment on column public.agent_settings.short_funding_bps_per_day is 'Perpetual-funding rate charged on a SHORT position only (broker/accounting.ts''s computeFundingAccrual), expressed in bps/day. 3 (0.03%/day) is an explicit placeholder — verify against current perpetual funding rates before trusting any long-vs-short arm comparison (Strategy V4 plan §4.3). Never charged on a long.';
comment on column public.agent_settings.time_stop_minutes is 'Strategy V4 (intraday_ls) only — the soft time stop''s threshold: a position held this long with positionPnlR < 0.5 is closed (close_reason=''time_stop''). A position that has already proven itself (>= 0.5R) is exempt, even past this threshold.';
comment on column public.agent_settings.max_hold_minutes is 'Strategy V4 (intraday_ls) only — the hard max hold: a position held this long is force-closed (close_reason=''time_stop'') unconditionally, regardless of P&L. The absolute ceiling; time_stop_minutes above is the earlier, conditional one.';

-- ---------------------------------------------------------------------------
-- 2. New columns: positions (origination provenance + funding clock),
--    trades (funding cost charged on this trade)
-- ---------------------------------------------------------------------------

alter table public.positions
  add column opened_under_strategy_profile text
    check (opened_under_strategy_profile is null or opened_under_strategy_profile in ('balanced', 'aggressive', 'intraday_ls')),
  add column last_funding_accrual_at timestamptz;

comment on column public.positions.opened_under_strategy_profile is 'The strategy that ORIGINATED this position, frozen at open_position_atomic and never redefined — same immutable-at-origination discipline as initial_entry_price. Scopes the two intraday_ls-only monitor exits (hard max hold, soft time stop) to positions THIS strategy opened, deliberately never the currently-active global profile (unlike the giveback ratchet''s own EXIT, which does key on the active profile — see position-monitor/plan.ts for why that precedent does not generalize here). NULL for every position opened before this column existed, or where agent_decisions.strategy_version did not map to a known profile (ambiguous pre-profile rows) — never backfilled with a guess.';
comment on column public.positions.last_funding_accrual_at is 'Perpetual-funding accrual clock for a SHORT position (meaningless for a long, which never accrues). Set to opened_at at origination and advanced to the executed_at of every OPEN/ADD/REDUCE/CLOSE thereafter — funding settles on the whole open quantity at every event that changes it, not prorated per-trade, which is what prevents double-charging across more than one partial exit (Strategy V4 plan §4.3).';

alter table public.trades
  add column funding_cost numeric not null default 0 check (funding_cost >= 0);

comment on column public.trades.funding_cost is 'Perpetual-funding cost charged on THIS trade (always 0 for a long). A real, separate column, never folded into fee: fee is load-bearing elsewhere (partial_realized_pnl_usd''s own net-of-fee derivation), and overloading it would make it mean two things at exactly the point that precision was hard-won for the giveback ratchet (Strategy V4 plan §4.3).';

-- ---------------------------------------------------------------------------
-- 3. time_stop as a new, monitor-legal close reason
-- ---------------------------------------------------------------------------

alter table public.positions drop constraint positions_close_reason_valid;
alter table public.positions add constraint positions_close_reason_valid check (
  close_reason is null or close_reason in
  ('agent_close', 'stop_loss', 'take_profit', 'collateral_exhausted', 'profit_giveback', 'time_stop')
);

alter table public.trades drop constraint trades_trigger_reason_valid;
alter table public.trades add constraint trades_trigger_reason_valid check (
  trigger_reason is null or trigger_reason in
  ('agent_close', 'stop_loss', 'take_profit', 'collateral_exhausted', 'profit_giveback', 'time_stop')
);

alter table public.trades drop constraint trades_provenance_valid;
alter table public.trades add constraint trades_provenance_valid check (
     (intent in ('OPEN_LONG', 'OPEN_SHORT', 'ADD_LONG', 'ADD_SHORT', 'REDUCE_LONG', 'REDUCE_SHORT')
        and decision_id is not null and trigger_reason is null)
  or (intent in ('CLOSE_LONG', 'CLOSE_SHORT') and decision_id is not null and trigger_reason = 'agent_close')
  or (intent in ('CLOSE_LONG', 'CLOSE_SHORT') and decision_id is null
        and trigger_reason in ('stop_loss', 'take_profit', 'collateral_exhausted', 'profit_giveback', 'time_stop'))
);

-- ---------------------------------------------------------------------------
-- 4. open_position_atomic — signature change (new p_strategy_profile
--    param), so this is an explicit drop + create, same discipline the
--    2026-09-23 migration used for adjust/close.
-- ---------------------------------------------------------------------------

drop function if exists public.open_position_atomic(
  uuid, uuid, text, text, numeric, numeric, numeric, numeric, numeric,
  timestamptz, uuid, uuid, text, numeric, numeric, numeric, numeric,
  numeric, numeric, timestamptz, text, uuid
);

create function public.open_position_atomic(
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
  p_decision_id           uuid,
  -- Strategy V4 (2026-10-01) — the strategy that originated this
  -- position, frozen here, never redefined (positions.opened_under_
  -- strategy_profile's own column comment). Required, not optional: every
  -- caller already knows its own active profile at open time.
  p_strategy_profile      text
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
    high_water_tracked_from, opened_under_strategy_profile, last_funding_accrual_at
  ) values (
    p_position_id, p_portfolio_id, p_asset, p_direction, p_quantity, p_entry_price, p_cost_basis,
    p_stop_loss_price, p_take_profit_price, 'open', p_opened_at, p_opened_by_decision_id,
    p_entry_price, p_stop_loss_price, p_quantity * abs(p_entry_price - p_stop_loss_price),
    p_opened_at, p_strategy_profile, p_opened_at
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
    executed_at, intent, trigger_reason, funding_cost
  ) values (
    p_trade_id, p_portfolio_id, p_decision_id, p_position_id, p_asset,
    p_side, p_quantity, p_reference_price, p_fill_price, p_fee,
    p_slippage_cost, p_gross_value, p_net_cash_delta, v_cash_after,
    p_executed_at, p_intent, null, 0
  );

  return query select v_cash_after;
end;
$$;

revoke all on function public.open_position_atomic from public, anon, authenticated;
grant execute on function public.open_position_atomic to service_role;

comment on function public.open_position_atomic is
  'Atomically opens a new position and records its opening trade. Since 2026-10-01, also persists opened_under_strategy_profile and starts the funding-accrual clock (last_funding_accrual_at), atomically with creation, same as the ruler/high-water columns already were.';

-- ---------------------------------------------------------------------------
-- 5. adjust_position_atomic — signature change (new trailing optional
--    p_funding_cost), explicit drop + create.
-- ---------------------------------------------------------------------------

drop function if exists public.adjust_position_atomic(
  uuid, numeric, numeric, numeric, numeric, uuid, text, numeric, numeric,
  numeric, numeric, numeric, numeric, numeric, timestamptz, text, uuid, numeric
);

create function public.adjust_position_atomic(
  p_position_id     uuid,
  p_new_quantity    numeric,
  p_new_entry_price numeric,
  p_new_cost_basis  numeric,
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
  p_partial_realized_pnl_delta numeric default null,
  -- Strategy V4 (2026-10-01) — the perpetual-funding cost charged on THIS
  -- add/reduce (0 for a long, or for any pre-V4 caller that never
  -- computes one — broker/accounting.ts's computeFundingAccrual already
  -- defaults to 0). last_funding_accrual_at always advances to
  -- p_executed_at regardless of this value, per "settles at every event
  -- that changes quantity" (plan §4.3) — the clock resets on every ADD
  -- and REDUCE, not just when funding happened to be nonzero.
  p_funding_cost    numeric default null
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
      partial_realized_pnl_usd  = partial_realized_pnl_usd + coalesce(p_partial_realized_pnl_delta, 0),
      last_funding_accrual_at   = p_executed_at
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
    executed_at, intent, trigger_reason, realized_pnl, funding_cost
  ) values (
    p_trade_id, v_portfolio_id, p_decision_id, p_position_id, v_asset,
    p_side, p_trade_quantity, p_reference_price, p_fill_price, p_fee,
    p_slippage_cost, p_gross_value, p_net_cash_delta, v_cash_after,
    p_executed_at, p_intent, null, p_realized_pnl, coalesce(p_funding_cost, 0)
  );

  return query select true, v_cash_after;
end;
$$;

revoke all on function public.adjust_position_atomic from public, anon, authenticated;
grant execute on function public.adjust_position_atomic to service_role;

comment on function public.adjust_position_atomic is
  'Atomically ADDs to or REDUCEs an open position (quantity/entry_price/cost_basis + cash + trade row), or reports won_race=false if the position-monitor closed it first. Since 2026-10-01, also persists funding_cost on the trade row and advances last_funding_accrual_at to executed_at on every call, regardless of direction.';

-- ---------------------------------------------------------------------------
-- 6. close_position_atomic — signature change (new trailing optional
--    p_funding_cost), explicit drop + create.
-- ---------------------------------------------------------------------------

drop function if exists public.close_position_atomic(
  uuid, timestamptz, numeric, text, uuid, uuid, text, numeric, numeric,
  numeric, numeric, numeric, numeric, numeric, timestamptz, text, uuid, text, numeric
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
  p_expected_quantity     numeric default null,
  -- Strategy V4 (2026-10-01) — the perpetual-funding cost charged on this
  -- closing trade (0 for a long).
  p_funding_cost          numeric default null
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
    executed_at, intent, trigger_reason, realized_pnl, funding_cost
  ) values (
    p_trade_id, v_portfolio_id, p_decision_id, p_position_id, v_asset,
    p_side, p_quantity, p_reference_price, p_fill_price, p_fee,
    p_slippage_cost, p_gross_value, p_net_cash_delta, v_cash_after,
    p_executed_at, p_intent, p_trigger_reason, p_realized_pnl, coalesce(p_funding_cost, 0)
  );

  return query select true, v_cash_after;
end;
$$;

revoke all on function public.close_position_atomic from public, anon, authenticated;
grant execute on function public.close_position_atomic to service_role;

comment on function public.close_position_atomic is
  'Atomically closes an open position and records its closing trade, or reports won_race=false if another path (ADD/REDUCE changing quantity, or a second close) already invalidated the snapshot this close was computed from. p_expected_quantity (2026-09-23) guards the giveback and (2026-10-01) the two time-based exits; every other caller passes null, matching status=''open'' alone. Since 2026-10-01, also persists funding_cost on the trade row.';

-- ---------------------------------------------------------------------------
-- 7. Guarded backfill — existing rows only, never a guess beyond what
--    agent_decisions.strategy_version directly maps to.
-- ---------------------------------------------------------------------------

update public.positions p
set opened_under_strategy_profile = case ad.strategy_version
  when 'v1-regime' then 'balanced'
  when 'v3-jev-intraday-30m' then 'aggressive'
  else null
end
from public.agent_decisions ad
where p.opened_by_decision_id = ad.id
  and p.opened_under_strategy_profile is null;

update public.positions
set last_funding_accrual_at = opened_at
where last_funding_accrual_at is null;
