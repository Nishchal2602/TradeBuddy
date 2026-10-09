-- ============================================================================
-- DT-1 (2026-10-09) — dt1_build_universe_membership returning rows hit a
-- second problem: PostgREST's max_rows cap (1000) silently truncated the
-- RPC result exactly like it does a plain select, and paginating the RPC
-- call would re-run the entire ~34s computation once per page (the
-- function is STABLE/pure, so this is wasteful but not actually
-- incorrect -- still worth fixing properly rather than tolerating it).
--
-- Fixed by having the function perform the write itself and return only
-- a row count. The calling Edge Function already connects with the
-- service-role client, which bypasses RLS entirely -- the function
-- writing directly to research_universe_membership needs no SECURITY
-- DEFINER escalation beyond what the caller already has.
-- ============================================================================

create or replace function public.dt1_build_and_write_universe_membership(
  p_universe_version text,
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

comment on function public.dt1_build_and_write_universe_membership is 'DT-1 (2026-10-09) -- same ranking contract as dt1_build_universe_membership, but writes directly to research_universe_membership and returns only a row count, avoiding PostgREST''s max_rows truncation on a bulk historical build and avoiding re-running the computation once per result page.';
