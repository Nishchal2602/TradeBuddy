# DT-1 pre-registration (2026-10-09)

**Committed BEFORE any full DT-1 run executes** (plan §12 Phase 2, the hard gate). This document freezes every remaining DT-1 parameter not already frozen by Stage A (`dt1-pre-registration-stage-a-2026-10-08.md`) or Stage B (`dt1-power-simulation-stage-b-2026-10-09.md`). Nothing here may be amended after a result is viewed except by a dated, visibly-appended amendment, per the project's own standing discipline.

## 0. Explicit framing — DT-1 runs UNDERPOWERED, by user decision

The Stage B power simulation found **S11 FAILS, decisively and non-fragile-ly, across the entire pre-registered ρ̄ grid**: power at the frozen Sharpe=0.54 hurdle is 3.0–4.0% at every ρ̄ point tested, against A10's 80% threshold. Per A10's own frozen language: *"If power is below 80%: label the study underpowered for the economic advancement decision. DT-1 may still run and report estimates and intervals, but it cannot earn a 'supported' verdict on this study's evidence."*

**User decision (2026-10-09, explicit): proceed with DT-1 anyway, as a deliberately underpowered research exercise — report E1/E2 honestly as intervals, never claim "Supported," and never relax A10's threshold or re-scope to manufacture a pass.** This is option 3 of the three the Stage B report named, chosen in full awareness of the power finding. Every section below is written on that basis. The permissible claim (plan §2.2) is unchanged by this decision — if anything, it is the claim this document exists to keep the eventual write-up inside.

## 1. The strategy — frozen by content hash

`r4-daily-trend@5641c13b3b6886aa40fab351382895a4bc2a47d9d223010031fc90536e876e11`

Recovered from committed code only (plan stop gate S1), pinned field-by-field by `daily-trend-config.test.ts`, reproduction-gate-verified against R4's own published numbers three separate times (S1b). Full literal: `src/shared/strategy/daily-trend-presets.ts`'s `R4_DAILY_TREND_CONFIG`. Includes the full risk envelope as transcribed (the undocumented aggressive-tier `effectiveRiskBudgetPct=0.0075` / `maxTotalNotionalPct=0.60` divergence from `STRATEGY_PROFILES.balanced`, preserved verbatim, never corrected) — this resolves open item A5 in practice: the hash covers strategy constants AND the risk envelope together, as one unit, because that is what was actually implemented and is what R4 actually ran.

`canOpen` membership seam: proven inert by default (S1c identity gate, 4 tests, byte-identical reproduction of every existing fixture with the predicate omitted or always-true). DT-1 is the one caller that ever passes a non-trivial predicate.

## 2. Universe rules (§5.3)

| Rule | Value |
|---|---|
| Venue / quote | Binance spot, USDT pairs only |
| Formation | 00:00 UTC, 1st of each month |
| Information cutoff | bars with `close_time <` formation instant only |
| Minimum history | ≥180 days of daily bars at formation |
| Active at formation | data presence for the window, never `exchangeInfo` status alone (P1c: `BREAK` can mean "delisted 35 days ago") |
| Ranking | mean daily quote volume (USD), trailing 30 calendar days |
| Size | `N = min(20, eligible count)` |
| Membership effect | gates new OPENs only, via the `canOpen` seam. Never forces an exit. An asset already held runs to its own R4 exit (stop/target/regime-flip) regardless of universe status. The one non-R4 close is `delisted_close` — a data fact, not a rule |
| `universe_version` / `mapping_version` | **`dt1-v3`** — the verified-clean, canonical version (coefficient-of-variation sweep confirmed no residual stablecoin/fiat contamination; `dt1-v1`/`dt1-v2` preserved as superseded audit artifacts, never deleted) |

**Named exclusion list, frozen** (P1c census, Stage A):
- **11 leveraged tokens**: `BTCUPUSDT`, `BTCDOWNUSDT`, `ETHBULLUSDT`, `ETHBEARUSDT`, `EOSBULLUSDT`, `EOSBEARUSDT`, `BULLUSDT`, `BEARUSDT`, `LINKDOWNUSDT`, `XRPUPUSDT`, `XRPDOWNUSDT`
- **4 stablecoins** (census pool): `PAXUSDT`, `BUSDUSDT`, `USTUSDT`, `USDSOLDUSDT` — plus `USD1`, `RLUSD`, `U`, `EUR` found by the later coefficient-of-variation sweep and folded into `dt1-v3`'s classification
- **1 exchange-affiliated token** (new, 6th named category, Stage A sign-off): `WRXUSDT`
- 7 renames mapped to one underlying, live-confirmed, non-overlapping date ranges (`BCCUSDT`/`BCHABCUSDT`→`BCHUSDT`, `VENUSDT`→`VETUSDT`, `LENDUSDT`→`AAVEUSDT`, `ERDUSDT`→`EGLDUSDT`, `RNDRUSDT`→`RENDERUSDT`, `AGIXUSDT`→`FETUSDT`)
- `TONUSDT` retained as an ordinary candidate with a footnote: its `BREAK` status is almost certainly a jurisdiction-specific restriction, not a project failure — included, not excluded, per the eligibility rule (data presence, never status alone)

**No frozen fallback is needed.** Phase P1/P1c confirmed PIT is feasible (stop gate S3 did not fire) — DT-1 runs on the true, mechanically-reconstructed point-in-time universe (`dt1-v3`), not the survivorship-biased fallback. §6.8's asymmetric-fallback-reading clause and open item A3 are therefore moot for this run.

**Measured, not assumed, for the frozen window (2018-03 through 2026-09, 103 months / 3,136 days):** N ramps 2→20 over the first 17 months, then holds flat at exactly 20 for the remaining 86 months with zero dips (2020 crash, 2021 bull run, full 2022 bear market all included); 159 distinct underlying assets have held an external-sleeve slot at some point.

## 3. Contract mapping

`mapping_version = 'dt1-v3'`, the live `research_contracts` table — frozen before this run, amended only by a dated append with affected results re-run (none anticipated; the coefficient-of-variation sweep that produced `dt1-v3` already re-verified clean at a widened 50% threshold). The data-snapshot fingerprint (below, item 8) is computed at run time directly against this version; a mismatch halts the run rather than proceeding on stale data.

## 4. Asset roles (strictly separated)

| Role | Assets | Use |
|---|---|---|
| Development / discovery | BTC, ETH | R4's own discovery assets. Re-run for continuity only. **Excluded from the primary result** |
| **External generalization — THE PRIMARY RESULT** | Every `dt1-v3` universe member except BTC/ETH (~18 sleeves, varying per formation month per the measured N trajectory) | E1, E2, all primary statistics |
| Secondary / descriptive | Full universe including BTC/ETH | Reported as context only |

## 5. Execution — frozen, identical to R4

Entries/regime-flip exits at `bar.close`; pessimistic intrabar ordering (long: `bar.low` tested before `bar.high`); stop fills at the observed price (`bar.low`, models gaps), take-profit fills at the level (no windfall); warm-up 50 closed daily + 15 closed 4h bars; ATR Wilder, period 14, on the 4h series; stop `max(2.0×ATR%, 2.5%)`; take-profit `6.0×stop`. Fee 10 bps, slippage 5 bps, flat and global — **not** per-asset, a deliberate departure from historical-fee-schedule realism in favor of exact R4 comparability (documented limitation, not an oversight).

## 6. Funding

**Zero in the primary** — correct for a spot long/flat strategy; R4 paid zero. The post-hoc overlay (`research/funding-overlay.ts`, new) is strictly separate: computed only after the trade ledger is final, structurally incapable of feeding back into entries/exits/sizing/eligibility, labelled "not R4 semantics" everywhere it appears, and reports coverage explicitly (assets with no perp funding series are named and excluded from the overlay, never imputed as zero).

## 7. Sleeve and portfolio construction (§5.4/§5.4b)

- **Primary = N single-asset sleeves** (one `runDailyTrendBacktest` call per external-universe asset, $10,000 starting capital each, byte-identical in shape to how R4 itself called the engine), pooled for descriptive trade-level analysis. Never a shared-NAV multi-asset portfolio (would newly activate `portfolio_risk`/`total_notional`, silently changing sizing).
- **The equal-weight portfolio curve** (`research/portfolio-curve.ts`, new): `R(d) = mean over sleeves in that month's universe membership of sleeve_i's own daily NAV return`, cumulated. Built from **returns only** — no capital transfer, no position resize, no sleeve ever sees another sleeve's capital. A sleeve flat on day *d* contributes 0. This is THE decision-bearing series for E1, D1, D2.
- **Known, reported bias**: each sleeve carries R4's own unmodified drawdown breaker (0.5 floor). A tripped sleeve stops opening permanently and its subsequent trades never enter the pool — biasing pooled expectancy upward, since breakers trip overwhelmingly in losing sleeves. Reported per sleeve: trip date, trading days lost, share of eligible asset-days truncated. A breaker-disabled secondary run quantifies the magnitude, clearly labelled not-R4-semantics, never co-primary (A9, confirmed).

## 8. Data snapshot fingerprint (§5.1)

**Method frozen now; value recorded automatically at Phase 5 run time.** `run-dt1.ts` computes, per `(asset, timeframe)` in scope: row count, `min(open_time)`, `max(close_time)`, and a content hash over the ordered `(open_time, close)` pairs — then refuses to run if any value differs from what Phase 4's integrity pass recorded immediately before. Since `historical_bars` is append-only and the `dt1-v3` universe build is already complete and verified clean, this is a consistency guard against concurrent mutation, not an expectation of change.

## 9. Statistics — the decision series, named explicitly (§6.3, the item whose omission caused the design's earlier self-contradiction)

| # | Estimate | Role | Computed on | Interval |
|---|---|---|---|---|
| **E1** | Annualized Sharpe | **PRIMARY** | Daily returns of the equal-weight external-sleeve portfolio curve | Stationary block bootstrap (Politis-White automatic block length), 10,000 resamples, 90% CI |
| **E2** | Pooled expectancy in R | **PRIMARY** (continuity with R4) | All closed trades, every external sleeve, pooled with NO minimum trade count (pooling truncation is itself a survivorship-biasing selection effect) | n_eff-corrected interval AND a block-bootstrap CI; bootstrap interval is the one quoted in the claim if the two disagree (heavy right-skew from the 6R take-profit) |
| D1 | Deflated Sharpe Ratio | diagnostic | E1's series, per-period, daily-resampled (corrected scale, §6.7 units fix) | at N=1 (primary diagnostic count) and N=14 (maximally-conservative bound), both reported |
| D2 | CPCV Sharpe distribution | diagnostic (stability check, not a leakage control — DT-1 fits no parameter) | E1's series, 10 groups / 2 test groups / 14-day embargo, C(10,2)=45 paths | median + IQR across folds |
| D3 | `expectancyR.actionable` | diagnostic | E2's population, n_eff per item 10 below | MDE, alpha 0.10 / power 0.80 |

**Per-asset display**: minimum 10 closed trades to print a per-asset point estimate; below that, "insufficient" — this gates DISPLAY only, never POOLING (E2 pools every trade regardless).

## 10. n_eff methodology (§6.4, frozen in full, no discretion left at run time)

- Observation unit: one closed trade's net R (`tradeR`).
- Correlation definition: contemporaneous holding-period overlap, not entry month or asset identity.
- Cluster rule: connected components of overlapping `[openedAt, closedAt)` windows (merge-intervals sweep) — the live-validated rule from `research/dependence/icc-cluster.ts`.
- Estimator: one-way random-effects ANOVA ICC with the unequal-cluster-size design effect (`m_a = Σmᵢ²/Σmᵢ`), floored at `max(ρ_intra, 0)` so `n_eff ≤ N` always.
- Computed **once**, over the full training window, over the full pooled population in scope for the primary — never per fold, never per asset, never selected from multiple candidate windows.
- **Three estimators, for E2 only** (E1 uses the bootstrap alone, no tie-break needed): overlap-clustered ICC, Newey-West on the corrected monthly-closing-month series (automatic lag, `L=floor(4·(T/100)^(2/9))`, small-sample `T/(T-1)` variance correction, Student-t(T-1) reference), stationary block bootstrap (Politis-White automatic length) on the daily portfolio curve. **Tie-break**: all three exclude zero in the same direction → significant in that direction; any one interval includes zero → not significant; two exclude zero in opposite directions → **"estimator conflict,"** reported and investigated, never resolved by majority.
- Reported alongside, never substituted: raw N, the naive asset-level `N/(1+(N-1)ρ̄)` using the real measured ρ̄ (0.459 full-population / 0.498 current-snapshot, both already measured 2026-10-09), for comparability with the ASSET-4 figure.

## 11. Corrected Deflated Sharpe Ratio (§6.7, units already fixed 2026-10-08)

`sharpePerPeriod`, not annualized, fed to `deflatedSharpeRatio`. Trial count: **N=1 primary** (DT-1 tests one pre-specified hypothesis on assets that played no part in selecting it — the standard holdout treatment; `SR0=0` at N=1, so DSR reduces to a skew/kurtosis-adjusted significance test of Sharpe>0), **N=14 reported alongside** as the maximally-conservative cumulative bound (full `trial-registry.json`, daily-resampled Sharpes throughout so cadence never contaminates the variance term). If the two disagree, both are reported with equal prominence — never resolved silently in favor of the friendlier number.

## 12. Economic advancement framework (§6.8, scale-free, frozen)

- `σ_max = 25%` annualized (frozen).
- Required Sharpe `= 13.5% / 25% = 0.54` — Sharpe needs no further scaling (scale-invariant under linear re-leveraging at zero risk-free rate).
- MaxDD veto: `≤30%` at the 90th percentile of each bootstrap resample's daily-return path scaled by `L = σ_max/σ_realized`.
- Horizon: full-period annualized is the decision bar; rolling 12-month windows are diagnostic only (trend-following strategies are known to fail a rolling-consistency bar even when genuinely edge-positive).
- Robustness condition: with the single best calendar year removed, E1's point estimate remains positive.
- **"Supported" requires all three — condition 1 (E1's CI clears 0.54) AND condition 2 (MaxDD veto not triggered) AND condition 3 (robustness holds).** Given the explicit underpowered framing in §0, this document records in advance that **DT-1 is not expected to, and is not required to, achieve "Supported."** Its reportable output is the interval itself, honestly stated — per A10, this run cannot earn "Supported" regardless of where the point estimate lands, because the power simulation already showed the design cannot resolve the required effect at 80% confidence. A positive point estimate inside the band would be reported as suggestive and underpowered, not as validated.

## 13. R4's three-clause rule — secondary diagnostic only, never decision-bearing

`expectancyR.actionable` (alpha 0.10/power 0.80, n_eff) AND DSR>0.95 (both N=1 and N=14 reported) AND CPCV median sign agreement — computed and reported in full, for continuity with R4 and to keep the multiple-testing correction visible. Does not determine the conclusion (§2.0's own reasoning: this rule's `SR0` benchmark can sit above the realistic crypto-trend Sharpe range and fail regardless of whether the strategy works).

## 14. Complete secondary analysis list (§6.9) — nothing added later without a dated amendment

Per-year breakdown of E1/E2 with per-year n/N; leave-one-year-out recomputation of E1/E2 (nine passes, one per calendar year — directly addresses 2020–21 concentration risk); contribution concentration (share of total P&L from best year / best quarter / top 5% of trades); per-asset breakdown with per-asset MDE (≥10-trade display floor); BTC/ETH continuity re-run; full-universe pooled including BTC/ETH; funding overlay with named coverage exclusions; `delisted_close` count and P&L impact; universe turnover (how often an asset leaves mid-position); drawdown-breaker trip report + breaker-disabled quantification run; realized N per formation date over time; one uniform higher-flat-slippage stress (never a per-asset tuning knob); exits-by-type; cap-binding distribution; all three n_eff estimators reported with raw inputs.

## 15. No promotion

No DT-1 outcome — regardless of where E1/E2 land — promotes anything to paper or live trading. This is advisory input to a separately human-reviewed decision, and given §0's framing, the honest expectation is that this run produces a wide, informative interval rather than a verdict. That is not a failed experiment; it is the exact outcome the Stage A/B architecture exists to surface before a longer or wider re-scope is considered.

---

**Gate status: committed. Phase 4 (data integrity validation) and Phase 5 (the DT-1 run itself, `research/run-dt1.ts`) may now proceed.**
