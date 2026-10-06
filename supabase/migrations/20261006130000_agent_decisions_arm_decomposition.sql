-- ============================================================================
-- agent_decisions arm decomposition (CFG-1 Stage 0, 2026-10-06) — the six
-- arm ids (breakout_long/short, pullback_long/short, fade_long/short)
-- look like six independent strategies. Statistically they are one of
-- three setup FAMILIES crossed with DIRECTION (bias — LONG/SHORT/NEUTRAL
-- — already persisted and plays the "regime" role here). Persisting
-- arm_family and direction as their OWN columns, alongside the existing
-- arm_id (never instead of it), is what makes "does pullback work
-- independent of direction?" a GROUP BY instead of six isolated buckets
-- each starved of sample size.
--
-- Both are backfillable from the existing arm_id for every historical
-- row that has one (arm_family is a pure function of arm_id; direction
-- is the suffix arm_id already encodes) — unlike market_bars'
-- ingested_at/batch_id, this IS safe to backfill, since it's a
-- deterministic derivation of data already present, not a reconstruction
-- of something unknown.
-- ============================================================================

alter table public.agent_decisions
  add column arm_family text check (arm_family is null or arm_family in ('breakout', 'pullback', 'fade')),
  add column direction   text check (direction   is null or direction   in ('long', 'short'));

update public.agent_decisions
set
  arm_family = case
    when arm_id like 'breakout%' then 'breakout'
    when arm_id like 'pullback%' then 'pullback'
    when arm_id like 'fade%'     then 'fade'
  end,
  direction = case
    when arm_id like '%_long'  then 'long'
    when arm_id like '%_short' then 'short'
  end
where arm_id is not null;

comment on column public.agent_decisions.arm_family is 'Setup family (breakout | pullback | fade), derived from arm_id. NULL exactly when arm_id is NULL. Added so arm_id''s six concatenated values can be grouped by family or by direction independently, rather than only as six isolated buckets.';
comment on column public.agent_decisions.direction is 'long | short, derived from arm_id''s own suffix (and, for the live code path, identical to the detected opportunity''s own direction field — never re-parsed ad hoc). NULL exactly when arm_id is NULL.';
