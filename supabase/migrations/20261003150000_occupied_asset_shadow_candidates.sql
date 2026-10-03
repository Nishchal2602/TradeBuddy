-- ============================================================================
-- Strategy V4 (intraday_ls) — occupied-asset shadow candidates
-- (2026-10-03, "Candidate vs management" follow-up to the §5.1 advisory
-- candidate evaluation migration earlier today).
--
-- Closes the gap that migration's own header deliberately deferred:
-- detection previously only ran for a FLAT asset, so an asset already
-- holding an open position produced NO row at all when the six-arm
-- detector also found a genuine opportunity on it the same cycle. Plan
-- §3.4 is explicit that detection runs regardless of position state ("it
-- is free — same data"), and §6's reward loop needs exactly this
-- counterfactual: an asset_occupied shadow is what measures what the
-- one-position-per-asset constraint costs. Every cycle this ran without
-- the fix below lost that data permanently — shadow labels cannot be
-- backfilled (plan §12, risk 3).
--
-- agent-cycle/index.ts now emits TWO agent_decisions rows for such a
-- cycle: the existing MANAGEMENT row for the open position (unchanged),
-- and a separate 'candidate' row recording the detected opportunity,
-- deterministically gate-rejected with 'position already open; CLOSE
-- first' (evaluateOpen's own first check — no new gate logic needed) and
-- never evaluated by Jev at all (occupation is a structural fact no
-- news/entry/adversarial question could change).
--
-- The ONLY schema change this requires: agent_decisions_run_asset_unique
-- (unique (run_id, asset), since the table's original creation) blocks a
-- second row per (run_id, asset) outright. Replaced with a unique INDEX
-- over (run_id, asset, coalesce(decision_type, 'candidate')) — an
-- expression index, since a plain table UNIQUE constraint cannot
-- reference an expression. Every pre-2026-10-03 row has decision_type
-- NULL, so coalesce(...) resolves to 'candidate' for every one of them,
-- preserving the OLD guarantee byte-for-byte across all historical data
-- (at most one row per (run_id, asset) when decision_type is NULL).
-- Going forward, decision_type is always non-null on a new row (set
-- unconditionally in index.ts's Pass 2), so this permits exactly what's
-- needed — one 'candidate' row and one 'management' row per (run_id,
-- asset) — and nothing looser than that: two 'candidate' rows (or two
-- 'management' rows) for the same asset in the same run still collide.
-- ============================================================================

alter table public.agent_decisions drop constraint agent_decisions_run_asset_unique;

create unique index agent_decisions_run_asset_decision_type_idx
  on public.agent_decisions (run_id, asset, (coalesce(decision_type, 'candidate')));

comment on index public.agent_decisions_run_asset_decision_type_idx is 'Replaces agent_decisions_run_asset_unique (dropped above). Permits exactly one ''candidate'' row and one ''management'' row per (run_id, asset) — the occupied-asset shadow case — while still forbidding two of the same decision_type for one asset in one run. coalesce(decision_type, ''candidate'') keeps every pre-2026-10-03 row (decision_type NULL) under the exact same at-most-one-row guarantee the old plain unique(run_id, asset) constraint gave them.';
