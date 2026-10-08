# Investigation: sustained losses across every account, zero shorts ever opened

**Date:** 2026-10-08
**Trigger:** User report — "All strategies and the champion account, every one is in big total pnl losses, this was not the case before; it has still never opened short, even in bearish markets it is opening long taking losses then closing those trades."
**Method:** Direct SQL queries against the live Supabase database (`positions`, `trades`, `agent_decisions`, `nav_snapshots`, `strategy_configs`, `market_bars`). No assumptions — every claim below is backed by a query result, reproduced inline.

---

## 1. Current state (as queried, 2026-10-08 ~05:15 UTC)

| Account | Starting capital | NAV | Realized P&L (cum) | Unrealized P&L |
|---|---|---|---|---|
| V0 Paper Portfolio (champion) | $20,000 | $19,657.05 | **-$219.77** | -$1.87 |
| E4-A Control | $20,000 | $19,911.02 | **-$72.16** | -$1.89 |
| E4-B Signal-Drift | $20,000 | $19,911.02 | **-$72.16** | -$1.89 |
| E4-C Giveback | $20,000 | $19,911.02 | **-$72.16** | -$1.89 |
| E4-D Volume-Gate | $20,000 | $19,876.29 | **-$100.94** | -$1.89 |

Every account is negative. The E4 accounts (seeded ~12 hours before this investigation, 2026-10-07 ~17:45 UTC) are already down $72–101 from three trades each — a much faster bleed rate than the champion's 17-day history, simply because they began trading right as the market entered the decline described below.

## 2. The losses are not random noise — they are 100% directional

Querying every closed position for the champion, across its **entire trading history** (2026-09-21 → 2026-10-08):

```
total_closed: 21
long_count:   21
short_count:   0        <-- zero, ever
wins:          6
losses:       15
total_realized_pnl: -$194.20
avg_realized_pnl:   -$9.25
```

Close-reason breakdown:

| close_reason | count | total P&L | avg P&L |
|---|---|---|---|
| `agent_close` (Jev management CLOSE) | 16 | **-$214.28** | -$13.39 |
| `time_stop` (soft/hard time-stop) | 4 | -$29.10 | -$7.28 |
| `take_profit` | 1 | +$49.19 | +$49.19 |
| `stop_loss` | **0** | — | — |

**No position has ever been closed by hitting its stop-loss.** Losses are being realized almost entirely through `agent_close` — Jev's own portfolio-management layer deciding to cut a position — and through the time-stop, not through the deterministic protective stop. The stop-loss levels themselves look sane (e.g. the open BTC position: entry $82,716.34, stop $81,682.90 — a 1.25% stop, consistent with the configured 1.2% floor); they're just rarely the thing that actually triggers.

## 3. Zero shorts, confirmed at the `bias` level — not just at the trade level

```sql
select bias, count(*) from agent_decisions ... where bias is not null group by bias;
```

| bias | count |
|---|---|
| LONG | 53 |
| NEUTRAL | 3 |
| **SHORT** | **0** |

In the champion's entire history, the deterministic bias classifier (`evaluateBias`, `strategy/intraday-ls/bias.ts`) has **never once** returned `SHORT`. Every arm that has ever fired is attributable to this:

| arm_id | bias | executed trades |
|---|---|---|
| `pullback_long` | LONG | 18 |
| `breakout_long` | LONG | 1 |
| `fade_long` | NEUTRAL | 1 (currently open) |
| `pullback_short` | SHORT | 0 |
| `breakout_short` | SHORT | 0 |
| `fade_short` | NEUTRAL | 0 |

This is not a config problem — the active config (`v4-compat`, confirmed via `strategy_configs.is_active=true`) has `shortEnabled: true` and a correctly-populated `directionPolicy`:
```json
{ "LONG": ["breakout_long","pullback_long"], "SHORT": ["breakout_short","pullback_short"], "NEUTRAL": ["fade_long","fade_short"] }
```
Shorts are fully wired and fully permitted to execute. The gate never gets a chance to even consider one, because `bias` never reaches `SHORT` in the first place.

## 4. Why bias never reaches SHORT (and why NEUTRAL doesn't save it either)

`bias` is computed from two lagging trend measures that must **both** agree on a downtrend:
- the 50-day daily-close SMA regime (`UP` requires price above the 50-day moving average)
- the 4-hour EMA20/EMA50 cross

A fresh decision payload pulled live (2026-10-08 05:15 UTC, BTC):
```json
"regime": { "regime": "UP", "dailyMa": 80264.59, "dailyClose": 82681.27, "barsUsed": 50 }
```
Price ($82,681) is still ~3% above the 50-day MA ($80,265) — the daily trend is genuinely, correctly still "UP" by this rule's own definition, even though BTC has fallen from the high-$83,000s to the low-$82,000s over the preceding ~36 hours. A 50-day SMA is designed to lag short pullbacks; that part is working as designed, not broken.

The problem is what happens once price falls far enough to knock the *shorter-term* leg (the 4h EMA cross) out of agreement with the daily trend, flipping `bias` to `NEUTRAL` (confirmed happening live — BTC's bias flipped `LONG → NEUTRAL` between 04:00 and 04:15 UTC on 2026-10-08). Under `NEUTRAL`, only the two fade arms are eligible:

- `fade_long` triggers on `RSI14 <= 30` **and** within 1×ATR of the 7-day low.
- `fade_short` triggers on `RSI14 >= 70` **and** within 1×ATR of the 7-day high.

The same live BTC payload shows exactly why only one of these can ever be true during a decline:
```json
"rsi14": 28.31, "distanceFromSevenDayLowPct": 0, "distanceFromSevenDayHighPct": -5.08
```
RSI is oversold (28.31 ≤ 30) and price is sitting at its 7-day low (0% away) — `fade_long` correctly triggers and opens a **long**, betting on a bounce. `fade_short`'s own condition (overbought, near the 7-day *high*) cannot be true at the same time price is making new 7-day *lows* — it is mechanically excluded by the same market condition that makes `fade_long` fire.

**The consequence: every bias state this system can actually reach in a falling market is long-only.**
- `LONG` bias → trend-continuation longs (lagging; keep buying dips that don't recover before the stop/time-limit).
- `NEUTRAL` bias during a decline → only `fade_long` can trigger (buying the oversold dip); `fade_short` is structurally excluded by the same price action.
- `SHORT` bias, the only state that could open a real short, requires the daily *and* 4h legs to jointly confirm a downtrend — a conjunction that has not occurred even once in this account's full trading history, and was already identified as a near-impossibility in an earlier offline measurement of this same regime rule (0 of 160 four-hour observations, BTC+ETH, prior to this session).

This matches the trade ledger exactly: 18 of 19 arm-attributed closed trades are `pullback_long` (LONG-bias trend continuation), the one open position right now is a `fade_long` (NEUTRAL-bias oversold bounce) that has already been re-detected on three consecutive 15-minute cycles while BTC continues to grind lower — each bounce it's betting on hasn't materialized yet.

## 5. A secondary, separate data-quality finding (contributing, not primary)

`market_bars`' `1d` timeframe rows for BTC do not land on daily boundaries — the most recent row's `open_time` advances by ~15 minutes between consecutive checks (05:13:10, 04:58:40, 04:43:30, 04:28:30, ... — exactly the agent-cycle's own 15-minute cadence), rather than sitting still until a genuine new calendar day closes. The live decision payload confirms this is not just a logging artifact: `regime.dailyClose` in the `agent_decisions.input_payload` matches this same shifting value. The closed-bar filter (`closedPoints`, `strategy/closed-bars.ts`) is designed to drop exactly one trailing live/off-grid point per series; for the daily series specifically, it appears insufficient to fully stabilize "today's" value, so the SMA50 comparison is effectively reacting to a live, continuously-updating spot price rather than a single fixed end-of-day close.

This does not appear to be the primary driver of the losses — the regime read (`UP`, price 3% above the 50-day MA) looks directionally correct regardless — but it means the daily trend signal is noisier and more reactive intraday than its own design intends, and it deserves its own investigation independent of this one. Flagging it here rather than folding it into the main hypothesis, since I have not traced far enough to know whether it ever flips the regime classification outright on its own.

## 6. What this is **not** — ruled out, with evidence

- **Not a sizing/execution bug from the recent multi-account (EXP-1) work.** All 4 E4 accounts and the champion opened the *identical* AVAX position (entry $11.2156, qty 267.618198037467, stop $10.97873549) and the *identical* BTC position at the same timestamps — the shared-tick, multi-account execution path is replicating the strategy consistently, not corrupting it.
- **Not a sudden regression on a specific date.** The hourly `realized_pnl_cum` trace for the champion shows a steady, continuous bleed from -$16.64 (2026-10-05) to -$219.77 (2026-10-08), not a cliff at one point in time. The E4 accounts simply make the same long-standing pattern more visible, faster, because they started trading mid-decline.
- **Not a disabled short flag.** `shortEnabled: true` is confirmed active in the live config.
- **Not unique to one variant.** None of E4's own variant differences (signal-drift enforcement, giveback ratchet, volume-gate removal) touch `directionPolicy` or the bias computation at all — this finding is orthogonal to everything the E4 dry run is currently testing, and explains why all 4 variants degrade together.

## 7. Hypothesis, stated plainly

**The system is a long-only strategy in practice, despite being designed and configured for both directions.** Every bias state it can actually reach during a price decline (`LONG` via a lagging 50-day trend filter that hasn't caught up, `NEUTRAL` via an oversold-bounce arm that is the only fade arm whose condition can be true in a falling market) only ever opens longs. The one bias state capable of opening a short (`SHORT`, requiring the daily and 4h trend legs to jointly agree) is reachable in theory and fully wired for execution, but has not occurred once in this account's history. The recent losses are the direct, mechanical consequence of this long-only-in-practice behavior meeting a real, multi-day price decline in BTC/AVAX/ETH — not a new code defect, a sizing bug, or a short-circuited config flag.

This is a known class of problem — an earlier offline investigation into this same regime rule had already measured and documented that joint SHORT-bias occurrence is rare to the point of practical non-existence, and that the regime filter's own measured forward-return edge was inconclusive at best. What's new here is live confirmation, from this account's own real trade ledger, of exactly how that structural limitation translates into a sustained real-money (paper) drawdown once the market actually turns down — and the secondary finding that the daily bar feeding the slower of the two bias legs isn't landing on clean daily boundaries, which may be adding noise to an already-rare signal.

No code has been changed as part of this investigation — this is a diagnostic report only, per the request.
