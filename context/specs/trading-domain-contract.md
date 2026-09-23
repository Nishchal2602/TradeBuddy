# Trading Domain Contract

Status: **locked — Step 0 of the position-model plan.** This is the authoritative specification of trading behavior: state model, action semantics, accounting, SL/TP, and the relationships between decisions, positions, and trades. Steps 1–7 implement against this; they do not redefine it.

The executable source of truth is [`supabase/functions/agent-cycle/domain/contract.fixtures.ts`](../../supabase/functions/agent-cycle/domain/contract.fixtures.ts) and [`contract.test.ts`](../../supabase/functions/agent-cycle/domain/contract.test.ts) — 19 passing tests checking every rule below for internal consistency. This document is the prose explanation; the fixtures are what later steps are actually graded against.

**Not in scope here:** NEWS/TECHNICAL decision methodology, Gemini prompt content, indicator interpretation. Those are reviewed separately.

---

## 1. Position state model

One net position per asset. No lots, no pyramiding — enforced at the database level by `positions_one_open_per_asset_idx` (a partial unique index on `status = 'open'`), not just by application logic. That invariant is unchanged and remains the actual hard limit.

~~No partial exits.~~ **Superseded 2026-09-22/23 (Phase 2, "Jev as a portfolio-management decision layer").** A partial exit (`REDUCE`) now exists, and an existing position's size can also grow (`ADD`) — both mutate the ONE open row in place (quantity/entry_price/cost_basis) via a true weighted-average entry; neither ever inserts a second position row, and the one-net-position-per-asset invariant above is completely unaffected. A `REDUCE` resolving to the full quantity is normalized to `CLOSE` before it reaches this state machine, never executed as a 100% reduce. Full accounting detail: `broker/accounting.ts`'s `addToPosition`/`reducePosition`, proven against `accounting.test.ts`'s Phase 2 fixtures the same way §2 below was originally proven against `ACCOUNTING_SCENARIOS`.

| State | Meaning | Valid actions |
|---|---|---|
| **FLAT** | no open `positions` row for the asset | `OPEN_LONG`, `OPEN_SHORT`, `HOLD` |
| **LONG** | one open row, `direction = 'long'` | `HOLD`, `ADD`, `REDUCE`, `CLOSE`, `MODIFY_PROTECTION` |
| **SHORT** | one open row, `direction = 'short'` | `HOLD`, `ADD`, `REDUCE`, `CLOSE`, `MODIFY_PROTECTION` |

Every other (state, action) pair is rejected — see `STATE_TRANSITIONS` in the fixtures for all 12 pairs and their exact rejection reasons. The table is total: no undefined pair, no unreachable state.

### Reversal behavior

A direction flip takes **two cycles**: `CLOSE` at cycle N, `OPEN_SHORT` (or `OPEN_LONG`) at N+1 — 6 hours apart at the 3-hour cadence. The action set has no atomic reversal. Adding one would mean two fills under a single decision, which is out of scope here. This is an accepted, documented property, not an oversight.

---

## 2. Short accounting — 1x unleveraged synthetic

Opening a short **reserves collateral equal to notional** rather than crediting cash on the sale. This is the entire mechanism that makes it genuinely unleveraged: no margin is borrowed, nothing is sold that isn't already accounted for.

For notional `N` at entry `E`, quantity `Q = N / E`:

| | Long | Short |
|---|---|---|
| **Open** | `cash −= N + fee`; `cost_basis = N` | `cash −= N + fee`; `cost_basis = N` |
| **Unrealized P&L** | `(current − E) × Q` | `(E − current) × Q` |
| **Close at price `X`** | `cash += Q×X − fee` | `cash += N + (E − X)×Q − fee` |
| **Realized P&L** | `(X − E) × Q` | `(E − X) × Q` |

`cost_basis` has one meaning regardless of direction: *cash removed from free cash at open*. Realized P&L is always the **clean, price-based** figure — fees are a separate cost, already visible as their own `trades.fee` value, and are never folded into `positions.realized_pnl`.

**Accounting identity, holds for every scenario in both directions:**

```
cashAfterClose − startingCash  ==  realizedPnl − totalFees − totalSlippage
```

Verified arithmetically for 6 scenarios (long profit/loss, short profit/loss/exhaustion/gap-through) — see `ACCOUNTING_SCENARIOS`.

### Collateral exhaustion

A short's **exhaustion price is `2 × entry`** — the price at which cumulative loss exactly equals the collateral reserved at open.

**Exhaustion is a deterministic close, not a P&L clamp on an open position.** If price reaches `2E`, the position is **closed** — trade written, `close_reason = 'collateral_exhausted'`, realized P&L of exactly `−N`. A short never remains open with its loss silently capped while the position itself keeps running.

**Gap handling — the case that actually needs a clamp:** if a price poll observes a value *beyond* `2E` (a gap that skipped past the exact boundary — plausible given the monitor's 10-minute/5-minute-replay cadence, §5 below), the close must still **fill at the exhaustion price**, not the observed price. Filling at the observed price would realize a loss beyond what the collateral actually covers — e.g. entry 100, notional 2000, observed 250: filling at the observed price gives `realizedPnl = -3000`, a $1,000 error past the $2,000 actually at risk; filling at the clamped exhaustion price (200) gives exactly `-2000`. This is asserted directly in `ACCOUNTING_SCENARIOS` (`'short, GAP THROUGH exhaustion'`) — the naive computation is computed in the test specifically to show it would have been wrong.

**Longs need no equivalent.** Price is floored at 0, so a long's maximum loss is naturally bounded by its cost basis — there's no earlier artificial threshold to enforce.

```
NAV = cash + Σ long(Q × current) + Σ short(collateral + (E − current) × Q, floored at 0)
```

No real leverage, margin borrowing, funding payments, or exchange-style liquidation mechanics exist anywhere in this model. The `2E` exhaustion rule is the *entire* risk mechanism for a synthetic short, standing in for what a real exchange's liquidation engine would otherwise do.

---

## 3. Stop-loss / take-profit

The model proposes SL/TP as **percentage distances from entry**; deterministic code computes absolute prices and validates before the open is accepted. A failing validation **rejects the open outright** — it is never silently corrected or partially accepted.

```
LONG:   stop_loss_price < entry_price < take_profit_price
SHORT:  take_profit_price < entry_price < stop_loss_price
```

**Validation is one combined check, not two independent ones.** For a short specifically, ordering alone (`entry < stop_loss_price`) is not sufficient — a stop placed at or beyond the exhaustion price (`stop_loss_price >= 2 × entry`, i.e. a stop-loss distance of 100% or more) is unreachable, because exhaustion fires first or simultaneously. This surfaced as a real gap while building the fixtures: a validator that checks ordering alone accepts a 100%-distance short stop, which is wrong. The correct check is `ordering_valid AND stop_loss_price < exhaustion_price` as one combined predicate — see `isValidSlTp` in `contract.test.ts` and the explicit fixture case for it.

Distance bounds (`min_stop_loss_pct`, `max_stop_loss_pct`, `min_take_profit_pct`, `max_take_profit_pct`) are **configurable, values deliberately deferred** until after the NEWS/TECHNICAL methodology review — seeded with wide placeholders in Step 1's migration, flagged there as provisional. The one bound that is *not* a free tuning choice: a short's `max_stop_loss_pct` must stay strictly below 100%, structurally, independent of whatever methodology-driven value is eventually chosen.

Every `SL_TP_ORDERING_CASES` entry (12 cases: 6 valid/rejected per direction, including strict-equality edge cases and the exhaustion-ceiling case) is checked in `contract.test.ts`.

---

## 4. Decision → position → trade relationships

Every trade carries a `position_id` — no exceptions, whether agent-initiated or automatic.

Exactly **three** legal combinations of (`intent`, `decision_id`, `trigger_reason`) exist. Every other combination is invalid:

| `intent` | `decision_id` | `trigger_reason` |
|---|---|---|
| `OPEN_LONG` / `OPEN_SHORT` / `ADD_LONG` / `ADD_SHORT` / `REDUCE_LONG` / `REDUCE_SHORT` | **set** | **null** |
| `CLOSE_*` — agent-initiated | **set** | **`'agent_close'`** |
| `CLOSE_*` — automatic exit | **null** | `'stop_loss'` / `'take_profit'` / `'collateral_exhausted'` |

**`ADD_*`/`REDUCE_*` added by Phase 2 (2026-09-22/23)** — they share OPEN's exact provenance shape (always agent-initiated; the position monitor only ever closes, never adjusts). `CLOSE_*` stays reserved for the FINAL close of a position — `trades_one_close_per_position_idx` (a genuine unique index, unaffected by this addition) still permits at most one close-trade per position, ever; a partial exit is `REDUCE_*`, never `CLOSE_*`.

**An agent-initiated close legitimately carries both `decision_id` and `trigger_reason`.** An earlier draft of the position-model plan stated the rule as "exactly one of (`decision_id`, `trigger_reason`)" — that was wrong, caught during plan review before any code existed. The corrected rule is keyed on `intent`, not an XOR across two fields, and `contract.test.ts` has a dedicated test (`'an agent-initiated close legitimately carries BOTH...'`) specifically guarding against that mistake recurring.

Step 1's migration enforces this with a single constraint:

```sql
constraint trades_provenance_valid check (
  (intent in ('OPEN_LONG','OPEN_SHORT')
     and decision_id is not null and trigger_reason is null)
  or
  (intent in ('CLOSE_LONG','CLOSE_SHORT')
     and decision_id is not null and trigger_reason = 'agent_close')
  or
  (intent in ('CLOSE_LONG','CLOSE_SHORT')
     and decision_id is null
     and trigger_reason in ('stop_loss','take_profit','collateral_exhausted'))
)
```

`agent_decisions` gains a `position_id` column so the relationship is navigable from either side (`positions.opened_by_decision_id` / `closed_by_decision_id` already exist in the other direction).

All 12 `PROVENANCE_CASES` (3 legal + 9 illegal, covering every plausible near-miss — an open carrying a trigger reason, an open with no decision, an agent close missing its marker, an automatic exit carrying a decision id, a close with neither marker) are checked in `contract.test.ts`.

---

## 5. Position monitor — data sufficiency

SL/TP execution runs on its own 10-minute schedule, independent of the 3-hour decision cycle — a second `pg_cron` job, not a side effect of the agent cycle. **This is not equivalent to a real stop order**, and the design says so explicitly rather than implying otherwise.

Verified live against CoinGecko (2026-09-18), not assumed:

| Source | Resolution | High/Low |
|---|---|---|
| `/market_chart?days=1` | 289 points, **5-minute** spacing | no — spot price only |
| `/ohlc?days=1` | 48 candles, **30-minute** spacing | yes |

Each 10-minute monitor run **replays every 5-minute point since its last run**, not a single spot snapshot — same API cost as reading one point, strictly better fidelity. This is the actual justification for the 10-minute cadence: detection is data-limited at 5 minutes, not poll-limited at 10.

**Stated limitations, not hidden:**
- Sub-5-minute price action is invisible. A wick that breaches and recovers within one 5-minute interval is missed entirely.
- The 30-minute OHLC high/low is the only source that could catch such a wick, but it lags up to 30 minutes and can't order SL vs. TP within a single candle. Whether to add it is a Step 5 decision made after measuring how often it would actually matter — it roughly doubles monitor API calls.
- Where a single window's data shows both SL and TP breached, **SL wins** — the conservative resolution.
- All monitor fills are approximations of what a real stop order would achieve, not a claim of equivalence.

### Fill policy

The **less favorable** of the trigger level and the observed price:

| | Trigger condition | Fill price |
|---|---|---|
| Long SL | `observed ≤ SL` | `observed` (models gap risk) |
| Long TP | `observed ≥ TP` | `TP` (no windfall from polling luck) |
| Short SL | `observed ≥ SL` | `observed` |
| Short TP | `observed ≤ TP` | `TP` |

Then slippage applies adversely on top. Filling every trigger at its exact level would assume a perfect fill a real stop wouldn't get, and would make paper P&L systematically optimistic — precisely the bias that would invalidate the experiment this whole project exists to run.

---

## 6. Concurrent close — two independent execution paths

The agent cycle and the position monitor can both target the same open position. Both interleavings are specified, not just the happy path:

```
agent cycle reads LONG  →  agent decides CLOSE
                              ↓
        monitor hits SL first  →  monitor closes position
                              ↓
                   agent attempts CLOSE  →  must be a no-op
```

**Required result, regardless of which side wins: exactly one position close, one close trade, one realized P&L entry.** The loser is always recorded correctly — an agent decision that lost the race persists as `rejected` ("position already closed"), never silently dropped; a monitor tick that lost the race logs a no-op in its run record and creates no trade.

**Mechanism** — the loser must *detect* the race, not assume an earlier read still holds:

- The status check is a **conditional `UPDATE ... WHERE status = 'open'`, executed inside the same transaction as the fill** — not a separate read-then-write. Zero rows affected means another path already closed it.
- The decision row is written **once, after execution is attempted**, carrying the true outcome.
- The partial unique index (one close-trade per position) is the database-level backstop if both paths somehow passed the status check.

`OPEN_*` has no equivalent race: overlapping agent cycles are already prevented by the `agent_runs` idempotency key, and the monitor never opens positions.

Both interleavings (`CONCURRENT_CLOSE_RACE`) are encoded as ordered event sequences in the fixtures — Step 5 re-runs them against real code and the live database, asserting actual row counts, not just replaying the sequence narratively.

---

## 7. Stop-out re-entry block

After a **stop-loss** exit, re-opening the **same asset in the same direction** is blocked for `stop_out_reentry_block_minutes` (default 360 = 2 cycles). The opposite direction is never affected.

**This is a deterministic proxy for "avoid immediately re-entering the same failed thesis," not actual thesis matching.** It compares asset, direction, and elapsed time — nothing semantic, nothing about *why* the stop hit. Stated here explicitly so no later reader mistakes the mechanism for something it isn't.

`CLOSE` is never blocked by this, under any condition — a blanket cooldown that could delay an exit was explicitly rejected. Risk management must always be actionable; only *re-entry* is throttled.

---

## Change log

- **2026-09-18** — initial contract (Step 0). Two corrections made during the executable-fixture pass, both recorded above where they apply: the provenance rule (§4) was mis-stated as an XOR in an earlier plan draft; SL/TP validation (§3) needed the exhaustion-ceiling folded into one combined check rather than ordering alone.
