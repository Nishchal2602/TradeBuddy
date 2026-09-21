-- ============================================================================
-- Follow-up to 20260921060026_trading_strategy_v1.sql, applied separately
-- rather than editing that already-pushed migration (ai-workflow-rules.md
-- Protected Files: an applied migration changes only via a new one).
--
-- The two new sizing-cap candidates (portfolio_risk, total_notional — the
-- prior migration's size_cap_applied CHECK already allows both tags) had
-- no denormalized "what was the ceiling" column of their own, unlike the
-- two pre-existing sizing candidates that DO: effective_single_trade_cap_pct
-- and effective_asset_exposure_cap_pct. Every agent_decisions row already
-- carries its full risk-config context regardless of outcome (see
-- decisions.test.ts: "a rejected proposal must still carry every
-- effective_* config value") — these two close that gap for the new caps
-- on the same terms: NOT NULL, stamped on every row.
-- ============================================================================

alter table public.agent_decisions
  add column effective_portfolio_risk_ceiling_pct numeric(6,4),
  add column effective_max_total_notional_pct numeric(6,4);

update public.agent_decisions set
  effective_portfolio_risk_ceiling_pct = 0,
  effective_max_total_notional_pct = 0
where effective_portfolio_risk_ceiling_pct is null;

alter table public.agent_decisions
  alter column effective_portfolio_risk_ceiling_pct set not null,
  alter column effective_max_total_notional_pct set not null,
  add constraint agent_decisions_effective_portfolio_risk_ceiling_pct_range
    check (effective_portfolio_risk_ceiling_pct >= 0),
  add constraint agent_decisions_effective_max_total_notional_pct_range
    check (effective_max_total_notional_pct >= 0 and effective_max_total_notional_pct <= 1);
