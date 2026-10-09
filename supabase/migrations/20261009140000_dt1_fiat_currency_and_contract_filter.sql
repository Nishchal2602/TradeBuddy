-- ============================================================================
-- DT-1 (2026-10-09) — two corrections found by a post-build verification
-- sweep: the first REAL run of dt1_build_and_write_universe_membership
-- (universe_version dt1-v1) was checked for stablecoin contamination via
-- price coefficient-of-variation (genuine crypto assets never sit near a
-- stablecoin's ~0.05% figure), which found THREE pollutants the
-- name-based contracts classifier had missed: USD1 and RLUSD (both
-- stablecoins with no textual hint of being dollar-pegged) and EUR (a
-- fiat currency pair, not a cryptocurrency at all). The classifier itself
-- is fixed in the same commit as this migration (research/universe/
-- contracts.ts's KNOWN_STABLECOINS/KNOWN_FIAT_CURRENCIES).
--
-- 1. Widen asset_class to admit 'fiat_currency' as a named category.
-- 2. Make the ranking function itself robust against this entire CLASS of
--    problem recurring: it previously trusted historical_bars alone
--    (reasoning: ingestion only ever requested already-classified
--    "ordinary" candidates, so nothing excluded should be present) --
--    that reasoning is exactly what this incident falsified. The
--    function now explicitly joins against research_contracts and
--    filters to excluded=false under the given mapping_version, so a
--    FUTURE classifier correction (a new mapping_version) can be applied
--    to re-rank WITHOUT needing to delete or re-ingest historical_bars
--    rows at all.
-- ============================================================================

alter table public.research_contracts drop constraint research_contracts_asset_class_check;
alter table public.research_contracts add constraint research_contracts_asset_class_check
  check (asset_class in ('ordinary', 'stablecoin', 'leveraged_index', 'wrapped', 'lst', 'exchange_token', 'fiat_currency'));

create or replace function public.dt1_build_and_write_universe_membership(
  p_universe_version text,
  p_mapping_version text,
  p_from date,
  p_to date,
  p_min_history_days int default 180,
  p_max_staleness_days int default 10,
  p_lookback_days int default 30,
  p_max_universe_size int default 20
)
returns integer
language plpgsql
set statement_timeout to '120s'
as $$
declare
  v_row_count integer;
begin
  with formations as (
    select generate_series(p_from, (p_to - interval '1 day')::date, interval '1 month')::date as formation_date
  ),
  eligible_assets as (
    select distinct underlying_id from public.research_contracts
    where mapping_version = p_mapping_version and excluded = false
  ),
  per_asset_bounds as (
    select
      f.formation_date,
      hb.asset,
      min(hb.close_time) as earliest_close,
      max(hb.close_time) as latest_close
    from formations f
    join public.historical_bars hb
      on hb.timeframe = '1d'
      and hb.close_time < f.formation_date
    join eligible_assets ea on ea.underlying_id = hb.asset
    group by f.formation_date, hb.asset
  ),
  eligible as (
    select formation_date, asset, earliest_close, latest_close
    from per_asset_bounds
    where (latest_close::date - earliest_close::date) >= p_min_history_days
      and (formation_date - latest_close::date) <= p_max_staleness_days
  ),
  window_stats as (
    select
      e.formation_date,
      e.asset,
      avg(hb.quote_volume) as adv,
      count(*) as bar_count,
      count(*) filter (where hb.quote_volume is null) as null_count
    from eligible e
    join public.historical_bars hb
      on hb.asset = e.asset
      and hb.timeframe = '1d'
      and hb.close_time >= (e.formation_date - (p_lookback_days || ' days')::interval)
      and hb.close_time < e.formation_date
    group by e.formation_date, e.asset
  ),
  ranked as (
    select
      formation_date,
      asset as underlying_id,
      adv,
      row_number() over (partition by formation_date order by adv desc) as rnk
    from window_stats
    where bar_count > 0 and null_count = 0
  ),
  inserted as (
    insert into public.research_universe_membership (formation_date, underlying_id, rank, adv_usd_30d, universe_version)
    select formation_date, underlying_id, rnk::int, adv, p_universe_version
    from ranked
    where rnk <= p_max_universe_size
    on conflict (formation_date, underlying_id, universe_version)
      do update set rank = excluded.rank, adv_usd_30d = excluded.adv_usd_30d
    returning 1
  )
  select count(*) into v_row_count from inserted;

  return v_row_count;
end;
$$;
