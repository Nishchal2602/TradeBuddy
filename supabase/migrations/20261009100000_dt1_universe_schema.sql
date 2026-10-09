-- ============================================================================
-- DT-1 (2026-10-09, Stage A frozen, Order-of-Work step 4) — universe data
-- infrastructure. Purely additive: one new nullable column, two new tables.
-- No existing column changes type or constraint; no existing table is
-- altered destructively. Per the plan's own §8 "Schema / database changes":
-- historical_bars.asset stays plain text with no CHECK/FK, so a research
-- symbol (e.g. a delisted altcoin's underlying id) needs no migration for
-- the asset column itself.
-- ============================================================================

-- 1. quote_volume — TRUE per-interval USD-quote volume (Binance spot
--    klines' own quoteAssetVolume field, tuple index 7), the input the PIT
--    universe ranking (§5.3: "mean daily quote volume over the preceding
--    30 days") actually needs. Binance's own providers/binance.ts already
--    validates this field on every kline response and, until now, silently
--    discarded it (the DT-1 plan's own G3 gap finding). Nullable so every
--    existing historical_bars row (the live 4-asset RESEARCH-1 ingestion,
--    2026-10-08) stays valid without a backfill; new ingestion populates it
--    going forward, and a targeted re-ingest of 1d bars is how BTC/ETH/
--    SUI/AVAX's own existing rows gain it.
alter table public.historical_bars
  add column quote_volume numeric;

comment on column public.historical_bars.quote_volume is 'DT-1 (2026-10-09) — Binance kline quoteAssetVolume (tuple index 7): the USD-denominated volume for this bar''s interval, used ONLY for the PIT universe''s 30-day ADV ranking (plan §5.3). Nullable: pre-2026-10-09 rows were ingested before this field existed.';

-- 2. research_contracts — the frozen, auditable Binance-symbol -> underlying
--    -> classification mapping (plan §5.7, §8). A Binance "symbol" (e.g.
--    BCCUSDT) and an "underlying asset" (e.g. BCH, the ResearchSymbol used
--    as historical_bars.asset) are NOT the same identity: Binance treats a
--    rename as delist-old/list-new, never in-place, so one underlying can
--    map to more than one Binance symbol over non-overlapping date ranges
--    (BCCUSDT and BCHUSDT both -> BCH). This table is the one place that
--    mapping is recorded, append-only in spirit: an error is corrected by a
--    dated, visibly-appended new mapping_version, never an in-place edit
--    (same discipline as every other "legacy value preserved for audit"
--    amendment in this project).
create table public.research_contracts (
  id                uuid primary key default gen_random_uuid(),
  binance_symbol    text not null,
  underlying_id     text not null,
  quote_asset       text not null default 'USDT',
  -- Recorded for audit only -- NOT applied anywhere. A trend strategy
  -- operates on ratios (close/SMA, ATR%), so a 1000X-style redenomination
  -- is irrelevant to it; see plan §5.7.
  price_scale       numeric not null default 1 check (price_scale > 0),
  asset_class       text not null check (asset_class in (
    'ordinary', 'stablecoin', 'leveraged_index', 'wrapped', 'lst', 'exchange_token'
  )),
  excluded          boolean not null default false,
  exclusion_reason  text,
  -- Inferred from the earliest/latest available kline (or archive file),
  -- never from exchangeInfo status alone (P1c's own ICXUSDT finding:
  -- BREAK does not mean "long dead" -- point-in-time eligibility must be
  -- decided by data presence, not status). Nullable: not always knowable
  -- without a deep per-symbol check.
  listed_at         timestamptz,
  delisted_at       timestamptz,
  mapping_version   text not null,
  notes             text,
  created_at        timestamptz not null default now(),
  unique (binance_symbol, mapping_version)
);

comment on table public.research_contracts is 'DT-1 (2026-10-09) — the frozen Binance-symbol -> underlying-asset mapping and exclusion classification for the PIT universe (plan §5.7). Append-only in spirit: corrections are a new mapping_version, never an in-place edit of a frozen one.';

create index research_contracts_underlying_idx on public.research_contracts (underlying_id, mapping_version);
create index research_contracts_mapping_version_idx on public.research_contracts (mapping_version);

alter table public.research_contracts enable row level security;
create policy "anon read research_contracts" on public.research_contracts for select to anon using (true);

-- 3. research_universe_membership — the point-in-time universe record
--    (plan §5.3, §8): one row per (formation_date, underlying_id,
--    universe_version), append-only. A universe_version is never mutated
--    once any DT-1 pre-registration or run has cited it (stop gate S3b) --
--    a methodology change after that point gets a NEW universe_version,
--    never a silent edit of rows under the old one.
create table public.research_universe_membership (
  id                uuid primary key default gen_random_uuid(),
  formation_date    date not null,
  underlying_id     text not null,
  rank              int not null check (rank > 0),
  adv_usd_30d       numeric not null check (adv_usd_30d >= 0),
  universe_version  text not null,
  created_at        timestamptz not null default now(),
  unique (formation_date, underlying_id, universe_version)
);

comment on table public.research_universe_membership is 'DT-1 (2026-10-09) — monthly point-in-time universe membership (plan §5.3): which underlying assets ranked in the top-N by 30-day ADV at each formation date, under a given, frozen universe_version. Append-only once a universe_version is cited by a pre-registration (stop gate S3b).';

create index research_universe_membership_formation_idx on public.research_universe_membership (formation_date, universe_version);
create index research_universe_membership_underlying_idx on public.research_universe_membership (underlying_id, universe_version);

alter table public.research_universe_membership enable row level security;
create policy "anon read research_universe_membership" on public.research_universe_membership for select to anon using (true);
