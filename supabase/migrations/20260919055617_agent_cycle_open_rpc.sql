-- ============================================================================
-- open_position_atomic — Step 7 of the position-model plan.
--
-- Symmetric counterpart to close_position_atomic (20260918124421), but
-- deliberately simpler: opening has no equivalent of the monitor-vs-agent
-- concurrent-close race (trading-domain-contract.md §6 — "OPEN_* has no
-- equivalent race: overlapping agent cycles are already prevented by the
-- agent_runs idempotency key, and the monitor never opens positions"). So
-- this function does not need a conditional "did I win the race" check —
-- it inserts position + trade and applies the cash delta unconditionally,
-- inside one transaction. positions_one_open_per_asset_idx remains the
-- DB-level backstop if that assumption is ever wrong; a violation there
-- surfaces as a genuine Postgres error, not a designed "lost race, no-op"
-- outcome the way close_position_atomic's status check is.
--
-- Same reasoning as close_position_atomic for the two real jobs this
-- function has: (1) persist exactly what the caller's own pure
-- accounting (broker/accounting.ts's openPosition) already computed —
-- no accounting math lives here — and (2) apply net_cash_delta via a
-- fresh `cash = cash + delta` read-modify-write rather than trusting a
-- pre-computed cash_after, so this is safe even if a different asset's
-- trade is executing around the same moment.
--
-- security invoker, not definer, for the same reason as
-- close_position_atomic: the only caller is the service-role key, which
-- already bypasses RLS and holds full table grants by default.
-- ============================================================================
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
    stop_loss_price, take_profit_price, status, opened_at, opened_by_decision_id
  ) values (
    p_position_id, p_portfolio_id, p_asset, p_direction, p_quantity, p_entry_price, p_cost_basis,
    p_stop_loss_price, p_take_profit_price, 'open', p_opened_at, p_opened_by_decision_id
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

revoke all on function public.open_position_atomic from public, anon, authenticated;
grant execute on function public.open_position_atomic to service_role;

comment on function public.open_position_atomic is
  'Atomically opens a new position and records its opening trade. No race guard needed (trading-domain-contract.md §6: the monitor never opens, and agent_runs idempotency prevents overlapping decision cycles) — positions_one_open_per_asset_idx is a DB-level backstop, not the primary mechanism.';
