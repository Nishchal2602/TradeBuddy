-- ============================================================================
-- Phase 2.1 (2026-09-23) — separate entry eligibility from position
-- management as two independently switchable layers.
--
-- Phase 2 deployed with news_veto_enabled gating BOTH the entry-veto call
-- AND the management call (index.ts's single combined guard) — a real
-- defect: disabling the entry veto silently also disabled the ability to
-- ADD/REDUCE/CLOSE/MODIFY_PROTECTION on a live open position, two
-- unrelated product decisions sharing one switch. This migration adds the
-- management layer's own switch so news_veto_enabled goes back to meaning
-- only what its name says. See the approved Phase 2.1 plan for the full
-- design; cycle/collect-candidates.ts is where each flag is now read
-- independently.
-- ============================================================================

alter table public.agent_settings
  add column management_enabled boolean not null default true;

comment on column public.agent_settings.management_enabled is
  'Gates ONLY the Phase 2 portfolio-management layer (HOLD/ADD/REDUCE/CLOSE/MODIFY_PROTECTION on an already-open position) — independent of news_veto_enabled, which gates ONLY the entry-veto layer (the noul question asked of a new OPEN_LONG candidate). The two were conflated behind one flag for the first hour of Phase 2''s deployment; this column is the fix. Default true: management stays active until deliberately turned off, matching news_veto_enabled''s own default reasoning (trading_strategy_v1.sql).';
