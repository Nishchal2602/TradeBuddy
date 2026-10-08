# P4 — deterministic-exit counterfactual: did Jev's CLOSE help or hurt?

**Date:** 2026-10-08
**Plan:** STRAT-1 §P4 (`/Users/nishchal/.claude/plans/pricing-and-model-selection-ethereal-fox.md`)
**Trigger:** F3 in the STRAT-1 investigation found Jev's `agent_close` exits averaged +0.29R MFE vs. -0.61R MAE — but flagged that conclusion as provisional, since MFE/MAE are sampled only while a position is open and Jev's own CLOSE truncates that sampling. This replays the REAL subsequent price path (now available, since time has passed) to settle it properly.
**Method:** Every champion `intraday_ls` position (`positions` joined to `trades` for exact fee/funding-inclusive realized P&L), replayed against the stored 30-minute **true-OHLC** `market_bars` series. No assumptions about what price did after a Jev close — every bar is a real, stored high/low/close. Script: `p4_replay.py` (reproduced in full below).

---

## 1. Scope and data quality

20 champion `intraday_ls` positions exist as of this writing (2026-10-03 → 2026-10-08), not the 21 the earlier investigation counted — the one-position difference is simply time passing between that investigation and this one (one more BTC position opened 2026-10-08 04:15 and is still open). All 20 are **long** (0 shorts ever, consistent with every prior finding).

| close_reason | count |
|---|---|
| `agent_close` (Jev) | 14 |
| `time_stop` | 4 |
| `take_profit` | 1 |
| still open | 1 |

**Coverage is complete — no guessing required anywhere.** Every one of the 19 closed positions resolved to a definitive outcome within the available 30m bars: **zero** ambiguous same-bar stop+target intervals, **zero** "undetermined/data cutoff" cases. (The still-open BTC position is excluded from the counterfactual entirely — it hasn't had a Jev close to counterfactual yet.)

### Documented approximations (stated, not silently assumed)

- **Bar-granularity, not the monitor's real 10-minute poll.** A breach or time-stop crossing inside one 30m bar is resolved at that bar — a genuine, permanent fidelity limit of replaying on 30m bars (the same gap Stage 2's own replay work already documents, not a new one).
- **Exit cost on the counterfactual leg** is approximated at a flat 0.15% of exit notional (10bps fee + 5bps slippage — the system's own per-side convention), expressed in R units. The real entry-side cost and any real prior `REDUCE`'s cost are the actual recorded values, not re-estimated.
- **R is normalized against the ORIGINAL `initial_risk_usd`/`initial_stop_loss_price`**, exactly as the live system's own `positionPnlR` does — a later `MODIFY_PROTECTION` tighten (found on 2 of the 20 positions) changes the breach **level**, never the R **denominator**.
- Two positions had a real partial `REDUCE` before their final close (one `agent_close`, one `time_stop`) — the counterfactual for the `agent_close` one correctly carries the already-banked partial R forward and runs only the **remaining** quantity's fraction forward.

---

## 2. Per-trade result

`cf` = counterfactual R if Jev's CLOSE had been replaced by deterministic-only exits (stop / target / time-stop), replayed against the real subsequent price path. For `time_stop`/`take_profit` rows, the actual result **already is** the deterministic-exit result — no counterfactual needed, shown for completeness.

| Asset | Opened | Closed | Real exit | Actual R | Counterfactual R |
|---|---|---|---|---|---|
| BTC | 10-03 00:00 | 10-04 11:38 | agent_close | +0.495R | +0.581R (hard time-stop) |
| ETH | 10-03 04:00 | 10-05 00:45 | agent_close | +1.065R | +1.105R (take-profit) |
| SUI | 10-04 16:15 | 10-04 16:45 | agent_close | -0.741R | -1.099R (stop-loss) |
| AVAX | 10-04 17:15 | 10-05 01:45 | agent_close | -0.675R | -0.520R (stop-loss) |
| BTC | 10-04 17:15 | 10-05 01:50 | take_profit | +1.150R | +1.150R *(= actual)* |
| ETH | 10-05 01:15 | 10-05 04:45 | agent_close | -0.964R | -0.420R (soft time-stop) |
| BTC | 10-05 08:45 | 10-05 15:45 | agent_close | -1.064R | -1.042R (stop-loss) |
| ETH | 10-05 08:45 | 10-05 16:00 | agent_close | -0.979R | -1.119R (stop-loss) |
| BTC | 10-05 21:15 | 10-06 13:40 | time_stop | +0.274R | +0.274R *(= actual)* |
| ETH | 10-05 21:45 | 10-06 13:40 | time_stop | -0.604R | -0.604R *(= actual)* |
| **AVAX** | **10-06 05:45** | **10-06 07:15** | **agent_close** | **-1.059R** | **+1.763R (take-profit)** |
| AVAX | 10-06 08:00 | 10-06 12:15 | agent_close | +0.577R | +0.647R (take-profit) |
| BTC | 10-06 14:15 | 10-06 22:20 | time_stop | -0.812R | -0.812R *(= actual)* |
| ETH | 10-06 14:15 | 10-06 19:15 | agent_close | -0.913R | -0.609R (soft time-stop) |
| ETH | 10-06 23:45 | 10-07 02:00 | agent_close | -0.975R | -1.119R (stop-loss) |
| AVAX | 10-07 07:15 | 10-07 09:30 | agent_close | -0.854R | -1.073R (stop-loss) |
| ETH | 10-07 07:15 | 10-07 09:30 | agent_close | -0.600R | -1.119R (stop-loss) |
| AVAX | 10-07 16:15 | 10-07 20:15 | agent_close | -0.670R | -1.072R (stop-loss) |
| BTC | 10-07 19:15 | 10-08 03:20 | time_stop | -0.720R | -0.720R *(= actual)* |
| BTC | 10-08 04:15 | — (open) | — | -0.080R (unrealized) | n/a, no close yet |

---

## 3. Aggregate result, with its own MDE — and a finding the aggregate alone would hide

Across the **14** `agent_close` positions (the only ones where Jev's discretion changed the outcome):

```
sum actual_net_r       = -7.357R
sum counterfactual_r   = -5.096R
mean actual            = -0.525R/trade
mean counterfactual    = -0.364R/trade

paired diff (actual − counterfactual): mean = -0.162R, sd = 0.817, n = 14
t = -0.74
90% CI: [-0.548, +0.225]R
95% CI: [-0.633, +0.310]R
MDE at n=14 (80% power, α=.10, two-sided): 0.542R
```

**Per invariant I5: this is NOT ACTIONABLE.** The point estimate (-0.162R/trade, i.e. Jev's CLOSE cost about 0.16R/trade on average) is well inside the 90% CI, which spans zero, and the CI's own width (0.77R) exceeds the MDE (0.542R) by enough that no directional claim is supportable at this n.

**The point estimate is also not robust — it is driven almost entirely by one trade.** The AVAX position opened 2026-10-06 05:45 is a genuine outlier: Jev closed it at -1.059R, but the real subsequent price action shows it would have run to its take-profit at +1.763R — a 2.82R swing, by far the largest single divergence in the set (next-largest is 0.544R). Excluding that one trade:

```
n = 13, mean diff (actual − counterfactual) = +0.043R, sd = 0.296
median diff (actual − counterfactual), full n=14 = -0.031R
```

With the outlier removed, Jev's CLOSE and the deterministic-only path are **statistically indistinguishable — a wash**, and the median across all 14 (-0.031R) already said the same thing before any exclusion. The full-sample mean of -0.162R is not a representative "typical trade" result; it is one large reversal dominating a 14-trade average.

---

## 4. What this settles, and what it doesn't

- **F3's provisional "Jev's CLOSE helps, removing it would make things worse" is NOT supported by the full-path replay.** The original MFE/MAE-based read was itself an artifact of truncated sampling (MFE/MAE stop updating the moment Jev closes the position) — exactly the caveat F3 flagged. With the real subsequent path available, the honest read is: **no detectable difference, at this sample size, once a single outlier trade is set aside.**
- **This does not establish that Jev's CLOSE is useless or harmful either.** 14 trades cannot resolve a question whose own MDE (0.54R) is more than 3x the point estimate (0.16R). The correct action is to keep collecting (both more champion history and, per P3, the `shadow_candidates` evidence instrument) — not to act on this number either way.
- **The outlier itself is worth a second look independently of the statistics**: a 2.82R round-trip swing on one trade is a large single data point about *when* Jev's CLOSE fires relative to a reversal, and is exactly the kind of case the (not-yet-built) failure-analysis/regression-case machinery from §6B would want to capture as an observation — not yet a regression case, since a losing-trade outcome alone never qualifies as one (invariant I6).
- **Jev's CLOSE is NOT removed or changed by this analysis.** This is a diagnostic read, not a strategy change — no code path was touched.

---

## Appendix — the replay script

```python
p4_replay.py  (saved at context/diagnostics/p4_replay.py for reproducibility)
```

Inputs: `positions`/`trades` for the champion portfolio (`is_test = false`) filtered to `opened_under_strategy_profile = 'intraday_ls'`, and `market_bars` (`timeframe = '30m'`, true OHLC) for BTC/ETH/SUI/AVAX from 2026-10-03 onward. Re-running this script against a later data pull will extend coverage as more champion history accumulates — the n=14 sample is expected to grow, and the MDE above should be recomputed each time rather than assumed to still apply.
