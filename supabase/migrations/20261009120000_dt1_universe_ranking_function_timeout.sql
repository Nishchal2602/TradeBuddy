-- ============================================================================
-- DT-1 (2026-10-09) — dt1_build_universe_membership (previous migration)
-- works perfectly when run via `db query --linked` (~20s of actual query
-- time for the full 2017-2026 range, confirmed) but hit Postgres error
-- 57014 ("canceling statement due to statement timeout") when invoked
-- via RPC from the Edge Function's service_role connection -- the
-- PostgREST-facing role has its own, much shorter statement_timeout
-- (consistent with the same 57014 error seen earlier at page 477 of a
-- plain paginated SELECT). Fixed with a per-function SET clause, which
-- overrides the calling role's statement_timeout for exactly the
-- duration of this function's own execution and nothing else -- no
-- session- or role-level timeout changes, no effect on any other query.
-- ============================================================================

create or replace function public.dt1_build_universe_membership(
  p_from date,
  p_to date,
  p_min_history_days int default 180,
  p_max_staleness_days int default 10,
  p_lookback_days int default 30,
  p_max_universe_size int default 20
)
returns table (
  formation_date date,
  underlying_id text,
  rank int,
  adv_usd_30d numeric
)
language sql
stable
set statement_timeout to '120s'
as $$
  with formations as (
    select generate_series(p_from, (p_to - interval '1 day')::date, interval '1 month')::date as formation_date
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
  )
  select formation_date, underlying_id, rnk::int as rank, adv as adv_usd_30d
  from ranked
  where rnk <= p_max_universe_size
  order by formation_date, rnk;
$$;
