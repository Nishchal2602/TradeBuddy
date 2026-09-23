# Trading Strategy V1

**Status:** PROPOSED — not frozen, not implemented. Supersedes the earlier draft of this file (2026-09-19), which was a partial outline whose §4 contained no actual rules.
**Product:** TradeBuddy · **Assets:** BTC, ETH · **Execution:** paper only
**Authoritative contract:** [`trading-domain-contract.md`](./trading-domain-contract.md). Where this document and that one disagree, **the contract and the live implementation win.**

Every statement below is tagged:

- **[LOCKED]** — already specified by the contract or shipped in code. Not re-decidable here.
- **[PROPOSED V1]** — new strategy rule, with its rationale.
- **[OPEN]** — genuinely unresolved; must not be silently resolved by implementation.

---

## 0. Executive assessment — read this first

**The system this strategy runs on was built around a decision horizon that has no evidentiary support, and its two mandatory exit rules were mutually inconsistent until the signal horizon was moved.**

Four findings drove the redesign:

1. **There is no credible peer-reviewed evidence of exploitable trend *continuation* in BTC at 1–4 hour horizons. The evidence at exactly that horizon points to *reversal*.** De Nicola (*Ledger* 6, 2021; Bitstamp BTC/USD, Mar 2015 – Jun 2018) measures first-order return autocorrelation as significantly **negative** at 1h (−0.0557, p≈1.9×10⁻²¹), 2h (−0.0858), and 4h (−0.0564), while **daily is insignificant** (−0.0071, p=0.80) — and argues explicitly that at 1–4h this is not bid-ask bounce.

2. **When this exact hypothesis was tested on these exact assets, momentum lost.** *JRFM* 19(9) 692 (2026) searched 25 momentum/reversal combinations across all 12 hourly session boundaries on Kraken BTC and ETH, 2016–2025. The selected rules were **reversal-based** (BTC: Reversal/Reversal; ETH: Long/Reversal) — and even those **failed paired bootstrap significance tests**. Hudson & Urquhart (*Annals of Operations Research* 297, 2021) tested ~15,000 technical rules with multiple-hypothesis correction and found **no out-of-sample predictability for Bitcoin specifically**.

3. **The mandatory stop-loss and the mandatory take-profit are optimal under opposite return-generating processes.** Kaminski & Lo (*J. Financial Markets*, 2014): under a random walk the stopping premium is **Δμ = p_o(r_f − μ) = −p_o·π ≤ 0** — always negative; under AR(1) a stop adds value only when **ρ ≥ π/σ = Sharpe at the same sampling frequency**. Dao et al. (arXiv:1607.02410): trend P&L is **quadratic** in the cumulative move, and its positive skew is a χ² right tail that a fixed take-profit **flattens**. The stop wants ρ > 0; the take-profit wants ρ < 0. **No value of ρ makes both correct.**

4. **V1 cannot prove it has an edge on any realistic timeline.** ~216 trades are needed to distinguish a 2R/40%-win-rate edge from luck at t=2, and Harvey & Liu (*RFS* 29(1), 2016) argue the bar should be **t > 3.0**. With 20 strategy variants tried on a 3-month window, a **zero-skill** strategy is expected to print an annualised Sharpe near **2.7** (Bailey & López de Prado, Deflated Sharpe Ratio). And the binding sample is not bars but **independent market cycles — crypto has had roughly three since 2015.**

**What V1 therefore is:** the simplest high-prior hypothesis worth testing first, framed for falsification. It is explicitly **not** "the only defensible strategy" — Hudson & Urquhart's out-of-sample null applies to price-vs-moving-average rules too, and the strongest supporting paper (Detzel et al.) contains a footnote predicting its own decay as an asset matures.

**What V1 is not:** a claim of edge, a backtest-optimised configuration, or a system whose AI component has earned its place. Removing the LLM entirely is a pre-registered acceptable outcome (§23, H5).

---

## 1. Purpose

Define, precisely enough to implement without further interpretation, the conditions under which TradeBuddy opens, holds, or closes a BTC/ETH paper position; how much risk it takes; and why that logic has a defensible prior of working out of sample.

The document optimises for **robustness > interpretability > testability > simplicity > historical performance**, in that order. It deliberately does not optimise for backtest results.

## 2. Scope and boundaries

**[LOCKED] This document may not redefine:**

| Area | Owner |
|---|---|
| Position state machine, valid actions per state | contract §1 |
| Short accounting, collateral exhaustion at `2 × entry`, NAV formula | contract §2 |
| SL/TP ordering and the exhaustion-ceiling predicate | contract §3 |
| Decision → position → trade provenance | contract §4 |
| Position-monitor cadence, replay, fill policy, SL-wins tiebreak | contract §5 |
| Concurrent-close race resolution | contract §6 |
| Re-entry block *mechanics* | contract §7 |
| Position sizing *implementation* | `src/shared/risk/sizing.ts` |

**[PROPOSED V1] This document owns**, per the carve-out at `trading-domain-contract.md:7` ("Not in scope here: NEWS/TECHNICAL decision methodology, Gemini prompt content, indicator interpretation") and `:81` (SL/TP distance bounds deferred to this review): indicator interpretation, regime definition, entry and exit *criteria*, news methodology, the Gemini prompt's decision content, SL/TP distance *bounds and derivation*, strategy-level no-trade conditions, and portfolio-level risk rules.

## 3. Strategy philosophy

> The agent is allowed to be wrong. It is not allowed to be uncontrolled, and it is not allowed to claim an edge it has not demonstrated.

Three commitments:

1. **Deterministic where possible.** Every directional decision is reproducible from data. The LLM may veto; it may never originate.
2. **Few, well-motivated features.** Two decision-relevant inputs, not eight. Each must answer: what market behaviour does this capture, why would it exist in crypto, and is it distinct from what we already have?
3. **Falsifiable by construction.** Every layer has a pre-registered null and a retirement condition (§23).

**[PROPOSED V1] Mechanism hypothesis, stated as a hypothesis:** slow time-series momentum in large-capitalisation crypto at **multi-week** horizons — the only horizon at which BTC trend persistence survives peer review. Detzel et al. (*Financial Management*, 2021) report Lo-MacKinlay variance ratios significantly above one at horizons of **four or more weeks**, and moving-average predictors significant at **20-, 50- and 100-day** lookbacks (5-day and 10-day were **not** significant). Zaremba et al. (*IRFA* 78, 2021) find that among the **largest and most liquid** coins, daily continuation beats reversal. Liu & Tsyvinski (*RFS* 34(6), 2021) find time-series momentum significant at **weekly** frequency (R² 3–5%) but with **daily R² = 0.00** and the one-day coefficient losing significance under their own bootstrapped standard errors (t = 1.22).

Candidate economic mechanisms: slow diffusion of information among a largely retail base, persistence of institutional and ETF flows, and reflexive leverage cascades that extend moves. **We do not claim to have verified any of these.**

**Known expiry risk.** Detzel et al.'s own robustness footnote reports that applying their strategies to NASDAQ in the decade *after* the dot-com era — as the asset matured and fundamentals became assessable — produced **no significant alpha and no Sharpe gain**. Their mechanism predicts its own obsolescence. Bitcoin in 2026, with spot ETFs, CME futures and institutional market makers, is materially more mature than Bitcoin in 2018, when their sample ends.

## 4. User risk configuration

**[LOCKED]** `agent_settings.risk_appetite ∈ {conservative, balanced, aggressive}`, mapped by `src/shared/risk/appetite-mapping.ts`. Currently `balanced`. **There is no onboarding flow**: `starting_capital` is set by migration (`seed_v0_config.sql:57`, $10,000) and the appetite selector in the extension is read-only (`settings-screen.tsx:94`) because the anon key has `SELECT`-only RLS. Any user-facing configuration requires a control endpoint that does not exist.

**[PROPOSED V1] Recalibrate the risk budgets.** Position size is `min(budget / stopPct, 0.20)`, so the 20%-of-NAV single-trade cap binds for every stop tighter than `budget / 0.20`:

| Appetite | Shipped budget | Cap binds below | Proposed budget | New crossover |
|---|---|---|---|---|
| Conservative | 0.75% | 3.75% | **0.25%** | 1.25% |
| Balanced | 1.00% | 5.00% | **0.50%** | 2.50% |
| Aggressive | 1.50% | 7.50% | **0.75%** | 3.75% |

At any realistic stop distance, **all three shipped appetites produce an identical 20%-of-NAV position** — the budget is inert and only `minConfidence` differentiates them. Since §12 removes the confidence gate, the recalibration is not optional: without it, risk appetite would control nothing at all. Under the proposed budgets at a 4% stop, sizes are 6.2% / 12.5% / 18.8% of NAV — genuinely separated.

**[PROPOSED V1] Risk appetite controls exactly two things:** the risk budget per trade, and the portfolio risk ceiling (§17). It does **not** control signal thresholds, the MA lookback, the stop multiple, or the news policy. Making appetite change the *signal* would mean three strategies to validate instead of one, against a sample that cannot validate even one.

## 5. Market universe

**[LOCKED]** BTC and ETH. One net position per asset; no lots, pyramiding or partial exits (contract §1, enforced by `positions_one_open_per_asset_idx`).

**[PROPOSED V1] Long/flat only in V1.** Short support is built, tested and correct (contract §2) but **unused by the strategy**. Rationale: Detzel et al. tested a long/flat rule exclusively; *IRFA* 94 (2024) finds crypto momentum alpha "extracts alpha largely from SHORT positions" but that abnormal returns "occur primarily in bull markets and fade over time"; and arXiv:2003.13517 finds BTC and ETH have **opposite-signed** hourly autocorrelation, which undermines applying one symmetric rule to both. Shorts become a separately-tracked V1.1 hypothesis (§28).

**[OPEN] BTC/ETH heterogeneity.** The two assets do not behave identically. **V1 deliberately applies the same rule to both and does not tune per-asset** — with ~3 independent market cycles, per-asset tuning is exactly the overfitting the sample cannot afford. Per-asset behaviour is *reported*, never *fitted*.

## 6. Data and timeframes

**[LOCKED] Current provider behaviour** (`providers/coingecko.ts`, verified live 2026-09-17/18):

| Endpoint | Granularity | Used for |
|---|---|---|
| `/coins/markets` | spot | price, 1h/24h/7d change |
| `/ohlc?days=30` | **4-hourly** candles (~180) | ATR%, 7-day range |
| `/market_chart?days=30` | **hourly** (~721) | RSI, EMA20/50, MACD, volume, 24 recent closes |
| `/market_chart?days=1` | **5-minute** (289) | position monitor (contract §5) |

`days=2..90` returns hourly (confirmed live, as above). **`days>90` is expected to return daily**, per CoinGecko's publicly documented auto-granularity behavior and the same tiering pattern already confirmed for the other three endpoints — **not yet independently live-verified by this codebase**, and must be confirmed the same way Unit 3 confirmed the other tiers before any code depends on it.

**[PROPOSED V1] Add one daily-granularity fetch per asset per cycle.** The directional signal requires a 50-day daily moving average. The current 30-day hourly window **structurally cannot express it** — `ema50` on hourly closes is 50 *hours* (≈2.1 days), shorter than the 5-day lookback that already failed significance in Detzel et al. This raises the decision cycle from 5 to 7 CoinGecko calls.

**[PROPOSED V1] Closed bars only — this is mandatory and currently violated.** Nothing in `calculate.ts` or `coingecko.ts` drops the current, in-progress period. Consequences today: (a) indicators are computed partly on a partial bar, so signals can flip within a bar (repainting); (b) a bar-replay backtest computes different values from identical history, so live behaviour is not reproducible; (c) `calculateDistanceFromSevenDayRange` compares **live spot** against **historical candles** (`calculate.ts:178`), a combination no backtest can reproduce at all. **Every rule in this document evaluates on completed bars.** Fixing this is a precondition for §22.

**[PROPOSED V1] Timeframe roles, kept strictly separate:**

| Clock | Role |
|---|---|
| **Daily** | Direction. The only signal timeframe |
| **4-hourly** | Volatility for position sizing. **Never a signal** |
| **3-hourly (decision cycle)** | *Checks* whether the daily state changed. Generates no signal of its own |
| **5-minute (monitor)** | SL/TP execution only (contract §5) |

**[LOCKED] Cadence.** Execution is currently **manual-only**; `decision_interval_minutes = 180` is configured and load-bearing (it sets the `agent_runs` idempotency bucket at `agent-cycle/index.ts:210` and the news lookback at `:238`) but no `pg_cron` schedule exists. The next phase enables the 3-hour schedule.

**Cost sets a floor on holding period.** At 0.30% round-trip cost (0.1% fee + 0.05% slippage per side, `accounting.ts`), the breakeven directional hit rate is **69% for a 3-hour hold**, 56.7% at 24h, 53.9% at 3 days, and **52.5% at 7 days**. No published signal in any asset class approaches 69%. **V1's expected holding period is weeks.**

## 7. Market regime

**[PROPOSED V1]** Computed on **completed daily bars**:

```
regime(asset) =
  UP    if  daily_close > SMA50(daily_close)
  DOWN  otherwise
```

That is the entire regime model. One comparison, one parameter.

**Why so simple.** Dacco & Satchell (*J. Forecasting* 18(1), 1999) show analytically that **a small misclassification rate destroys the entire advantage of knowing the correct model specification** — regime-switching models fit well in sample and lose to a random walk out of sample. A fitted HMM has an estimated transition matrix that can be unstable, a likelihood surface with local optima, and a state-count hyperparameter. A price-vs-MA comparison has none of these. The literature's one clear asymmetry is that **volatility-regime classification is far easier than mean-regime classification** — which is why volatility here governs *sizing* (§16) and never direction.

**Why 50-day specifically — chosen ex ante, never selected on results:**

1. It is the **midpoint** of Detzel et al.'s empirically significant 20/50/100-day band — a central choice rather than an edge pick.
2. It comfortably exceeds the ~4-week horizon at which variance-ratio tests first show significant trend persistence.
3. It is the **conventional** value, and that is an argument *for* it here: a crowded parameter is one **we did not select from our own data**. Choosing an unusual lookback would mean either an arbitrary choice or a search we cannot afford.

**20-day and 100-day are reported as robustness checks and are never selected on.** If V1's result depends on which of the three is used, that is itself a finding — reported as fragility, not resolved by picking the winner.

## 8. Trade setup

**[PROPOSED V1] Archetype: slow daily-trend regime following. One archetype, not a blend.**

The setup *is* the regime state. There is no separate pattern to detect:

```
setup(asset) = regime(asset) == UP  and  state(asset) == FLAT
```

**Why there is no breakout trigger.** An earlier draft proposed entering on a 7-day-high breakout. It was withdrawn for three reasons: a 7-day lookback sits below Detzel's significant band; checking for breakouts every 3 hours acts on precisely the 1–4h band where BTC measures mean-reverting; and breakout entry is latency-sensitive (drift between signal and execution is ≈0.4R at 3 hours and ≈1.1R at 24 hours), which is fatal under manual execution. A daily-MA **state** is latency-tolerant: entering at 09:00 or 15:00 gives materially the same trade.

**Expected holding period:** weeks. **Expected frequency:** roughly 6–20 round trips per asset per year. Low turnover is not a weakness — Sharpe drag scales as `(c/σ)·√(8760·N/h)`, so turnover is the enemy, and 100 trades/year at 24-hour holds would need a gross Sharpe above 1.15 merely to reach zero.

## 9. Entry triggers

**[PROPOSED V1]** `OPEN_LONG(asset)` requires **all** of the following, evaluated in order. First failure stops evaluation and yields `HOLD`.

| # | Condition | Source |
|---|---|---|
| 1 | `state(asset) == FLAT` | contract §1 |
| 2 | `regime(asset) == UP` on completed daily bars | §7 |
| 3 | No stop-out re-entry block active for (asset, long) | contract §7 |
| 4 | No material adverse news veto | §10 |
| 5 | Gemini does not veto | §12 |
| 6 | Portfolio risk ceiling admits the position | §17 |
| 7 | Deterministic risk gate approves | `gate.ts` [LOCKED] |

**`OPEN_SHORT` is never proposed in V1** (§5).

**There is no separate "trigger" distinct from the setup.** Conditions 2 is a *state*, not an *event*: if the regime is UP and we are flat, we enter — whether the regime turned up this cycle or three cycles ago. This is deliberate and is what makes the strategy robust to irregular manual execution.

**No condition references RSI, MACD, volume, hourly EMAs, or the 7-day range.** See §26 on why.

## 10. News methodology

**[PROPOSED V1] News is a veto. It never originates a trade, never sets direction, never changes size, and never changes SL/TP.**

**The evidence is against news being tradable at this cadence, and the design reflects that.** Price discovery in crypto concentrates in the **first 100 milliseconds** of each second (*Economics Letters*, sub-second price discovery). Twitter sentiment — a channel strictly *faster* than RSS — has a documented predictive half-life of **~15 minutes** (*Finance Research Letters*); a 3-hour poll samples it roughly 12× past its decay. An analysis of **63,926 CoinDesk headlines, Jan 2014 – Dec 2025**, matched to 4,381 daily BTC closes found return correlation **0.019**, FinBERT sentiment correlation 0.07, **no Granger causality at any lag 1–5 days**, and — most tellingly — BTC **+1% above baseline in the three days *before* a coverage spike** and −0.8% three days after. A peer-reviewed study (*European Journal of Finance*, 2026) concurs that in crypto "prices largely drive news sentiment rather than the reverse." Post-event crypto behaviour is documented **overreaction and reversal**, not continuation — so a naive "positive news → buy" rule trades *against* the evidence.

**Materiality classes.** Only these may veto:

| Class | Examples | Can veto |
|---|---|---|
| Regulatory / legal | ban, enforcement action, adverse ruling, ETF rejection | **Yes** |
| Security incident | exchange hack, bridge exploit, protocol vulnerability | **Yes** |
| Protocol failure | chain halt, consensus failure, critical bug | **Yes** |
| Institutional flow | large ETF outflow, treasury disposal | **[OPEN]** — see below |
| Macro | rate decision, CPI surprise | **No** in V1 — affects beta, not the thesis |
| **Market commentary** | "BTC falls 5%", analyst opinion, price prediction | **Never** |

**Market commentary is excluded because it double-counts price.** Most crypto RSS is commentary *about* a move the indicators have already seen. Letting it veto would mean the same price information vetoing a signal derived from that same price information.

**Recency.** A veto requires an item within a **materiality window**. **[OPEN]** The current news fetch window is `decision_interval + overlap` = 195 minutes, correct for "what is new since the last cycle" but wrong for "is there an unresolved material event" — a hack six hours old would not appear in the payload at all. A veto framework needs a longer window (~24–48h) for high-materiality classes only. This is a change to news retrieval, not to the strategy, and is not resolved here.

**Provider failure.** **[PROPOSED V1]** If news retrieval fails entirely, **block new opens and allow CLOSE**. This preserves fail-closed behaviour (`CLAUDE.md` § Data-quality rules) while keeping exits actionable (contract §7: "Risk management must always be actionable").

## 11. Technical + news synthesis

**[PROPOSED V1]** Exact behaviour for every combination. No hand-waving:

| Technical setup | News state | Action |
|---|---|---|
| Valid | No news | **Proceed.** Absence of news is not a veto |
| Valid | Confirming material news | **Proceed, unchanged.** No size increase, no confidence adjustment |
| Valid | **Fresh material adverse news** | **HOLD** (veto) |
| Valid | Adverse news outside the materiality window | **Proceed** — already priced |
| Valid | Commentary only, any sentiment | **Proceed** — commentary is not evidence |
| Valid | Provider failure | **HOLD** for opens; CLOSE still permitted |
| Invalid | Any news, however bullish | **HOLD.** News cannot create a setup |

**Confirming news is deliberately given zero weight.** Rewarding agreement would double-count price (most "confirming" items are commentary on the move), and post-event overreaction means agreement may be a mild negative rather than a positive. Treating it as neutral is the conservative, defensible choice.

## 12. Gemini's role

**Historical section — describes the state as implemented 2026-09-21.** Gemini was removed entirely 2026-09-22 (TypeSafe's Jev is the sole provider, no fallback), and the model's mandate widened again 2026-09-22/23 (Phase 2, "Jev as a portfolio-management decision layer") to also manage existing open positions — bounded, gate-validated ADD/REDUCE/MODIFY_PROTECTION, never an absolute size or price. See `CLAUDE.md`'s AI-specific rules and `context/architecture.md`'s Model Boundary section for the current, authoritative description; this section is kept as a record of what V1 originally specified, not edited to read as if it always described the current system.

**[PROPOSED V1] Gemini is a binary veto and a scribe. It has no other authority.**

**It may:**
- Return `veto: true | false` on the narrow question *"Is there a known exogenous confound that invalidates this setup's premise?"*
- Write the human-readable thesis and invalidation text for the audit trail.

**It may not:** originate a trade, choose direction, propose or influence size, propose SL/TP, override a veto, or gate on a self-reported confidence number. ~~Still true of the entry-veto question itself; no longer a complete description of the model's mandate as a whole once an existing position is being managed (Phase 2) — see the historical-section note above.~~

**Why the confidence gate is removed.** The shipped system gates trades on `confidence ≥ effectiveMinConfidence`. The evidence against this is strong and specific. Verbalised LLM confidence shows expected calibration error of **0.24–0.47**, clusters on **3–4 round values**, and — the property a gate actually requires — has **AUROC 0.55–0.61**, i.e. almost no ability to rank correct predictions above incorrect ones (Xiong et al., ICLR 2024; *Ordinal Gates, Cardinal Bets*, arXiv:2609.00187). Calibration repair provably does not help: "monotone calibration cannot reorder predictions." RLHF actively inflates confidence independently of correctness (arXiv:2410.09724). In the one study of exactly this use case — headline-driven directional gating — **0 of 18 configurations survived Romano-Wolf multiple-testing correction.**

Worse for this specific design: LLMs **over-extrapolate recent performance** (Chen, Green, Gulen & Zhou, arXiv:2409.11540), and the extrapolation persists on *simulated* returns, ruling out look-ahead as the cause. An LLM asked to confirm a trend-following setup *after* a price move is doing precisely what the literature says LLMs do worst.

**[PROPOSED V1]** `confidence` is still **requested and logged** — it is needed to build the reliability curve that would justify ever trusting it. It simply has no effect on execution until that curve exists.

**[PROPOSED V1] Pin and log the model version on every decision.** Model updates silently move the training cutoff forward, which re-contaminates a forward test that looked clean when it started. `agent_decisions.model_version` already exists [LOCKED].

**Gemini must earn its place, and may not.** §23 H4/H5 test this directly. *"The news and LLM layers add no incremental value → remove them from V1"* is a pre-registered acceptable outcome, not a failure.

## 13. Exit methodology

**[PROPOSED V1] Three exits, in priority order:**

| Priority | Exit | Mechanism | Nature |
|---|---|---|---|
| 1 | **Stop-loss** | Position monitor, 5-min replay [LOCKED contract §5] | Catastrophic risk constraint |
| 2 | **Take-profit** | Position monitor [LOCKED] | Provisional catastrophe cap |
| 3 | **Regime exit** | `CLOSE` on the decision cycle | **The actual thesis invalidation** |

```
CLOSE(asset)  ⟺  state(asset) != FLAT  and  regime(asset) == DOWN
```

**The regime flip is the thesis invalidation. The stop is not.** This distinction is load-bearing and is preserved deliberately throughout §14–15. They are different objects on different clocks — the thesis lives on the daily MA, the stop on 4-hourly volatility — and that is coherent only because their *roles* are separate. Conflating them would make the stop an alpha parameter, which it must never be.

**Reversal takes two cycles** [LOCKED contract §1] — irrelevant in V1, which never opens shorts.

**Manual-mode caveat.** The regime exit only fires when a decision cycle runs. Under manual execution that is whenever the user clicks; positions may therefore run to SL or TP instead. **Results from manual-mode and scheduled-mode operation must not be pooled** (§22).

## 14. Stop loss

**[PROPOSED V1]**

```
stopPct  = clamp(2.0 × atrPct_4h, 0.025, max_stop_loss_pct)
stopPrice = entry × (1 − stopPct)          [LOCKED: contract §3 ordering]
```

**The stop is a catastrophic risk constraint bought at a known price. It is not an alpha source, and its parameters are never tuned for return.**

Kaminski & Lo's Proposition 1 is unambiguous: under a random walk the stopping premium is **Δμ = −p_o·π ≤ 0** — a stop *always* reduces expected return by forfeiting the risk premium during the time it holds cash. Proposition 2 gives the sufficient condition for a stop to add value: **ρ ≥ Sharpe at the same frequency**. Their celebrated positive empirical result does not transfer here on three counts: their **shortest tested window was 3 days** (which had negative stopping premiums — positive premiums required **monthly-and-longer** windows); their "safe asset" was **long-term Treasury futures that rally in equity stress**, whereas this system exits to zero-yield cash; and they set **transaction costs κ = 0** throughout.

So why keep a mandatory stop? Because it does three things a return-maximiser does not value but this system does: it bounds per-trade loss, it makes position sizing well-defined (§16 depends on a stop distance existing), and it caps the left tail in an asset class where Grobys et al. (*FMPM* 2025) estimate a tail exponent **α < 3** — a regime in which the variance may not be finite in population.

**Why ATR-scaled.** Not because 4-hour volatility defines when the thesis is wrong — the daily MA does that. ATR-scaling is retained **entirely for its sizing property**: with `size = budget / stopPct` and `stopPct ∝ ATR ∝ σ`, position size becomes **∝ 1/σ**, which is inverse-volatility targeting obtained for free. That is the single best-evidenced component of the whole design (§16).

**Why 2.0 and 2.5%.** The multiple is pre-registered on the same conventional-value logic as the MA lookback — it is not derived, and it is **[OPEN]** to principled revision. The 2.5% floor *is* derived, from cost arithmetic: at 0.30% round-trip, a 0.5% stop (the currently seeded `min_stop_loss_pct`) needs an **80% win rate at 1R** or **53% at 2R** merely to break even; a 2.5% stop holds the cost at ~0.12R. **The shipped 0.5% floor is unsafe, not merely provisional.**

**[OPEN]** Carr & López de Prado (arXiv:1408.1159) derive optimal (stop, target) pairs analytically from an estimated Ornstein-Uhlenbeck half-life and drift, explicitly to avoid calibrating exits on a backtest. That is the methodologically correct approach and V1 does not use it, because it requires process parameters we have not estimated. It is the right successor to the pre-registered constant.

**[LOCKED]** For shorts, `stopPrice < 2 × entry` unconditionally (contract §3). Inert in V1.

## 15. Take profit

**[PROPOSED V1]**

```
tpPct   = 6.0 × stopPct
tpPrice = entry × (1 + tpPct)              [LOCKED: contract §3 ordering]
```

**This is a provisional catastrophe cap, not an optimal target.** The real exit is the regime flip (§13). The take-profit exists because the contract mandates one and because unattended operation needs a ceiling — not because 6R is believed optimal.

**Why wide.** Dao et al. show trend-following P&L is **quadratic** in the cumulative move, giving a **χ² distribution with positive skew** — trend followers "lose more often than they gain," and the entire expected value lives in the right tail. Capping *position size* degrades the payoff from a parabola to a V; a hard take-profit **flattens it entirely** beyond the threshold. An illustrative fat-tail model (Pareto α=1.6, 38% hit rate — a model, not a measurement) gives expectancy of **−0.025R at a 2R cap**, +0.065R at 3R, **+0.176R at 6R**, and +0.342R uncapped. Sharpened by Grobys et al.'s finding that **a single outlier accounted for 37% of crypto momentum's entire compounded return**: in a distribution that concentrated, truncating the right tail is not a modest give-up.

**There is no peer-reviewed support for fixed R-multiples in either direction.** "2R" is folklore. 6R is chosen to be far enough out that it rarely binds, and is explicitly provisional.

**[PROPOSED V1] Mandatory diagnostic — what fraction of profitable trades touch the take-profit before the regime exits?**

| Touch rate | Interpretation |
|---|---|
| 1–2% | Genuine backstop. Working as intended |
| 5–10% | Borderline; widen or justify |
| 15–20%+ | **We have accidentally built a take-profit-driven strategy.** The framing in this section is wrong and must be revised, not the number nudged |

This diagnostic must be reported before V1 is frozen (§27).

## 16. Position sizing

**[LOCKED] Implementation** (`src/shared/risk/sizing.ts`) — not re-decidable here:

```
riskAmount   = NAV × riskBudgetPct
riskPerUnit  = |entry − stop|
notional     = (riskAmount / riskPerUnit) × entry
final        = min(notional, NAV×maxSingleTrade, NAV×maxAssetExposure − current, affordableCash)
```

Four caps, minimum taken; the binding one is recorded as `size_cap_applied`. The model has no input. **Confidence is never a size multiplier** [LOCKED].

**[PROPOSED V1] What this already is, and why it is the strongest part of the design.** Because `stopPct ∝ ATR ∝ σ`, position size is **∝ 1/σ** — this *is* volatility targeting, obtained without estimating anything extra. Volatility is the one quantity here that is genuinely forecastable: GARCH persistence for BTC is ≈0.987 (a ~53-day shock half-life) and HAR models on realized variance achieve **R² ≈ 0.60** for hourly volatility — an order of magnitude better than anything achievable for the *sign* of returns. Harvey et al. (*JPM* 45(1), 2018; 60 assets, data from 1926) find volatility scaling makes **left-tail events less severe across all asset classes**, because losses occur at elevated volatility when the scaled position is small.

**Three honest qualifications:**

1. **It is one-sided.** Volatility targeting requires *levering up* in calm periods. Unlevered, with a 20% notional cap, exposure is truncated exactly in the low-volatility states where inverse-vol sizing wants maximum size. **Expect lower mean return than published volatility-targeting results, not parity.**
2. **The flagship result fails replication.** Cederburg, O'Doherty, Wang & Yan (*JFE* 138(1), 2020) tested **103 strategies** and found real-time volatility-managed versions generally earn **lower** certainty-equivalent returns and Sharpe ratios than the unmanaged originals. Liu, Tang & Zhou (*JPM* 46(1)) attribute part of the original result to look-ahead bias in a full-sample scaling constant. **[PROPOSED V1] Any scaling constant must be computed from a trailing or expanding window, never the full sample.**
3. **[OPEN] Volatility targeting may not help crypto at all.** Harvey et al. find the Sharpe benefit holds for *risk assets with a leverage effect* (equities, credit) and is **negligible for bonds, FX and commodities**. Which is crypto? The literature conflicts directly: several GARCH studies find BTC has an **inverse** leverage effect (volatility reacts more to positive returns, gold-like), while De Nicola measures a conventional one (volatility-return correlation −0.113). **If the inverse-leverage finding is right, volatility targeting de-risks into rallies and the tail-protection rationale does not apply.** This is unresolved and material.

**[PROPOSED V1] Kelly sizing is rejected.** Unknown edge, a sample dominated by noise, an asymmetric penalty for overbetting, and — decisively — if the α<3 tail finding has force, the variance is not finite and Kelly is ill-posed rather than merely hard to estimate. Fixed-fractional risk-at-stop is the right family. The 20% cap is a defensible shrinkage constraint: DeMiguel, Garlappi & Uppal (*RFS* 22(5), 2009) found **none of 14 optimisation models consistently beat naive 1/N**.

## 17. Portfolio risk controls

**[PROPOSED V1]** None of these exist today — the system has no daily loss limit, no drawdown breaker, no concurrent-position cap and no correlated-exposure rule, and the 35% per-asset cap is **structurally inert** because `build-context.ts:158` hardcodes `currentAssetExposureUsd = 0`.

### 17.1 Portfolio risk ceiling — the primary control

```
Σ riskAtStop(open positions) + riskAtStop(candidate)  ≤  portfolioRiskCeiling
```

where `riskAtStop = notional × stopPct`, already known exactly for every position.

**Why a risk ceiling rather than a correlation-derived notional cap.** BTC/ETH correlation is roughly 0.8, which would imply that two equal positions carry ~1.90× the volatility of one, and that risk-equivalence to a single 20% position needs a combined cap near 21%. But correlation is **time-varying, regime-dependent and horizon-dependent** — building the primary control on a point estimate of it is fragile. A risk-at-stop ceiling needs **no correlation input at all**: it bounds the loss if everything stops out together, which is precisely the scenario correlation was being invoked to describe.

**[PROPOSED V1]** `portfolioRiskCeiling = 1.5 × riskBudgetPct`. At balanced (0.50%), two full positions would risk 1.00%; the 0.75% ceiling scales each to ×0.75. **[OPEN]** The 1.5× multiplier is a judgement, not a derivation.

### 17.2 Secondary notional cap

**[PROPOSED V1]** Combined same-direction notional ≤ **30% of NAV**, handling concentration separately from loss. Also: repair the inert asset-exposure cap by passing real exposure into `buildRiskGateContext`.

### 17.3 Drawdown breaker

**[PROPOSED V1]** Block **new opens** (never closes) when NAV < 90% of peak NAV. **[OPEN]** Resume condition — manual reset, or recovery above 95% of peak.

### 17.4 No consecutive-loss breaker

**[PROPOSED V1] Deliberately excluded.** At a 40% hit rate, runs of 4 consecutive losses are expected **~6.5 times per 50 trades** — such a breaker would fire on randomness, not regime failure. A drawdown breaker measures magnitude; a streak breaker measures count, and count is noise at these hit rates. This is an example of a sensible-sounding rule rejected on arithmetic.

### 17.5 Max concurrent positions

**[PROPOSED V1]** 2, trivially bounded by the universe. §17.1 is the real constraint.

## 18. Re-entry

**[LOCKED]** After a stop-loss exit, re-opening the same asset in the same direction is blocked for `stop_out_reentry_block_minutes` (360). `CLOSE` is never blocked (contract §7).

**[PROPOSED V1] Strategy assessment: this rule does much less work in V1 than it appears to, and its duration is anchored to the wrong thing.**

- **Largely redundant.** After a stop-out the regime must still be UP to re-enter, and the stop is 2×ATR below entry. A structural re-entry condition (regime still favourable) already exists and is market-anchored.
- **The duration is cadence-derived, not market-derived.** 360 minutes is documented as "2 cycles" at the 3-hour cadence. If the cadence changes, the rule's meaning silently changes. A market-anchored equivalent (e.g. requiring a fresh regime transition) would be more defensible.
- **[OPEN] A real gap:** the block arms only on `close_reason = 'stop_loss'` (`index.ts:129`). A short closed by `collateral_exhausted` — a *worse* outcome — arms nothing. Inert in V1 (no shorts), but wrong.
- **The trading rationale is genuinely two-sided.** Whipsaw protection is real; but in a strong trend, stop-outs are frequently followed by continuation, and trend followers normally accept re-entry. The evidence does not settle this.

## 19. No-trade conditions

**[PROPOSED V1]** `HOLD` — the expected outcome of most cycles — when any of:

| Condition | Rationale | Status |
|---|---|---|
| Regime is DOWN and we are flat | No setup | V1 |
| Already positioned and regime still UP | Nothing to do | V1 |
| Stop-out re-entry block active | contract §7 | LOCKED |
| Fresh material adverse news | §10 | V1 |
| Gemini veto | §12 | V1 |
| Portfolio risk ceiling reached | §17.1 | V1 |
| Drawdown breaker active | §17.3 | V1 |
| Market data stale | fail closed | LOCKED |
| News provider failed | §10 | V1 |
| Sized notional ≤ 0 | `gate.ts` | LOCKED |

**Deliberately absent, with reasons** — every no-trade rule needs a justification, and these did not survive:

- **No volatility floor.** An earlier draft proposed skipping when `atrPct < 1.0%`, derived from cost-per-R. That derivation assumed an hours-long hold. At a 3-week hold, even a low-volatility 0.5% 4-hour ATR implies a ~5.6% expected move, against which the 0.30% cost is ~5%. **The rationale did not survive the holding-period change, so the rule was removed.** **[OPEN]** whether a floor is wanted for a different reason (weak trend signal in dead markets) — but that would need its own evidence, not a recycled cost argument.
- **No RSI overbought filter.** It would veto exactly the strong-trend conditions the strategy exists to capture.
- **No 7-day-extreme filter.** A new high in an uptrend is the normal state of a trending asset, not a warning.
- **No time-of-day or day-of-week filter.** Calendar effects in crypto are asset-specific, sample-specific, concentrated in one or two hours, and vanish under intraday fixed effects. Liu & Tsyvinski's own table shows BTC and ETH with *different* significant days.

## 20. Decision state machine

**[PROPOSED V1]** Evaluated per asset, per cycle. First match wins.

```
if state != FLAT:
    if regime == DOWN                 -> CLOSE        (thesis invalidated)
    else                              -> HOLD         (reaffirm invalidation text)

if state == FLAT:
    if regime == DOWN                 -> HOLD
    if reentry_block_active(long)     -> HOLD
    if drawdown_breaker_active        -> HOLD
    if news_provider_failed           -> HOLD
    if material_adverse_news          -> HOLD  (veto)
    if gemini_veto                    -> HOLD  (veto)
    if portfolio_risk_ceiling_reached -> HOLD
    else                              -> OPEN_LONG
                                         then LOCKED risk gate may still reject
```

**[LOCKED]** A `HOLD` on an open position must carry non-empty invalidation (`gate.ts`). **[LOCKED]** Every cycle is persisted, including HOLD and skipped cycles.

## 21. Worked examples

**Example 1 — the one real decision on record (2026-09-19, BTC).**
Observed: price 80,957; EMA20 80,453.90; EMA50 79,019.80; RSI 66.6; MACD histogram −143.03; ATR% 1.10%; volume ratio 1.04×; distance from 7-day high −0.88%.
V1 evaluation: state FLAT. Regime requires the **daily** 50-day MA, which the system does not currently fetch — under V1 this cycle **could not have been evaluated at all** until §6's daily fetch exists. Using the hourly EMA50 as an illustrative stand-in (price > EMA20 > EMA50 ⇒ UP), the setup would be valid and V1 would propose `OPEN_LONG`. *The live system decided HOLD* — because the model weighed the negative MACD histogram, an input V1 does not use.
**This is a genuine disagreement, not a validation.** It illustrates that V1 will trade in conditions the current prompt declines, and that a single observation cannot adjudicate between them.

**Example 2 — sizing, balanced appetite, $10,000 NAV, ATR% 1.10%, entry $82,000.**

```
stopPct  = max(2.0 × 1.10%, 2.5%) = 2.50%      (floor binds)
tpPct    = 6.0 × 2.50%            = 15.00%
stop     = 82,000 × 0.975         = 79,950
target   = 82,000 × 1.15          = 94,300
notional = min(0.50%/2.50%, 20%) × 10,000 = min(20%, 20%) = $2,000
riskAtStop = 2,000 × 2.50%        = $50.00  (0.50% of NAV — budget binds exactly)
round-trip cost = 2,000 × 0.30%   = $6.00   = 0.12R
```

**Example 3 — the portfolio ceiling binding.** BTC open with $50 risk-at-stop. ETH setup valid, would also risk $50. Ceiling = 1.5 × 0.50% × 10,000 = $75. Remaining room $25 ⇒ ETH sized to half, `size_cap_applied` records the portfolio ceiling.

**Example 4 — news veto.** Regime UP, flat, sizing available. A headline within the materiality window reports a major exchange exploit. Class = security incident ⇒ **HOLD**. Had the headline instead read "Bitcoin slides 6% as traders take profit" (commentary), it would carry **zero weight** and the trade would proceed.

## 22. Backtest methodology

**[OPEN — requires a scope change before any work begins.]** Backtesting is currently excluded in three places: `CLAUDE.md:219`, `ai-workflow-rules.md:17`, `project-overview.md:146`. `architecture.md` contains no design for it. Building a harness requires updating those documents first (`ai-workflow-rules.md:17`: "unless the context is explicitly updated first").

**[PROPOSED V1] Scope: technical layer only. The news layer is not backtestable.** Public RSS has no historical archive — it is not possible to reconstruct what headlines existed, with correct publication timestamps, at an arbitrary past moment. Any historical news backtest would also be contaminated by Gemini's training data. **§23 H4 and H5 are therefore forward-test-only hypotheses.**

**Dependency:** §22 cannot precede §7–9 being implemented deterministically. There is no deterministic strategy to backtest until the regime rule exists in code.

**[PROPOSED V1] Look-ahead controls, each mapped to a known failure:**

| Control | Failure prevented |
|---|---|
| Completed bars only; drop the in-progress period | §6 defect — repainting, live/backtest divergence |
| Signal from bar *t*, execution at bar *t+1*'s price | Signal/execution timestamp conflation |
| Never compare live spot against historical candles | `calculate.ts:178` |
| Full indicator warm-up before the first signal | Partial-window indicator values |
| Fees 0.1%/side, slippage 0.05%/side, applied adversely | Frictionless-fill optimism |
| Replicate the monitor's fill policy exactly (contract §5) | Optimistic stop fills |
| Pinned Gemini model version; no historical LLM calls | LLM training contamination |

**[PROPOSED V1] Reported metrics:** CAGR, max drawdown, Calmar, Sharpe and Sortino *with the §26 caveat*, downside deviation, profit factor, expectancy per trade in R, win rate, average win/loss, trade count, time in market, exposure, turnover, total fees, total slippage, exits by type (stop / take-profit / regime), risk rejections by reason, longest drawdown, **the §15 take-profit touch rate**, and performance split by regime and by asset.

## 23. Validation methodology — the falsification hierarchy

**[PROPOSED V1] Test in order. Each layer must justify itself before the next is evaluated.** This replaces "backtest → tweak → backtest."

| | Hypothesis | Null | Retire if |
|---|---|---|---|
| **H1** | The 50-day daily MA regime contains exploitable directional information in BTC/ETH | Buy-and-hold; random entry at matched frequency | **The strategy is retired, not patched.** Do not add indicators to rescue it |
| **H2** | Volatility-scaled sizing improves risk-adjusted behaviour | Fixed fractional sizing | Drop the complexity; use fixed sizing |
| **H3** | Wide backstop + regime exit beats finite profit-taking | 2R and 3R take-profit variants | The archetype was misidentified; revisit §3 |
| **H4** | A deterministic news veto adds incremental value | No news layer; random veto at matched rate | **Remove news from V1** |
| **H5** | Gemini's veto adds value beyond the deterministic news rule | Deterministic news rule alone; coin-flip veto at matched rate | **Remove the LLM from the trading path** |

**H5 is the most important question in this document** — more important than whether V1 beats buy-and-hold.

**[PROPOSED V1] Success is not "beat buy-and-hold BTC."** A strategy returning +115% with a −27% drawdown against buy-and-hold's +180% / −72% may be the better product. Baselines are **reference points, not pass/fail gates**, and comparison is on the full §22 panel with explicit error bars.

**[PROPOSED V1] Anti-overfitting protocol, binding:**

1. **Pre-register** every parameter and the full list of variants *before* looking at results. Count honestly — every abandoned variant counts.
2. **Report Deflated Sharpe**, never raw Sharpe. With 20 variants on a 3-month window, a zero-skill strategy is expected to print Sharpe ≈ 2.7.
3. **Respect the minimum backtest length.** `MinBTL ≈ 2·ln(N)` years for N independent trials. The binding sample is **independent market cycles — roughly three since 2015** — not the ~2,920 three-hour bars per year. **We can afford almost no configuration search.**
4. **CPCV with purging and embargoing** rather than walk-forward, which shows weaker false-discovery control on small samples.
5. **Never tune per-asset.** BTC/ETH differences are reported, never fitted.
6. **Reserve a holdout that is never inspected.**
7. **Do not re-tune V1 after seeing results.** Any substantive change creates V1.1 (§27).

**[PROPOSED V1] Statistical power — state this plainly in any results write-up.** Trades needed to distinguish edge from luck at t=2: **216** for 2R at a 40% hit rate; 138 for 3R at 33%. At ~800 trades for 80% power at a per-trade Sharpe of 0.10, and a V1 frequency of 6–20 round trips per asset per year, **edge detection is not achievable on any realistic timeline.** Treat the first 50 trades as an **engineering and instrumentation test**: does the system execute its own rules, is realized slippage near 0.05%, is trade frequency as predicted, what does Gemini's veto rate and reliability curve look like. **Do not compute a Sharpe ratio from 50 trades; if you do, do not believe it.**

## 24. Failure modes — adversarial review

**[PROPOSED V1]** For each: does V1 address it, or knowingly accept it?

| # | Failure mode | Disposition |
|---|---|---|
| 1 | **The premise is simply wrong** — Hudson & Urquhart found no OOS predictability for Bitcoin across ~15,000 rules. Price-vs-MA is not exempt | **Accepted, and it is the headline risk.** H1 tests it; failure retires the strategy |
| 2 | **The edge decays with maturation** — Detzel's own NASDAQ footnote predicts exactly this | **Accepted.** Monitored, not mitigated |
| 3 | **Sideways markets** — repeated regime flips, whipsaw, cost bleed | **Partly addressed** by the 50-day lookback (slow) and the drawdown breaker. Expect losing streaks |
| 4 | **Sharp reversals from high-volatility drawdowns** — where trend strategies lose most | **Accepted.** Inverse-vol sizing reduces exposure at high volatility, which helps *if* crypto has a conventional leverage effect — itself **[OPEN]** (§16) |
| 5 | **The stop has negative expectancy** (Kaminski & Lo Prop 1–2) | **Knowingly accepted and priced.** §14 |
| 6 | **Fat tails may make the variance undefined** (α<3) | **Accepted.** §26 caveats every Sharpe |
| 7 | **BTC/ETH correlated stop-outs** | **Addressed** by the §17.1 risk ceiling |
| 8 | **News is already priced in** | **Addressed by design** — veto-only, commentary excluded. H4 tests whether even that helps |
| 9 | **LLM miscalibration / over-extrapolation** | **Addressed** — confidence gate removed, veto narrowed, H5 can delete the layer |
| 10 | **LLM training contamination moves silently** | **Addressed** — pinned, logged model version |
| 11 | **Sample too small to conclude anything** | **Accepted and stated.** §23 |
| 12 | **Manual execution degrades the strategy** | **Partly addressed** — a daily-MA state is latency-tolerant. But regime exits do not fire unattended; do not pool the two modes |
| 13 | **Overfitting through iteration** | **Addressed** by the §23 protocol and §27 freeze |
| 14 | **Slippage worse than modelled in stress** | **Accepted.** 0.05% is optimistic precisely when the strategy is most active |
| 15 | **Liquidation cascades / gap risk** | **Partly addressed.** The monitor is data-limited at 5 minutes and cannot see sub-5-minute wicks (contract §5) |

## 25. Known limitations

1. The signal has **one parameter**; if 20/50/100-day give materially different results, V1 is fragile and that is a finding, not something to resolve by choosing.
2. **Two correlated assets** — effectively close to one bet. None of the managed-futures literature, which depends on diversification across dozens of markets, transfers.
3. **No leverage** ⇒ volatility targeting is one-sided (§16).
4. The **take-profit truncates** the tail it is designed not to truncate; §15's diagnostic measures how much.
5. **No intra-bar visibility** below 5 minutes (contract §5).
6. **Manual mode** makes regime exits unreliable (§13).
7. **News cannot be backtested** at all (§22).
8. Published evidence supporting this design comes from **samples ending 2018–2023**, largely pre-ETF.

## 26. Open questions

| # | Question | Why it matters | Status |
|---|---|---|---|
| 1 | **Sign of BTC's leverage effect** — conventional (De Nicola, −0.113) or inverse (several GARCH studies)? | Determines whether volatility targeting helps *at all* (§16). If inverse, crypto sits in Harvey et al.'s "negligible benefit" bucket | Unresolved; conflicting peer-reviewed evidence |
| 2 | **Is the tail exponent α < 3 for BTC/ETH?** | If so, variance is undefined in population and **Sharpe, volatility targeting and Kelly all rest on a moment that may not exist** | Grobys et al. measure it on a 30-coin long-short; transfer to BTC/ETH unestablished |
| 3 | **Has hourly mean reversion decayed?** De Nicola's ρ ≈ −0.07 is a 2015–2018 retail-dominated sample; nobody appears to have re-estimated post-2021 | Directly prices the stop's drag (§14). **This is the cheapest high-value measurement available** — hours of work against an assumption the design rests on. Still ≈ −0.06 ⇒ drag quantified; ≈ 0 ⇒ Prop 1 applies; > 0 ⇒ much of the pessimism lifts | **Recommended before implementation** |
| 4 | Should a volatility floor exist for non-cost reasons? | §19 removed the cost-based one | Would need its own evidence |
| 5 | Is the 2.0 stop multiple right? | Pre-registered convention, not derived (§14) | Carr & López de Prado is the principled successor |
| 6 | Should the materiality window be decoupled from `decision_interval`? | A 6-hour-old hack is invisible to the veto today (§10) | Requires a news-retrieval change |
| 7 | Portfolio risk ceiling multiplier (1.5×)? | §17.1 | Judgement, not derivation |
| 8 | Drawdown breaker resume condition? | §17.3 | Unspecified |
| 9 | Should the re-entry block be market-anchored rather than clock-anchored? | §18 | Rule is LOCKED; rationale is questioned |
| 10 | Minimum viable notional floor? | A $12 position is "approved" today | Carried from the pre-existing tracker |

## 27. V1 freeze criteria

V1 may be frozen when **all** hold:

1. §26 questions 1, 2 and 3 are resolved or explicitly accepted in writing.
2. The §6 closed-bar defect is fixed and verified.
3. The daily-granularity fetch exists and the 50-day MA is computed from completed daily bars.
4. Every parameter in §7, §14, §15, §16, §17 has a written ex-ante rationale — **none selected from results**.
5. The complete variant list is pre-registered (§23).
6. The §15 take-profit touch rate has been measured and the framing confirmed.
7. `trading-domain-contract.md` and this document contain no contradictions.

**After freezing:** backtest results **must not** retroactively change V1 parameters. Any substantive change creates V1.1. This prevents tuning against the same data that evaluates the strategy.

## 28. V1.1 / V2 candidates

Explicitly **not** in V1:

| Candidate | Blocked on |
|---|---|
| **Shorts** | H1 first; short-side evidence is weaker (§5) |
| **Carr & López de Prado optimal exits** | Estimating OU half-life and drift |
| **Ensemble-disagreement LLM uncertainty** | H5; a defensible alternative to self-reported confidence |
| **Explicit volatility targeting** | §26 Q1 |
| **Additional assets (SOL)** | Out of V0 scope; would also give the cross-section that Liu/Tsyvinski/Wu's factor work actually requires |
| **Trailing stops** | Explicitly excluded by `CLAUDE.md` |
| **Event-driven decision triggers** | Explicitly excluded |
| **Multi-timeframe confirmation** | Would need evidence it adds beyond price ÷ MA |

---

## Change log

**2026-09-20 — complete rewrite.** The prior draft (2026-09-19) contained no strategy: §4.1–4.9 were headers with one-line descriptions and no rules, while §1–3 restated already-shipped code and §4.5–4.8 proposed to redefine locked contract rules.

Substantive changes:

| # | Change | Reason |
|---|---|---|
| 1 | Corrected the header's "1-hour decision horizon" | No cadence exists; `decision_interval_minutes = 180` is load-bearing, and the data is two-tier, not uniformly hourly |
| 2 | Reframed §1 onboarding as *not built* | No onboarding exists and the extension is structurally forbidden from writing |
| 3 | Removed duplication of contract/implementation | Two sources of truth drift |
| 4 | **Rejected the 3-hourly technical archetype** | De Nicola; *JRFM* 2026; Hudson & Urquhart — the evidence at 1–4h points to reversal |
| 5 | **Withdrew an intermediate 7-day-breakout design** | Below Detzel's significant band; latency-sensitive; defect D1 makes it unimplementable as specified |
| 6 | **Adopted a 50-day daily MA as the sole directional signal** | The only horizon where BTC trend persistence survives peer review |
| 7 | **Dropped RSI, MACD, volume ratio, hourly EMAs, 7-day range from the decision** | Feature importance ≈ 0; mechanically collinear with price ÷ MA |
| 8 | **Removed the LLM confidence gate** | AUROC 0.55–0.61; 0 of 18 configurations survived correction |
| 9 | **Narrowed news to veto-only**, commentary excluded | News follows price; confirmation double-counts the chart |
| 10 | **Reframed the stop as a priced risk constraint** | Kaminski & Lo Prop 1: Δμ = −p_o·π ≤ 0 |
| 11 | **Widened the take-profit to 6R**, with a touch-rate diagnostic | Dao et al.: a hard TP flattens the χ² right tail |
| 12 | **Recalibrated risk budgets to 0.25/0.50/0.75%** | All three appetites were producing identical positions |
| 13 | **Raised the stop floor to 2.5%** | 0.5% needs an 80% win rate at 1R to break even |
| 14 | **Added portfolio risk controls**, with a risk-at-stop ceiling rather than a correlation estimate | None existed; correlation is time-varying |
| 15 | **Excluded a consecutive-loss breaker** | Would fire ~6.5× per 50 trades on noise |
| 16 | **Removed the proposed volatility floor** | Its cost rationale did not survive multi-week holds |
| 17 | **Long/flat only in V1** | Short-side evidence is weaker; BTC/ETH differ in sign at short horizons |
| 18 | **Rescoped §6 backtesting** to technical-only, gated on a documented scope change | Excluded in three authoritative files; news is not backtestable |
| 19 | **Replaced "beat buy-and-hold" with a risk-adjusted panel**, and added the H1–H5 falsification hierarchy | Raw return vs buy-and-hold is the wrong question; H5 is the right one |
| 20 | **Stated plainly that V1 cannot prove an edge** | ~216 trades for t=2 against 6–20 round trips per asset per year |
