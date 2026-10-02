# Current Configuration Reference

**Generated 2026-09-24, against live code + live `agent_settings`.** This is a snapshot, not a spec — re-verify against source before relying on it in a future session; a memory of this file is not the same as the file being current. Every number below is cited to its file or confirmed via a live query.

---

## 1. What parameters can configure a strategy right now

Two independent config layers exist. They are easy to conflate — they aren't the same thing.

### 1a. `agent_settings.strategy_profile` — WHICH strategy runs

`'balanced' | 'aggressive'` (fails closed — `'conservative'` is not a valid value). Read fresh by `agent-cycle` every cycle. Routes through `strategy/registry.ts` to one of two complete, independently-defined strategies (`src/shared/strategy/profiles.ts`'s `STRATEGY_PROFILES`). Switching takes effect on the *next* cycle only — never retroactive, never touches an already-open position's protection.

Per-profile parameters (`StrategyDefinition` / `StrategyRiskPolicy`, `src/shared/strategy/profiles.ts`):

| Parameter | What it controls |
|---|---|
| `strategyVersion` | Persisted verbatim to `agent_decisions.strategy_version` |
| `decisionIntervalMinutes` | The profile's *intended* cadence (informational — the real cadence is whatever cron/manual clicks actually happen) |
| `newsLookbackMinutes` | How far back the news feed looks for relevant items |
| `maxDataStalenessMinutes` | How old market data can be before the cycle fails closed |
| `risk.riskBudgetPct` | Fraction of NAV risked per trade at the stop (`null` = fall through to `risk_appetite`'s mapping instead) |
| `risk.maxSingleTradePct` | Cap on one trade's notional as % of NAV |
| `risk.maxTotalNotionalPct` | Cap on total portfolio notional as % of NAV |
| `risk.stopOutReentryBlockMinutes` | Cool-off after a stop-loss exit before re-entering the same asset/direction |

Both profiles' sizing caps are further clamped by the **global ceilings** in `agent_settings` (`max_single_trade_pct`, `max_total_notional_pct`) — the effective cap actually used is always `min(profile value, ceiling)`.

### 1b. `agent_settings` — global config, applies to both profiles

| Column | Purpose |
|---|---|
| `assets` | Which assets trade (currently `BTC`, `ETH` only) |
| `is_paused` | Kill switch |
| `risk_appetite` | `conservative`/`balanced`/`aggressive` — a **separate, older dial** from `strategy_profile`. Only ever consulted when a profile's own `risk.riskBudgetPct` is `null` (currently only Balanced). Maps via `src/shared/risk/appetite-mapping.ts` to `{minConfidence: 0 for all tiers, riskBudgetPct: 0.25%/0.50%/0.75%}`. |
| `max_single_trade_pct`, `max_total_notional_pct` | Global ceilings (see above) |
| `max_asset_exposure_pct` | Cap on one asset's total exposure |
| `min_stop_loss_pct` / `max_stop_loss_pct` | Bounds any proposed stop must fall within |
| `min_take_profit_pct` / `max_take_profit_pct` | Bounds any proposed target must fall within |
| `portfolio_risk_ceiling_multiplier` | Multiplies risk budget into a portfolio-wide risk-at-stop ceiling |
| `drawdown_breaker_floor_pct` | Blocks new OPENs (never CLOSE) when NAV falls below this fraction of its own peak |
| `min_trade_notional_pct` / `min_trade_notional_usd` | Floor below which an ADD/REDUCE is normalized away as too small (a full CLOSE has no floor) |
| `stop_out_reentry_block_minutes` | Global fallback re-entry block (Balanced/Aggressive each override this via their own profile value above) |
| `fee_bps`, `slippage_bps` | Simulated trading costs, both sides |
| `news_veto_enabled` | Gates the entry-veto layer only |
| `management_enabled` | Gates the position-management layer only (independent of the flag above) |
| `max_data_staleness_minutes` | Global fallback staleness bound |
| `monitor_interval_minutes` | Position-monitor's own polling cadence |
| `decision_interval_minutes` | Now used **only** to bucket scheduled-trigger idempotency keys — see §4 |
| `news_lookback_overlap_minutes` | Added to the decision interval to build the actual news fetch window |
| `starting_capital` | Portfolio's initial NAV |

### 1c. Strategy-internal constants (not exposed as `agent_settings` columns — frozen in code)

Balanced (`strategy/rules.ts`): stop/target formula (§2 below). Regime lookback: 50-day SMA (`TREND_MA_LOOKBACK_DAYS`).
Aggressive (`strategy/aggressive/`): detector window parameters, tradeability floor `K`, protection formula, giveback ratchet rungs — all listed under "Currently configured" below. Changing any of these is explicitly meant to require declaring a new sub-version (V3.2+), not a live-tunable dial.

---

## 2. Technical analysis data points

### Balanced

Computed once per cycle, per asset, from CoinGecko data (`indicators/calculate.ts`):

| Indicator | Definition | Source series |
|---|---|---|
| `rsi14` | Wilder's RSI, 14-period | hourly close series |
| `ema20` / `ema50` | Exponential moving average | hourly close series |
| `macdHistogram` | Standard 12/26/9 MACD, histogram only (line − signal) | hourly close series |
| `atrPct` | Wilder's ATR(14), as % of latest close | 4-hourly OHLC candles |
| `volumeRatio` | latest volume ÷ mean volume over trailing 20 points | volume series |
| `distanceFromSevenDayHighPct` / `LowPct` | signed % distance of current price from the 7-day high/low | 4-hourly candles, filtered to a rolling 7-day window by timestamp |
| **50-day trend regime** | `evaluateTrendRegime`: `UP` iff daily close **strictly** > 50-day SMA of daily closes; `DOWN` otherwise | daily close series (needs ≥50 closed daily bars, or the cycle fails closed for that asset) |
| Recent-closes context | last ~24 hourly closes, sent as raw shape context | hourly close series |

### Aggressive (all additional, on top of the same Balanced indicators above — the 50-day regime stays available as context, never a gate, for this profile)

| Feature | Definition | Source |
|---|---|---|
| ATR30 | Wilder's ATR(14) computed on 30-minute true OHLC (not the 4-hourly candles Balanced uses) | 30-min OHLC (`managementAtrPctFor`) |
| `ret15mPct` / `ret30mPct` / `ret60mPct` | latest closed 5-min close ÷ close 3/6/12 points earlier − 1 | 5-min spot series |
| `realizedVol5m` | stdev of 5-min log returns, trailing 24 points (2h), raw (not annualized) | 5-min spot series |
| `volumeTrendRatio` | mean volume, last 6 points (30min) ÷ mean volume, last 24 points (2h) | 5-min spot series |
| `sampledDayHighPct` / `sampledDayLowPct` | signed % distance of current price from the max/min **close** of the ~289-point 5-min series | 5-min spot series — explicitly `sampled`, not a true 24h extreme (CoinGecko's free tier has no true intraday OHLC at this granularity) |

Data requirements: ≥12 closed 30-min bars, ≥25 closed 5-min points, or the cycle fails closed for that asset (never falls back to Balanced's 50-daily-bar rule).

---

## 3. How "sentiment analysis" for news actually works

**There is no numeric sentiment score, classifier, or ML model reading news text independently of Jev.** News handling is:

1. **Fetch** — 8 curated RSS feeds (`providers/rss-news.ts`): Cointelegraph, Decrypt, Bitcoin Magazine, CryptoSlate, The Block, Bitcoin.com News, CoinDesk, The Defiant. No paid API, no scraping.
2. **Relevance tag** — word-boundary, case-insensitive regex per asset (`/\b(bitcoin|btc)\b/i`, `/\b(ethereum|eth|ether)\b/i`) against headline+summary — purely lexical, not semantic.
3. **Filter** — dropped if outside the cycle's lookback window (`newsLookbackMinutes` + `newsLookbackOverlapMinutes`, currently 195+15=210 min for both profiles).
4. **Dedupe** — by normalized title (or link, if no guid), across all 8 feeds combined, sorted newest-first.
5. **Judgment — this is where "sentiment" actually happens, and it's Jev, not a classifier.** The raw headline/summary/source/age of every relevant item is handed to Jev inside its state payload. Jev is never asked "is this positive/negative" — it's asked a specific, narrow structured question:
   - **Entry veto** (`model/jev/question.ts`): *"Does the supplied news evidence contain a material, known, exogenous event specific to {asset} that should prevent opening a new long position right now?"* — a single **noul** (calibrated probability, 0-1), thresholded in code at `JEV_VETO_THRESHOLD = 0.70` to derive a boolean veto. Criteria explicitly exclude "price commentary, generic market commentary, analyst opinion, ordinary volatility, technical weakness, prediction or speculation" — only a specific named event counts.
   - **Aggressive entry quality** (`model/jev/entry-question.ts`): same news evidence, folded into a Choice question (ENTER/SKIP) alongside the detected opportunity — can only ever remove a candidate, never grant one.
   - News evidence is also visible to Jev during **position management** (HOLD/ADD/REDUCE/CLOSE/MODIFY_PROTECTION reasoning), same news, same relevance-tagged set for that asset.

News is treated as **untrusted data, never as instructions** — this is an explicit, load-bearing invariant (`CLAUDE.md`).

---

## 4. How the agent is configured — everything

### Model / provider
- Sole provider: TypeSafe's **Jev**, pinned to a concrete version — `JEV_MODEL_ID = 'jev-1.13.0'` (`model/jev/question.ts`). No fallback provider exists.
- Veto threshold: `JEV_VETO_THRESHOLD = 0.70`, explicitly provisional/unvalidated, persisted raw `noul` on every decision for later revisiting.
- Model boundary (unchanged since Trading Strategy V1 / Phase 2): the model never originates a trade, never sets an absolute size/stop/target/direction. It can only veto a deterministically-originated FLAT→OPEN_LONG candidate, or (for an OPEN position) choose HOLD/ADD/REDUCE/CLOSE/MODIFY_PROTECTION with bounded, code-defined magnitudes/intents — deterministic code (the risk gate) is the sole authority over what actually executes.
- Management magnitude/intent tables (code-defined, never a raw model number): `ADD_MAGNITUDE_BY_SCORE_LEVEL = [0.25, 0.50, 1.00]`, `REDUCE_MAGNITUDE_BY_SCORE_LEVEL = [0.25, 0.50, 0.75]`, `TP_STEP_ATR_MULTIPLE = 1.0`, stop intent `KEEP`/`TIGHTEN_TOWARD_ENTRY` (only offered when a legal tighten exists), target intent `KEEP`/`MOVE_CLOSER`/`MOVE_OUT`.
- Aggressive-only: `EXPECTED_MOVE_PCT_BY_SCORE_LEVEL = [0.001, 0.003, 0.008, 0.020]`, used for both the entry `expected_move` question and the management `remaining_upside` question.

### Execution model
- **Paper only.** 1x unleveraged synthetic positions. One net position per asset (FLAT/LONG/SHORT — no lots, no pyramiding, no short in Aggressive's own detectors — long-only entries). Simulated fee `fee_bps=10` (0.10%) and slippage `slippage_bps=5` (0.05%) per side, both configurable globally.
- Broker (`broker/accounting.ts`): shared by `agent-cycle` and `position-monitor`, one implementation — `openPosition`, `addToPosition` (true weighted-average entry), `reducePosition` (proportional cost-basis release, never touches entry price), `closePosition`.

### Cadence — two independent automatic loops, plus manual
- **`agent-cycle` (decisions)**: automatic via `pg_cron` job `agent-cycle-60min`, every hour on the hour (changed from 15 minutes on 2026-09-27 — `agent-cycle-15min` was unscheduled, not disabled), **plus** the extension's "Run agent" button (`{trigger:'manual'}`) — fully independent infrastructure, both always available. Scheduled vs. manual triggers get disjoint idempotency-key namespaces (`cycle/idempotency.ts`) so neither can starve the other.
- **`position-monitor` (SL/TP/collateral-exhaustion)**: automatic via `pg_cron` job `position-monitor-10min`, every 10 minutes, independent of the decision cycle — always wins any race against an ADD/REDUCE/MODIFY_PROTECTION/CLOSE the decision cycle proposes concurrently.
- **`market-refresh`**: currently **disabled** (paused, not dropped) — `agent-cycle` already upserts `market_quotes` on every run, so display freshness now tracks the 60-minute decision cadence instead of a separate 5-minute poller.

### Risk gate (`src/shared/risk/gate.ts`) — deterministic, applies identically to both profiles
State/action validity → SL/TP ordering + exhaustion-ceiling validation → stop-out re-entry block → risk-derived sizing against every cap → drawdown breaker (OPENs only) → stale-data / idempotency protection. Confidence gates nothing (self-reported LLM confidence measured too close to random in the literature reviewed — zeroed at the source).

### Aggressive-only mechanisms layered on top of the shared pipeline
- Deterministic opportunity detectors (never Jev-originated) — §"Currently configured" below.
- A monitor-enforced **giveback ratchet**: samples MFE/MAE every 10-minute monitor tick (regardless of active profile — pure telemetry under Balanced), arms at +1R, closes the position (`close_reason: 'profit_giveback'`) if accumulated profit retraces below a monotone floor — **exit only executes when Aggressive is the active profile**.

### Persistence
Every cycle persisted, including HOLD and skipped cycles. Every decision stores exact model input/output, prompt version, model version (`'jev-*'` = real call, `'call-failed'` = news/API failure, `'not-called'` = layer disabled or no candidate). `agent_decisions.strategy_version` records which strategy actually produced the row.

---

## Currently configured — Balanced

| Param | Value |
|---|---|
| `strategyVersion` | `v1-regime` |
| Decision cadence (intended) | 180 min (3h) — **actual live cadence is 60 min via cron** (changed from 15 min on 2026-09-27), see note below |
| News lookback | 195 min + 15 min overlap = 210 min |
| Max data staleness | 30 min |
| Risk budget | *(profile value is `null`)* → falls through to `risk_appetite` mapping — **live `risk_appetite = 'balanced'` → 0.50% of NAV per trade** |
| Max single-trade % | 0.20 (profile value; global ceiling is 0.35, so **effective cap = 0.20**) |
| Max total notional % | 0.30 (profile value; global ceiling is 0.70, so **effective cap = 0.30**) |
| Stop-out re-entry block | 360 min |
| Entry rule | 50-day SMA regime: OPEN_LONG when FLAT + daily close strictly > 50-day SMA |
| Stop-loss | `max(2.0 × ATR%, 2.5%)` |
| Take-profit | `6.0 ×` the stop distance |
| Model's role | Single veto question (noul, threshold 0.70) on entry; Phase-2 management (HOLD/ADD/REDUCE/CLOSE/MODIFY_PROTECTION) on open positions |
| Giveback ratchet | Not applicable — Balanced-originated positions are still *sampled* by the monitor if their ruler exists, but the ratchet never *exits* a position while Balanced is active |

## Currently configured — Aggressive

| Param | Value |
|---|---|
| `strategyVersion` (live, persisted) | `v3-jev-intraday-30m` — **reconciled 2026-10-01**: `CLAUDE.md`, `architecture.md`, and the spec file previously said `v3.1-jev-intraday-30m`, describing an intended version bump that was never actually made in code. Docs were corrected to match `src/shared/strategy/profiles.ts:111` and all 834+ live decision rows, not the reverse. |
| Decision cadence (profile declares) | 15 min — **unwired, confirmed live 2026-10-01 while scoping Strategy V4**: `strategy.decisionIntervalMinutes` is never read; the ACTUAL cadence is the flat `agent_settings.decision_interval_minutes` column, currently 60 (set 2026-09-27). This is the same dead-wiring class as the bug fixed 2026-09-24, just a second field on the same struct. |
| News lookback (profile declares) | 195 min — **also unwired, found in the same pass**: the actual lookback is `settings.decision_interval_minutes + settings.news_lookback_overlap_minutes` = 60 + 15 = **75 min live**, well short of the documented/intended 195. This has been quietly narrowing news context since the 2026-09-27 cadence change. |
| Max data staleness (profile declares) | 10 min — **also unwired**: `agent_settings.max_data_staleness_minutes` is read flat regardless of profile; live value is **30 min** (Balanced's), 3× looser than Aggressive's declared tolerance. |
| Risk budget (profile declares) | 0.75% of NAV per trade (pre-registered directly, not derived from `risk_appetite`) — **also unwired**: every live Aggressive decision row's `effective_risk_budget_pct` reads **0.0050**, i.e. `risk_appetite='balanced'`'s mapped value, not 0.0075. Aggressive has been sizing trades under Balanced's risk budget since it went live. |
| Max single-trade % (profile declares) | 0.30 — **also unwired**: live `effective_single_trade_cap_pct` is **0.3500** (the raw global ceiling), not clamped to the profile's 0.30 at all. |
| Max total notional % (profile declares) | 0.60 — **also unwired**: live `effective_max_total_notional_pct` is **0.7000** (the raw global ceiling), same gap. |
| Stop-out re-entry block (profile declares) | 60 min — **also unwired**: live value is **360 min** (Balanced's), 6× longer than intended. |
|  | **All six rows above are instances of one root cause**: `STRATEGY_PROFILES[profile].risk`/`decisionIntervalMinutes`/`newsLookbackMinutes`/`maxDataStalenessMinutes` are declared but no production code path reads them — `agent-cycle/index.ts` reads the flat, profile-agnostic `agent_settings` columns and `riskAppetiteThresholds(settings.riskAppetite)` instead, for every profile. **Aggressive has been running entirely on Balanced's risk/data policy since 2026-09-23.** This is Phase 0, item 0.1 of the Strategy V4 plan — fix in progress as of 2026-10-01, not yet deployed as this row is being written. Re-check this table against live `effective_*` decision-row values after that fix lands; this entire block should then read the intended values above verbatim.
| Data sufficiency | ≥12 closed 30-min OHLC bars, ≥25 closed 5-min spot points (50-day daily rule never gates this profile) |
| Entry detectors | `MOMENTUM_BREAKOUT` (close exceeds prior 8-bar high, edge-triggered) and `PULLBACK_CONTINUATION` (frozen wick-based formula) — `MIN_BARS=12`, `LOOKBACK_BARS=8`, `RECENCY_BARS=4`, `PULLBACK_MIDPOINT=0.5` |
| Tradeability floor | `atrTargetDistancePct ≥ K × estimatedRoundTripCostPct`, `K = 3` |
| Stop-loss (at origination) | `max(2.0 × ATR30%, 0.8%)` |
| Take-profit (at origination) | `4.0 × ATR30%` — no floor; NOT a constant 2R (only true while the ATR term dominates the 0.8% stop floor) |
| Entry judgment | `entry_quality` (ENTER/SKIP choice) + `expected_move` (score, mapped through `[0.001, 0.003, 0.008, 0.020]`) — either can only remove a detected candidate, never grant one |
| Management reframe | Action question quotes `positionPnlR`/`sampledMfeR`/`givebackRatio`/`priceR`/`costR` explicitly — "is continuing to hold better than realizing part/all of it now," not "are you bullish" |
| `MODIFY_PROTECTION` availability | Omitted from the offered action set whenever no legal tighten exists (applies to both profiles, but matters most here since Aggressive positions swing through this state often) |
| `remaining_upside` question | Aggressive-only sixth question, same `[0.001,0.003,0.008,0.020]` table as entry's `expected_move` |
| **Giveback ratchet** (monitor-enforced, exits only while Aggressive is active) | Arms at `sampledMfeR ≥ 1.0`. Floor: `costR` at 1.0R MFE, `0.5R` at 1.5R MFE, `1.0R` at 2.0R MFE, `1.5R` at 3.0R MFE. Exits (`close_reason='profit_giveback'`) when `positionPnlR` retraces to/below the armed floor. Monotone — never un-arms, never decreases. |
| Legacy-position eligibility | Positions opened before 2026-09-23 (the current 2 live BTC/ETH longs) have their ruler backfilled but `high_water_tracked_from = NULL` — **permanently excluded** from the giveback mechanism |

### One more live discrepancy worth knowing, not yet fully resolved
`decision_interval_minutes` is now `15` live (fixed 2026-09-24, matching the actual cron cadence) — but this column is **global**, not per-profile. `src/shared/strategy/profiles.ts` already declares the semantically-correct per-profile value (`aggressive: 15`, `balanced: 180`), but nothing reads it yet — `agent-cycle`'s idempotency bucketing and news-lookback window both still read the flat `agent_settings.decision_interval_minutes` regardless of active profile. Right now this is correct by coincidence (Aggressive is active and 15 is its correct value); if the profile is ever switched back to Balanced, this column will silently stay at 15 unless changed by hand. Parked as the next enhancement, per explicit prior instruction — not fixed in this pass.
