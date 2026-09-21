-- ============================================================================
-- Trading Strategy V1 (context/specs/trading-strategy-v1.md) — schema
-- support for the deterministic daily-trend regime strategy: a raised
-- take-profit ceiling (blocker B4), portfolio-level risk controls (§17),
-- a news-veto kill switch (§10, §23 H4), and two new columns making the
-- H4/H5 falsification hierarchy directly queryable rather than buried in
-- jsonb (§23).
--
-- Deliberately NOT touched here, per the same document's own distinction
-- between strategy constants and domain constraints: min_stop_loss_pct
-- (the strategy's 2.5% floor is a strategy constant, agent-cycle/
-- strategy/rules.ts, not a domain bound), max_stop_loss_pct (an
-- over-15% stop should be rejected by the existing gate, not silently
-- widened), risk_appetite's three-tier vocabulary, and every position/
-- trade/decision provenance rule (all locked, trading-domain-contract.md).
-- ============================================================================

-- B4: a 6x-stop take-profit exceeds the old 50% ceiling whenever atrPct >
-- ~4.17%, which would silently reject opens in exactly the volatile
-- conditions this strategy needs to trade in. Raised, not removed — the
-- agent_settings_tp_bounds_valid check constraint (min < max) still
-- applies unchanged.
update public.agent_settings set max_take_profit_pct = 0.9000;

alter table public.agent_settings
  -- §17.1 — the primary portfolio-level control. A MULTIPLIER of the
  -- active risk appetite's own riskBudgetPct, not a flat percentage: the
  -- ceiling scales with whichever appetite is configured, matching the
  -- spec's own worked example (balanced 0.50% budget x 1.5 = 0.75% NAV
  -- combined risk-at-stop across all open positions + the candidate).
  -- Applied as a NEW sizing-cap candidate inside the existing min-of-N
  -- applySizingCaps pattern (src/shared/risk/sizing.ts) — never a
  -- correlation estimate (§17.1's own reasoning: correlation is
  -- time-varying; risk-at-stop is already known exactly per position).
  add column portfolio_risk_ceiling_multiplier numeric(4,2) not null default 1.50,

  -- §17.2 — a secondary, independent control: bounds total DOLLAR
  -- exposure regardless of stop distance (distinct from the risk-at-stop
  -- ceiling above, which bounds LOSS if every stop hits simultaneously).
  add column max_total_notional_pct numeric(6,4) not null default 0.3000,

  -- §17.3 — blocks new OPENs (never CLOSE, per §17.3's own explicit
  -- requirement) when NAV falls below this fraction of its own
  -- historical peak. Deliberately a floor-as-fraction-of-peak, not a
  -- "drawdown amount", so the number matches the spec's own wording
  -- ("NAV < 90% of peak NAV") without an inversion a future reader could
  -- misread.
  add column drawdown_breaker_floor_pct numeric(6,4) not null default 0.9000,

  -- §10 — news must be disableable without a code change: "the strategy
  -- explicitly allows the eventual outcome: remove news entirely if it
  -- provides no incremental value" (§23 H4). Default true: news veto
  -- stays active until H4 is actually evaluated.
  add column news_veto_enabled boolean not null default true,

  add constraint agent_settings_portfolio_risk_ceiling_multiplier_positive
    check (portfolio_risk_ceiling_multiplier > 0),
  add constraint agent_settings_max_total_notional_pct_range
    check (max_total_notional_pct > 0 and max_total_notional_pct <= 1),
  add constraint agent_settings_drawdown_breaker_floor_pct_range
    check (drawdown_breaker_floor_pct > 0 and drawdown_breaker_floor_pct < 1);

-- Two new sizing-cap tags for the portfolio-risk candidates above, added
-- to applySizingCaps' existing min-of-N candidate list (src/shared/risk/
-- sizing.ts) alongside the existing single_trade/asset_exposure/cash.
-- Postgres has no ALTER CONSTRAINT for a CHECK body (already hit once at
-- position_model.sql:110) — drop and re-add is the only path.
alter table public.agent_decisions
  drop constraint agent_decisions_size_cap_applied_valid;
alter table public.agent_decisions
  add constraint agent_decisions_size_cap_applied_valid
    check (size_cap_applied is null or size_cap_applied in (
      'single_trade', 'asset_exposure', 'cash', 'portfolio_risk', 'total_notional'
    ));

alter table public.agent_decisions
  -- Makes §23's falsification hierarchy directly queryable instead of
  -- parsing input_payload jsonb for every row. 'v0-gemini-originated' is
  -- an honest, distinct backfill label for the 2 pre-V1 rows that
  -- actually exist (Gemini originated those decisions outright; V1's
  -- deterministic regime rule did not exist yet) — never confused with a
  -- real V1 strategy_version value by construction.
  add column strategy_version text;
update public.agent_decisions set strategy_version = 'v0-gemini-originated' where strategy_version is null;
alter table public.agent_decisions alter column strategy_version set not null;

alter table public.agent_decisions
  -- §12/§23 H5 — nullable, not a false default: null means "no model call
  -- happened this cycle" (a HOLD candidate never reaches the veto step,
  -- §11's entry-trigger ordering), true/false means Gemini vetoed or
  -- confirmed. The 2 pre-V1 rows backfill to null for the identical
  -- reason strategy_version backfills separately above — there is no
  -- honest true/false value for a decision the old Gemini-originates
  -- design made outright, and null already means exactly "not
  -- applicable" for every other nullable column on this table.
  add column model_vetoed boolean;
