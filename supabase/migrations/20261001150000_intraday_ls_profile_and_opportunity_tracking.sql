-- ============================================================================
-- Strategy V4 (intraday_ls) — Stage B, §2 + index.ts wiring (2026-10-01).
--
-- This migration adds ONLY what THIS pass's wiring needs to persist:
-- the new profile enum value, and the three opportunity-detection
-- provenance columns (arm_id/bias/opportunity_bar_ts) the consumed-
-- opportunity lifecycle (strategy/intraday-ls/lifecycle.ts) depends on
-- to avoid re-emitting the same detected edge every cycle. It deliberately
-- does NOT add the rest of the V4 plan's §7 schema (entry_quality/
-- entry_gate_mode/expected_move_horizon_minutes/arm_risk_multiplier/
-- arm_weights_version, decision_outcomes, arm_weights, market_bars's
-- funding/time_stop columns) — those belong to later, separately-scoped
-- pieces (§5 Jev's role, §6 the reward loop, §4 exits) not yet built.
--
-- Scope note on what this pass actually DOES with these columns: V4
-- detection (bias + six arms + the cost gate) is fully wired into
-- agent-cycle's Pass 1 and persists arm_id/bias/opportunity_bar_ts on
-- every FLAT-asset decision row under intraday_ls — but candidates are
-- deliberately neutralized to HOLD before ever reaching the veto/gate/
-- broker path, the same "Pass 1: wiring only, nothing downstream changes
-- yet" discipline this codebase's own Aggressive rollout used. The
-- reason: the existing news-veto question text is hardcoded to "a new
-- long position" (model/jev/question.ts's buildJevQuestion), which would
-- ask Jev the WRONG question for a short candidate — making it
-- direction-aware is explicitly §5.2 point 1, not part of this pass. This
-- is a deliberate, named checkpoint: you can observe real bias/arm
-- detection firing against live market data, with zero risk of a trade
-- executing, before the entry path is wired live.
-- ============================================================================

alter table public.agent_settings drop constraint agent_settings_strategy_profile_valid;
alter table public.agent_settings add constraint agent_settings_strategy_profile_valid
  check (strategy_profile in ('balanced', 'aggressive', 'intraday_ls'));

alter table public.agent_decisions
  add column arm_id text check (arm_id in ('breakout_long', 'breakout_short', 'pullback_long', 'pullback_short', 'fade_long', 'fade_short')),
  add column bias text check (bias in ('LONG', 'SHORT', 'NEUTRAL')),
  add column opportunity_bar_ts timestamptz;

comment on column public.agent_decisions.arm_id is 'Strategy V4 (intraday_ls) only — which of the six detector arms fired this cycle, null otherwise. Set even when the resulting action is HOLD (detection is persisted regardless of whether a trade executes).';
comment on column public.agent_decisions.bias is 'Strategy V4 (intraday_ls) only — the LONG/SHORT/NEUTRAL directional bias in force this cycle (evaluateBias). Null for every other profile and for any intraday_ls row where data sufficiency failed.';
comment on column public.agent_decisions.opportunity_bar_ts is 'Strategy V4 (intraday_ls) only — the close timestamp of the bar/candle that triggered arm_id''s detection. The sole input to the consumed-opportunity lifecycle (strategy/intraday-ls/lifecycle.ts): a later cycle must not re-emit the SAME opportunity, which it detects by comparing a freshly-scanned edge''s own timestamp against max(opportunity_bar_ts) for this asset.';

-- Serves the lifecycle's own lastConsumedOpportunityBarTs lookup
-- (max(opportunity_bar_ts) per portfolio+asset) — a partial index since
-- the column is null for every non-intraday_ls row and every intraday_ls
-- row where nothing was detected.
create index agent_decisions_opportunity_idx
  on public.agent_decisions (portfolio_id, asset, opportunity_bar_ts desc)
  where opportunity_bar_ts is not null;
