-- ============================================================================
-- V0 initial schema — autonomous crypto paper-trading agent
--
-- Source of truth: context/architecture.md § Core Data Model, § Risk Gate,
-- § Paper Broker; context/code-standards.md § Data and Storage.
--
-- Conventions enforced here:
--   * All timestamps are timestamptz, stored UTC (code-standards.md).
--   * Money/prices/quantities are numeric (never float) — decimal-safe.
--   * Every table has RLS enabled with anon granted SELECT only; all writes
--     go through Edge Functions using the service-role key, which bypasses
--     RLS. The extension ships the public anon key and must never write.
--   * Every cycle is persisted, including HOLD and skipped cycles
--     (invariant 7), so agent_runs rows exist even when nothing traded.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- agent_settings — single-row configuration.
--
-- decision_interval_minutes is config rather than a hardcoded constant
-- (architecture.md § Scheduling). Three things derive from it: the pg_cron
-- schedule, the news lookback window, and the staleness threshold. Changing
-- the interval without moving the news window silently drops headlines that
-- fall in the gap, hence news_lookback_overlap_minutes as an explicit buffer.
--
-- The risk/capital dials (starting capital, min confidence, cooldown) are
-- deliberately NOT NULL with NO DEFAULT and no seed row in this migration:
-- progress-tracker.md lists them as open questions and forbids resolving them
-- by silently inventing values. Seed the row once those are decided.
-- ---------------------------------------------------------------------------
create table public.agent_settings (
  id                            smallint     primary key generated always as identity,
  singleton                     boolean      not null default true,

  decision_interval_minutes     integer      not null,
  news_lookback_overlap_minutes integer      not null,
  max_data_staleness_minutes    integer      not null,

  assets                        text[]       not null,

  starting_capital              numeric(20, 8) not null,
  max_position_pct              numeric(6, 4)  not null,
  fee_bps                       integer        not null,
  slippage_bps                  integer        not null,
  cooldown_minutes              integer        not null,

  -- The user picks a risk appetite; the deterministic risk gate derives its
  -- minimum-confidence threshold from it. Stored as the appetite rather than
  -- a raw number so there is a single source of truth and the extension's
  -- risk control has something meaningful to bind to (ui-context.md
  -- § Controls). The appetite -> threshold mapping is a pure function in
  -- src/shared/ so it can be tuned without a migration; the threshold that
  -- actually applied to a given decision is recorded on that decision
  -- (agent_decisions.effective_min_confidence), so tuning the mapping later
  -- never makes historical decisions unreadable.
  risk_appetite                 text         not null,

  is_paused                     boolean      not null default false,

  created_at                    timestamptz  not null default now(),
  updated_at                    timestamptz  not null default now(),

  constraint agent_settings_singleton_unique unique (singleton),
  constraint agent_settings_singleton_true   check (singleton is true),
  constraint agent_settings_interval_positive
    check (decision_interval_minutes > 0),
  constraint agent_settings_overlap_nonneg
    check (news_lookback_overlap_minutes >= 0),
  constraint agent_settings_staleness_positive
    check (max_data_staleness_minutes > 0),
  constraint agent_settings_assets_nonempty
    check (array_length(assets, 1) > 0),
  constraint agent_settings_capital_positive
    check (starting_capital > 0),
  constraint agent_settings_max_position_pct_range
    check (max_position_pct > 0 and max_position_pct <= 1),
  constraint agent_settings_fee_nonneg      check (fee_bps >= 0),
  constraint agent_settings_slippage_nonneg check (slippage_bps >= 0),
  constraint agent_settings_risk_appetite_valid
    check (risk_appetite in ('conservative', 'balanced', 'aggressive')),
  constraint agent_settings_cooldown_nonneg check (cooldown_minutes >= 0)
);

comment on table public.agent_settings is
  'Single-row agent configuration. The singleton column plus its unique + check constraints enforce exactly one row. Prompt/model versions are deliberately absent: they are execution-time facts recorded on agent_runs and agent_decisions, not user-tunable config.';

-- ---------------------------------------------------------------------------
-- portfolios — the paper portfolio. One row in V0.
-- ---------------------------------------------------------------------------
create table public.portfolios (
  id               uuid        primary key default gen_random_uuid(),
  name             text        not null,
  starting_capital numeric(20, 8) not null,
  cash             numeric(20, 8) not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint portfolios_starting_capital_positive check (starting_capital > 0),
  constraint portfolios_cash_nonneg               check (cash >= 0)
);

-- ---------------------------------------------------------------------------
-- news_items — ingested headlines. Untrusted data (invariant 9): stored as
-- plain text and delimited as data when rendered into the prompt, never
-- treated as instructions.
--
-- published_at vs ingested_at are both retained deliberately
-- (code-standards.md § API/Data Boundaries): the lag between them is the
-- measurement that tells us whether news is already priced in by the time
-- the agent sees it.
-- ---------------------------------------------------------------------------
create table public.news_items (
  id           uuid        primary key default gen_random_uuid(),
  external_id  text        not null,
  source       text        not null,
  headline     text        not null,
  summary      text,
  url          text,
  assets       text[]      not null default '{}',
  published_at timestamptz not null,
  ingested_at  timestamptz not null default now(),
  raw          jsonb,

  constraint news_items_external_id_unique unique (external_id)
);

create index news_items_published_at_idx on public.news_items (published_at desc);
create index news_items_assets_idx        on public.news_items using gin (assets);

comment on column public.news_items.external_id is
  'Stable provider-side identifier, used to dedupe across overlapping lookback windows.';

-- ---------------------------------------------------------------------------
-- agent_runs — one row per cycle attempt, including skipped ones.
--
-- idempotency_key is unique: a retry of the same scheduled cycle must not
-- create a second run or duplicate trades (invariant 10).
-- ---------------------------------------------------------------------------
create table public.agent_runs (
  id               uuid        primary key default gen_random_uuid(),
  portfolio_id     uuid        not null references public.portfolios (id) on delete cascade,
  idempotency_key  text        not null,

  status           text        not null,
  skip_reason      text,
  error_detail     text,

  started_at       timestamptz not null default now(),
  completed_at     timestamptz,

  prompt_version   text,
  model_version    text,

  constraint agent_runs_idempotency_key_unique unique (idempotency_key),
  constraint agent_runs_status_valid check (
    status in ('running', 'completed', 'skipped', 'failed')
  ),
  -- A skipped run must say why; fail closed and legibly rather than silently.
  constraint agent_runs_skip_reason_present check (
    (status <> 'skipped') or (skip_reason is not null)
  )
);

create index agent_runs_portfolio_started_idx
  on public.agent_runs (portfolio_id, started_at desc);
create index agent_runs_status_idx on public.agent_runs (status);

-- ---------------------------------------------------------------------------
-- market_snapshots — the market state and deterministic indicators as of a
-- run. Indicators are computed in code and stored here (invariant 4); the
-- model never supplies authoritative indicator values.
-- ---------------------------------------------------------------------------
create table public.market_snapshots (
  id             uuid        primary key default gen_random_uuid(),
  run_id         uuid        not null references public.agent_runs (id) on delete cascade,
  asset          text        not null,

  price          numeric(20, 8) not null,
  change_1h_pct  numeric(10, 4),
  change_24h_pct numeric(10, 4),
  change_7d_pct  numeric(10, 4),

  indicators     jsonb       not null,
  recent_closes  jsonb       not null,

  provider       text        not null,
  data_as_of     timestamptz not null,
  ingested_at    timestamptz not null default now(),

  constraint market_snapshots_price_positive check (price > 0),
  constraint market_snapshots_run_asset_unique unique (run_id, asset)
);

create index market_snapshots_asset_as_of_idx
  on public.market_snapshots (asset, data_as_of desc);

comment on column public.market_snapshots.indicators is
  'Deterministically computed: RSI(14), EMA20, EMA50, MACD histogram, ATR%, volume ratio, distance from 7d high/low.';
comment on column public.market_snapshots.data_as_of is
  'Provider-reported timestamp for the data, distinct from ingested_at. Freshness checks use this.';

-- ---------------------------------------------------------------------------
-- agent_decisions — one row per asset per run, including HOLDs.
--
-- input_payload / output_payload store the exact serialized model I/O so a
-- decision can be replayed or re-graded later (invariant 8).
-- ---------------------------------------------------------------------------
create table public.agent_decisions (
  id                uuid        primary key default gen_random_uuid(),
  run_id            uuid        not null references public.agent_runs (id) on delete cascade,
  portfolio_id      uuid        not null references public.portfolios (id) on delete cascade,
  asset             text        not null,

  -- Model proposal
  action            text        not null,
  confidence        numeric(3, 2) not null,
  primary_driver    text        not null,
  proposed_size_pct numeric(6, 4),
  horizon_hours     integer,
  reasons           jsonb       not null default '[]'::jsonb,
  invalidation      jsonb       not null default '[]'::jsonb,
  cited_news_ids    uuid[]      not null default '{}',

  -- Risk-gate outcome. The gate records what it did; it must never silently
  -- turn an invalid proposal into an apparently valid one
  -- (architecture.md § Risk Gate).
  risk_status             text        not null,
  risk_reason             text,
  approved_size_pct       numeric(6, 4),
  -- The confidence threshold in force when this decision was gated, derived
  -- from agent_settings.risk_appetite at cycle time. Denormalised on purpose:
  -- it makes each decision self-describing even after the appetite or the
  -- mapping changes.
  effective_min_confidence numeric(3, 2) not null,

  -- Replay
  input_payload     jsonb       not null,
  output_payload    jsonb       not null,
  prompt_version    text        not null,
  model_version     text        not null,

  decided_at        timestamptz not null default now(),

  constraint agent_decisions_run_asset_unique unique (run_id, asset),
  constraint agent_decisions_action_valid
    check (action in ('BUY', 'SELL', 'HOLD')),
  constraint agent_decisions_driver_valid
    check (primary_driver in ('NEWS', 'TECHNICAL', 'BOTH', 'NONE')),
  constraint agent_decisions_risk_status_valid
    check (risk_status in ('approved', 'rejected', 'clamped', 'not_applicable')),
  constraint agent_decisions_confidence_range
    check (confidence >= 0 and confidence <= 1),
  constraint agent_decisions_proposed_size_range
    check (proposed_size_pct is null or (proposed_size_pct >= 0 and proposed_size_pct <= 1)),
  constraint agent_decisions_approved_size_range
    check (approved_size_pct is null or (approved_size_pct >= 0 and approved_size_pct <= 1)),
  constraint agent_decisions_effective_min_confidence_range
    check (effective_min_confidence >= 0 and effective_min_confidence <= 1),
  -- A rejection or a clamp must state a reason.
  constraint agent_decisions_risk_reason_present check (
    (risk_status not in ('rejected', 'clamped')) or (risk_reason is not null)
  ),
  constraint agent_decisions_reasons_is_array
    check (jsonb_typeof(reasons) = 'array'),
  constraint agent_decisions_invalidation_is_array
    check (jsonb_typeof(invalidation) = 'array')
);

create index agent_decisions_decided_at_idx
  on public.agent_decisions (decided_at desc);
create index agent_decisions_portfolio_decided_idx
  on public.agent_decisions (portfolio_id, decided_at desc);
create index agent_decisions_asset_decided_idx
  on public.agent_decisions (asset, decided_at desc);
create index agent_decisions_action_idx on public.agent_decisions (action);
create index agent_decisions_run_idx    on public.agent_decisions (run_id);

comment on column public.agent_decisions.invalidation is
  'Conditions that would falsify the thesis. Fed back into the next cycle so an open position is exited against its stated thesis rather than a freshly re-derived opinion.';

-- ---------------------------------------------------------------------------
-- positions — long-or-flat only in V0 (no shorts, no leverage).
-- ---------------------------------------------------------------------------
create table public.positions (
  id                    uuid        primary key default gen_random_uuid(),
  portfolio_id          uuid        not null references public.portfolios (id) on delete cascade,
  asset                 text        not null,

  quantity              numeric(28, 12) not null,
  entry_price           numeric(20, 8)  not null,
  cost_basis            numeric(20, 8)  not null,

  status                text        not null default 'open',
  opened_at             timestamptz not null default now(),
  closed_at             timestamptz,
  realized_pnl          numeric(20, 8),

  opened_by_decision_id uuid references public.agent_decisions (id) on delete set null,
  closed_by_decision_id uuid references public.agent_decisions (id) on delete set null,

  constraint positions_status_valid  check (status in ('open', 'closed')),
  constraint positions_qty_positive  check (quantity > 0),
  constraint positions_entry_positive check (entry_price > 0),
  constraint positions_closed_fields check (
    (status = 'open'  and closed_at is null and realized_pnl is null) or
    (status = 'closed' and closed_at is not null)
  )
);

-- Long-or-flat: at most one open position per asset per portfolio.
create unique index positions_one_open_per_asset_idx
  on public.positions (portfolio_id, asset)
  where status = 'open';

create index positions_portfolio_status_idx
  on public.positions (portfolio_id, status);

-- ---------------------------------------------------------------------------
-- trades — simulated fills. Fees and slippage are modelled explicitly; a
-- frictionless fill would make paper results fiction.
-- ---------------------------------------------------------------------------
create table public.trades (
  id             uuid        primary key default gen_random_uuid(),
  portfolio_id   uuid        not null references public.portfolios (id) on delete cascade,
  decision_id    uuid        not null references public.agent_decisions (id) on delete cascade,
  position_id    uuid        references public.positions (id) on delete set null,
  asset          text        not null,

  side           text        not null,
  quantity       numeric(28, 12) not null,
  reference_price numeric(20, 8) not null,
  fill_price     numeric(20, 8) not null,
  fee            numeric(20, 8) not null,
  slippage_cost  numeric(20, 8) not null,
  gross_value    numeric(20, 8) not null,
  net_cash_delta numeric(20, 8) not null,

  cash_after     numeric(20, 8) not null,
  executed_at    timestamptz not null default now(),

  constraint trades_side_valid      check (side in ('BUY', 'SELL')),
  constraint trades_qty_positive    check (quantity > 0),
  constraint trades_prices_positive check (reference_price > 0 and fill_price > 0),
  constraint trades_costs_nonneg    check (fee >= 0 and slippage_cost >= 0),
  constraint trades_cash_after_nonneg check (cash_after >= 0),
  -- One fill per decision: guards against a retry double-executing.
  constraint trades_decision_unique unique (decision_id)
);

create index trades_portfolio_executed_idx
  on public.trades (portfolio_id, executed_at desc);
create index trades_asset_executed_idx on public.trades (asset, executed_at desc);

comment on column public.trades.reference_price is
  'Market price before simulated slippage; fill_price is what the paper broker actually filled at.';

-- ---------------------------------------------------------------------------
-- nav_snapshots — mark-to-market portfolio value per run, so the equity
-- curve is reconstructable and HOLD-only cycles still leave a trace.
-- ---------------------------------------------------------------------------
create table public.nav_snapshots (
  id               uuid        primary key default gen_random_uuid(),
  portfolio_id     uuid        not null references public.portfolios (id) on delete cascade,
  run_id           uuid        references public.agent_runs (id) on delete set null,

  cash             numeric(20, 8) not null,
  positions_value  numeric(20, 8) not null,
  nav              numeric(20, 8) not null,
  unrealized_pnl   numeric(20, 8) not null,
  realized_pnl_cum numeric(20, 8) not null,

  captured_at      timestamptz not null default now(),

  constraint nav_snapshots_run_unique unique (run_id)
);

create index nav_snapshots_portfolio_captured_idx
  on public.nav_snapshots (portfolio_id, captured_at desc);

-- ============================================================================
-- Row Level Security
--
-- Decision (progress-tracker.md § Architecture Decisions): V0 is single-user
-- and paper-only, so the extension ships the public anon key with no login.
-- Every table therefore enables RLS and grants anon SELECT *only*. No anon
-- INSERT/UPDATE/DELETE policy exists anywhere, so all writes are blocked for
-- the extension. Edge Functions use the service-role key, which bypasses RLS.
--
-- Accepted exposure: someone with the extension ID could read paper P&L.
-- Revisit before any move toward real funds (invariant 11).
-- ============================================================================
alter table public.agent_settings   enable row level security;
alter table public.portfolios       enable row level security;
alter table public.news_items       enable row level security;
alter table public.agent_runs       enable row level security;
alter table public.market_snapshots enable row level security;
alter table public.agent_decisions  enable row level security;
alter table public.positions        enable row level security;
alter table public.trades           enable row level security;
alter table public.nav_snapshots    enable row level security;

create policy "anon read agent_settings"   on public.agent_settings   for select to anon using (true);
create policy "anon read portfolios"       on public.portfolios       for select to anon using (true);
create policy "anon read news_items"       on public.news_items       for select to anon using (true);
create policy "anon read agent_runs"       on public.agent_runs       for select to anon using (true);
create policy "anon read market_snapshots" on public.market_snapshots for select to anon using (true);
create policy "anon read agent_decisions"  on public.agent_decisions  for select to anon using (true);
create policy "anon read positions"        on public.positions        for select to anon using (true);
create policy "anon read trades"           on public.trades           for select to anon using (true);
create policy "anon read nav_snapshots"    on public.nav_snapshots    for select to anon using (true);
