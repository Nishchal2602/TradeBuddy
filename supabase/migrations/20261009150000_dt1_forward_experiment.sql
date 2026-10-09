-- DT-1 forward paper experiment (2026-10-09) — user decision (option 3):
-- run DT-1's historical analysis as an explicitly underpowered research
-- exercise WHILE starting a parallel 5-day forward paper-trading test of
-- R4's exact daily-trend config, live, on BTC/ETH only.
--
-- Deliberately ISOLATED from agent-cycle/position-monitor/cycle-dispatcher:
-- no new StrategyProfile, no new branch in index.ts, no interaction with
-- the champion or any EXP-1 test account. A single new, standalone Edge
-- Function (dt1-forward-runner) owns both the daily regime decision AND
-- its own 10-minute protection check (stop-loss/take-profit), reusing the
-- SAME pure strategy/risk/broker functions R4's own backtest engine calls
-- (strategy/rules.ts, strategy/regime.ts, src/shared/risk/gate.ts,
-- broker/accounting.ts, position-monitor/triggers.ts) — never a second
-- implementation of the strategy.
--
-- Two single-asset portfolios, mirroring EXACTLY how R4 itself backtested
-- BTC and ETH (research/baseline-daily-trend.ts's own per-asset sleeve
-- design, plan DT-1 §5.4): a shared-NAV combined portfolio would newly
-- activate portfolio_risk/total_notional caps R4's own per-asset runs
-- never exercised, silently changing sizing. $10,000 each, matching
-- R4_DAILY_TREND_CONFIG.risk.startingCapitalUsd exactly.

insert into public.portfolios (name, starting_capital, cash, is_test, label)
values
  ('DT-1 Forward (BTC, daily-trend)', 10000, 10000, true, 'dt1-forward-btc'),
  ('DT-1 Forward (ETH, daily-trend)', 10000, 10000, true, 'dt1-forward-eth');

-- Audit trail for the forward runner's own two kinds of event: a daily
-- regime decision (HOLD/OPEN_LONG/CLOSE via regime flip) and an automatic
-- protection exit (stop_loss/take_profit), checked independently and
-- tracked as two different decision_kind values so "has today's regime
-- decision already run" can be queried without conflating it with a
-- same-day stop-out. Deliberately NOT agent_decisions: that table's
-- schema is shaped around the Jev candidate/veto/management model this
-- strategy never touches (R4 makes zero model calls, by design — see
-- daily-trend-presets.ts) and reusing it would mean writing a wall of
-- always-null Jev columns for no benefit. trades.decision_id DOES still
-- reference a real agent_decisions row for provenance (trades_provenance_
-- valid requires it for every OPEN/ADD/REDUCE and for an agent_close) —
-- this table is the human-readable layer on top, not a replacement for it.
create table public.dt1_forward_decisions (
  id                   uuid primary key default gen_random_uuid(),
  portfolio_id         uuid not null references public.portfolios(id) on delete cascade,
  asset                text not null,
  run_date             date not null, -- UTC calendar date this row's regime decision covers (null for a pure protection-exit row's own run_date would still be today's date, see constraint below)
  decision_kind        text not null check (decision_kind in ('daily_regime', 'protection_exit')),

  regime               text check (regime in ('UP', 'DOWN')), -- null for a protection_exit row
  daily_close          numeric,
  daily_ma             numeric,
  atr_pct              numeric,

  action               text not null check (action in ('OPEN_LONG', 'HOLD', 'CLOSE')),
  close_trigger        text check (close_trigger in ('stop_loss', 'take_profit', 'agent_close')),

  stop_loss_price      numeric,
  take_profit_price    numeric,
  approved_size_pct    numeric,
  risk_status          text not null,
  risk_reason          text,

  strategy_config_hash text not null,
  position_id          uuid references public.positions(id) on delete set null,
  decided_at           timestamptz not null default now()
);

-- One daily_regime row per (portfolio, asset, day) — a plain partial
-- unique index rather than an EXCLUDE constraint, since EXCLUDE on plain
-- equality needs the btree_gist extension and a unique index does the
-- identical job without it. This is the exact gate the runner uses to
-- decide whether to re-evaluate the regime on a given tick.
-- protection_exit rows are NOT subject to this uniqueness — a stop and a
-- later re-entry's own eventual exit can both land same-day.
create unique index dt1_forward_decisions_one_regime_per_day
  on public.dt1_forward_decisions (portfolio_id, asset, run_date)
  where (decision_kind = 'daily_regime');

alter table public.dt1_forward_decisions enable row level security;

create policy "dt1_forward_decisions_anon_read"
  on public.dt1_forward_decisions for select
  to anon
  using (true);

comment on table public.dt1_forward_decisions is
  'Audit trail for the standalone DT-1 forward paper-trading runner (2026-10-09) — isolated from agent-cycle/position-monitor. See dt1-forward-runner/index.ts.';
