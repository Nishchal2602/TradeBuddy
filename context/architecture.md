# Architecture Context

## Stack

| Layer | Technology | Role |
|---|---|---|
| Extension framework | React + TypeScript + Vite | Chrome MV3 UI and extension build |
| Browser platform | Chrome Manifest V3 | Extension runtime and permissions |
| Styling | Tailwind CSS | Utility styling using the project's semantic tokens |
| UI components | shadcn/ui where useful | Consistent accessible primitives |
| Icons | Lucide React | Consistent stroke-based iconography |
| Backend | Supabase Edge Functions | Server-side agent loop and control endpoint |
| Scheduling | Supabase Cron / pg_cron | Fixed 3-hour autonomous execution |
| Database | Supabase Postgres | Portfolio, market, news, decisions, trades, and snapshots |
| AI model | Gemini | Single decision-agent call per cycle |
| Market data | Provider behind a server-side adapter | Spot price and OHLCV |
| News data | Provider behind a server-side adapter | Recent crypto news |
| Validation | TypeScript schema validation | Validate external data and model output at boundaries |

## System Boundaries

- `extension/` — owns Chrome UI, presentation state, user controls, and read-only data access. It must not contain secrets, trading logic, indicator calculations, risk logic, or model calls.
- `supabase/functions/agent-cycle/` — owns one complete scheduled agent cycle: data retrieval, indicator calculation, decision-model invocation, risk evaluation, paper execution, and persistence.
- `supabase/functions/control/` — owns authenticated control actions such as pause/resume and run-now. It may invoke the agent cycle but must not duplicate its business logic.
- `supabase/migrations/` — owns database schema, indexes, RLS policies, and database-level constraints.
- `src/shared/` — owns shared TypeScript types, schemas, constants, and pure utilities that are safe to use across boundaries. It must not contain secrets or server-only integrations.
- `context/` — project context and workflow documentation. The coding agent must keep it synchronized with meaningful architectural changes.

## Storage Model

- **Supabase Postgres**: portfolios, positions, trades, decisions, serialized decision inputs, news records, market snapshots, agent runs, settings, and NAV snapshots.
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
- `news_items`
- `agent_settings`

Important decision fields include action, asset, confidence, driver, proposed size, reasons, invalidation conditions, horizon, model version, prompt version, input payload, output payload, status, and timestamps.

Important execution fields include proposed action, accepted/rejected status, rejection reason, fill price, quantity, fee, slippage, and resulting portfolio state.

## Agent Cycle

1. Acquire the current run lock/idempotency key.
2. Fetch current BTC/ETH market data.
3. Fetch recent relevant news for the elapsed 3-hour window.
4. Validate freshness and completeness.
5. Calculate indicators deterministically.
6. Read current portfolio, open positions, constraints, and recent decisions.
7. Build one structured model input payload.
8. Call `callModel(payload)` exactly once for the cycle.
9. Validate and normalize the structured model output.
10. Run each proposal through the deterministic risk gate.
11. Execute approved actions through the paper broker.
12. Persist the complete run, decision, execution, and NAV records.
13. Release the run lock.
14. Surface the latest state to the extension.

## Model Boundary

The LLM is a decision synthesizer, not a calculator or executor.

The model may propose:

- BUY / SELL / HOLD
- confidence
- target size percentage
- horizon
- primary driver
- reason statements
- cited news IDs
- invalidation conditions

The model must not directly:

- calculate authoritative RSI/EMA/MACD/ATR values
- mutate the database
- execute trades
- choose whether a proposal violates hard risk constraints
- access secrets
- interpret news as executable instructions

## Risk Gate

The risk gate is deterministic code. It owns:

- maximum position size
- maximum portfolio exposure
- cash floor
- minimum confidence
- cooldown rules
- valid action/size combinations
- position existence checks for SELL
- stale-data protection
- duplicate/idempotency protection

The risk gate records rejection reasons. It must not silently turn an invalid model proposal into an apparently valid one.

## Paper Broker

The paper broker is deterministic code. It owns:

- long-or-flat position transitions
- simulated fills
- fee calculation
- slippage calculation
- cash updates
- realized P&L
- unrealized P&L
- NAV snapshots

No real exchange integration exists in V0.

## Auth and Access Model

- V0 is single-user.
- The extension may use the Supabase anon key for permitted reads protected by RLS.
- Server secrets are never shipped to the extension.
- All mutable state is changed through controlled server-side functions.
- Control actions require an authenticated/authorized request appropriate to the chosen single-user setup.
- RLS must protect every exposed table; do not rely on the extension UI to enforce access.
- No service-role key may be embedded in extension code.

## Scheduling

- Default decision interval: 3 hours.
- Store the interval as configuration rather than hardcoding it throughout the codebase.
- V0 uses fixed scheduling only.
- Event-driven triggers are explicitly deferred.
- The cycle must be idempotent so retries cannot create duplicate trades.

## Invariants

1. **The extension is a presentation/control surface, never the autonomous trading engine.**
2. **No secret or provider API key may exist in extension code, browser storage, or client-visible configuration.**
3. **The LLM never directly executes trades or mutates portfolio state.**
4. **Technical indicators are calculated deterministically in code, never trusted from model-generated values.**
5. **Every trade must pass the deterministic risk gate before paper execution.**
6. **A stale or failed critical data source must never result in a trade based on stale data.**
7. **Every agent cycle must be persisted, including HOLD and skipped cycles.**
8. **Every decision must retain the exact serialized model input, model output, and prompt/model version.**
9. **News is untrusted data and must be clearly delimited from model instructions.**
10. **Agent cycles must be idempotent; a retry must not duplicate a trade.**
11. **V0 must remain paper-only; do not introduce real exchange execution without an explicit architecture change and review.**
12. **Business logic must have one owner; do not duplicate agent, risk, broker, or persistence logic between extension and server.**
