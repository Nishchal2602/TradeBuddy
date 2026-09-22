-- ============================================================================
-- Independent market-quote refresh ("market_quotes plan", 2026-09-21).
--
-- Problem: BTC/ETH prices shown in the extension only ever change when a
-- user manually clicks "Run agent" — verified live before writing this
-- migration: the newest market_snapshots row was 30 minutes old, the pair
-- before it nearly two days old. Neither existing schedule can fix this:
-- agent-cycle is deliberately manual-only (20260919131706_manual_
-- execution_mode.sql), and position-monitor fetches nothing while flat
-- (it exists for SL/TP exits, not quotes).
--
-- Fix: a third, genuinely trade-incapable Edge Function (market-refresh)
-- that does exactly one thing — fetch current BTC/ETH prices and store
-- them here — on its own 5-minute schedule. It never reads agent_settings,
-- never calls the risk gate or broker, and has no code path that can
-- produce a trade.
--
-- Deliberately a NEW table, not a repair/reuse of market_snapshots:
-- market_snapshots.run_id is `not null references agent_runs`, and
-- indicators/recent_closes are both `jsonb not null` — a quote-only write
-- would either need to fabricate an agent_runs row every 5 minutes
-- (polluting the Activity screen, which reads that table) or insert fake
-- indicator payloads (exactly the "partial/stale indicator data"
-- corruption this design avoids). market_snapshots keeps its existing,
-- single job — the immutable per-decision audit trail the strategy and
-- Decision-detail UI read — and gains no new writer or reader here.
-- ============================================================================

create table public.market_quotes (
  asset                 text        primary key,
  price                 numeric(20, 8) not null,
  change_1h_pct         numeric(10, 4),
  change_24h_pct        numeric(10, 4),
  change_7d_pct         numeric(10, 4),
  provider              text        not null,
  -- CoinGecko's own reported freshness for this price (its last_updated) —
  -- distinct from fetched_at, same data_as_of/fetched_at split as
  -- market_snapshots and NormalizedMarketData.
  data_as_of            timestamptz not null,
  fetched_at            timestamptz not null,
  -- Cleared to null on every successful refresh; set (message + timestamp)
  -- only on a failed refresh, which otherwise touches nothing else on this
  -- row — the price/change/data_as_of/fetched_at columns above are left
  -- exactly as they were, so a CoinGecko outage degrades to "quote stops
  -- advancing," never to a fabricated or blanked price. Not surfaced in
  -- the UI (explicit product decision this session, no freshness/staleness
  -- indicator for V0) — these exist for operational debugging only.
  last_refresh_error    text,
  last_refresh_error_at timestamptz,

  constraint market_quotes_price_positive check (price > 0)
);

alter table public.market_quotes enable row level security;
create policy "anon read market_quotes" on public.market_quotes for select to anon using (true);

-- Seed from the freshest existing market_snapshots row per asset, so the
-- table is never empty between this push and the first refresh tick (cron
-- or a manual invocation) — a real backfill from data that already exists
-- on the live project, not placeholder values.
insert into public.market_quotes (asset, price, change_1h_pct, change_24h_pct, change_7d_pct, provider, data_as_of, fetched_at)
select distinct on (asset)
  asset, price, change_1h_pct, change_24h_pct, change_7d_pct, provider, data_as_of, ingested_at
from public.market_snapshots
order by asset, data_as_of desc;

-- ---------------------------------------------------------------------------
-- pg_cron schedule — same shape as position-monitor-10min
-- (20260918124421_position_monitor_rpc.sql), including its Vault
-- convention: the function URL and the service-role bearer token are read
-- by name, never hardcoded. service_role_key already exists (created
-- generically for exactly this reuse — see that migration's own comment)
-- and is live-verified working as of this session (cron.job_run_details
-- shows clean successes once the two secrets existed). market_refresh_url
-- is the one new secret this migration needs — a public function
-- endpoint, not secret material, so it can be created directly rather
-- than hand-entered like the service-role key.
--
-- Cadence is 5 minutes, not the ~1 minute first floated — explicit user
-- choice this session, favoring lower sustained CoinGecko request volume
-- (288/day instead of 1,440/day) over marginally fresher quotes; the
-- extension's own 30s poll still surfaces every update quickly once it
-- lands. agent-cycle additionally upserts this table itself on every
-- manual run (index.ts) — it already holds this exact data from its own
-- getMarketData call, so that costs zero extra CoinGecko requests and
-- means a manual run's quote is never stale-behind-the-next-cron-tick.
-- extensions are idempotent (if not exists) to repeat here.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

select cron.schedule(
  'market-refresh-5min',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'market_refresh_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body    := '{}'::jsonb
  );
  $$
);

comment on extension pg_cron is
  'Schedules position-monitor-10min, market-refresh-5min (both this migration''s neighbor and this one), and manual-only agent-cycle has none by design.';
