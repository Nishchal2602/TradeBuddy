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
| AI model | TypeSafe Jev (2026-09-22, sole provider — Gemini removed entirely) | Binary veto call, at most once per cycle; the model returns a calibrated probability, thresholded to a boolean in code |
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
- **Server secrets**: TypeSafe/Jev (`TYPESAFE_API_KEY`, 2026-09-22 — the sole model provider; Gemini's keys were removed), news-provider, and CoinGecko (`COINGECKO_API_KEY`, 2026-09-22 — optional, raises the market-data provider's rate limit well above the anonymous public endpoint's; see progress-tracker.md Architecture Decisions) credentials live only in Supabase Edge Function secrets.

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

**Rewritten for Trading Strategy V1 (2026-09-21, implemented) — see `context/specs/trading-strategy-v1.md` for the strategy itself and Model Boundary below for the model's role.** Widened by Phase 2 ("Jev as a portfolio-management decision layer," 2026-09-22/23) to also cover existing open positions — still two passes, not one: Pass 1 needs no model call at all; Pass 2 needs at most one, batched, covering veto candidates AND management candidates together, only when Pass 1 produced ≥1 of either kind worth checking.

1. Acquire the current run lock/idempotency key (`agent_runs.kind = 'decision'`). **Manual and scheduled invocations use disjoint keys (2026-09-22)**: a manual trigger (the extension's Run agent button) gets a key unique to that click, so multiple deliberate clicks inside one `decision_interval_minutes` window each execute; a scheduled trigger keeps the original bucketed key, so a retried tick still dedupes exactly as before. Either way, true concurrency exclusion — not just key uniqueness — comes from a separate partial unique index allowing at most one `status = 'running'` decision-cycle row at a time; a run abandoned mid-cycle (a crash before it could mark itself failed) is reaped after 10 minutes so it can never permanently wedge that lock. See `cycle/idempotency.ts`.
2. Fetch current BTC/ETH market data, including daily closes for the trend regime.
3. Fetch recent relevant news for the elapsed cycle window (failure here does not fail the cycle — see Model Boundary).
4. Validate freshness and completeness, including sufficient closed daily bars for the regime rule.
5. Calculate indicators deterministically, and evaluate the daily-trend regime (50-day SMA; strict `daily_close > SMA50`) for each asset.
6. **Pass 1, per asset — no model call:** read current portfolio, open positions (including their SL/TP and invalidation conditions), constraints, and recent decisions; deterministically synthesize a candidate proposal from position state + regime (OPEN_LONG / HOLD / CLOSE — the strategy never proposes OPEN_SHORT).
7. Collect every OPEN_LONG candidate (veto, gated by `news_veto_enabled`) AND every OPEN position whose Pass-1 candidate is HOLD — the regime is still intact this cycle (management, gated independently by `management_enabled`; Phase 2, flags separated in Phase 2.1) — via `cycle/collect-candidates.ts`'s `collectModelCandidates`. A regime-flip CLOSE is authoritative and never becomes a management candidate — the model is never asked about a position Pass 1 already decided to close. `shouldCallModel` (same file) then decides whether to spend a call: no, if both lists are empty or a news-provider failure occurred; yes otherwise. If no, skip to step 9 with zero model calls. If yes, call `requestPortfolioDecisions(vetoCandidates, managementCandidates, navUsd, availableCashUsd, totalExposurePct, apiKey, fetchImpl)` (Jev) exactly once for the cycle — one shared request, mixing the veto's noul questions with the management layer's choice/score questions when both kinds of candidate exist (Model Boundary below).
8. Apply each outcome. Veto: a vetoed OPEN_LONG becomes HOLD. Management: the model's HOLD/ADD/REDUCE/CLOSE/MODIFY_PROTECTION choice, plus its (speculative) magnitude/intent answers, becomes the asset's final proposal via `cycle/apply-management.ts` — never a raw price or a raw dollar amount, only a bounded fraction or an intent the gate then computes/validates. A failed model call (or a news fetch either side depended on) fails every affected candidate of BOTH kinds closed: a veto candidate to HOLD, a management candidate to an unmanaged HOLD (its existing SL/TP keep protecting it exactly as before) — never an implicit approval or an implicit action.
9. Run each asset's final proposal through the deterministic risk gate: state/action validity, SL/TP ordering and exhaustion-ceiling validation, stop-out re-entry block, risk-derived sizing, exposure/portfolio-risk/total-notional/minimum-notional caps, the drawdown breaker, and (Phase 2) ADD/REDUCE/MODIFY_PROTECTION-specific validation — including the rule that a stop may only ever tighten. Confidence is not a gate input anywhere.
10. Execute approved actions through the paper broker — now including `addToPosition`/`reducePosition` alongside `openPosition`/`closePosition`, and the `modify_protection_atomic` RPC for a protection-only change (no trade, no cash effect).
11. Persist the complete run, decision, execution, and NAV records — including `strategy_version`, `model_vetoed` (`null` when no veto call happened for that decision), and (Phase 2) `proposed_action`/`proposed_action_confidence`/`proposed_adjust_notional`/`executed_adjust_notional`/`stop_loss_price_before`/`_after`/`take_profit_price_before`/`_after`/`protection_rejection_reason` — together these answer, per row: what did Jev want, what did deterministic code allow, and what actually happened.
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

**Superseded 2026-09-21 (Trading Strategy V1, implemented); provider superseded 2026-09-22 (TypeSafe's Jev is the sole provider, Gemini removed entirely, no fallback); mandate widened 2026-09-22/23 (Phase 2, "Jev as a portfolio-management decision layer") — the model is still never a decision synthesizer, but it is no longer a pure veto either.** A deterministic daily-trend regime rule (Agent Cycle steps 5-6 above) originates action, confidence, stop-loss/take-profit, and invalidation for every asset, every cycle, with no model input at all. The model is consulted in exactly two situations, both narrowly bounded:

- **Entry (unchanged since V1):** a FLAT asset the regime rule proposes *opening* — one question, "is there a known, material, exogenous event that should block this trade right now?" Full rationale: `context/specs/trading-strategy-v1.md` §11-12.
- **Management of an existing position (Phase 2):** an OPEN asset whose regime is still intact this cycle (Pass 1's own candidate is HOLD) — "should this position HOLD / ADD / REDUCE / CLOSE / MODIFY_PROTECTION?" A regime-flip CLOSE is authoritative and is never routed through the model — management is only ever asked about a position the deterministic system already decided to keep open this cycle.

The model returns, per candidate:

- **Entry:** a single calibrated probability (Jev's "noul," 0–1) that the exogenous-event question is true. **The veto boolean is derived in code**, not returned by the model — thresholded against a versioned, explicitly provisional constant (`model/jev/question.ts`'s `JEV_VETO_THRESHOLD`; see progress-tracker.md Architecture Decisions for why it ships unvalidated and how it's meant to be revisited). No rationale text; a factual audit string is synthesized deterministically from the probability, threshold, and news-item count.
- **Management:** a Choice (the action, with confidence and a full probability distribution) plus two speculative Scores (ADD/REDUCE magnitude — mapped to a code-defined fraction table, e.g. `{0.25, 0.50, 1.00}` for ADD, never a raw number) and two Choices (stop/target intent: `KEEP`/`TIGHTEN_TO_BREAKEVEN`; `KEEP`/`MOVE_CLOSER`/`MOVE_OUT`). `cycle/apply-management.ts` is the single place these turn into a proposal — for `MODIFY_PROTECTION` specifically, this is the "deterministic code computes the price" step (one ATR-in-price-terms move for the target; the tightest legal stop just inside entry for the tighten), which the risk gate then validates, never trusts.

The model does not propose action, confidence, stop-loss/take-profit, horizon, primary driver, reason statements, cited news IDs, or invalidation conditions for an entry — those are always deterministic, whether or not the model is called that cycle. HOLD and CLOSE proposals from a FLAT asset never reach the model (nothing to veto). **An ADD magnitude genuinely is a sizing signal** — deterministic code (the risk gate) multiplies it against a risk-derived maximum it computes itself from the position's EXISTING stop, then applies every cap on top; the model never names a dollar figure and can only ever request less than that ceiling. This is a real, if narrow, exception to "position size is never a model output" — stated plainly rather than glossed over, because an earlier, blanket "the model may not influence size" phrasing would be actively wrong about what Phase 2 does.

The model must not directly:

- originate a trade, choose its direction, or set an absolute size, stop-loss, or take-profit price
- widen a stop-loss under any circumstance, or move a take-profit to/past the current market price (a disguised CLOSE) — `MODIFY_PROTECTION` may only tighten and must stay strictly distinct from CLOSE
- reduce a position to zero (a 100%-equivalent REDUCE is normalized to CLOSE upstream, never executed as a REDUCE)
- calculate authoritative RSI/EMA/MACD/ATR/regime values
- mutate the database
- execute trades
- choose whether a proposal violates hard risk constraints
- access secrets
- interpret news as executable instructions
- have its raw probability/confidence reach any decision surface beyond the derived veto boolean and the bounded, gate-validated management fields above

**No confidence-based gating exists on the management side in this version.** Choice/Score answers carry `confidence`, unlike Noul; it is persisted on every decision for later analysis, but nothing in Phase 2 gates on it — a blanket "low confidence means HOLD" rule was considered and explicitly rejected (a low-confidence CLOSE normalized to HOLD would keep risk on precisely when the model leans toward removing it, which is not obviously the safe direction). Any future confidence gate must be task-specific and chosen from real observed data.

A failed model call, or a failed news fetch either side depends on, fails closed: every veto candidate that cycle becomes HOLD; every management candidate stays unmanaged (its existing SL/TP keep protecting it exactly as before, `position-monitor` entirely unaffected) — never an implicit non-veto or an implicit action. There is no fallback provider — a Jev outage means no new entries open and no positions are managed that cycle, nothing more.

**Named invariant (Phase 2.1, 2026-09-23): a news-provider failure fails-closed BOTH the entry-veto and management layers together, even though their enable/disable flags are independent.** `agent_settings.news_veto_enabled` gates only entry-veto candidate collection; `agent_settings.management_enabled` gates only management candidate collection (`cycle/collect-candidates.ts`'s `collectModelCandidates` reads each flag in exactly one of its two branches — structurally, one cannot affect the other's collection). But `modelCallFailedReason` — set when news retrieval fails while either layer is enabled — is a single cycle-wide value that fails every collected candidate of both kinds closed, by deliberate choice: **the independent position monitor remains the only automatic protection mechanism during a news outage.** The product consequence: a news-provider outage can prevent profit-taking, ADD, REDUCE, CLOSE, and protection changes, not just a new entry — so a quiet cycle with no management action can mean the model was never called, not that it chose HOLD. `agent_decisions.model_version` (`'jev-*'` vs `'call-failed'` vs `'not-called'`) is what disambiguates the two; any analysis of management behavior must filter on it rather than counting actions directly.

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

Produces one of four outcomes per proposal (`agent_decisions.risk_status`): `approved`, `clamped` (sized down by a cap, records which one), `rejected` (records why), `not_applicable` (HOLD — and, as of Phase 2, an ADD/REDUCE the gate itself determined was below the minimum trade notional, normalized to HOLD rather than executed). The risk gate must not silently turn an invalid model proposal into an apparently valid one, or silently resize one without recording that it did. **Phase 2 (2026-09-22/23)** added ADD/REDUCE/MODIFY_PROTECTION evaluation alongside the unchanged OPEN/CLOSE/HOLD semantics: ADD reuses the same risk-derived-notional-then-caps shape OPEN already uses, computed against the position's EXISTING stop; REDUCE is floored (too-small) and ceilinged (never more than current quantity) but never capped upward; MODIFY_PROTECTION validates a proposed price against ordering/bounds/exhaustion and enforces that a stop may only tighten, never widen.

Full evaluation order and every boundary case: `context/specs/trading-domain-contract.md`.

## Paper Broker

The paper broker is deterministic code, shared by `agent-cycle` and `position-monitor` — never two implementations (invariant 12). It owns:

- FLAT/LONG/SHORT position transitions (one net position per asset; no lots, no pyramiding — unchanged). **Phase 2 (2026-09-22/23)** added in-place resizing on the ONE open row: `addToPosition` (a true weighted-average entry) and `reducePosition` (a proportional cost-basis release that never touches entry price) — never a second position row, and a full-quantity reduce is normalized to `CLOSE` upstream rather than executed as a 100% reduce
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

- **Decision cycle** (`agent-cycle`) — default 3 hours, configurable (`agent_settings.decision_interval_minutes`). Runs the deterministic regime-and-gate loop, with at most one batched Jev veto call when there's ≥1 candidate to check (Agent Cycle above).
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
