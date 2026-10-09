-- ============================================================================
-- DT-1 (2026-10-09, Order-of-Work step 4) — push the PIT universe ranking's
-- expensive aggregation into Postgres itself.
--
-- The Edge Function approach (fetch every 1d bar, rank in TypeScript) was
-- tried first and failed three times in a row: sequential OFFSET
-- pagination hit the platform's 150s idle-request timeout; concurrent
-- OFFSET pagination hit Postgres error 57014 (OFFSET is O(n), a
-- half-million-row offset times out); per-asset pagination fixed the
-- query cost but then WORKER_RESOURCE_LIMIT (holding ~803K raw bars, one
-- JS object per row, in one Edge Function's memory while computing 106
-- formation months x ~692 assets of ranking). A set-based SQL
-- aggregation is what this kind of computation is actually for --
-- Postgres can do it with index range scans and never materializes more
-- than the final ~2,000-row answer over the wire.
--
-- This SQL function reproduces, exactly, the two already-tested TS
-- modules' real behavioral contract (not a reinterpretation of their
-- intent -- their own source was read to confirm this):
--   - eligibility.ts's evaluateEligibility: historyDays is purely
--     (latest_prior_bar - earliest_prior_bar) in days; staleness is
--     purely (formation - latest_prior_bar) in days. Confirmed by
--     reading the function: it only ever uses the FIRST and LAST
--     element of the sorted, formation-filtered bar list -- nothing
--     about the bars in between. minHistoryDays=180/maxStalenessDays=10
--     are its own defaults, reproduced here as this function's defaults.
--   - build-universe.ts's rankUniverseAtFormation: 30-day trailing mean
--     quote_volume, with a HARD exclusion (never a corrupted partial
--     mean) if any bar in that window has a NULL quote_volume, and a
--     top-N cap by descending mean.
--
-- Pre-filtering to non-excluded assets (research_contracts) is NOT done
-- here: historical_bars only contains rows for assets the ingestion
-- pipeline already classified non-excluded (DT-1's own ingestion script
-- only ever requested the ~699 "ordinary" candidates), so every asset
-- that reaches this function is already a legitimate candidate.
-- ============================================================================

-- close_time has no supporting index today (the table's own unique
-- constraint is on open_time) -- without this, every one of the
-- per-(asset, formation) range scans below falls back to a sequential
-- scan. Purely additive, no behavior change to any existing query.
create index if not exists historical_bars_asset_timeframe_close_time_idx
  on public.historical_bars (asset, timeframe, close_time);

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
as $$
  with formations as (
    select generate_series(p_from, (p_to - interval '1 day')::date, interval '1 month')::date as formation_date
  ),
  per_asset_bounds as (
    -- Mirrors evaluateEligibility exactly: only the earliest and latest
    -- prior-bar timestamps matter, never a count of bars in between.
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
    -- Mirrors rankUniverseAtFormation's window filter + NaN-never-
    -- silently-averaged rule: bar_count=0 or any null in the window both
    -- exclude the asset from that formation's ranking entirely.
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

comment on function public.dt1_build_universe_membership is 'DT-1 (2026-10-09) -- set-based reproduction of research/universe/eligibility.ts + build-universe.ts''s ranking contract, for bulk historical universe construction. Research-only, never called from any live trading path.';
