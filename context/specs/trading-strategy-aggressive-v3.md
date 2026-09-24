# Trading Strategy Aggressive V3.1 — profit recycling

**Status:** IMPLEMENTED (code-complete, gated at 577/577 tests, typecheck/lint/build clean) — **not yet deployed, not yet committed** as of 2026-09-23. Migration validated offline (`pglast`), not yet applied live beyond an earlier, narrower Strategy Profiles migration.
**Product:** TradeBuddy · **Assets:** BTC, ETH · **Execution:** paper only
**Authoritative contracts:** [`trading-domain-contract.md`](./trading-domain-contract.md) (execution semantics), [`trading-strategy-v1.md`](./trading-strategy-v1.md) (Balanced, unchanged, and the cost-arithmetic argument this document extends). Where this document and either of those disagree, **the contract, V1's cost arithmetic, and the live implementation win.**

This document covers **both** layers currently live under `agent_settings.strategy_profile = 'aggressive'`: the original entry/protection design (informally "V3," first implemented 2026-09-23) and the profit-recycling revision that supersedes its protection mechanism (**V3.1**, same day, following the first live observation). They are presented together because V3.1 is not additive — it replaces V3's broken profit-protection rung outright. `strategy_version` on a decision row reads `v3.1-jev-intraday-30m` for both layers; V3 alone was never deployed long enough to produce a distinguishable row.

---

## 1. Purpose and relationship to Balanced

**Balanced** (`strategy_version: v1-regime`) asks, every 3 hours: *is the longer-term thesis still intact?* It is the implemented, unmodified `trading-strategy-v1.md` design — daily 50-day trend regime, a single veto question, `max(2×ATR, 2.5%)` stop / 6× take-profit. Nothing in this document changes it. Every "Balanced regression" test in the suite exists specifically to prove that.

**Aggressive** (`strategy_version: v3.1-jev-intraday-30m`) asks, on a 15-minute decision cadence evaluating a 30-minute signal: *this position captured a meaningful short-term move — does remaining upside still justify leaving the accumulated profit at risk, or should some/all of it be realized?* The naming is deliberate: **cadence** (how often an existing position is re-evaluated, and how often the position-monitor samples it) is distinct from **signal timeframe** (the 30-minute OHLC the opportunity detectors and ATR reason over). Never call this a "15-minute strategy" in code or docs — that conflates the two and has caused real confusion during design review.

The non-negotiable rule carried over unchanged from V1: **the model never originates a trade or chooses its direction.** Aggressive's entries come from deterministic opportunity detectors, never from Jev; Jev can only judge a detected opportunity (ENTER/SKIP) or manage an already-open position (HOLD/ADD/REDUCE/CLOSE/MODIFY_PROTECTION), exactly the same bounded mandate `trading-strategy-v1.md` §11-12 established for Balanced.

---

## 2. Entry: deterministic opportunity detection, not origination

Two edge-triggered detectors on closed 30-minute true-OHLC bars (`strategy/aggressive/detectors.ts`), evaluated per asset, per cycle:

- **MOMENTUM_BREAKOUT** — the current bar's close exceeds the prior 8-bar high, and did not on the immediately preceding bar (the edge-trigger condition — a predicate that merely *stays* true never re-fires).
- **PULLBACK_CONTINUATION** — a frozen, pre-registered formula: `H` = the highest high over the 8 bars before current; require `H`'s bar index to be within the last 4 closed bars (recency); `L` = the lowest low strictly after the `H` bar; require `H > L` (a real leg exists); the current bar's close must sit strictly above the midpoint `L + 0.5×(H−L)`, strictly below `H`, and be a green bar (close > open) — all on a genuine edge.

Parameters (`MIN_BARS=12, LOOKBACK_BARS=8, RECENCY_BARS=4, PULLBACK_MIDPOINT=0.5`) are pre-registered and frozen; changing them without declaring a new sub-version is a violation of the anti-overfitting discipline `trading-strategy-v1.md` §480 already established for this project.

**Tradeability floor** (`clearsTradeabilityFloor`, `TRADEABILITY_FLOOR_K = 3`): no opportunity is emitted — regardless of detector output — unless `atrTargetDistancePct >= 3 × estimatedRoundTripCostPct`. At the documented 0.30% round-trip cost this requires ATR30 ≥ 0.225%; below that, a 4×ATR target is nearly consumed by fees and slippage before any edge exists.

**Jev's role, entry side** (`model/jev/entry-question.ts`): for a FLAT asset with a detected opportunity, the batched request additionally carries `{asset}_entry_quality` (Choice: ENTER/SKIP) and `{asset}_expected_move` (Score, mapped through a pre-registered, code-defined table — never a raw model number). Either veto or a SKIP answer can only ever REMOVE the candidate; Jev cannot invent one where no detector fired.

---

## 3. Protection at origination

`strategy/aggressive/protection.ts`'s `aggressiveProtectionFor(atr30Pct)`:

```
stopDistance   = max(2.0 × ATR30, 0.008)     // 0.8% floor — cost-derived (0.30% round trip ≈ 0.375R at this stop)
targetDistance = 4.0 × ATR30                  // no floor
```

**Explicitly not a constant 2R** — only true while the ATR term dominates the 0.8% floor; when the floor binds, stop is fixed at 0.8% while target keeps tracking 4×ATR30, so realized reward:risk varies with volatility. `protectionForEntry` is called ONLY at origination, never against an already-open position (`strategy/registry.ts`) — a profile switch never recomputes an existing position's SL/TP, and this holds for a position regardless of which profile opened it.

Deliberately does **not** inherit Balanced's 2.5%-floor / 6×-multiple formula — that formula is derived for a weeks-long hold and is incoherent at this horizon (`trading-strategy-v1.md` §15's own cost arithmetic).

---

## 4. Capital and risk policy

Pre-registered, not "2× Balanced's risk" (`src/shared/strategy/profiles.ts`):

| | Balanced | Aggressive |
|---|---|---|
| `riskBudgetPct` | from `risk_appetite` | 0.75% |
| `maxSingleTradePct` | 0.20 | 0.30 |
| `maxTotalNotionalPct` | 0.30 | 0.60 |
| `stopOutReentryBlockMinutes` | 360 | 60 |

Reachable via raised DB ceilings (`max_single_trade_pct` 0.20→0.35, `max_total_notional_pct` 0.30→0.70) — sizing is always `min(profile value, ceiling)`, so Balanced's own (smaller) profile values keep its effective caps at exactly 0.20/0.30, unchanged.

---

## 5. Diagnosis: why V3's protection mechanism was structurally inert

**Verified against live data** (agent_decisions, positions, market_quotes) after the first live Aggressive observation, not inferred. Full detail was worked out interactively; summarized here for anyone auditing V3.1's necessity later.

1. **The profit-locking rung was dead code at three layers.** The original `deterministicTighten`'s +1.5R rung computed a stop-loss price *above* entry for a long. `validateAbsoluteProtection` rejects a negative stop-distance and enforces `stopLoss < entry < takeProfit`; the DB constraint `positions_sl_tp_ordering_valid` independently hard-requires `stop_loss_price < entry_price` for a long. A stop that locks in profit is unrepresentable in this data model — confirmed by zero executed protection changes across the project's entire history.
2. **Jev's management context carried none of the profit-state fields it was documented as receiving.** `JevPositionSnapshot` declared `rMultiple`, `maxFavorableExcursionR`, momentum/volatility fields with a comment claiming an Aggressive producer existed; none did. A real live call showed Jev received only `direction, entryPrice, currentPrice, stopLossPrice, takeProfitPrice, heldHours, unrealizedPnlPct` — no R, no excursion, no momentum.
3. **No high-water state existed anywhere** — no MFE/MAE column, no tracking loop, in code or schema.
4. **R was sampled only at manual decision cycles.** `agent-cycle` has no cron (manual-only by explicit 2026-09-19 decision); the position-monitor runs automatically every 10 minutes but was a pure static-bracket executor with no adaptive logic. A live BTC position's true peak (+1.80R) occurred with no decision cycle anywhere near it; the cycles that did run all read inside `[1.0, 1.5)`, never reaching the dead +1.5R rung.
5. **The MODIFY_PROTECTION action was offered even when structurally incoherent.** An underwater position's only legal stop-tighten answer (`TIGHTEN_TO_BREAKEVEN`, landing above current price) would be rejected by the gate as a disguised CLOSE — so Jev's only coherent answer was to decline both sub-intents, silently normalized to HOLD with no trace of what was actually requested.

**Finding, stated plainly:** the original V3 policy was not "functioning correctly but insufficiently profit-seeking." It was structurally inert. That is an implementation defect, fixed below as a bug fix — the giveback ladder layered on top is the genuinely new hypothesis, and is what makes this V3.1.

---

## 6. V3.1: two R metrics, the immutable ruler, and the giveback ratchet

**Two metrics, computed against the same immutable ruler, never conflated** (`strategy/aggressive/protection.ts`):

```
priceR         = (price − initialEntryPrice) / |initialEntryPrice − initialStopLossPrice|      [long; mirrored for short]
               — MARKET-PATH. Quantity-independent. Context only, NEVER a profit statement.

positionPnlR   = (unrealizedPnlUsd + partialRealizedPnlUsd) / initialRiskUsd
               — ECONOMIC. THE profit metric. Drives every giveback decision.
```

An earlier draft of this design defined R purely from price displacement and called it profit — caught in review: after an ADD at a worse price, `priceR` can read positive while `positionPnlR` is genuinely negative. The two are persisted as separate `agent_decisions` columns (`price_r`, `position_pnl_r`) for exactly this reason — collapsing them into one column would destroy the distinction that makes this correct.

**`unrealizedPnlUsd` is GROSS (mark-to-market)**, matching every other unrealized-P&L figure this codebase reports — an eventual exit's cost is hypothetical until it happens, and is weighed separately via `costR` at the moment a giveback decision is made rather than pre-netted into a running number. **`partialRealizedPnlUsd` is NET of the fee each REDUCE actually paid** (slippage is already embedded via `fillPrice`) — deliberately NOT the same figure as `trades.realized_pnl`/`positions.realized_pnl`, which stay gross, matching this codebase's existing convention of reporting P&L and fees as separate line items for trade-history purposes. This distinction was caught during a pre-deploy review: a REALIZED cost is sunk and known, not hypothetical, so it must reduce the figure the giveback ratchet protects — otherwise repeated REDUCEs on one position would silently overstate protected profit by their cumulative fees (`broker/accounting.ts`'s `reducePosition` computes this as `ReducePositionResult.partialRealizedPnlDelta = realizedPnl − fee`, a field distinct from the gross `realizedPnl` it also returns).

**The immutable ruler** — `positions.initial_entry_price` / `initial_stop_loss_price` / `initial_risk_usd` — is captured once, atomically, inside `open_position_atomic` (for every new position, both profiles) and never redefined by ADD or REDUCE. `positions.partial_realized_pnl_usd` accumulates every REDUCE's NET realized amount, which is what keeps `positionPnlR` continuous across a partial exit — proven algebraically (and by test) that ADD and REDUCE are each P&L-neutral at the instant they execute, given this term.

**High-water state**, sampled by the position-monitor (not `agent-cycle`) every 10-minute tick, for any position with `high_water_tracked_from` set:

```
sampledMfeR = running max of positionPnlR over the position's life   [monitor-sampled]
sampledMaeR = running min of positionPnlR over the position's life
```

Explicitly **sampled**, never a guaranteed market maximum — if the true path ran +1R → +5R → +2R between two 10-minute observations, the system records +2R. The `sampled` prefix is load-bearing, matching this codebase's existing discipline for CoinGecko-derived extremes.

**The giveback ratchet** (`rawGivebackFloor`/`nextGivebackFloor`/`shouldExecuteGivebackExit`):

```
floorR(sampledMfeR) =
  sampledMfeR >= 3.0 → 1.5
  sampledMfeR >= 2.0 → 1.0
  sampledMfeR >= 1.5 → 0.5
  sampledMfeR >= 1.0 → costR        // currentRoundTripCostUsd / initialRiskUsd — true cost-adjusted breakeven
  otherwise          → not armed
```

Monotone — the stored floor never decreases, defended twice (the input `sampledMfeR` is itself a running max, and the ratchet step additionally takes an explicit `max` against the previously stored floor). Exit condition: armed, and `positionPnlR <= floorR` → **full close**, `close_reason = 'profit_giveback'`, filled at the observed price of the triggering point (the same "no windfall" policy a stop-loss gets). Partial profit-taking remains Jev's REDUCE decision — a deterministic partial close would duplicate that authority.

`currentRoundTripCostUsd`'s numerator tracks the position's CURRENT quantity (recomputed at each replayed point); only the `initialRiskUsd` denominator is frozen. After an ADD the position is larger and genuinely costs more to round-trip — an origination-based cost figure would set the +1R floor too low.

**Profile gating** (the product rule, stated explicitly since it isn't derivable from the mechanism alone): the monitor samples high-water state for every eligible position **regardless of the currently active profile** — under Balanced this is pure telemetry. The EXIT is checked only when Aggressive is the active profile at the moment of execution. Switching to Balanced disables the exit immediately, without touching any SL/TP; switching back to Aggressive resumes with intact high-water history rather than a reset ratchet. This is the one deliberate, narrow exception to this project's "no continuously-trailing stop" exclusion (`CLAUDE.md`) — a discrete, pre-registered, monotone floor evaluated once per 10-minute tick, not a price-by-price trail.

**Legacy-position eligibility**: a position opened before this migration is backfilled the immutable ruler ONLY if no protection change was ever recorded against it (structurally verified via `agent_decisions.stop_loss_price_after`, not assumed from out-of-band knowledge). `high_water_tracked_from` is deliberately left NULL for every backfilled position — its true historical peak predates any tracking, so sampling it now would understate MFE and could arm/exit the ratchet on a false read. Such a position remains permanently outside the giveback mechanism, continuing under its existing SL/TP only, until it closes.

**Concurrency**: the monitor's giveback close is guarded on both `status = 'open'` AND the CURRENT quantity matching the snapshot the trigger was computed from (`close_position_atomic`'s `p_expected_quantity`) — a same-tick ADD/REDUCE from `agent-cycle` loses the race rather than closing a position whose economics have since moved. A losing race is a no-op, re-evaluated fresh next tick, the same failure shape every other race in this codebase already uses.

---

## 7. Jev's management context and question design (Aggressive only)

`ManagementCandidateInput.aggressive` (undefined for Balanced — its snapshot stays byte-identical to the pre-2026-09-23 shape) carries: the immutable ruler, `partialRealizedPnlUsd`, sampled MFE/MAE, `minutesSinceEntry`, `currentRoundTripCostUsd`, and the reused intraday features (`ret15m/30m/60mPct`, `realizedVol5m`, `volumeTrendRatio`, `sampledDayHigh/LowPct`). `JevPositionSnapshot` carries both `priceR` and `positionPnlR` under distinct names — the ambiguous single `rMultiple` field was removed rather than kept alongside them.

The action question is reframed around marginal return:

> *This {asset} position reached a best point of {sampledMfeR}R and is now at {positionPnlR}R, having given back {givebackRatio} of its best gain. Price itself is {priceR}R from the original entry. A full round trip costs {costR}R. Considering the short-horizon momentum, the profit already accumulated, and how much of it is already gone — is continuing to hold the full position better than realizing part or all of it now?*

Deliberately not "are you bullish?" — that phrasing anchors reasoning to the broader trend, which is exactly what this strategy's short horizon must not do. `MODIFY_PROTECTION` is omitted from the offered action set whenever `isProtectionActionable` finds no legal tighten (the same fix as §5.5) — this applies to BOTH profiles, since it's a shared correctness fix, not an Aggressive-only behavior change.

One added, non-action question — `{asset}_remaining_upside` — reuses the entry path's `EXPECTED_MOVE_PCT_BY_SCORE_LEVEL` table rather than inventing a parallel scale or a second overlapping action space (`PROTECT_PROFIT`/`HOLD_FOR_CONTINUATION`/etc. was considered and rejected — near-isomorphic to the existing five actions, with no mechanism to reconcile disagreement). This is what finally populates `expected_move_pct`/`move_to_cost_ratio` on a management row — previously NULL on every Aggressive decision.

`MANAGEMENT_QUESTION_VERSION` bumped `v1 → v2` for this reframe.

---

## 8. H6 — pre-registered stopping rule

**Hypothesis:** a 15-minute decision cadence over a 30-minute signal, with deterministic opportunity detection and a monitor-enforced profit-recycling ratchet, produces a positive risk-adjusted result net of costs.

**Context this hypothesis sits inside** — `trading-strategy-v1.md` §0's cost arithmetic, extended: at 0.30% round-trip cost, the breakeven directional hit rate is ~69% for a 3-hour hold and rises as the typical move shrinks with √t at shorter horizons — roughly 83% at 60 minutes, and mathematically impossible (>100%) at 15 minutes on a naive directional-hit framing. H6 is deliberately framed as falsification, not as an expected win: **Aggressive's own edge, if any, must come from the profit-recycling mechanism harvesting more of a captured move than it gives back — not from directional prediction at a horizon the project's own cost model already argues against.**

**Window, pre-registered:** 30 completed round trips per asset, or 4 weeks of manual operation, whichever comes first.

**Evaluated on:** net P&L after costs · expectancy per trade in R (`positionPnlR` at close) · profit factor · max drawdown · capital utilization · median holding time · trade frequency · total fee burden · mean sampled MFE/MAE · the `move_to_cost_ratio` distribution · outcomes split by detector kind (`MOMENTUM_BREAKOUT` vs `PULLBACK_CONTINUATION`) · outcomes split by close reason (`take_profit` / `stop_loss` / `profit_giveback` / agent `CLOSE`).

**Explicitly not an edge test.** 30 trades is far below the ~216 `trading-strategy-v1.md` §497 computes as needed for t=2 significance; per that document's own instruction, do not compute a Sharpe ratio from this sample. The question is narrowly *does this deserve a second experiment?* — a clear negative (cost swamping every predicted move) is itself a real, useful result.

**H6's clock starts at the first genuinely Aggressive-originated entry**, not at the profile switch and not at any management-only decision on a Balanced-originated position. As of this document: **zero Aggressive-originated entries have ever executed** (the project's entire trade history is two `OPEN_LONG` trades from 2026-09-21, both Balanced-originated) — H6 has not started, and nothing about the V3.1 design changes was tuned against any observed H6 outcome, since none exists.

**Versioning discipline**: `strategy_version = 'v3.1-jev-intraday-30m'` is used for both the original V3 entry/protection design and this profit-recycling revision, since V3 alone was never deployed long enough to produce a distinguishable row. Any future parameter change to the giveback ladder, the detectors, or the capital policy — tuned from real H6 data rather than fixed now — must be declared as a new sub-version (V3.2+) before shipping, per this project's anti-overfitting discipline.

---

## 9. Hard gates before Aggressive may ever run automatically

No `pg_cron` schedule exists for `agent-cycle` in this phase, regardless of the gates below — Aggressive is manual-click-only exactly like Balanced. Before that changes:

1. H6's window (§8) completed and reviewed.
2. CoinGecko monthly-quota economics validated — usage was already close to the documented Demo-tier cap before Aggressive existed; automated 15-minute polling would add substantial additional load this project's current data architecture is not provisioned for.
3. Position-monitor cadence (currently 10 minutes) upgraded to ≤5 minutes — both stop-loss/take-profit latency and giveback-ratchet fidelity depend on it; the coarser the tick, the more of a real intraday peak is missed (§6's `sampled` discipline exists precisely because of this).
4. Real authentication added before any future write-capable Edge Function (a `control` function for switching `strategy_profile` remotely, if built) may write anything beyond one narrowly allowlisted field.

---

## 10. What this explicitly does not do

No cron, no automated trading, no multi-lot positions (still one net position per asset, database-enforced), no change to Balanced's entry rules/protection formula/risk settings/cadence/execution semantics, no weakened risk control anywhere, no second model provider, no forced minimum trade count, no partial deterministic profit-taking (REDUCE stays Jev's call), no auto-liquidation on a profile switch, no Settings-UI redesign beyond what a future strategy-profile selector needs.

## 11. Known remaining risks

1. 10-minute monitor sampling is a lower bound on true MFE — a fast intraday spike between ticks is invisible, so the ratchet can arm late or not at all. §9's cadence gate exists because of this, not just for stop-loss latency.
2. The ratchet is the only automatic profit mechanism; `agent-cycle`'s own discretionary REDUCE/CLOSE still requires a manual click.
3. All detector, protection, and capital parameters remain pre-registered judgment, not derived edges.
4. `runAgentCycle` has no unit test — the orchestration this design touches most is covered only indirectly, through its constituent pure functions.
5. Trade frequency may still disappoint: two edge-triggered detectors plus the K=3 tradeability floor deliberately suppress quiet regimes.
