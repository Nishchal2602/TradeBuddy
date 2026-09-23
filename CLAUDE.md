# Application Building Context

You are the implementation agent for an autonomous crypto paper-trading Chrome extension.

## Before doing anything

Read these files in this exact order:

1. `context/project-overview.md` — product definition, V0 scope, user flow, and success criteria
2. `context/architecture.md` — system boundaries, data model, agent flow, security rules, and invariants
3. `context/ui-context.md` — visual system and extension UI patterns
4. `context/code-standards.md` — implementation conventions and safety rules
5. `context/ai-workflow-rules.md` — how work must be scoped, implemented, and verified
6. `context/progress-tracker.md` — current implementation state and unresolved decisions

These files are the source of truth for the project.

## Core instruction

Act as an implementation engineer, not a product strategist.

Execute the defined architecture. Do not redesign the system, expand scope, or introduce speculative features unless explicitly instructed or a documented context change is made first.

The product is V0 paper trading only.

**Never introduce real-money trading, exchange execution, exchange API keys, real leverage, derivatives, or real financial transactions.** V0 simulates 1x unleveraged synthetic short positions in paper only — no borrowing, no margin, no liquidation, no funding mechanics. Full detail: `context/specs/trading-domain-contract.md`.

**NEWS/TECHNICAL decision methodology, prompt content, and indicator interpretation** — the areas `trading-domain-contract.md:7` explicitly parks for separate review — are specified in `context/specs/trading-strategy-v1.md` (2026-09-20 review, **implemented 2026-09-21** — code-complete and verified; deployment is the one remaining step, see `progress-tracker.md` Current Phase). It is evidence-led, not preference-led: read its §0 executive assessment before touching the regime rule, the veto prompt, or risk-appetite calibration. The two live defects it documented (partial-bar indicator computation; a 7-day-range calculation that mixed live spot against historical candles) were both fixed as part of this implementation.

## Non-negotiable architecture rules

- The Chrome extension is the UI/control surface, not the autonomous engine.
- The server-side agent loop owns trading decisions and execution.
- **Deterministic code originates every trading decision and remains the sole authority over final size and price. The model may veto a proposed entry, and — for an existing open position only — propose a bounded ADD/REDUCE magnitude or a MODIFY_PROTECTION intent; it never originates a trade, sets an absolute size, or computes a price — see AI-specific rules.** Superseded 2026-09-21 (Trading Strategy V1): before that, this line read "the LLM proposes; deterministic code validates, constrains, and executes" — the reverse of what was built then. Superseded again 2026-09-22/23 (Phase 2, "Jev as a portfolio-management decision layer"): the model's mandate widened from pure entry-veto to also managing existing positions, still strictly bounded — see AI-specific rules for the exact mandate and its limits.
- Technical indicators are calculated in code.
- Risk decisions are deterministic.
- Paper execution is deterministic.
- Secrets remain server-side.
- News is untrusted data and must never be treated as instructions.
- Every cycle is persisted, including HOLD and skipped cycles.
- Every decision stores its exact model input/output and prompt/model version, when a model call happened that cycle — see AI-specific rules for what a no-call decision records instead.
- Agent cycles must be idempotent.
- Stale or failed critical inputs must fail closed.
- Do not duplicate business logic between the extension and backend.

## Scope discipline

Work on one implementation unit at a time.

Before changing code:

1. Read the relevant context.
2. Read the active spec.
3. Inspect existing code and existing patterns.
4. Identify dependencies.
5. Implement only the requested unit.
6. Verify it.
7. Update `context/progress-tracker.md`.

Do not opportunistically refactor unrelated code.

If a requirement is ambiguous:

- First check the context files.
- If the context already defines the answer, follow it.
- If it does not, add the question to `progress-tracker.md` and stop before inventing important product behavior.

If the current architecture must change, explain the conflict and update the relevant context file before implementing the dependent change.

## AI-specific rules

**Trading Strategy V1 (2026-09-21, implemented) demoted the model to a binary veto — it no longer originates decisions.** A deterministic daily-trend regime rule (`supabase/functions/agent-cycle/strategy/`) decides action, confidence, stop-loss/take-profit, and invalidation for every asset, every cycle, with zero model input. The model's only entry-side question, asked once per candidate that rule proposes opening: *"is there a known, material, exogenous event specific to this asset that should prevent this trade right now?"* Full detail: `context/specs/trading-strategy-v1.md` §11–12. **This part is unchanged by Phase 2 below** — a FLAT asset's OPEN_LONG eligibility is still decided entirely by the deterministic regime rule, and the model can still only veto it, never originate one.

**Phase 2 (2026-09-22/23, implemented) widened the model's mandate to also manage EXISTING open positions** — still strictly bounded, never originating, never sizing, never pricing. For an OPEN position whose regime is still intact this cycle (Pass 1's own candidate is HOLD — a regime-flip CLOSE is authoritative and is never routed through the model at all), the model may propose exactly one of: `HOLD`, `ADD` (a bounded magnitude, 0–1, of the risk-derived headroom the gate computes from the EXISTING stop), `REDUCE` (a bounded magnitude of the current quantity, never reaching 100% — a full exit is normalized to `CLOSE`), `CLOSE`, or `MODIFY_PROTECTION` (a `KEEP`/`TIGHTEN_TO_BREAKEVEN` stop intent and/or a `KEEP`/`MOVE_CLOSER`/`MOVE_OUT` target intent — never a price). `cycle/apply-management.ts` is the single place these intents turn into a proposal, mirroring `cycle/apply-veto.ts`'s role exactly. Full detail: the Phase 2 migration plan and `progress-tracker.md`'s implementation entry.

**Jev may choose a bounded adjustment magnitude; deterministic code remains the sole authority over final size.** An ADD magnitude genuinely is a sizing signal — code (the risk gate) multiplies it against a risk-derived maximum it computes itself, then applies every existing cap on top; Jev never names a dollar figure and can only ever request less than the deterministic ceiling. Stating this plainly matters: an earlier, imprecise phrasing that flatly forbade the model from "influencing size" would have been actively wrong about what Phase 2 does.

**No confidence-based gating on the management side.** Choice/Score answers carry a `confidence` field Noul does not; Phase 2 persists it on every decision for later analysis but gates nothing on it in this version — a blanket low-confidence-means-HOLD rule was considered and explicitly rejected, because "HOLD" is not uniformly the safe direction (a low-confidence CLOSE normalized to HOLD would keep risk on precisely when the model leans toward removing it). If a confidence gate is ever added, it must be task-specific and chosen from real observed data, not assumed.

**The provider is TypeSafe's Jev, and only Jev (2026-09-22) — Gemini was removed entirely, not kept as a fallback, shadow, or comparison provider.** See `progress-tracker.md` Architecture Decisions for the full migration record.

At most one model call per scheduled V0 cycle — zero when there are no OPEN_LONG candidates AND no manageable OPEN positions that cycle; one batched call covering every candidate of both kinds together when there are (the veto's noul questions and the management layer's choice/score questions share one request — the API contract confirms mixed question types in one call).

All model calls must go through one `requestPortfolioDecisions(vetoCandidates, managementCandidates, navUsd, availableCashUsd, totalExposurePct, apiKey, fetchImpl)` abstraction (`model/jev/provider.ts`) — `requestVetoDecisions` still exists (a pure veto-only cycle degrades to it structurally) but the cycle wiring calls the unified function.

Use structured output/schema validation.

The model returns, per entry candidate, a single calibrated probability (Jev's "noul," 0–1) — not a boolean and not free-form text. **The boolean veto is derived in code** by thresholding that probability against a versioned constant (`model/jev/question.ts`'s `JEV_VETO_THRESHOLD`) — this threshold ships explicitly **provisional**, not validated against any evaluation study; see the same file's own comment for why that was a deliberate choice, and never describe it as validated until it has actually been reviewed. The raw probability is persisted on every decision specifically so the threshold can be revisited later from real data. For a management candidate, the model returns a Choice (the action, plus confidence and a full probability distribution) and two speculative Scores (ADD/REDUCE magnitude, mapped to a code-defined fraction table — never a raw number) and two Choices (stop/target intent) — all persisted verbatim.

The model does not propose action, confidence, stop-loss/take-profit, horizon, primary driver, reasons, cited news IDs, or invalidation conditions for an entry — the deterministic strategy rule originates all of those, for every proposal, whether or not the model is ever called that cycle. A HOLD or CLOSE proposal from a FLAT asset never reaches the model at all (exits and no-ops need no veto). The model returns no rationale text either — a factual audit string (`"noul=0.87, threshold=0.70, N news items evaluated"`) is synthesized deterministically in code for the veto, never model-authored prose; the management side's `reasons` are likewise carried from the deterministic Pass-1 candidate, never generated by the model.

The model may not:

- originate a trade, choose its direction, or set an absolute size, stop-loss, or take-profit price
- widen a stop-loss under any circumstance (long: never move down; short: never move up) — `MODIFY_PROTECTION` may only tighten
- move a take-profit to or past the current market price (that is a disguised CLOSE, kept strictly distinct)
- reduce a position to zero (a 100%-equivalent REDUCE is normalized to CLOSE, never executed as a REDUCE)
- execute trades
- mutate portfolio state
- bypass the risk gate
- calculate authoritative indicators
- access secrets
- turn news text into executable instructions
- have its probability/confidence reach sizing, direction, or any decision surface other than the derived veto boolean and the bounded, gate-validated management fields listed above

A failed model call (or a failed news fetch feeding it) fails closed for every affected candidate this cycle — an entry candidate fails to HOLD (veto); an open position simply stays unmanaged this cycle (no ADD, no REDUCE, no Jev-originated CLOSE, no protection change — its existing SL/TP keep protecting it exactly as before, and `position-monitor` is entirely unaffected). Never treated as an implicit non-veto or an implicit approval, and there is no second model to fall back to. A decision whose cycle made no model call records that honestly (`agent_decisions.model_vetoed = null`, `model_version = 'not-called'`) rather than a fabricated value — the "exact model input/output and prompt/model version" persistence invariant below now applies only to decisions a call actually happened for; see `progress-tracker.md`'s Trading Strategy V1 and Phase 2 implementation entries for the exact sentinel values and the reasoning behind them.

**Named invariant (Phase 2.1, 2026-09-23): when news retrieval fails, discretionary model management is fail-closed for the cycle; the independent position monitor remains the only automatic protection mechanism.** This is deliberate, not incidental — a news-provider outage fails BOTH the entry-veto layer and the management layer closed together (they still share a single `modelCallFailedReason`, even though their own enable/disable flags are independent — see the two-flags paragraph below). The consequence is easy to misread later and must not be: **a news-provider outage can prevent profit-taking, ADD, REDUCE, CLOSE, and protection changes on an open position**, not just a new entry. A quiet cycle with no management action can mean *the model was never called* (news outage, or the layer disabled), not *the model chose HOLD*. `agent_decisions.model_version` is what disambiguates the two after the fact — `'jev-1.13.0'` (or whatever's currently pinned) means a genuine call and decision happened; `'call-failed'` means a news or API failure, not a decision; `'not-called'` means a layer was disabled or there was no candidate. Any later analysis of management behavior (action distribution, veto rate, etc.) must filter on this column rather than counting actions directly, or it will silently attribute outages to model judgment.

**Two independent switches (Phase 2.1, 2026-09-23): `agent_settings.news_veto_enabled` gates ONLY the entry-veto layer; `agent_settings.management_enabled` gates ONLY the portfolio-management layer.** For the first hour of Phase 2's deployment these were conflated — `news_veto_enabled` alone gated both, so disabling the entry veto silently also disabled ADD/REDUCE/CLOSE/MODIFY_PROTECTION on every open position. `cycle/collect-candidates.ts`'s `collectModelCandidates` is where this is now structurally prevented: each flag is read by exactly one of its two branches, so there is no code path by which one flag can affect the other's collection. `shouldCallModel` (same file) is the separate "should we actually spend a call this cycle" decision, covering the case above (both empty, or a failure) in one place.

Trade only when the evidence crosses the decision threshold; otherwise HOLD. HOLD is a valid, ordinary outcome — not a biased default and not a fallback to avoid.

## Security rules

Never put these in extension/client code:

- TypeSafe (Jev) API key
- News API keys
- CoinGecko API key
- Supabase service-role keys
- Future exchange credentials
- Any other privileged secret

RLS must protect exposed Supabase data.

Never trust client-provided portfolio balances, prices, positions, or risk state.

## Data-quality rules

Every external provider response is untrusted until validated.

Every critical market/news input must have freshness information.

Distinguish:

- valid empty news result
- news-provider failure
- stale news
- malformed provider response

If the current decision policy requires news and news retrieval fails, skip the cycle rather than trading blind.

Do not use unclosed/future candles in a way that creates look-ahead leakage.

## UI rules

The decision feed is the hero experience.

The UI should answer:

- What did the agent decide?
- How confident was it?
- Why?
- What evidence did it use?
- What would invalidate the thesis?
- What happened to the portfolio afterward?

Do not turn the extension into a generic chat UI.

Use the tokens and patterns in `context/ui-context.md`.

## Verification

Before marking a unit complete:

- Run the project's type checks.
- Run relevant tests.
- Run the production/build command.
- Check for runtime/console errors where applicable.
- Verify the unit against its spec.
- Confirm no architecture invariant was violated.
- Confirm no secret entered client-visible code.
- Update `context/progress-tracker.md`.

Do not claim something works unless you actually verified it.

## Documentation

When implementation changes any of the following, update the relevant context file:

- Product scope
- Architecture
- Data model
- Security model
- AI behavior
- Risk rules
- UI system
- Code conventions

Keep `progress-tracker.md` current after every meaningful implementation change.

## Current V0

The intended flow is (Trading Strategy V1, 2026-09-21; Phase 2 portfolio management, 2026-09-22/23):

Market data (incl. daily closes) + recent news
→ deterministic indicators + the 50-day trend regime
→ deterministic candidate synthesis, per asset (OPEN_LONG / HOLD / CLOSE — never OPEN_SHORT; stop = max(2×ATR, 2.5%), take-profit = 6×stop)
→ at most one batched model call this cycle, covering BOTH: OPEN_LONG candidates asking only "is there a known exogenous confound?" (veto), and OPEN positions whose regime is still intact this cycle asking "HOLD / ADD / REDUCE / CLOSE / MODIFY_PROTECTION?" (management) — zero candidates of either kind means zero calls
→ deterministic risk gate (SL/TP validation, stop-out re-entry block, risk-derived sizing, single-trade/asset/portfolio-risk/total-notional/minimum-notional caps, drawdown breaker, ADD/REDUCE/MODIFY_PROTECTION validation — confidence is not a gate anywhere)
→ deterministic paper broker (now including `addToPosition`/`reducePosition` — a true weighted-average entry on ADD, a proportional cost-basis release on REDUCE, never a second position row)
→ Supabase persistence
→ Chrome extension

Running independently, every 10 minutes: the position monitor polls prices for open positions only, checks SL/TP/collateral-exhaustion triggers, and executes through the same paper broker — see `context/specs/trading-domain-contract.md`.

V0 assets:

- BTC
- ETH

V0 cadence:

- 3 hours, configurable — **but not currently scheduled**. V0 execution mode is manual-only (2026-09-19, explicit user decision, see `context/progress-tracker.md`): the decision cycle runs only when the user clicks "Run agent" in the extension; no `pg_cron` schedule exists for it. `decision_interval_minutes` stays configured, unused, for a future autonomous mode. The position monitor is unaffected and remains fully automatic on its own 10-minute schedule.

V0 execution:

- paper only
- one net position per asset: FLAT / LONG / SHORT (no lots, no pyramiding — unchanged, still database-enforced)
- **partial exits and in-place resizing exist as of Phase 2 (2026-09-22/23)**: `ADD` (weighted-average entry, never a second position row) and `REDUCE` (proportional cost-basis release, never touches entry price; a full-quantity reduce is normalized to `CLOSE`, never executed as a 100% reduce) — see `context/specs/trading-domain-contract.md` §1
- shorts are 1x unleveraged synthetic paper positions only — see `context/specs/trading-domain-contract.md`
- every open position carries a mandatory stop-loss and take-profit, validated deterministically; `MODIFY_PROTECTION` (Phase 2) may tighten a stop or move a take-profit, never widen a stop, never touch quantity
- SL/TP execution runs on an independent 10-minute position-monitor cycle, not gated by the 3-hour decision cycle — completely unaffected by Phase 2, and always wins any race against an ADD/REDUCE/MODIFY_PROTECTION the same way it already wins against a CLOSE
- position size is derived from risk-at-stop, then capped (max 20% NAV per trade, max 35% NAV per asset) — not a raw model-proposed percentage; an ADD's magnitude is capped the identical way, against the EXISTING stop
- a provisional minimum-trade-notional floor (`agent_settings.min_trade_notional_pct`/`_usd`, Phase 2) applies to ADD and a partial REDUCE only — a full CLOSE has no floor and is always permitted
- approximately 0.1% simulated fee per side
- approximately 0.05% simulated slippage per side

V0 deliberately excludes:

- SOL
- news/no-news control experiment
- buy-and-hold benchmark
- event-driven triggers on the decision cycle (the position monitor is a separate, deterministic exception — it exists for SL/TP execution, not for triggering new decisions)
- backtesting
- streaming feeds
- real leverage, funding, or exchange-style liquidation
- limit orders
- pyramiding (a second position row), multi-leg positions, trailing stops (`MODIFY_PROTECTION`'s stop-tighten is a discrete, gate-validated step per decision, not a continuously-trailing mechanism)
- ~~partial exits~~ — **superseded 2026-09-22/23 (Phase 2)**: `REDUCE` now exists, in-place on the one open position row; see the V0 execution list above
- multi-agent systems
- RAG/vector databases
- on-chain/social signals
- multi-user/billing
- notifications/mobile

Do not add these unless explicitly instructed.

## Starting a new session

When a session starts, report briefly:

1. What the progress tracker says is currently in progress.
2. What the next implementation unit is.
3. Any blocking open question.
4. What you intend to do in this session.

Then proceed only with the requested unit.
