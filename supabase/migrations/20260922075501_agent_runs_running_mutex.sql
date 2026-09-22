-- ============================================================================
-- Manual/scheduled idempotency split (2026-09-22).
--
-- Bug: agent-cycle's idempotency key floors to the 180-minute
-- decision_interval_minutes bucket regardless of trigger source, so a
-- single manual "Run agent" click claimed the entire 3-hour window and
-- every further deliberate click that session returned duplicate_tick —
-- confirmed live before this migration.
--
-- Fix, in two parts: application code (supabase/functions/agent-cycle/
-- cycle/idempotency.ts, index.ts) now derives a per-click key for manual
-- triggers and the unchanged bucketed key for scheduled ones. That alone
-- would be unsafe on its own — see below — so this migration adds the
-- real concurrency guard the key was never actually providing.
--
-- The unique constraint on idempotency_key only ever excluded two
-- invocations landing in the exact same bucket (or, going forward, the
-- exact same millisecond for manual clicks); it never stopped two
-- invocations straddling a boundary from running at the same time. That
-- gap already existed before this migration — it's just that a
-- floored-to-3-hours key made it hard to trigger by accident. Once
-- manual clicks get their own key per click, the same gap becomes easy
-- to hit deliberately (two closely-spaced clicks). This matters because
-- open_position_atomic's own comment
-- (20260919055617_agent_cycle_open_rpc.sql:93) states outright: "No race
-- guard needed ... agent_runs idempotency prevents overlapping decision
-- cycles." That was already only approximately true; this migration is
-- what actually makes it true, by adding a real mutex rather than
-- relying on key uniqueness to imply mutual exclusion it never did.
-- ============================================================================

-- At most one 'running' decision-cycle row at a time. A second concurrent
-- insert attempt (two overlapping invocations, any trigger) hits 23505
-- on THIS index specifically — distinguished in application code from
-- the idempotency_key collision via classifyRunInsertConflict
-- (cycle/idempotency.ts) — and is reported as 'already_running', a new,
-- more accurate status than the old single 'duplicate_tick'.
--
-- Deliberately scoped to kind = 'decision' only, not both kinds: a
-- single wedged 'running' monitor row would silently block ALL future
-- SL/TP monitoring — precisely the class of invisible safety failure the
-- broken service_role_key Vault secret just caused (see progress-
-- tracker.md). position-monitor needs no mutex regardless:
-- close_position_atomic is already fully race-safe via its own
-- won_race-returning conditional update.
--
-- Verified safe to add live: zero rows currently sit in status='running'
-- (checked before writing this migration), so the index builds clean
-- with no pre-existing violation to resolve.
create unique index agent_runs_one_running_decision_idx
  on public.agent_runs (kind)
  where status = 'running' and kind = 'decision';

-- Keeps the schema's own documentation honest about which mechanism
-- actually provides the guarantee the original comment claimed —
-- correcting it in place (function comments aren't "applied migration"
-- content in the Protected Files sense; they describe current behavior,
-- not a frozen historical record) rather than leaving it to assert
-- something that was only ever approximately true.
comment on function public.open_position_atomic is
  'Atomically opens a new position and records its opening trade. No explicit race guard inside this function (trading-domain-contract.md §6: the monitor never opens) — mutual exclusion between decision cycles is provided by agent_runs_one_running_decision_idx (a partial unique index: at most one running decision-cycle row at a time), not by idempotency_key uniqueness alone. positions_one_open_per_asset_idx remains a DB-level backstop underneath both.';
