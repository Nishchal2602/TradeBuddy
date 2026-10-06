-- ============================================================================
-- market_bars provenance (CFG-1 Stage 0, 2026-10-06) — adds the fields a
-- replay harness needs to reconstruct the INFORMATION SET available at
-- time t, not just the price path. Found necessary during the Stage 0
-- investigation into "why does the strategy never short": market_bars
-- recorded when a market event happened, never when this system LEARNED
-- of it, which makes point-in-time correctness unreconstructable.
--
-- close_time is an explicitly-named alias of the existing open_time —
-- every series this table stores has ALWAYS used open_time to hold the
-- bar's CLOSE instant (live-verified 2026-10-03: a 30m bar stamped 14:30
-- covers 14:00->14:30). open_time stays the column name (it is half the
-- primary key, and renaming it would be a breaking change to every
-- existing reader) — close_time exists so a future reader never has to
-- rediscover this the hard way. For every row written from this
-- migration forward, close_time = open_time by construction.
--
-- ingested_at/batch_id are NOT backfilled for pre-existing rows —
-- backfilling a provenance timestamp we don't actually have would
-- fabricate exactly the kind of false precision this migration exists to
-- prevent (same "never guess" backfill discipline as decision_type's own
-- NULL-for-historical-rows precedent, 20261003150000). NULL on an old
-- row honestly means "written before provenance tracking existed."
-- ============================================================================

alter table public.market_bars
  add column close_time  timestamptz,
  add column ingested_at timestamptz,
  add column batch_id    uuid,
  add column data_version text;

update public.market_bars set close_time = open_time where close_time is null;
alter table public.market_bars alter column close_time set not null;

comment on column public.market_bars.close_time is 'Explicitly-named alias of open_time, which has always held the bar''s CLOSE instant for every series this table stores. open_time stays the PK column for backward compatibility; close_time exists so this is never rediscovered the hard way.';
comment on column public.market_bars.ingested_at is 'When THIS SYSTEM learned of this bar (the writing cycle''s own nowIso) — distinct from open_time/close_time, which describe when the market event itself happened. NULL on every row written before this migration (not backfilled — unknowable, not fabricated).';
comment on column public.market_bars.batch_id is 'Correlates every bar written by one agent-cycle run (that run''s own agent_runs.id) — lets a replay harness group "everything this system knew as of run X" in one query. NULL on pre-migration rows and on any future write path that doesn''t have a run id (there is currently exactly one writer, agent-cycle).';
comment on column public.market_bars.data_version is 'Versions the CAPTURE PIPELINE''s own shape (which fields are populated, what they mean) — independent of is_sampled/source, which describe the DATA. Starts at ''v1''. NULL on pre-migration rows.';
