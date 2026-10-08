# P5 historical backtest results — 2026-10-08

Pre-registered in `p5-pre-registration-2026-10-08.md`. Executed by `research/run-backtest.ts`. Every number below is real output from this run — none hand-adjusted.

## BTC

| Variant | Train trades | Expectancy (R) | n | MDE | Actionable | Train Sharpe | CPCV OOS ratio (median, IQR) | DSR (N=13) | Holdout trades | Holdout expectancy (R) |
|---|---|---|---|---|---|---|---|---|---|---|
| v4-compat (control) | 1517 | -0.256 | 1517 | 0.078 | true | -3.058 | -0.212 [-0.247, -0.184] | 0.000 | 0 | 0.000 |
| breakout_long only | 1612 | -0.238 | 1612 | 0.074 | true | -3.129 | -0.200 [-0.225, -0.175] | 0.000 | 0 | 0.000 |
| breakout_short only | 1352 | -0.294 | 1352 | 0.080 | true | -3.502 | -0.250 [-0.270, -0.225] | 0.000 | 0 | 0.000 |
| pullback_long only | 1694 | -0.225 | 1694 | 0.072 | true | -2.976 | -0.192 [-0.228, -0.141] | 0.000 | 0 | 0.000 |
| pullback_short only | 1388 | -0.285 | 1388 | 0.077 | true | -3.461 | -0.248 [-0.263, -0.228] | 0.000 | 0 | 0.000 |
| fade_long only | 144 | -0.382 | 144 | 0.243 | true | -1.405 | -0.355 [-0.402, -0.252] | 0.000 | 8 | -0.140 |
| fade_short only | 162 | -0.432 | 162 | 0.200 | true | -1.840 | -0.411 [-0.509, -0.333] | 0.000 | 10 | -0.112 |
| random-entry baseline (long) | 1477 | -0.266 | 1477 | 0.074 | true | -3.185 | -0.239 [-0.306, -0.173] | 0.000 | 0 | 0.000 |
| random-entry baseline (short) | 1626 | -0.246 | 1626 | 0.071 | true | -3.082 | -0.204 [-0.270, -0.171] | 0.000 | 0 | 0.000 |
| daily-only bias | 1452 | -0.270 | 1452 | 0.079 | true | -3.154 | -0.235 [-0.283, -0.161] | 0.000 | 0 | 0.000 |
| geometry-alt-1 (wider stop) | 2960 | -0.128 | 2960 | 0.040 | true | -3.134 | -0.148 [-0.188, -0.114] | 0.000 | 0 | 0.000 |
| geometry-alt-2 (higher reward:risk) | 1528 | -0.251 | 1528 | 0.086 | true | -2.741 | -0.189 [-0.243, -0.148] | 0.000 | 0 | 0.000 |
| daily-trend + inverse-vol-targeting baseline | 159 | 0.314 | 159 | 0.579 | false | 0.409 | 0.114 [-0.038, 0.243] | 0.000 | 7 | 0.041 |

## ETH

| Variant | Train trades | Expectancy (R) | n | MDE | Actionable | Train Sharpe | CPCV OOS ratio (median, IQR) | DSR (N=13) | Holdout trades | Holdout expectancy (R) |
|---|---|---|---|---|---|---|---|---|---|---|
| v4-compat (control) | 1781 | -0.225 | 1781 | 0.078 | true | -2.779 | -0.175 [-0.200, -0.139] | 0.000 | 0 | 0.000 |
| breakout_long only | 1534 | -0.259 | 1534 | 0.083 | true | -2.957 | -0.203 [-0.229, -0.166] | 0.000 | 0 | 0.000 |
| breakout_short only | 1647 | -0.240 | 1647 | 0.076 | true | -3.043 | -0.190 [-0.215, -0.166] | 0.000 | 0 | 0.000 |
| pullback_long only | 1558 | -0.257 | 1558 | 0.078 | true | -3.048 | -0.198 [-0.244, -0.161] | 0.000 | 0 | 0.000 |
| pullback_short only | 1808 | -0.216 | 1808 | 0.072 | true | -2.936 | -0.167 [-0.221, -0.132] | 0.000 | 0 | 0.000 |
| fade_long only | 163 | -0.447 | 163 | 0.250 | true | -1.547 | -0.370 [-0.468, -0.233] | 0.000 | 1 | 1.237 |
| fade_short only | 186 | -0.543 | 186 | 0.224 | true | -1.994 | -0.451 [-0.527, -0.384] | 0.000 | 6 | -0.301 |
| random-entry baseline (long) | 1315 | -0.314 | 1315 | 0.081 | true | -3.390 | -0.270 [-0.318, -0.220] | 0.000 | 0 | 0.000 |
| random-entry baseline (short) | 1903 | -0.211 | 1903 | 0.070 | true | -2.826 | -0.165 [-0.227, -0.113] | 0.000 | 0 | 0.000 |
| daily-only bias | 1840 | -0.216 | 1840 | 0.074 | true | -2.817 | -0.170 [-0.215, -0.131] | 0.000 | 0 | 0.000 |
| geometry-alt-1 (wider stop) | 3136 | -0.126 | 3136 | 0.043 | true | -2.900 | -0.132 [-0.151, -0.108] | 0.000 | 0 | 0.000 |
| geometry-alt-2 (higher reward:risk) | 1874 | -0.212 | 1874 | 0.084 | true | -2.451 | -0.142 [-0.176, -0.120] | 0.000 | 0 | 0.000 |
| daily-trend + inverse-vol-targeting baseline | 182 | 0.008 | 182 | 0.533 | false | -0.003 | 0.034 [-0.091, 0.077] | 0.000 | 4 | 2.072 |

## Interpretation, against the pre-registered decision rule

**Decision rule** (§5 of the pre-registration): actionable AND DSR > 0.95 AND CPCV-median-sign-match, all three, else "not yet resolved."

**Verdict: not yet resolved, for every one of the 26 (variant × asset) cells.** No cell clears DSR > 0.95 — every arm-based/geometry/random/daily-only variant has a strongly negative train Sharpe (-1.4 to -3.5), which deflates to 0.000 under N=13 honest trial-counting; the one variant with a positive point estimate (daily-trend baseline) fails on actionability instead (MDE 0.53–0.58R dwarfs its 0.01–0.31R point estimate, so `expectancyR.actionable=false` on both assets). The formal rule is silent on direction by design — but the data underneath it is not, and three things are now established with much higher power than anything available before this run:

**1. Every V4-style intraday variant has a robust, out-of-sample-confirmed NEGATIVE expectancy.** All 11 arm/geometry/random/daily-only-bias variants land between -0.13R and -0.29R per trade on n=1,352–3,136 trades per asset, with MDEs of 0.04–0.09R — an order of magnitude smaller than the observed effect, so `actionable=true` in every one of these 22 cells. The CPCV out-of-sample median carries the **same negative sign** as the in-sample Sharpe in all 22 cells, and in all but a couple the interquartile range sits entirely below zero. This is not "insufficient evidence of an edge" — it is strong, out-of-sample-confirmed evidence of a **negative** edge, at a sample size (9+ years, 1,300+ trades per variant) roughly 100x larger than the live system's own ~20-trade history, and it lines up exactly with STRAT-1's own F6 (-0.356R/trade net, -0.141R pre-cost, on just 21 live trades).

**2. The deterministic arms show no measurable edge over random entry.** BTC: v4-compat -0.256R vs. random-long -0.266R / random-short -0.246R. ETH: v4-compat -0.225R vs. random-long -0.314R / random-short -0.211R. The six-arm detector logic is statistically indistinguishable from flipping a coin on whether to go long or short at each cycle — the entire negative result is attributable to cost drag and the stop/target risk:reward shape at this holding-period length, not to bad arm/signal selection. Fixing or re-tuning individual arms (fade thresholds, breakout confirmation, etc.) would not be expected to change this conclusion.

**3. Geometry-alt-1 (3.0× ATR stop, 2.0% floor) roughly halves the loss rate of every other V4-style variant** — BTC -0.128R vs. -0.256R control, ETH -0.126R vs. -0.225R control — consistent with a wider stop reducing how often noise alone triggers a round trip, cutting cost drag per unit of holding time. Still clearly negative and still fails the decision rule, but it is the least-bad variant tested by a wide margin.

**4. Critical caveat on holdout coverage — a real, correctly-functioning finding, not an engine bug.** Ten of the 13 variants show **zero** holdout trades on both assets. Verified directly (not assumed): BTC v4-compat's last trade closed 2020-02-26, with NAV at **$5,078.81 — 50.8% of the $10,000 starting capital** — immediately after which `evaluateRiskGate`'s drawdown breaker (`drawdownBreakerFloorPct=0.5`, the same deterministic, unmodified live code) rejected **10,856** further candidate opens for the remaining ~6.6 years of the series, including the entire 2026-07-01→2026-10-08 holdout window. This is the live risk gate working exactly as designed, reused unmodified — not a backtest-engine defect. The practical consequence: **the sealed holdout is only actually evaluated for the three low-frequency variants** (fade_long, fade_short, daily-trend baseline — all ≤20 trades/year, so NAV never decays far enough to trip the breaker within the data window). For the other 22 (variant × asset) cells, the "Holdout trades / Holdout expectancy" columns are correctly `0 / 0.000` and carry no information — they are not evidence the strategy is neutral in holdout, only evidence that a $10,000 account following that variant would already have been halted by its own safety mechanism years before the holdout window began. A deeper implication worth stating plainly: **the control variant's own real historical edge is severe enough that a live account would have tripped its own 50%-drawdown breaker within about 2.5 years of continuous operation** — a shorter horizon than this project's own live history to date.

**5. The daily-trend + inverse-vol-targeting baseline remains the most promising direction, still unresolved.** It is the only variant with a positive point estimate on BTC (+0.314R) and roughly neutral on ETH (+0.008R), and its CPCV out-of-sample median is weakly positive on BTC (0.114, IQR [-0.038, 0.243] — straddles zero) and near-zero on ETH (0.034, IQR [-0.091, 0.077]). At only 159–182 trades over 9+ years (the cost of a daily-cadence signal), its own MDE (0.53–0.58R) is far too wide to resolve a modest effect — this needs a much longer run or a cross-sectional design (more assets, not more years) to power up, not a re-tuning of what's already here.

## Honest limitations

- **This is Binance spot data, not live paper-trading data.** It establishes what the deterministic strategy layers would have decided and roughly how they would have fared against one real venue's own historical OHLCV, including real historical fees/slippage assumptions (10bps/5bps, matching live defaults) — not a replay of CoinGecko-sourced live fills, which are known to smooth wicks relative to a single venue's own order book (per the existing Backtest/Replay Scope's own documented caveat).
- **Jev is not modeled anywhere in this backtest**, per the permanent, standing scope exclusion (historical LLM replay risks pretraining contamination and is never performance evidence). These results speak only to the deterministic detection/sizing/exit layers.
- **Stop/target geometry was not re-tuned from this run** — geometry-alt-1/2 were the two pre-registered alternatives only; no new variant was mined from these results, consistent with the pre-registration's own binding rule against post-hoc tuning.
- **SUI/AVAX are explicitly deferred**, per the pre-registration's own stated scope — a dated follow-up appendix using this identical methodology, not a new or re-tuned pass.
- **The sealed holdout was evaluated exactly once**, per the pre-registration; these numbers are final and are not re-run or cherry-picked.

---

## DSR unit-fix amendment — 2026-10-08

**Dated, visibly-appended amendment, never an in-place edit of the table above.** `deflatedSharpeRatio` expects a per-period Sharpe (`stats.ts`'s own `DeflatedSharpeInput.observedSharpe` doc comment); the original run above passed the ANNUALIZED `sharpe` field instead. The distortion scales with cadence (sqrt(17520) at 30-minute vs sqrt(365) daily), so the twelve 30-minute V4 trials and the one daily baseline trial were never on a comparable scale when pooled into `sharpeVarianceAcrossTrials`. This amendment re-executes the IDENTICAL, unmodified strategy code and config against the SAME historical_bars dataset and recomputes the DSR statistic two ways: **'legacy, recomputed'** reproduces the original (buggy) call exactly, as a correctness check — it must equal the DSR column already published above; **'corrected'** uses every trial's Sharpe resampled to a common daily basis regardless of native cadence (`research/daily-resample.ts`). The legacy column is invalid and must never be cited as evidence going forward. The corrected column is canonical. The decision threshold (0.95) is unchanged.

### BTC (corrected)

| Variant | DSR — legacy, recomputed (INVALID, audit only) | DSR — corrected (per-period, daily-resampled — CANONICAL) |
|---|---|---|
| v4-compat (control) | 0.000 | 0.000 |
| breakout_long only | 0.000 | 0.000 |
| breakout_short only | 0.000 | 0.000 |
| pullback_long only | 0.000 | 0.000 |
| pullback_short only | 0.000 | 0.000 |
| fade_long only | 0.000 | 0.000 |
| fade_short only | 0.000 | 0.000 |
| random-entry baseline (long) | 0.000 | 0.000 |
| random-entry baseline (short) | 0.000 | 0.000 |
| daily-only bias | 0.000 | 0.000 |
| geometry-alt-1 (wider stop) | 0.000 | 0.000 |
| geometry-alt-2 (higher reward:risk) | 0.000 | 0.000 |
| daily-trend + inverse-vol-targeting baseline | 0.000 | 0.000 |

### ETH (corrected)

| Variant | DSR — legacy, recomputed (INVALID, audit only) | DSR — corrected (per-period, daily-resampled — CANONICAL) |
|---|---|---|
| v4-compat (control) | 0.000 | 0.000 |
| breakout_long only | 0.000 | 0.000 |
| breakout_short only | 0.000 | 0.000 |
| pullback_long only | 0.000 | 0.000 |
| pullback_short only | 0.000 | 0.000 |
| fade_long only | 0.000 | 0.000 |
| fade_short only | 0.000 | 0.000 |
| random-entry baseline (long) | 0.000 | 0.000 |
| random-entry baseline (short) | 0.000 | 0.000 |
| daily-only bias | 0.000 | 0.000 |
| geometry-alt-1 (wider stop) | 0.000 | 0.000 |
| geometry-alt-2 (higher reward:risk) | 0.000 | 0.000 |
| daily-trend + inverse-vol-targeting baseline | 0.000 | 0.000 |

**Worked consistency check**: the "legacy, recomputed" column above reproduces the original table's DSR values exactly (both read 0.000 for every cell) — confirming this amendment changed nothing about HOW the strategy ran, only the units of ONE downstream statistic. The corrected per-period scale does not change which cell clears the pre-registered decision rule either — every arm/geometry/random/daily-only variant still deflates to ≈0.000 (strongly negative trial Sharpes dominate regardless of annualization), and the daily-trend baseline still fails on actionability rather than DSR. This is a units correction, not a result-flattering change.

