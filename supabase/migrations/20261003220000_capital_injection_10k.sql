-- ============================================================================
-- Capital injection: +$10,000 into the paper portfolio (2026-10-03),
-- explicit user instruction: "Currently 10k is the total budget and 3k is
-- in BTC and 3k is in ETH, so no new trades can be done for the new
-- assets, add 10k into the total budget increasing it to 20k."
--
-- Context: ASSET-4 (same-day migration 20261003210000) widened the traded
-- universe to BTC/ETH/SUI/AVAX, but BTC and ETH already held their
-- pre-existing ~30%-each positions from before that change, leaving no
-- notional headroom under the 60% total_notional cap for SUI/AVAX to
-- open — exactly the "transitional behavior" the ASSET-4 plan flagged as
-- expected to resolve once a slot frees. This migration resolves it
-- directly by growing the budget instead of waiting for a position to
-- close, per explicit user choice.
--
-- portfolios.cash is the ONLY column that actually matters for sizing —
-- NAV (cash + open positions' current value) is what every risk cap in
-- src/shared/risk/sizing.ts is computed as a PERCENTAGE of
-- (maxTotalNotionalPct, maxSingleTradePct, portfolioRiskCeilingMultiplier
-- x riskBudgetPct x nav, etc.) — so crediting cash directly and
-- proportionally raises every cap's dollar room, with zero other code or
-- config change required. This is paper money in a simulation
-- (trading-domain-contract.md) — not a real transfer of funds.
--
-- portfolios.starting_capital is bumped by the SAME delta, not left at
-- 10000, so the Home screen's cumulative-return stat
-- (pnl / startingCapital, src/features/home/home-screen.tsx:89) continues
-- to mean "return on capital actually contributed" rather than reading a
-- fabricated ~100% gain purely from this injection. agent_settings.
-- starting_capital is bumped identically for consistency even though no
-- code currently reads it (grepped: zero consumers, unlike portfolios.
-- starting_capital) — kept in sync rather than left to drift stale, the
-- same discipline this project applied to decision_interval_minutes
-- after the column-drift bug found 2026-09-24.
--
-- peakNav (src/shared/risk/gate.ts's drawdown breaker) is read live from
-- nav_snapshots' historical max, not from a config column — raising NAV
-- only ever makes the breaker LESS likely to trip, never more, so no
-- special handling is needed there.
-- ============================================================================

update portfolios set
  cash = cash + 10000,
  starting_capital = starting_capital + 10000;

update agent_settings set
  starting_capital = starting_capital + 10000;
