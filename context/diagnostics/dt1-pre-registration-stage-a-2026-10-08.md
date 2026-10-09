# DT-1 pre-registration — STAGE A (draft, pending final sign-off on 5 flagged items)

**2026-10-08.** Per the DT-1 plan's two-stage pre-registration split (§6.7b): Stage A freezes everything that does **not** depend on the real universe's own price data existing. Stage B (ρ̄/N/T measured from that data, the power simulation across both grids, and its stop-rule outcome) follows only after Stage A is frozen and the universe is built.

**This document is a draft, not yet frozen.** Five items are marked `[DEFAULT — confirm or override]` — a reasoned default is stated for each so this can be approved in one pass rather than reopening the whole design. Everything else here reflects decisions already made explicitly in this review (committed in `5b8a5ef`..`29467bf`) and is not reopened.

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

**A6 — `[DEFAULT — confirm or override]`**: rank the true top 20 **including** BTC/ETH (they are genuinely the most liquid; excluding them from the ranking step would silently redefine the universe), then exclude them from the **primary** analysis only, leaving ~18 external sleeves. The secondary full-universe analysis (§6.9) includes them.

**Exclusion list (A1)** — census-derived, named, not a description (`dt1-phase1c-pit-census-2026-10-08.md`):

- **11 leveraged tokens** (Binance's own 3x long/short products, excluded by construction): `BTCUPUSDT`, `BTCDOWNUSDT`, `ETHBULLUSDT`, `ETHBEARUSDT`, `EOSBULLUSDT`, `EOSBEARUSDT`, `BULLUSDT`, `BEARUSDT`, `LINKDOWNUSDT`, `XRPUPUSDT`, `XRPDOWNUSDT`
- **4 stablecoins**: `PAXUSDT`, `BUSDUSDT`, `USTUSDT`, `USDSOLDUSDT`
- **`[DEFAULT — confirm or override]` `WRXUSDT`** (WazirX, an exchange-affiliated token fitting no named exclusion category): proposed default is **exclude**, on the reasoning that an exchange token's value is tied to a specific platform's own fortunes rather than being an ordinary open-market asset — but this was never one of the plan's originally-named categories, so it is flagged rather than silently folded in.

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

**Block bootstrap**: 10,000 resamples, 90% CI. **A7 — `[DEFAULT — confirm or override]`**: mean block length via the Politis-White automatic selection algorithm, computed from the real portfolio series once it exists (the algorithm is frozen now; its numeric output cannot be known before the data does). This is the one dependence parameter with no explicit sign-off yet, unlike the Newey-West lag above.

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

**A9 — still open, `[DEFAULT — confirm or override]`**: the per-sleeve drawdown-breaker truncation bias (R4's own `drawdownBreakerFloorPct=0.5` halts a losing sleeve permanently, biasing pooled expectancy upward) is distinct from the MaxDD veto above (which measures drawdown on the bootstrap-*scaled* series, not the breaker-truncation effect itself). Proposed default: report the breaker-disabled run as a **secondary**, not co-primary — the primary stays faithful to R4's exact execution rules (including its own risk breaker), and the disabled-breaker variant quantifies the bias's magnitude separately. Flagged because the plan never resolved this one.

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

Specified in full (§6.7b): DGP measured from R4's own real trade population (skew/kurtosis) and BTC's own real regime-timing sequence (temporal/cross-sectional structure); `ρ̄` measured from the real universe's price data (not borrowed from ASSET-4) **once it exists**, swept across `{0.5, 0.65, 0.8}`; Sharpe grid `{0, 0.3, 0.5, 0.8, 1.2}`.

**A10 — open, no default proposed.** The power simulation's exact numeric stop-rule threshold (e.g. minimum acceptable economic power at Sharpe=0.5) has no confirmed value — 50% was proposed in the original review package but never addressed in the subsequent correction round. This is the one item left genuinely open rather than defaulted, because a wrong default here directly risks manufacturing a pass or an unnecessary stop.

---

## Items requiring sign-off before this freezes

| # | Item | Proposed default |
|---|---|---|
| A6 | BTC/ETH occupy 2 of the top-20 ranking slots, then excluded from primary | Rank including them, exclude from primary only |
| A1 (WRX) | `WRXUSDT` exclusion | Exclude (exchange token) |
| A7 | Block-bootstrap mean length algorithm | Politis-White automatic selection |
| A9 | Drawdown-breaker-truncation bias treatment | Secondary run, not co-primary |
| A10 | Power-simulation stop-rule threshold | **No default — needs your number** |

Everything else in this document is settled and will not be reopened absent new evidence.
