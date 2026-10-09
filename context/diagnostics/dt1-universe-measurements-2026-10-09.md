# DT-1 — ρ̄ / N / T measured from the real universe (2026-10-09)

**Scope: data only.** Every figure below is computed from `historical_bars` close prices and `research_universe_membership` (`universe_version='dt1-v3'`) alone. No strategy code was run, no trade was simulated, no performance statistic was touched — the same "data availability, never performance" boundary the PIT census (P1c) and the universe build itself were held to. This is the "between stages" measurement step of the plan's §6.7b Stage A/Stage B split: Stage A is already frozen; these numbers are what Stage B's power simulation will actually be run against.

## 1. T — series length

| Framing | Value |
|---|---|
| Monthly (formation dates with ≥1 eligible member) | **103 months** (2018-03-01 through 2026-09-01, inclusive) |
| Daily (calendar days spanning the same window) | **3,136 days** (≈ 8.6 years) |

The two agree exactly once the window boundaries are held consistent: BTC's own daily bar count over `[2018-03-01, 2026-10-01)` is 3,136 — identical to the calendar-day count, confirming crypto trades every single day with zero gaps in this dataset. Both figures are reported because the plan's two dependence estimators operate at different cadences (Newey-West on the monthly E2 series needs the monthly T; the block bootstrap on E1's daily portfolio-return series needs the daily T).

This is close to, but not identical to, the plan's own earlier **pre-data estimate of "T≈108 months"** — the real figure (103) is slightly lower, consistent with the eligibility floor (180 days of history before a symbol can enter the universe) pushing the first eligible formation to 2018-03 rather than immediately after BTC/ETH's 2017-08 listing.

## 2. N — realized universe size over time

Full trajectory: **ramps 2 → 20 over 17 months (2018-03 through 2019-07), then holds at exactly N=20 for every one of the remaining 86 months (2019-08 through 2026-09) with zero dips** — across the 2020 crash, the 2021 bull run, the entire 2022 bear market, and everything since.

| Statistic | Value |
|---|---|
| Months total | 103 |
| Months at N=20 (full cap) | 86 (83.5%) |
| Months below N=20 | 17, all in the initial 2018-03→2019-07 ramp |
| min N | 2 (2018-03, -04, -05) |
| max N | 20 |
| mean N | 18.47 |

| Month | N | | Month | N |
|---|---|---|---|---|
| 2018-03 | 2 | | 2018-11 | 9 |
| 2018-04 | 2 | | 2018-12 | 12 |
| 2018-05 | 2 | | 2019-01 | 17 |
| 2018-06 | 5 | | 2019-02 | 18 |
| 2018-07 | 6 | | 2019-03–07 | 18 (flat) |
| 2018-08 | 6 | | 2019-08 onward | **20, every month, through 2026-09** |
| 2018-09 | 6 | | | |
| 2018-10 | 7 | | | |

The thin-early-years pattern the plan's own secondary analyses (§6.9) anticipated is real and sharply bounded: it is entirely a 2018–2019 phenomenon, not a recurring liquidity constraint. 159 distinct underlying assets have occupied an external-sleeve slot at some point across the full window (the universe's composition rotates substantially even while N itself stays flat at 20).

## 3. ρ̄ — mean pairwise correlation, external-sleeve population

**Methodology**: daily log returns (`ln(close_t / close_{t-1})`) per asset, from `historical_bars` 1d closes. Pairwise Pearson correlation computed over each pair's own overlapping trading days only (the standard approach for an unbalanced panel — assets enter and leave the universe at different times). BTC and ETH excluded throughout, matching A6's "exclude from the primary analysis only" scope — this is ρ̄ for the **external** sleeves specifically, the population the n_eff correction (§6.4) actually needs it for.

| Population | Pairs | ρ̄ | min | max | avg overlap (days) |
|---|---|---|---|---|---|
| **Full historical population** (all 159 assets ever ranked, ≥30-day overlap floor) | 12,165 | **0.459** | −0.338 | 0.839 | 1,383 |
| Current snapshot only (2026-09's 18 external members) | 153 | **0.498** | 0.106 | 0.723 | 1,257 |

**Sensitivity to the minimum-overlap floor** (full historical population, floor raised from 30 to 1,095 days):

| Min overlap (days) | Pairs | ρ̄ |
|---|---|---|
| ≥30 | 12,165 | 0.459 |
| ≥365 | 11,324 | 0.476 |
| ≥730 | 9,142 | 0.493 |
| ≥1,095 | 7,508 | 0.492 |

**The measured ρ̄ is stable across every methodology choice tried — it clusters tightly in [0.46, 0.50]** regardless of whether the population is the full 9-year history or just today's snapshot, and regardless of the overlap floor.

### The finding that needs your attention

**The plan's pre-registered power-simulation sensitivity grid is `ρ̄ ∈ {0.5, 0.65, 0.8}` (frozen in Stage A). Every real-data measurement above sits AT or BELOW the grid's lowest point** — the full-population estimate (0.459) is actually *below* 0.5 entirely; only the current-snapshot figure (0.498) and the longest-overlap-floor figures (0.492–0.493) come close to the grid's floor, and none reach it from above.

This is reported as a finding, not resolved unilaterally: the grid was pre-registered in Stage A specifically so it could not be adjusted after seeing data (the same discipline A10 itself exists to protect — "no threshold changes after seeing DT-1 performance"). Measuring ρ̄ was explicitly scoped as a *data-only* step precisely to keep it on the right side of that line, so re-opening the grid now, having seen this number, would reintroduce exactly the thing the Stage A/B split was designed to prevent. **Flagging for your decision rather than deciding it myself**: the grid can be left as-is (the simulation would then be systematically evaluating `ρ̄` values at or somewhat above the real figure, which — since higher ρ̄ lowers effective n and therefore lowers power — would make the simulation's power estimates conservative, i.e. understate achievable power rather than overstate it), or the grid can be widened to also include a lower point nearer the measured value (e.g. adding 0.45) as an explicit, dated amendment to the Stage A record before Stage B's simulation runs. Either choice is defensible; which one is chosen should be a recorded decision, not an implicit one.

## 4. What does NOT change

No code outside `context/diagnostics/` was touched to produce these numbers — every query here was read-only, run via `supabase db query --linked` against the already-live `historical_bars`/`research_universe_membership` tables built in the prior step. No strategy, no trade, no P&L. This document is the data-only handoff Stage B's power simulation (§6.7b) now runs against.
