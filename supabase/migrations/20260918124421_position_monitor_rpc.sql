-- ============================================================================
-- Position-monitor persistence — Step 5 of the position-model plan.
--
-- Two things: (1) close_position_atomic, the single atomic-persistence
-- primitive for closing a position, shared by the position monitor (this
-- step) and, later, the agent cycle's own CLOSE handling (Step 7) — one
-- owner, never two implementations of the same conditional-close logic
-- (invariant 12); (2) the pg_cron schedule that invokes the monitor Edge
-- Function every agent_settings.monitor_interval_minutes.
--
-- Source of truth: context/specs/trading-domain-contract.md §5 (data
-- sufficiency, fill-price policy) and §6 (the concurrent-close race this
-- function exists to resolve).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- close_position_atomic
--
-- The caller (position-monitor/index.ts, and later the agent cycle) has
-- already run the pure accounting math (broker/accounting.ts's
-- closePosition) against its own read of the position and portfolio cash.
-- This function does NOT repeat that math — duplicating it here would mean
-- two implementations of the same formulas that could silently drift
-- (invariant 12). Its only two jobs:
--
--   1. Conditionally close the position — `WHERE status = 'open'` inside
--      this same transaction, not a separate prior read — so a second
--      caller racing to close the same position (the agent cycle vs. this
--      monitor, trading-domain-contract.md §6) reliably loses rather than
--      double-executing. Postgres's row-level MVCC makes a single
--      `UPDATE ... WHERE` statement atomic across concurrent callers with
--      no extra locking required.
--
--   2. Apply the trade's net_cash_delta to portfolios.cash by a fresh
--      read-modify-write (`cash = cash + delta`) inside this same
--      transaction, rather than trusting whatever `cash_after` the caller
--      pre-computed from its own (possibly now-stale) read of cash. cash is
--      shared across every asset in the portfolio, so two trades on
--      different assets executing around the same moment could otherwise
--      race on it; reading fresh and applying a delta atomically avoids
--      that for free, without needing a broader locking scheme the
--      contract doc never asked for. The returned cash_after is what
--      actually got persisted, not a prediction.
--
-- Returns won_race = false (and no other effect) when the position was
-- already closed by the other path — the caller discards its computed
-- trade and logs a no-op rather than treating this as an error.
--
-- security invoker (the default) rather than definer: the only intended
-- caller is the service-role key, which already bypasses RLS and holds
-- full table grants by default in every Supabase project, so there is no
-- privilege gap for definer semantics to bridge — and invoker avoids the
-- well-known definer-function privilege-escalation footgun entirely,
-- rather than needing to be trusted not to fall into it.
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
    -- Lost the race: another path already closed this position. No cash
    -- movement, no trade row — the caller is responsible for logging this
    -- as a no-op, not retrying or treating it as failure.
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
  'Atomically closes an open position and records its trade, or reports won_race=false if another caller already closed it first. The sole shared persistence path for any position close — trading-domain-contract.md §6.';

-- ---------------------------------------------------------------------------
-- pg_cron schedule — invokes the position-monitor Edge Function every
-- agent_settings.monitor_interval_minutes (10, by default; this schedule
-- string is not itself read from that column — pg_cron has no
-- table-driven schedule input, so changing the interval requires a new
-- migration that reschedules this job, same as changing the decision
-- cycle's own cadence will).
--
-- The function URL and the service-role key are read from Vault BY NAME,
-- never hardcoded here — consistent with how every other secret in this
-- project is handled (.env is gitignored; the service-role key has never
-- been written to a tracked file). The actual `vault.create_secret(...)`
-- calls with real values are a one-time manual step against the live
-- project, run once outside of any tracked migration (documented in
-- progress-tracker.md), not part of this file.
--
-- service_role_key is deliberately named generically, not
-- monitor-specific: Step 7's decision-cycle cron job will need the exact
-- same secret for the exact same purpose (authenticating a pg_cron-
-- initiated call to an Edge Function), so this avoids a confusing
-- duplicate secret later.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

select cron.schedule(
  'position-monitor-10min',
  '*/10 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'position_monitor_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body    := '{}'::jsonb
  );
  $$
);

comment on extension pg_cron is
  'Schedules position-monitor-10min (this migration) and, from Step 7 onward, the 3-hour decision cycle.';
