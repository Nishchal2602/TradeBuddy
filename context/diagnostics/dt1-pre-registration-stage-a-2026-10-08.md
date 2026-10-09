# DT-1 pre-registration — STAGE A (FROZEN 2026-10-08)

**2026-10-08.** Per the DT-1 plan's two-stage pre-registration split (§6.7b): Stage A freezes everything that does **not** depend on the real universe's own price data existing. Stage B (ρ̄/N/T measured from that data, the power simulation across both grids, and its stop-rule outcome) follows only after Stage A is frozen and the universe is built.

**STAGE A IS NOW FROZEN.** All five previously-flagged items were signed off explicitly on 2026-10-08, with one substantive decision on A10 (see §11 and the table at the end). Nothing in this document is reopened absent new evidence — per the plan's own stop gate S3b, a universe or methodology change contemplated after this freeze is a hard stop, not a revision. Everything else here reflects decisions already made explicitly in this review (committed in `5b8a5ef`..`29467bf`) and is not reopened either.

---

## 1. Strategy

**Config**: `r4-daily-trend@5641c13b3b6886aa40fab351382895a4bc2a47d9d223010031fc90536e876e11`

Recovered from committed code only (never documentation), per stop gate S1. Includes the full risk envelope verbatim from R4 (the aggressive-tier `effectiveRiskBudgetPct=0.0075` and `maxTotalNotionalPct=0.60`, preserved not corrected). Field-by-field pinning: `daily-trend-config.test.ts` (8 tests). `canOpen` membership-gate seam proven inert by default (S1c, 4 tests) — the strategy loop is unmodified, not merely asserted to be.

**A5 — resolved**: the hash includes the full risk envelope, not only the strategy constants. Confirmed by what is actually committed, not a separate design choice still open.

## 2. Universe

**Venue / quote**: Binance spot, USDT pairs only.

**Formation**: monthly, 00:00 UTC, 1st of month. Information cutoff: bars with `close_time` strictly before the formation instant.

**Eligibility**: ≥180 days of daily history; active at formation (data presence for the relevant window, never `exchangeInfo` status alone — P1c confirmed `BREAK` can mean "delisted 35 days ago," not "long dead").

**Ranking**: mean daily quote volume over the preceding 30 days. `N = min(20, eligible)`.

**A6 — CONFIRMED 2026-10-08**: rank the true top 20 **including** BTC/ETH (they are genuinely the most liquid; excluding them from the ranking step would silently redefine the universe), then exclude them from the **primary** analysis only, leaving ~18 external sleeves. The secondary full-universe analysis (§6.9) includes them.

**Exclusion list (A1)** — census-derived, named, not a description (`dt1-phase1c-pit-census-2026-10-08.md`):

- **11 leveraged tokens** (Binance's own 3x long/short products, excluded by construction): `BTCUPUSDT`, `BTCDOWNUSDT`, `ETHBULLUSDT`, `ETHBEARUSDT`, `EOSBULLUSDT`, `EOSBEARUSDT`, `BULLUSDT`, `BEARUSDT`, `LINKDOWNUSDT`, `XRPUPUSDT`, `XRPDOWNUSDT`
- **4 stablecoins**: `PAXUSDT`, `BUSDUSDT`, `USTUSDT`, `USDSOLDUSDT`
- **`WRXUSDT` — CONFIRMED EXCLUDED 2026-10-08.** **"Exchange-affiliated token" is now a sixth named exclusion category**, alongside leveraged-index products / stablecoins / wrapped tokens / LSTs, applied consistently rather than as a discretionary per-asset call. Rationale: an exchange token's value is tied to a specific platform's own fortunes rather than being an ordinary open-market asset. Any future census hit matching this category (a token whose issuing or namesake entity is itself an exchange) is excluded under the same rule, not re-litigated asset by asset.

**Contract/underlying mapping** — 7 renames, every one live-verified against `exchangeInfo` (not assumed):

| Old symbol | New symbol | Verified |
|---|---|---|
| `BCCUSDT` | `BCHUSDT` | `TRADING` |
| `BCHABCUSDT` | `BCHUSDT` | same underlying as above |
| `VENUSDT` | `VETUSDT` | `TRADING` |
| `LENDUSDT` | `AAVEUSDT` | `TRADING` |
| `ERDUSDT` | `EGLDUSDT` | `TRADING` |
| `RNDRUSDT` | `RENDERUSDT` | `TRADING` |
| `AGIXUSDT` | `FETUSDT` | `TRADING` — corrects an initial wrong guess (a separate `ASI` ticker), caught by verifying rather than asserting |

**Fallback universe (A3)**: specified per the original plan (a mechanically-generated, frozen-observation-window fallback, with the pre-registered asymmetric reading — a negative result from it is meaningful, a positive one is not sufficient to claim generalization). **Status: almost certainly moot.** P1 found PIT is feasible (stop gate S3 did not fire) and P1c's census found the scrubbing risk for DT-1's actual candidate pool negligible. The fallback stays pre-registered regardless, per the plan's own discipline of never leaving a contingency unspecified just because it looks unlikely to trigger.

## 3. Cost model — unchanged from R4

Flat 10bps fee, 5bps slippage, global (not per-asset). Funding excluded from the primary (correct for a spot long/flat strategy — R4 paid zero and zero is right); a strictly post-hoc, architecturally-enforced overlay answers the forward perp question separately and can never feed back into entries, exits, sizing, or eligibility (§5.6).

## 4. Statistical contracts (§6.3–6.4)

**Primary estimates**: E1 (annualized Sharpe, computed on the equal-weight external-sleeve portfolio's daily returns, bootstrap CI) is the headline. E2 (pooled expectancy in R, n_eff-corrected) is retained for continuity with R4's own reporting units. E1 and E2 weight the universe differently (E1 per-sleeve-over-time, E2 per-trade) — a second, independent reason E1 is primary, not just the economic framework's own denomination.

**n_eff (E2)**: one closed trade's net R is the observation; correlation is contemporaneous exposure via overlap-clustered ICC (not entry-month); unequal-cluster-size design effect (`m_a = Σmᵢ²/Σmᵢ`); `max(ρ_intra,0)` floor so `n_eff ≤ N` always; estimated once over the full training window, never per-fold.

**Newey-West (E2)**: automatic lag rule `L=floor(4·(T/100)^(2/9))` (≈4 at the realistic `T≈108` months), no discretion left; small-sample correction via `T/(T-1)` variance scaling and a Student-*t*(`T-1`) reference. Series construction corrected: each trade assigned only to its closing month; `E2 = (Σ monthly sums of R) / (Σ monthly trade counts)`; standard error via the delta method on the HAC-estimated variance/covariance of the two monthly series, with zero-trade months correctly defined as `(0,0)`, never dropped.

**Block bootstrap**: 10,000 resamples, 90% CI. **A7 — CONFIRMED 2026-10-08**: mean block length via the Politis-White automatic selection algorithm. The *algorithm* is frozen now, by this sign-off; its *numeric output* is computed later, from the real assembled portfolio series once it exists (Stage B) — freezing the algorithm now and deferring only the number it produces is the point, not a gap.

**Direction-disagreement rule (E2 only — E1 has a single interval method and needs no tie-break)**: significant only if all three E2 intervals exclude zero in the same direction; any interval including zero → not significant; two excluding zero in opposite directions → "estimator conflict," reported as its own finding, never resolved by majority.

**Minimum trade count (A4, closed)**: no minimum for pooling, ever — excluding low-trade assets would itself be a survivorship-biasing selection effect. Minimum of 10 closed trades for **per-asset display only**; below that, "insufficient."

**CPCV**: parameters preserved from R4 (10 groups, 2 test groups, 14-day embargo), reframed as a block-subsample stability diagnostic rather than a leakage control, since DT-1 fits nothing — the config is frozen from R4.

## 5. Economic advancement framework (§6.8) — scale-free, not sizing-dependent

- `σ_max = 25%` annualized (frozen).
- Required Sharpe `= 13.5% / 25% = 0.54`. Compared directly against E1 — no scaling needed, since Sharpe is scale-invariant under re-leveraging at the zero risk-free rate this project's paper cash already implies.
- MaxDD veto: `≤30%`, measured as the 90th percentile of `L`-scaled (`L=σ_max/σ_realized`) bootstrap-resample drawdowns.
- Horizon: full-period annualized is the decision bar. Robustness condition: with the single best calendar year removed, the point estimate must remain positive. Rolling 12-month results (share of positive windows, worst window) reported as diagnostics only, never decision-bearing.
- **"Supported" requires all three**: E1 above 0.54, MaxDD veto not triggered, robustness condition holds. Any one failing → not supported.
- Two checks to run once real E1 data exists (not resolvable now): gross exposure stays under 100% per sleeve when scaled to `σ_max`; the zero-risk-free-rate assumption is stated explicitly, not silently assumed.

**A8 — closed.** This was the single most important open item in the original review package and is now resolved in full, including the scale-free reformulation that fixed a real circular-dependence-on-sizing error (the first-draft formula made the bar depend on R4's own frozen position sizing — identical to the Deflated Sharpe trap in different clothing).

## 6. DSR — demoted to a secondary diagnostic, not the primary decision rule

Reported in full per §6.3/§6.6: `expectancyR.actionable` at n_eff; DSR>0.95 on E1's daily-resampled per-period series at both N=1 and N=14; CPCV median sign agreement. Concrete justification for the demotion, verified at full precision: BTC's daily-trend per-period Sharpe (+0.0214) sits against an `SR0` benchmark of 0.0949 — annualizing that benchmark back (≈1.81) lands **above the realistic 0.5–1.2 crypto-trend range**, meaning this clause could never have passed regardless of whether the strategy actually works.

**A9 — CONFIRMED 2026-10-08**: the per-sleeve drawdown-breaker truncation bias (R4's own `drawdownBreakerFloorPct=0.5` halts a losing sleeve permanently, biasing pooled expectancy upward) is distinct from the MaxDD veto above (which measures drawdown on the bootstrap-*scaled* series, not the breaker-truncation effect itself). **The primary keeps R4's exact risk breaker, unmodified.** The breaker-disabled run is a **secondary quantification of the bias's magnitude only — never co-primary, never substituted into the primary estimate.**

## 7. Trial registry and counting (§6.6)

`context/research/trial-registry.json` — 26 R4 entries, daily-resampled Sharpes, config hashes where they exist (`null` for the 11 ad hoc V4 variants never given a committed preset). DT-1 is trial 14 if counted cumulatively.

**Primary trial count for DT-1's own DSR diagnostic: N=1** (one pre-specified hypothesis, tested on assets that played no part in selecting it — the standard treatment of a holdout test). **N=14 reported alongside** as the maximally-conservative cumulative bound. If the two disagree, that disagreement is reported prominently, never resolved silently in favor of the friendlier number.

## 8. Data snapshot fingerprint

Per `(asset, timeframe)`: row count, `min(open_time)`, `max(close_time)`, and a content hash over the ordered `(open_time, close)` pairs — computed once the universe's own historical bars are ingested (Phase 3), not yet possible.

## 9. Decision rule

**Primary conclusion**: E1 and E2 with their intervals. Advancement judged against §5 above (the economic framework) — three pre-registered outcomes (above the band / overlapping / below), with the "below" outcome treated as meaningful negative evidence, not a non-result.

**R4's three-clause rule**: reported in full as a secondary, non-decision-bearing diagnostic, at both N=1 and N=14.

**No DT-1 result promotes anything to paper or live trading.** Advisory input to a separately human-reviewed decision, always.

## 10. Secondary analyses (§6.9, all pre-registered, none decision-bearing)

Per-year breakdown + leave-one-year-out · contribution concentration (best year/quarter/top-5%-of-trades P&L share) · per-asset breakdown (≥10-trade display floor) · BTC/ETH continuity re-run · full-universe pooled (incl. BTC/ETH) · equal-weight sleeve equity curve · funding overlay with coverage · `delisted_close` count and P&L impact · universe turnover · drawdown-breaker reporting (sleeves tripped, dates, trading days lost) + the breaker-disabled run (§6 above) · realized N per formation date over time · one uniform flat-slippage stress · exits-by-type · cap-binding distribution · all three n_eff-adjacent estimators reported together with raw N, `m_a`, `ρ_intra`, DEFF.

## 11. Power simulation — Stage B, not frozen here

Specified in full (§6.7b): DGP measured from R4's own real trade population (skew/kurtosis) and BTC's own real regime-timing sequence (temporal/cross-sectional structure); `ρ̄` measured from the real universe's price data (not borrowed from ASSET-4) **once it exists**, swept across `{0.5, 0.65, 0.8}`; Sharpe grid **`{0, 0.3, 0.5, 0.54, 0.8, 1.2}`** — widened from the plan's original `{0, 0.3, 0.5, 0.8, 1.2}` by inserting **0.54 exactly** (see A10 below: the economic hurdle is computed *at* 0.54, not interpolated from the nearby 0.5 grid point).

**AMENDMENT, 2026-10-09 (dated, transparent, the frozen grid itself untouched).** `ρ̄` was measured from the real universe (`dt1-universe-measurements-2026-10-09.md`): 0.459 (full 9-year external-sleeve population) to 0.498 (current snapshot), stable in `[0.46, 0.50]` across every methodology tried — at or below this grid's own frozen floor of 0.5. Per explicit user decision: **the original pre-registered `{0.5, 0.65, 0.8}` grid is retained exactly as frozen**, and **`0.45` is added as a fourth, explicitly-labeled transparency point** so the simulation's sensitivity sweep also covers the real measured region — `ρ̄ ∈ {0.45, 0.5, 0.65, 0.8}` going forward. This is reported as an addition, not a substitution: `0.45` is never used in place of the three frozen points, and neither A10's 80% threshold nor the Sharpe=0.54 hurdle changes.

**A10 — CONFIRMED 2026-10-08. Minimum economic power threshold: 80%, evaluated at true Sharpe = 0.54 (the exact economic hurdle, §5 above), not at 0.5.**

**The rule, frozen exactly, with no further discretion left at Stage B:**

1. **Primary power threshold**: at least **80%** probability that the pre-registered E1 economic-advancement criterion (§5 — E1 above 0.54, MaxDD veto not triggered, robustness condition holds) is satisfied, when the simulation's true input Sharpe is **0.54**.
2. **Implementation**: `0.54` is an explicit point on the simulation's Sharpe grid (see the widened grid above) — never interpolated from the neighboring `0.5` point. This removes a free choice (which interpolation method, what error it introduces) that would otherwise exist at the exact hurdle value that matters most.
3. **If power at Sharpe=0.54 is below 80%**: DT-1 is labeled **underpowered for the economic-advancement decision**. DT-1 may still run in full and report its estimates and intervals (E1, E2, with their CIs) — those remain valid descriptive output — but **it cannot earn a "supported" verdict on this study's evidence alone.** This is not a stop on running DT-1; it is a pre-committed cap on what conclusion the run is allowed to produce.
4. **Sensitivity**: power at Sharpe=0.54 is computed and reported at **all four** `ρ̄` grid points (`{0.45, 0.5, 0.65, 0.8}` — `0.45` added 2026-10-09 as a transparency amendment after the real measurement came back at/below the original floor; see the amendment note above). If the 80%-threshold verdict (pass/fail) changes across that grid, this is reported explicitly as **"power conclusion: fragile"** in the Stage B write-up — never silently resolved by picking whichever `ρ̄` is most convenient.
5. **No threshold changes after seeing DT-1's actual performance, ever.** 80% is frozen by this sign-off. A different number proposed after the power-simulation's real output exists, or after DT-1's own result exists, is not a refinement — it is exactly the threshold-relaxation-to-manufacture-a-pass that stop gate S11 and the plan's own "never relax a threshold" instruction forbid.

**Why 80% and not the originally-proposed 50%**: 50% would mean DT-1 is as likely to fail to detect a real, at-the-hurdle effect as to detect it — a coin flip is not a basis for a "supported" verdict on a question this consequential (whether a strategy advances past a research gate). 80% is the conventional minimum for a power analysis to be considered informative at all, and is consistent with the power convention already adopted elsewhere in this plan (§6.4, alpha=0.10/power=0.80 for the n_eff MDE calculations) — this closes the one place where DT-1's own gate was about to use a laxer standard than the rest of the design.

---

## Items signed off 2026-10-08 — STAGE A FROZEN

| # | Item | Decision |
|---|---|---|
| A6 | BTC/ETH occupy 2 of the top-20 ranking slots, then excluded from primary | **Confirmed**: rank including them, exclude from primary only (~18 external sleeves) |
| A1 (WRX) | `WRXUSDT` exclusion | **Confirmed excluded**; "exchange-affiliated token" is now a named 6th exclusion category, applied consistently |
| A7 | Block-bootstrap mean length algorithm | **Confirmed**: Politis-White automatic selection, algorithm frozen now, numeric output computed at Stage B |
| A9 | Drawdown-breaker-truncation bias treatment | **Confirmed**: R4's exact breaker stays in the primary; breaker-disabled run is a secondary quantification only, never co-primary |
| A10 | Power-simulation stop-rule threshold | **Confirmed: minimum 80% power, evaluated at true Sharpe=0.54 (added explicitly to the grid, not interpolated), reported across the ρ̄∈{0.45,0.5,0.65,0.8} grid (0.45 added 2026-10-09 as a transparency amendment; original three points unchanged), fragility flagged if the verdict changes across it. No threshold changes after seeing DT-1 performance.** |

Everything in this document is now settled and will not be reopened absent new evidence. Per the plan's own 5-step Order of Work, Stage A being frozen means the next steps are: (4) build the universe data (Phase 3 infrastructure), measure `ρ̄`/realized-N-over-time/`T` from that real price data — data only, never strategy performance — then implement and run the power simulation across the `ρ̄` × Sharpe grid above; (5) freeze Stage B (including the A10 stop-rule's actual outcome), then proceed to the DT-1 backtest run itself.
