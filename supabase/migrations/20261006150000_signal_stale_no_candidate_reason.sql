-- ============================================================================
-- Widen agent_decisions.no_candidate_reason with 'signal_stale' (CFG-1
-- Stage 1B, 2026-10-06) — isOpportunityStillValid (strategy/intraday-ls/
-- detectors.ts) was specified, tested, and never called from production.
-- Now wired into index.ts's Pass 1: a window-scanned edge can surface a
-- trigger bar up to WINDOW_SCAN_BARS-1 bars old, and if price has since
-- drifted more than signalDriftMaxFraction x stopLossPct away from that
-- bar's own close, the opportunity is reported this way rather than
-- promoted to a candidate. Gated on the active config's
-- signalDriftRuleEnforced (false in v4-compat, so unreachable there; true
-- in v4.1-corrected).
--
-- The column's original CHECK (migration 20261006140000) was added
-- inline via `add column ... check (...)`, so Postgres auto-named the
-- constraint rather than this project choosing a name for it — found
-- and dropped here by introspection (pg_constraint) rather than by a
-- guessed name, the exact discipline plan ASSET-4 learned the hard way
-- (agent_settings_strategy_profile_valid vs. a guessed _check suffix).
-- Replaced with an EXPLICITLY named constraint so a future widening
-- never has to guess again.
-- ============================================================================

do $$
declare
  existing_constraint_name text;
begin
  select conname into existing_constraint_name
  from pg_constraint
  where conrelid = 'public.agent_decisions'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%no_candidate_reason%';

  if existing_constraint_name is not null then
    execute format('alter table public.agent_decisions drop constraint %I', existing_constraint_name);
  end if;
end $$;

alter table public.agent_decisions
  add constraint agent_decisions_no_candidate_reason_valid check (
    no_candidate_reason is null or no_candidate_reason in (
      'data_insufficient', 'regime_null', 'no_arm_triggered', 'cost_gate',
      'opportunity_consumed', 'arm_disabled', 'direction_disabled', 'signal_stale'
    )
  );

comment on column public.agent_decisions.no_candidate_reason is 'CFG-1 — WHY no candidate was built this cycle, for an intraday_ls row with no arm_id. Makes F1/F3/F4-style findings (this plan''s own motivating investigation) a live GROUP BY instead of archaeology. NULL exactly when arm_id is populated (a candidate WAS built) or this is not an intraday_ls candidate-eligible row. ''signal_stale'' added 2026-10-06 (Stage 1B): isOpportunityStillValid''s drift check rejected the detected edge as too far from its trigger bar''s close; the opportunity is deliberately left unconsumed (no opportunity_bar_ts write) so the same bar can still qualify a later cycle if price reverts.';
