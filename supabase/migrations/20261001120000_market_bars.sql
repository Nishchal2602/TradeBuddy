-- ============================================================================
-- market_bars (Strategy V4 Phase 0.6, 2026-10-01) — persistent price
-- history, filled entirely from data agent-cycle already fetches every
-- cycle (candles -> 4h, dailyCloseSeries -> 1d, ohlc30m -> 30m, spot5m ->
-- 5m). Zero extra CoinGecko requests. This is the foundation the shadow
-- labeler (Strategy V4 §6.1) and any future backtest/replay harness
-- depend on — no history exists before this table starts filling, so
-- everything before this migration is permanently unlabelable.
--
-- True OHLC series (candles/ohlc30m) persist with real high/low and
-- is_sampled=false. Close-only series (dailyCloseSeries/spot5m) persist
-- with open/high/low NULL and is_sampled=true — matching this project's
-- existing `sampled...` naming discipline (strategy/aggressive/
-- features.ts) for exactly the same reason: a close-only point has no
-- true high/low to report, and must never be mistaken for one later.
-- ============================================================================

create table public.market_bars (
  asset       text        not null,
  timeframe   text        not null check (timeframe in ('5m','30m','4h','1d')),
  open_time   timestamptz not null,
  open        numeric,
  high        numeric,
  low         numeric,
  close       numeric     not null check (close > 0),
  volume      numeric,
  is_sampled  boolean     not null default false,
  source      text        not null default 'coingecko',
  primary key (asset, timeframe, open_time)
);

comment on table public.market_bars is 'Persistent OHLC/close price history, filled from data agent-cycle already fetches every cycle (zero extra API cost). Feeds the Strategy V4 shadow labeler and any future backtest/replay harness. No history exists before this table started filling.';
comment on column public.market_bars.is_sampled is 'true for a close-only series (dailyCloseSeries/spot5m — no true high/low exists for that bar); false for a true OHLC series (candles/ohlc30m). Never read open/high/low as real when this is true.';

-- No separate index for "most recent bar per asset/timeframe" lookups —
-- the primary key (asset, timeframe, open_time) already covers exactly
-- that access path; a B-tree scans efficiently backward as well as
-- forward, so ORDER BY open_time DESC LIMIT 1 (filtered on asset +
-- timeframe) uses it directly without a second index to maintain.

alter table public.market_bars enable row level security;
create policy "anon read market_bars" on public.market_bars for select to anon using (true);
