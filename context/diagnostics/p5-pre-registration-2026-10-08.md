# P5 pre-registration — historical backtest variant list, parameters, and decision rule

**Date:** 2026-10-08, written and committed **before** `research/run-backtest.ts` is executed against the full historical dataset, per `trading-strategy-v1.md §23`'s own binding rule #1 ("pre-register every parameter and the full list of variants before looking at results. Count honestly — every abandoned variant counts") and the `RESEARCH-1` plan's own R4 stage.

**Scope of this run:** BTC and ETH first (full ~9.1-year history, the two statistically richest series). SUI (~3.4 years) and AVAX (~6 years) are run as a dated follow-up appendix to this same pre-registration, using the identical variant list and methodology — never a separate, re-tuned pass. This scoping decision is itself pre-registered here, not discovered after seeing BTC/ETH's own results.

---

## 1. The full variant list (N = 13 — the honest trial count for Deflated Sharpe)

Every one of these is a real, already-built, already-tested execution path. None is added after this document is committed without a new, dated, visibly-appended amendment below (never an in-place edit).

| # | Variant | Mechanism | Built in |
|---|---|---|---|
| 1 | **v4-compat (control)** | All six arms, existing daily+4h bias, existing 2.0×ATR/1.2%-floor geometry | `backtest-engine.ts` + `V4_COMPAT_CONFIG` |
| 2 | breakout_long only | `V4_COMPAT_CONFIG` with every other arm's `enabled:false` | same engine, config override |
| 3 | breakout_short only | same, isolating `breakout_short` | same |
| 4 | pullback_long only | same, isolating `pullback_long` | same |
| 5 | pullback_short only | same, isolating `pullback_short` | same |
| 6 | fade_long only | same, isolating `fade_long` | same |
| 7 | fade_short only | same, isolating `fade_short` | same |
| 8 | random-entry baseline, long | Unconditional long entry whenever flat, no signal | `variants.ts`'s `buildRandomEntryDetector('long', ...)` |
| 9 | random-entry baseline, short | Unconditional short entry whenever flat, no signal | `variants.ts`'s `buildRandomEntryDetector('short', ...)` |
| 10 | **daily-only bias** | All six arms, geometry unchanged, bias = daily regime ALONE (no 4h confirmation leg) | `variants.ts`'s `resolveDailyOnlyBias`, injected via `resolveBias` |
| 11 | **geometry-alt-1 (wider stop)** | All six arms, existing bias, `stopAtrMultiple=3.0`, `stopFloorPct=0.020`, reward:risk unchanged (2.0 trend / 1.5 fade) | `variants.ts`'s `computeIntradayLsProtectionFromConfig`, injected via `computeProtection` |
| 12 | **geometry-alt-2 (higher reward:risk)** | All six arms, existing bias, existing stop (2.0×ATR/1.2% floor), reward:risk raised to 3.0 (trend) / 2.0 (fade) | same mechanism, different config |
| 13 | **daily-trend + inverse-vol-targeting baseline** | A wholly separate strategy (`evaluateTrendRegime` + `buildCandidateProposal`, Balanced's own live rule) | `baseline-daily-trend.ts` |

Variants 2–7 and 10–12 all run through the identical `backtest-engine.ts` loop as variant 1 — only the config (and, for #10, the bias resolver) differs. Variant 13 runs through its own, separately-built loop (`baseline-daily-trend.ts`), justified in R2's own design note: genuinely different cadence and exit methodology, not a parameterization of the same loop.

**Geometry-alt values, stated as numbers now, never tuned after seeing a result:**
```
geometry-alt-1: stopAtrMultiple = 3.0, stopFloorPct = 0.020   (both trend and fade keep their existing reward:risk)
geometry-alt-2: stopAtrMultiple = 2.0, stopFloorPct = 0.012   (unchanged)
                trend-arm rewardRiskRatio = 3.0 (was 2.0), fade-arm rewardRiskRatio = 2.0 (was 1.5)
```
These bracket the existing choice in both directions (wider risk vs. higher reward) without being selected from any prior look at this project's own trade data — picked as plausible, round, pre-registerable alternatives only.

## 2. Sealed holdout

**Holdout window:** `2026-07-01T00:00:00.000Z` through the data's own most recent ingested bar (2026-10-08). **Training/exploration window:** every asset's own history start through `2026-06-30T23:59:59.999Z`.

All 13 variants are run and compared **only on the training window** first. The holdout is evaluated **exactly once**, after every training-window number in this document's own results companion is already fixed in writing — never re-run, never used to pick a variant, never iterated on. If a variant's training-window result looks promising, the holdout either confirms the sign of that result or it doesn't; a holdout miss is reported as a holdout miss, not re-litigated.

## 3. CPCV parameters (Combinatorial Purged Cross-Validation)

Stated as numbers now, per `research/stats.ts`'s own `buildCpcvSplits`:

| Strategy class | numGroups | testGroupsPerSplit | embargo | Combinatorial paths |
|---|---|---|---|---|
| V4 variants (1–12), intraday holding periods | 10 | 2 | 2 days | C(10,2) = 45 |
| Daily-trend baseline (13), multi-week holding periods | 10 | 2 | 14 days | C(10,2) = 45 |

The embargo widths differ because the two strategy classes hold positions on genuinely different timescales (hours for V4, weeks for the baseline) — a fixed embargo appropriate for one would either leak information (too short for the baseline) or needlessly discard most of the series (too long for V4). This is stated here, before any run, specifically so it cannot look like it was picked to flatter one strategy's own result.

## 4. What gets reported for every (variant, asset) pair

The full `research/stats.ts` performance panel (trade count, win rate, avg win/loss R, expectancy **with its own n and MDE**, profit factor, total fees/slippage/funding, exits by type, risk rejections by reason, CAGR, max drawdown and its longest duration, Calmar, Sharpe, Sortino, downside deviation, time in market, take-profit touch rate, splits by direction and by asset) — **plus**:
- The median and interquartile range of out-of-sample Sharpe across the 45 CPCV paths (never just the single in-sample Sharpe).
- The Deflated Sharpe Ratio, with `numTrials = 13` (this document's own honest count) and `sharpeVarianceAcrossTrials` computed from the 13 variants' own observed Sharpes on the training window.

## 5. The decision rule, stated before any number is seen

A variant is reported as **"a real, actionable signal"** only if **all three** hold:
1. `stats.ts`'s own `expectancyR.actionable` is `true` (the point estimate exceeds its own MDE at the project's standing alpha=.10/power=80% convention).
2. The Deflated Sharpe Ratio exceeds **0.95**.
3. The CPCV out-of-sample Sharpe distribution's **median** agrees in **sign** with the in-sample Sharpe (magnitude may differ; sign must not flip).

Failing any one of these three, the honest conclusion is **"not yet resolved"** — never silently rounded up to "confirmed" or down to "retired." This mirrors this project's own established discipline (invariant I5, and this session's own P4 report) of refusing a confident verdict a sample cannot support.

**No variant is promoted to a live config change by this run alone, regardless of outcome.** Per the existing Backtest/Replay Scope, a finding here is advisory input to a separately human-reviewed version bump — this document does not authorize anything beyond itself.

## 6. Amendments

None yet. Any future change to the variant list, parameters, or decision rule above is appended below with its own date and reasoning, never edited into the sections above.
