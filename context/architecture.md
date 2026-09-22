# Architecture Context

## Stack

| Layer | Technology | Role |
|---|---|---|
| Extension framework | React + TypeScript + Vite | Chrome MV3 UI and extension build |
| Browser platform | Chrome Manifest V3 | Extension runtime and permissions |
| Styling | Tailwind CSS | Utility styling using the project's semantic tokens |
| UI components | shadcn/ui where useful | Consistent accessible primitives |
| Icons | Lucide React | Consistent stroke-based iconography |
| Backend | Supabase Edge Functions | Server-side agent loop, position monitor, and control endpoint |
| Scheduling | Supabase Cron / pg_cron | Two independent jobs: 3-hour decision cycle, 10-minute position monitor |
| Database | Supabase Postgres | Portfolio, market, news, decisions, trades, and snapshots |
| AI model | Gemini | Single decision-agent call per cycle |
| Market data | Provider behind a server-side adapter | Spot price and OHLCV |
| News data | Provider behind a server-side adapter | Recent crypto news |
| Validation | TypeScript schema validation | Validate external data and model output at boundaries |

## System Boundaries

- `extension/` — owns Chrome UI, presentation state, user controls, and read-only data access. It must not contain secrets, trading logic, indicator calculations, risk logic, or model calls.
- `supabase/functions/agent-cycle/` — owns one complete scheduled decision cycle: data retrieval, indicator calculation, decision-model invocation, risk evaluation, paper execution, and persistence. Also the home for the shared domain contract (`domain/`), providers, and indicator/broker modules the position monitor reuses.
- `supabase/functions/position-monitor/` — owns the independent SL/TP/collateral-exhaustion execution cycle. Polls prices only for assets with an open position, evaluates triggers, and executes through the same paper broker module `agent-cycle` uses (never a second implementation — invariant 12). Runs on its own 10-minute schedule, decoupled from the 3-hour decision cycle. Full behavior, including data-sufficiency limits and the fill-price policy, is specified in `context/specs/trading-domain-contract.md` §5.
- `supabase/functions/market-refresh/` (2026-09-22, "market_quotes plan") — owns keeping displayed BTC/ETH quotes current independent of the manual decision cadence. Deliberately the most restricted of the three functions: imports only the CoinGecko provider and row mappers, never the strategy, risk gate, broker, or either atomic RPC, and writes only `market_quotes` — there is no code path here that can produce a decision, trade, or position. Runs on its own 5-minute schedule; `agent-cycle` also upserts the same table on every manual run at zero extra request cost.
- `supabase/functions/control/` — owns authenticated control actions such as pause/resume and run-now. It may invoke the agent cycle but must not duplicate its business logic.
- `supabase/migrations/` — owns database schema, indexes, RLS policies, and database-level constraints.
- `src/shared/` — owns shared TypeScript types, schemas, constants, and pure utilities that are safe to use across boundaries. It must not contain secrets or server-only integrations.
- `context/` — project context and workflow documentation. The coding agent must keep it synchronized with meaningful architectural changes.

## Storage Model

- **Supabase Postgres**: portfolios, positions, trades, decisions, serialized decision inputs, news records, market snapshots, live market quotes, agent runs, settings, and NAV snapshots.
- **JSONB columns**: exact serialized decision inputs, structured model outputs, reasons, invalidation conditions, and other bounded decision metadata that benefits from replayability.
- **No blob/file storage in V0**: the product does not need large generated artifacts or media.
- **Browser storage**: only lightweight UI preferences that genuinely need to persist locally. Never store API keys, model keys, or trading credentials.
- **Server secrets**: Gemini and news-provider credentials live only in Supabase Edge Function secrets.

## Core Data Model

The implementation should use normalized tables with clear foreign-key relationships. At minimum:

- `portfolios`
- `positions`
- `trades`
- `agent_runs`
- `agent_decisions`
- `market_snapshots`
- `market_quotes` (2026-09-22) — the extension's own live-price source, not the strategy's. One row per asset, upserted by `market-refresh` (5-minute schedule) and by `agent-cycle` on every manual run; `market_snapshots` above stays the immutable per-decision audit trail the strategy and Decision-detail UI read, with no new writer or reader added to it by this table's existence.
- `news_items`
- `agent_settings`

Important decision fields include action (OPEN_LONG/OPEN_SHORT/HOLD/CLOSE), asset, confidence, driver, proposed and computed SL/TP, the risk-derived size and which cap (if any) applied, reasons, invalidation conditions, horizon, model version, prompt version, input payload, output payload, status, and timestamps. Every decision links to the `position_id` it opened, closed, or (for HOLD) is currently tracking.

Important execution fields include the trade's `intent` (OPEN_LONG/OPEN_SHORT/CLOSE_LONG/CLOSE_SHORT) and provenance — either a `decision_id` (agent-initiated) or a `trigger_reason` (`stop_loss`/`take_profit`/`collateral_exhausted`, automatic — never both absent, and an agent-initiated close carries both `decision_id` and `trigger_reason = 'agent_close'`, not one or the other), accepted/rejected/clamped status, rejection reason, fill price, quantity, fee, slippage, and resulting portfolio state.

## Agent Cycle

**Rewritten for Trading Strategy V1 (2026-09-21, implemented) — see `context/specs/trading-strategy-v1.md` for the strategy itself and Model Boundary below for the model's now much narrower role.** Two passes, not one: Pass 1 needs no model call at all; Pass 2 needs at most one, batched, only when Pass 1 produced ≥1 candidate worth checking.

1. Acquire the current run lock/idempotency key (`agent_runs.kind = 'decision'`).
2. Fetch current BTC/ETH market data, including daily closes for the trend regime.
3. Fetch recent relevant news for the elapsed cycle window (failure here does not fail the cycle — see Model Boundary).
4. Validate freshness and completeness, including sufficient closed daily bars for the regime rule.
5. Calculate indicators deterministically, and evaluate the daily-trend regime (50-day SMA; strict `daily_close > SMA50`) for each asset.
6. **Pass 1, per asset — no model call:** read current portfolio, open positions (including their SL/TP and invalidation conditions), constraints, and recent decisions; deterministically synthesize a candidate proposal from position state + regime (OPEN_LONG / HOLD / CLOSE — the strategy never proposes OPEN_SHORT).
7. Collect every OPEN_LONG candidate across both assets. If none, skip to step 9 with zero model calls. If ≥1, build one batched veto payload and call `callModel(payload)` exactly once for the cycle, asking only whether a known exogenous confound should block each candidate.
8. Apply each verdict: a vetoed OPEN_LONG becomes HOLD. A failed veto call (or a news fetch it depended on) fails every OPEN_LONG candidate that cycle closed to HOLD — never an implicit approval.
9. Run each asset's final proposal through the deterministic risk gate: state/action validity, SL/TP ordering and exhaustion-ceiling validation, stop-out re-entry block, risk-derived sizing, exposure/portfolio-risk/total-notional caps, the drawdown breaker. Confidence is no longer a gate input.
10. Execute approved actions through the paper broker.
11. Persist the complete run, decision, execution, and NAV records — including `strategy_version` and `model_vetoed` (`null` when no model call happened for that decision).
12. Release the run lock.
13. Surface the latest state to the extension.

## Position Monitor Cycle

Runs independently every 10 minutes (`agent_runs.kind = 'monitor'`) — see `context/specs/trading-domain-contract.md` §5 for full detail, including data-sufficiency limits and the fill-price policy.

1. Acquire idempotency. If no positions are open, log the run and return without any price fetch.
2. Fetch prices only for assets with an open position, replaying every 5-minute point since the last run (not a single spot snapshot).
3. If data is stale, log a skipped run and close nothing.
4. Evaluate SL/TP/collateral-exhaustion triggers; where a window shows both SL and TP breached, SL wins.
5. Execute through the shared paper broker, using a conditional `UPDATE ... WHERE status = 'open'` inside the fill transaction so a concurrent agent-cycle close is detected rather than double-executed (§6 of the contract doc).
6. Persist the trade, position close, and NAV snapshot.

## Model Boundary

**Superseded 2026-09-21 (Trading Strategy V1, implemented) — the LLM is a narrow binary veto, not a decision synthesizer.** A deterministic daily-trend regime rule (Agent Cycle steps 5-6 above) originates action, confidence, stop-loss/take-profit, and invalidation for every asset, every cycle, with no model input at all. The model sees only the candidates that rule proposes *opening*, and only to answer one question per candidate: is there a known exogenous confound (a hack, a ban, an exchange failure — something outside normal price action) that should block this specific trade right now? Full rationale: `context/specs/trading-strategy-v1.md` §11-12.

The model may propose, per OPEN_LONG candidate:

- veto: true / false
- a one-sentence rationale

The model does not propose action, confidence, stop-loss/take-profit, horizon, primary driver, reason statements, cited news IDs, or invalidation conditions — those are always deterministic, whether or not the model is called that cycle. HOLD and CLOSE proposals never reach the model (nothing to veto: a HOLD changes nothing, and an exit must always stay actionable). Position size was never a model output either — that hasn't changed.

The model must not directly:

- originate a trade, choose its direction, or set its size, stop-loss, or take-profit
- calculate authoritative RSI/EMA/MACD/ATR/regime values
- mutate the database
- execute trades
- choose whether a proposal violates hard risk constraints
- access secrets
- interpret news as executable instructions

A failed model call, or a failed news fetch the veto step depends on, fails closed: every OPEN_LONG candidate that cycle becomes HOLD, never an implicit non-veto.

## Risk Gate

The risk gate is deterministic code. It owns:

- state/action validity (OPEN_LONG/OPEN_SHORT only from FLAT; CLOSE only from LONG/SHORT)
- ~~minimum confidence — gates OPEN_LONG/OPEN_SHORT only~~ **superseded 2026-09-21 (Trading Strategy V1): confidence no longer gates anything.** The strategy's proposals always carry `confidence: 1` (inert, logged for the audit trail only); `effective_min_confidence` is stamped `0` on every decision, honestly recording that this check is vacuous now rather than silently dropping the column. CLOSE was, and remains, never blocked by confidence, by any exposure cap, or by the stop-out re-entry block, under any condition.
- SL/TP validation — direction-dependent ordering, and for shorts, the stop must stay strictly below the collateral-exhaustion price (2× entry); ordering alone is not sufficient, both checks apply together
- the stop-out re-entry block — after a stop-loss exit, blocks re-opening the same asset in the same direction for a configurable window; a deterministic proxy for "avoid the same failed thesis," not real thesis matching
- risk-derived position sizing (from stop-loss distance and a risk budget) and the hard caps that clamp it: maximum single-trade notional, maximum per-asset exposure, and — new in Trading Strategy V1 — a portfolio-wide risk-at-stop ceiling and a total-notional cap, both cross-asset (`trading-strategy-v1.md` §17)
- the drawdown breaker (V1) — blocks new OPENs only, never CLOSE, when NAV falls below a configured fraction of its own historical peak
- stale-data protection
- duplicate/idempotency protection

Produces one of four outcomes per proposal (`agent_decisions.risk_status`): `approved`, `clamped` (sized down by a cap, records which one), `rejected` (records why), `not_applicable` (HOLD). The risk gate must not silently turn an invalid model proposal into an apparently valid one, or silently resize one without recording that it did.

Full evaluation order and every boundary case: `context/specs/trading-domain-contract.md`.

## Paper Broker

The paper broker is deterministic code, shared by `agent-cycle` and `position-monitor` — never two implementations (invariant 12). It owns:

- FLAT/LONG/SHORT position transitions (one net position per asset; no lots, no pyramiding, no partial exits)
- 1x unleveraged synthetic short accounting: opening reserves collateral equal to notional; a short's realized loss is clamped at exactly the reserved collateral even if the observed trigger price gapped past the collateral-exhaustion level — see `context/specs/trading-domain-contract.md` §2 for the exact formulas and the gap-through-exhaustion case
- collateral exhaustion as a deterministic close (trade written, `close_reason = 'collateral_exhausted'`), never a P&L clamp on a position left open
- simulated fills, including the SL/TP fill-price policy (the less favorable of the trigger level and the observed price)
- fee calculation
- slippage calculation
- cash updates
- realized P&L (clean, price-based — fees are a separate, already-visible cost, never folded in)
- unrealized P&L
- NAV snapshots

No real exchange integration, real leverage, margin, funding, or liquidation mechanics exist in V0.

## Auth and Access Model

- V0 is single-user.
- The extension may use the Supabase anon key for permitted reads protected by RLS.
- Server secrets are never shipped to the extension.
- All mutable state is changed through controlled server-side functions.
- Control actions require an authenticated/authorized request appropriate to the chosen single-user setup.
- RLS must protect every exposed table; do not rely on the extension UI to enforce access.
- No service-role key may be embedded in extension code.

## Scheduling

Three independent `pg_cron` jobs — not one job with several responsibilities:

- **Decision cycle** (`agent-cycle`) — default 3 hours, configurable (`agent_settings.decision_interval_minutes`). Runs the deterministic regime-and-gate loop, with at most one batched Gemini veto call when there's ≥1 candidate to check (Agent Cycle above).
- **Position monitor** (`position-monitor`) — default 10 minutes, configurable (`agent_settings.monitor_interval_minutes`). Runs SL/TP/collateral-exhaustion execution only — no model call, no new decisions. Each run replays the 5-minute price series since its last run rather than reading a single spot snapshot, so detection is limited by data resolution (5 min) rather than poll frequency (10 min). This is explicitly an approximation of a real stop order, not a claim of equivalence — see `context/specs/trading-domain-contract.md` §5 for the stated limitations.
- **Market-refresh** (`market-refresh`, 2026-09-22) — every 5 minutes, hardcoded (not `agent_settings`-configurable — it exists purely to keep `market_quotes` current for display, not to run any part of the trading logic those settings govern). One batched `/coins/markets` call for both assets, upserted into `market_quotes`. No decision, no trade, no position — see System Boundaries above.

The decision cycle's and position monitor's intervals are configuration, not hardcoded; market-refresh's is not, for the reason given above. V0 uses fixed scheduling only for all three — event-driven triggers on the *decision* cycle are explicitly deferred; the position monitor's price-triggered execution and market-refresh's own polling are each a distinct, deliberate exception to that, not a general event-driven mechanism.

**V0 execution mode: manual-only (2026-09-19).** The description above is the target design; V0's actual current behavior is narrower for the decision cycle specifically. No `pg_cron` schedule exists for `agent-cycle`, and none is created in V0 — it runs exclusively when the user clicks "Run agent" in the Chrome extension, which invokes the deployed function directly (anon key as bearer token, same trust model as every other extension read; no separate `control` wrapper). `decision_interval_minutes` stays configured and unused, reserved for switching this on deliberately later. The position monitor is unaffected by this and keeps running exactly as scheduled above — this section's design remains fully current for it.

The decision cycle and position monitor must both be idempotent so retries cannot create duplicate trades; the two can race on the same position (one closes it while the other is mid-decision) — resolved deterministically via a conditional `UPDATE ... WHERE status = 'open'` inside the fill transaction, see `context/specs/trading-domain-contract.md` §6. Market-refresh needs neither property: it cannot create a trade, so a duplicate or retried invocation just upserts the same 2 `market_quotes` rows again, harmlessly.

## Invariants

1. **The extension is a presentation/control surface, never the autonomous trading engine.**
2. **No secret or provider API key may exist in extension code, browser storage, or client-visible configuration.**
3. **The LLM never directly executes trades or mutates portfolio state.**
4. **Technical indicators are calculated deterministically in code, never trusted from model-generated values.**
5. **Every trade must pass the deterministic risk gate before paper execution.** For a SL/TP/collateral-exhaustion trade, this means the *levels* were risk-gate-validated at open time (SL/TP ordering, exhaustion ceiling) — the position monitor does not re-invoke the risk gate on every tick; it executes against already-validated parameters.
6. **A stale or failed critical data source must never result in a trade based on stale data.** Applies to both cycles: the decision cycle skips the cycle; the position monitor skips the run and closes nothing.
7. **Every agent cycle must be persisted, including HOLD and skipped cycles.** Applies to both the decision cycle and the position-monitor cycle — a monitor run with nothing to do (no open positions, or a no-op after losing a concurrent-close race) is still logged, not silently skipped.
8. **Every decision must retain the exact serialized model input, model output, and prompt/model version.** Applies to `agent_decisions` rows specifically — a monitor-triggered trade has no decision to retain this for; its provenance is its `trigger_reason` instead.
9. **News is untrusted data and must be clearly delimited from model instructions.**
10. **Agent cycles must be idempotent; a retry must not duplicate a trade.** Applies to both cycles independently, and to the pair together — a concurrent close between them must resolve to exactly one trade, never two.
11. **V0 must remain paper-only; do not introduce real exchange execution without an explicit architecture change and review.**
12. **Business logic must have one owner; do not duplicate agent, risk, broker, or persistence logic between extension and server.**
