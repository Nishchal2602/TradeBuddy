-- ============================================================================
-- RESEARCH-1 (2026-10-08, STRAT-1 P5) — historical market data for the
-- backtest/research engine, fetched from Binance's public, read-only,
-- unauthenticated spot-kline and USDS-M futures funding-rate endpoints
-- (context/project-overview.md's "Historical Market-Data Scope").
--
-- Deliberately a SEPARATE schema from market_bars, never reused or mixed:
-- market_bars' entire ingested_at/is_off_grid design exists to solve a
-- problem bulk historical data does not have (reconstructing what a LIVE
-- cycle knew at its own decision instant). Sharing identity with it would
-- risk a real collision — a Binance row and a CoinGecko row for the same
-- (asset, timeframe, open_time) during the live system's own operating
-- window could silently shadow each other through upsertMarketBars' own
-- dedup query, corrupting the live replay harness's already-verified
-- golden window. No code path reads both tables; there is no shared
-- consumer to simplify by merging them.
-- ============================================================================

create table public.historical_bars (
  id          uuid primary key default gen_random_uuid(),
  asset       text not null,
  timeframe   text not null check (timeframe in ('30m', '1h', '4h', '1d')),
  open_time   timestamptz not null,
  close_time  timestamptz not null,
  open        numeric not null,
  high        numeric not null,
  low         numeric not null,
  close       numeric not null check (close > 0),
  -- TRUE per-interval volume (Binance spot) — NOT market_bars.volume's
  -- rolling-24h CoinGecko artifact (CFG-1 Stage 0's own documented
  -- defect). This is the field that makes a real volume-confirmation
  -- signal researchable at all.
  volume      numeric not null,
  source      text not null default 'binance',
  ingested_at timestamptz not null default now(),
  unique (asset, timeframe, open_time)
);

comment on table public.historical_bars is 'RESEARCH-1 (2026-10-08) — Binance spot klines for the historical backtest engine only. Never read by any live trading path. True per-interval OHLCV, unlike market_bars.';

alter table public.historical_bars enable row level security;
create policy "anon read historical_bars" on public.historical_bars for select to anon using (true);

create table public.historical_funding_rates (
  id            uuid primary key default gen_random_uuid(),
  asset         text not null,
  funding_time  timestamptz not null,
  -- Fraction, e.g. 0.0001 = 0.01% — Binance USDS-M perpetual, 8h interval.
  funding_rate  numeric not null,
  mark_price    numeric not null check (mark_price > 0),
  source        text not null default 'binance',
  ingested_at   timestamptz not null default now(),
  unique (asset, funding_time)
);

comment on table public.historical_funding_rates is 'RESEARCH-1 (2026-10-08) — Binance USDS-M perpetual funding-rate history, for the backtest engine''s research-only short-side cost model. A different market (perpetual futures) from historical_bars'' spot klines, layered on for cost-modeling purposes only — see the research plan''s own "Spot price process, futures funding economics" honest-limitations note.';

alter table public.historical_funding_rates enable row level security;
create policy "anon read historical_funding_rates" on public.historical_funding_rates for select to anon using (true);
