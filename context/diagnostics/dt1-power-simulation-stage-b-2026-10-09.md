# DT-1 Stage B — power simulation results, and the S11 gate (2026-10-09)

**Stage B is now frozen.** This document records the power simulation's measured inputs, its full results across the pre-registered grid, and stop gate S11's actual outcome — per the plan's own Order of Work: "freeze Stage B (including the stop rule's outcome), then the DT-1 run."

## 1. What was run

24 scenario cells (`ρ̄ ∈ {0.45, 0.5, 0.65, 0.8}` × true annualized Sharpe `∈ {0, 0.3, 0.5, 0.54, 0.8, 1.2}`), 400 Monte Carlo replicates per cell, each replicate simulating the full measured realistic structure (T=3,136 days / 103 months, the real N(t) trajectory, R4's own measured trade-population skew/kurtosis) and running it through the complete, unmodified E1/E2 analysis pipeline. Full methodology, DGP validation, and code: `research/power-sim/` (commit `7143bd6`). Raw results: `research/power-sim/power-simulation-results.json`.

**Before trusting the headline number, the result was independently verified against closed-form theory** (not just re-read from the simulation's own output): the observed ~1.1-wide 90% CI on E1's annualized Sharpe matches the Lo (2002) asymptotic standard-error formula for an annualized-Sharpe estimate almost exactly (predicted 1.123 vs. observed ~1.10–1.12 across cells). This confirms the wide intervals are a real statistical fact about estimating an *annualized* Sharpe from daily data — annualizing multiplies the daily Sharpe's own sampling error by √365 ≈ 19.1 — not an artifact of the simulation's implementation.

## 2. S11 gate — the primary result

**FAIL across the entire grid. Not fragile — every ρ̄ point agrees.**

| ρ̄ | Power at Sharpe=0.54 | Passes 80%? |
|---|---|---|
| 0.45 | 3.5% | **FAIL** |
| 0.50 | 3.5% | **FAIL** |
| 0.65 | 3.0% | **FAIL** |
| 0.80 | 4.0% | **FAIL** |

Power stays far below 80% even at the highest Sharpe grid point tested (1.2, more than double the required hurdle):

| ρ̄ | Power at Sharpe=1.2 |
|---|---|
| 0.45 | 35.2% |
| 0.50 | 38.0% |
| 0.65 | 50.5% |
| 0.80 | 59.0% |

**No ρ̄ point comes anywhere close to 80% power even at the most favorable true Sharpe in the entire grid.** This is the full economic-power curve, condition 1 of §6.8's "Supported" verdict only (E1's bootstrap CI clears 0.54) — the MaxDD veto (condition 2) was explicitly out of scope for this round, stated in `replicate.ts`'s own header comment.

## 3. Secondary results (reported for completeness, never decision-bearing)

| ρ̄, Sharpe | Power | Robust. holds | DSR N=1 pass | DSR N=14 pass | CPCV agree | 3-clause N=1 | 3-clause N=14 |
|---|---|---|---|---|---|---|---|
| 0.5, 0 | 0.0% | 29.8% | 4.5% | 0.0% | 93.5% | 4.5% | 0.0% |
| 0.5, 0.54 | 3.5% | 80.3% | 38.0% | 0.0% | 92.0% | 35.5% | 0.0% |
| 0.5, 1.2 | 38.0% | 99.0% | 91.0% | 0.0% | 92.5% | 84.5% | 0.0% |

(Full 24-row table in the raw JSON.)

- **DSR at N=14 is 0.0% in every single cell, at every true Sharpe tested, including 1.2.** This independently reproduces R4's own documented finding (`p5-historical-backtest-results-2026-10-08.md`'s DSR-correction amendment): the N=14 benchmark `SR0` annualizes to a figure well above the realistic crypto-trend Sharpe range, so this clause is structurally unpassable regardless of whether the strategy works. This is exactly why DSR was demoted to a secondary diagnostic in Stage A — now confirmed again, independently, by simulation rather than by the single R4 observation alone.
- **DSR at N=1 scales sensibly with true Sharpe** (4–5% at Sharpe=0, rising to 88–98% at Sharpe=1.2) — behaves as a real, informative test when not deflated against an unpassable N=14 benchmark.
- **CPCV median-sign-agreement sits at 91–95% in every cell, largely independent of scenario** — not a very discriminating diagnostic here, consistent with the plan's own reframing of CPCV as a block-subsample stability check rather than a power-bearing test.
- **The robustness condition** (best-contiguous-year removed, still positive) climbs from ~30% at Sharpe=0 to ~99–100% at Sharpe=1.2 — behaves sensibly and independently confirms the DGP is generating economically meaningful signal at high true Sharpe, even while E1's own CI remains too wide to *prove* it at conventional confidence.
- **E2's three-way tie-break is conservative by design, and it shows**: `not_significant` is the overwhelming majority verdict in every one of the 24 cells (typically 360–390 of 400 replicates), even at Sharpe=1.2. This is consistent with the whole point of requiring all three dependence estimators to agree before calling E2 significant.

## 4. What this means — stop gate S11

> **S11 (plan, pre-registered): "If the simulation shows DT-1 cannot resolve an economically meaningful effect at the realistic N trajectory across the ρ̄ grid, stop and re-scope... Relaxing the statistical bar to manufacture a pass is not among the options."**

S11 has fired. The result is unambiguous and non-fragile: across every pre-registered ρ̄ sensitivity point (including the 0.45 transparency amendment), power at the frozen Sharpe=0.54 hurdle is 3–4%, nowhere near the 80% bar A10 froze. The reason is traceable to real, verified statistics, not implementation error: **3,136 days of daily data, even pooled across a realistically-sized universe, cannot pin down an *annualized* Sharpe ratio precisely enough to distinguish 0.54 from zero at 80% power** — the annualized-Sharpe estimator's own sampling noise is simply too large at this T, a known and well-documented property of Sharpe-ratio estimation, now confirmed for this specific universe/window by direct simulation rather than assumed.

**This is not a failed exercise.** It is exactly the information this entire Stage A/Stage B architecture was built to surface *before* spending the real DT-1 run — precisely the scenario the plan's own closing section anticipated: *"[DT-1] may still produce an interval that straddles both zero and the required band... That outcome is informative and is not a failed experiment... The failure mode to guard against is not a wide interval; it is reacting to a wide interval by re-running with a different universe, estimator, or bar until it narrows."*

## 5. Options — presented per the plan's own text, not decided here

The plan names these explicitly as the only legitimate responses to an S11 failure, and this document does not choose among them:

1. **Extend the window.** More calendar time (not just more assets) would shrink the annualized-Sharpe estimator's own sampling error, since the dominant source of imprecision here is T (days), not N (sleeves) — confirmed by the fact that power barely improves between ρ̄=0.45 and ρ̄=0.8 (it's governed by T far more than by cross-sectional structure).
2. **Widen the universe further** (beyond N=20) — would help less than extending T, given the above, but is a legitimate lever.
3. **Accept DT-1 as an explicitly-underpowered precision exercise** whose output is an interval and nothing more — run the real DT-1 analysis anyway, report E1/E2 with their honest, wide intervals, and explicitly decline to claim a "Supported" verdict either way, per §6.8's own framing (an interval straddling the band is reported as inconclusive, not resolved by assumption).
4. **Something not yet named** — the plan does not claim this list is exhaustive, only that threshold-relaxation is excluded from it.

**Not an option, per the plan's own explicit, repeated instruction**: lowering the 80% threshold, narrowing the required Sharpe band, or re-running with a cherry-picked ρ̄/Sharpe assumption to manufacture a pass.

## 6. What does NOT change

A10's 80%/Sharpe=0.54 threshold is untouched. The ρ̄ and Sharpe grids are untouched (this document reports against the full amended grid, including 0.45). No strategy parameter, no universe-construction rule, no estimator was adjusted in response to seeing this result — this simulation ran once, against the pre-registered design, and its outcome is reported as found.
