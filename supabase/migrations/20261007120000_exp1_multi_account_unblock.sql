-- ============================================================================
-- EXP-1 Stage E1 (2026-10-07) — unblocks running more than one portfolio at
-- once. Two structural blockers found by reading the schema, not assumed:
--
-- B1: agent_runs_idempotency_key_unique was unique(idempotency_key) alone —
--     not portfolio-scoped, so two accounts on the same cadence build the
--     IDENTICAL scheduled key (cycle/idempotency.ts's
--     buildDecisionIdempotencyKey has no portfolio in it) and 99 of 100
--     collapse to duplicate_tick.
-- B2: agent_runs_one_running_decision_idx was a GLOBAL mutex on
--     (kind) where status='running' and kind='decision' — at most one
--     decision cycle could run system-wide, making cross-account
--     concurrency impossible by construction.
--
-- Both are widened to include portfolio_id, preserving their own INTENT
-- exactly ("one key per tick per account", "one running decision per
-- account") rather than relaxing them. Constraint/index NAMES are kept
-- IDENTICAL — cycle/idempotency.ts's classifyRunInsertConflict string-
-- matches on these exact names ('agent_runs_one_running_decision_idx',
-- 'agent_runs_idempotency_key_unique') to distinguish the two 23505
-- causes, and that logic needs zero changes as a direct result.
--
-- is_test/label are added now (not deferred to the experiment-schema
-- migration) because they are what every `.from('portfolios')…single()`
-- site needs fixed to `.eq('is_test', false)` — B4 from the plan. With
-- is_test defaulting to false and exactly one portfolio existing today,
-- this is behavior-preserving by construction: the live champion is the
-- only row matching the new filter, today and after this migration.
--
-- experiment_variant_id is deliberately NOT added here — its target table
-- (experiment_variants) doesn't exist until Stage E2's own migration;
-- adding an FK-less column now and constraining it later is messier than
-- adding both together where the dependency actually lives.
-- ============================================================================

alter table public.portfolios
  add column is_test boolean not null default false,
  add column label    text;

comment on column public.portfolios.is_test is 'EXP-1 (2026-10-07) — false for the live champion account (the only portfolio before this migration, and the only one every pre-existing `.single()` query must keep resolving to). true for any experiment account. Every pre-EXP-1 read of "the" portfolio is fixed to filter `.eq(''is_test'', false)` rather than relying on there being exactly one row.';
comment on column public.portfolios.label is 'EXP-1 — a human-readable name for a test account (e.g. the variant + capital level it represents). NULL for the champion, which is identified by is_test=false alone, not by name.';

-- B1: widen the tick-dedup key to be per-account, not global.
alter table public.agent_runs drop constraint agent_runs_idempotency_key_unique;
alter table public.agent_runs add constraint agent_runs_idempotency_key_unique unique (portfolio_id, idempotency_key);

-- B2: widen the concurrency mutex to be per-account, not global.
drop index public.agent_runs_one_running_decision_idx;
create unique index agent_runs_one_running_decision_idx
  on public.agent_runs (portfolio_id, kind)
  where status = 'running' and kind = 'decision';
