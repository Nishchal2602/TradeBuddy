-- ============================================================================
-- Bug fix: agent_decisions.output_payload was still `not null`, inherited
-- unchanged from V0 (20260917102906_initial_schema.sql) — correct at the
-- time, since every V0 decision genuinely called Gemini and always had
-- real output to store. Trading Strategy V1's Phase 5 rewrite
-- (20260921*) introduced decisions that legitimately never call the
-- model at all (HOLD/CLOSE proposals never reach the veto step; an
-- OPEN_LONG proceeds unvetoed when news_veto_enabled is false) and
-- persists that honestly as a real `null` — the same "no completed
-- model interaction this row" meaning `model_vetoed` (already nullable,
-- same migration) already carries — but the column itself was never
-- relaxed to allow it. Live impact: every HOLD/CLOSE decision from a
-- manual agent run has been failing this NOT NULL constraint since V1
-- deployed, breaking "Run agent" for exactly the common case.
--
-- input_payload stays NOT NULL, correctly — agent-cycle/index.ts always
-- constructs a real ModelCallPayload per asset regardless of whether a
-- model call happened (the rich audit-trail record the strategy rule
-- itself used), so it is never null and never needed relaxing.
-- ============================================================================

alter table public.agent_decisions
  alter column output_payload drop not null;
