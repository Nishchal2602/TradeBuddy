-- ============================================================================
-- V0 seed: agent configuration + the single paper portfolio.
--
-- Split from the schema migration on purpose: the schema is structure, this
-- is policy. Every value below was an explicit decision, not a default picked
-- by the implementation — progress-tracker.md forbids resolving the open
-- questions by silently inventing behaviour.
--
-- Provenance of each value:
--   decision_interval_minutes  180   — 3h cadence (architecture.md § Scheduling)
--   assets                     BTC/ETH — V0 scope (project-overview.md)
--   starting_capital           10000 — user decision
--   max_position_pct           0.25  — project-overview.md § Risk
--   fee_bps                    10    — ~0.1%/side (project-overview.md)
--   slippage_bps               5     — ~0.05%/side (project-overview.md)
--   cooldown_minutes           360   — 6h / 2 cycles, user decision
--   risk_appetite              balanced — user chose appetite-driven confidence;
--                                        'balanced' is the mid setting and the
--                                        starting point, changeable from the UI
--
-- Two values below were NOT separately specified and are implementation
-- choices, flagged here so they are visible rather than buried:
--   news_lookback_overlap_minutes 15 — buffer so headlines landing near a
--       cycle boundary are not dropped when the interval changes.
--   max_data_staleness_minutes    30 — above this the cycle fails closed and
--       skips rather than trading on stale data (invariant 6).
-- ============================================================================

insert into public.agent_settings (
  decision_interval_minutes,
  news_lookback_overlap_minutes,
  max_data_staleness_minutes,
  assets,
  starting_capital,
  max_position_pct,
  fee_bps,
  slippage_bps,
  cooldown_minutes,
  risk_appetite,
  is_paused
) values (
  180,
  15,
  30,
  array['BTC', 'ETH'],
  10000.00000000,
  0.2500,
  10,
  5,
  360,
  'balanced',
  -- Starts paused: the agent must not begin trading the moment the schema
  -- lands. Unpause explicitly once the loop has been smoke-tested.
  true
);

insert into public.portfolios (name, starting_capital, cash)
values ('V0 Paper Portfolio', 10000.00000000, 10000.00000000);
