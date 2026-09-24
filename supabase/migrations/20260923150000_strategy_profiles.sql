-- ============================================================================
-- Strategy profiles (2026-09-23) — Balanced (the live V1/Phase-2 strategy,
-- moved behind a first-class profile selector with zero behavior change)
-- vs Aggressive (v3-jev-intraday-30m, a new 15-minute-decision-cadence /
-- 30-minute-signal strategy, pre-registered falsification hypothesis H6).
-- See the approved migration plan and
-- context/specs/trading-strategy-aggressive-v3.md for the full design;
-- this file is the minimum schema surface it requires.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- agent_settings.strategy_profile — the persisted selection, read fresh by
-- agent-cycle every run (no in-memory cache to go stale). Default
-- 'balanced' so no existing installation is silently switched by this
-- migration. 'conservative' is deliberately ABSENT from the CHECK — it is
-- not a trading strategy and must fail closed, never silently map to one.
-- ---------------------------------------------------------------------------

alter table public.agent_settings
  add column strategy_profile text not null default 'balanced';

alter table public.agent_settings
  add constraint agent_settings_strategy_profile_valid
    check (strategy_profile in ('balanced', 'aggressive'));

comment on column public.agent_settings.strategy_profile is
  'Which strategy generates the next agent-cycle decision, for every asset. Read fresh every cycle -- switching takes effect on the NEXT run only, never retroactively, and never auto-closes/resizes an existing position (see cycle/collect-candidates.ts and strategy/registry.ts). Deliberately NOT the same concept as risk_appetite, which predates this column and continues to govern only Balanced''s riskBudgetPct.';

-- ---------------------------------------------------------------------------
-- Sizing-cap CEILINGS raised so Aggressive's own, wider, pre-registered
-- risk policy (src/shared/strategy/profiles.ts's STRATEGY_PROFILES.
-- aggressive.risk: 30% single-trade / 60% total-notional) is actually
-- reachable -- the effective cap a cycle uses is
-- min(profile-specific value, this ceiling), so raising the ceiling alone
-- changes nothing for Balanced: its own profile value (20% / 30%, the
-- historical numbers) is still the smaller of the two, so
-- min(0.20, 0.35) = 0.20 and min(0.30, 0.70) = 0.30 -- UNCHANGED. Only
-- Aggressive, whose profile values are now large enough to actually reach
-- these new ceilings, is affected.
-- ---------------------------------------------------------------------------

update public.agent_settings set
  max_single_trade_pct = 0.3500,
  max_total_notional_pct = 0.7000;

comment on column public.agent_settings.max_single_trade_pct is
  'Hard ceiling on single-trade notional as % of NAV -- the OUTER bound a strategy profile''s own (smaller) value is clamped against, never exceeded regardless of profile (src/shared/strategy/profiles.ts). Raised 2026-09-23 (0.20 -> 0.35) specifically so Aggressive''s own 30% profile value is reachable; Balanced''s effective cap is unchanged at 0.20 because its own profile value is still the smaller number.';

comment on column public.agent_settings.max_total_notional_pct is
  'Hard ceiling on total portfolio notional as % of NAV -- same outer-bound relationship to a strategy profile''s own value as max_single_trade_pct above. Raised 2026-09-23 (0.30 -> 0.70) for the same reason; Balanced''s effective cap stays 0.30.';

-- ---------------------------------------------------------------------------
-- agent_decisions -- three nullable cost/expectation columns (null for
-- every Balanced decision; populated only when Aggressive actually
-- detects and evaluates an opportunity). Kept STRUCTURALLY SEPARATE, per
-- an explicit correction during plan review: atrTargetDistancePct (the
-- deterministic target distance the strategy chose) and expectedMovePct
-- (Jev's OWN prediction) are different quantities and must never be
-- conflated -- this is what later lets analysis distinguish "Jev was
-- directionally/magnitude wrong" from "the deterministic target was
-- never achievable given real costs," two failures with opposite
-- remedies. atrTargetDistancePct itself needs NO new column -- it is
-- already derivable from the persisted computed_take_profit_price and
-- entry price.
-- ---------------------------------------------------------------------------

alter table public.agent_decisions
  add column expected_move_pct numeric(8, 6),
  add column estimated_round_trip_cost_pct numeric(8, 6),
  add column move_to_cost_ratio numeric(10, 4);

alter table public.agent_decisions
  add constraint agent_decisions_expected_move_pct_nonneg
    check (expected_move_pct is null or expected_move_pct >= 0),
  add constraint agent_decisions_estimated_round_trip_cost_pct_nonneg
    check (estimated_round_trip_cost_pct is null or estimated_round_trip_cost_pct >= 0),
  add constraint agent_decisions_move_to_cost_ratio_nonneg
    check (move_to_cost_ratio is null or move_to_cost_ratio >= 0);

comment on column public.agent_decisions.expected_move_pct is
  'Aggressive-only, null for every Balanced decision. Jev''s OWN prediction of the favorable move size (model/jev/entry-question.ts''s expected_move Score question, mapped through the pre-registered EXPECTED_MOVE_PCT_BY_SCORE_LEVEL table -- never a raw model number) -- deliberately NOT the same quantity as the deterministic ATR-derived target distance.';

comment on column public.agent_decisions.estimated_round_trip_cost_pct is
  'Aggressive-only, null for every Balanced decision. Deterministic fee+slippage round-trip cost, as a fraction (0.003 means 0.30%) -- the SAME quantity strategy/aggressive/protection.ts''s tradeability floor and model/jev/management-question.ts''s estimatedRoundTripCostPct already compute.';

comment on column public.agent_decisions.move_to_cost_ratio is
  'Aggressive-only, null for every Balanced decision. expected_move_pct / estimated_round_trip_cost_pct, computed from Jev''s OWN expectation (never the deterministic target) -- the diagnostic that later separates "Jev was directionally wrong" from "the predicted moves never cleared friction."';

-- ---------------------------------------------------------------------------
-- positions.initial_risk_usd -- the ONE immutable ruler for R-multiple
-- tracking over the life of a position (strategy/aggressive/
-- protection.ts's computeRMultiple / deterministicTighten). Captured
-- ONCE at original entry (quantity x |entry - originalStopLossPrice|),
-- and NEVER redefined by a subsequent ADD or REDUCE -- an explicit fix
-- for the "what is 1R after an ADD?" ambiguity raised during plan
-- review. Nullable: every position opened before this migration has no
-- captured value (their R-multiple is simply never computed -- they
-- predate Aggressive's deterministic tightening entirely, and Balanced
-- never reads this column at all).
-- ---------------------------------------------------------------------------

alter table public.positions
  add column initial_risk_usd numeric(20, 8);

alter table public.positions
  add constraint positions_initial_risk_usd_nonneg
    check (initial_risk_usd is null or initial_risk_usd >= 0);

comment on column public.positions.initial_risk_usd is
  'quantity x |entry_price - stop_loss_price| AT ORIGINAL ENTRY, captured once and never updated by a subsequent ADD/REDUCE -- the immutable basis for R-multiple tracking (strategy/aggressive/protection.ts). Null for every position opened before 2026-09-23 and for every Balanced-opened position, neither of which uses R-multiple tightening.';
