# Code Standards

## General

- Keep modules small and single-purpose.
- Prefer pure functions for calculations, validation, transformations, and risk rules.
- Fix root causes; do not layer workarounds over broken abstractions.
- Do not mix UI, data access, trading logic, and infrastructure concerns in one module.
- Prefer explicit names over clever abstractions.
- Keep provider integrations behind adapters so market/news providers can be changed without rewriting the agent.
- Do not introduce dependencies unless they solve a current V0 requirement.
- Avoid speculative abstractions for V1/V2 functionality.
- Keep V0 implementation simple enough to understand end-to-end.

## TypeScript

- Use strict TypeScript.
- Avoid `any`. Use explicit interfaces, discriminated unions, or `unknown` plus validation.
- Validate all unknown external input at system boundaries.
- Treat API responses as untrusted until parsed and validated.
- Treat LLM output as untrusted until schema validation succeeds.
- Use discriminated unions for action/state variants such as OPEN_LONG/OPEN_SHORT/HOLD/CLOSE and FLAT/LONG/SHORT.
- Keep shared domain types in the shared layer.
- Do not duplicate domain types across extension and server.
- Use UTC timestamps internally and ISO 8601 strings at API boundaries.
- Use decimal-safe numeric handling where required for monetary calculations; avoid casual floating-point arithmetic for persisted money values.
- Do not use TypeScript constructor parameter-property shorthand
  (`constructor(private readonly x: T)`) in anything under `src/` — the
  root tsconfig sets `erasableSyntaxOnly`, which rejects it (it emits real
  assignment code, not just erasable type annotations). Deno's checker does
  not enforce this, so it only surfaces under the real `tsc -b` build —
  confirmed the hard way in the market-data-provider unit. Declare the
  field, assign it in the constructor body.

## React / Extension

- Use functional React components.
- Keep components focused on presentation and interaction.
- Keep data fetching out of deeply nested presentational components.
- Prefer small hooks for reusable UI state.
- Do not put trading calculations in React components.
- Do not put provider API calls directly in UI components.
- Keep Chrome-specific APIs isolated behind small adapters.
- The extension should remain usable if the backend is temporarily unavailable.
- Loading, empty, stale, skipped, and error states must be explicit.

## Backend / Edge Functions

- Keep each Edge Function focused on one boundary.
- `agent-cycle` owns the orchestration of one cycle.
- `control` owns control commands and delegates to shared/server logic.
- Never duplicate business logic between endpoints.
- Validate request inputs before processing.
- Validate provider responses before using them.
- Validate model output before risk evaluation.
- Return predictable error shapes.
- Do not expose internal secrets or stack traces to the extension.
- Use structured logging with run IDs and decision IDs.

## AI / Model Calls

- All model calls must pass through one `callModel(payload)` seam.
- Keep prompt text versioned.
- Stamp prompt/model versions on every decision.
- Use structured output/schema validation.
- Use low temperature or equivalent deterministic settings where supported.
- The model must receive explicit hard constraints.
- The model must know that HOLD is valid and preferred when evidence is insufficient.
- Never let model-generated text become executable instructions.
- News must be delimited as data.
- Never allow model output to bypass the risk gate.

## Styling

- Use semantic CSS variables defined in `ui-context.md`.
- Do not scatter hardcoded color values across components.
- Follow the defined spacing, radius, typography, and surface hierarchy.
- Use semantic positive/negative state tokens consistently.
- Avoid gradients unless explicitly defined by the UI context.
- Prefer dense but readable information design appropriate for a trading workspace.

## API / Data Boundaries

- Validate every mutation request.
- Enforce authorization before mutation.
- Use idempotency keys for agent cycles and trade execution.
- Never trust client-provided portfolio balances, prices, P&L, or risk limits.
- Server-side state is authoritative.
- Provider timestamps and ingestion timestamps should both be retained where freshness matters.
- Distinguish "empty result" from "provider failed".
- Persist enough raw/structured input to make a decision replayable.

## Data and Storage

- Metadata and application state belong in Postgres.
- Use JSONB for bounded structured decision payloads and model records.
- Do not store secrets in Postgres rows unless encrypted and explicitly required; V0 does not require this.
- Add indexes for frequently queried decision timestamps, asset IDs, run IDs, and open positions.
- Use foreign keys for relationships.
- Use database constraints where they protect invariants.
- Store money and quantities with suitable precision.
- Store timestamps in UTC.

## File Organization

- `extension/` — Chrome extension UI and browser adapters only.
- `supabase/functions/agent-cycle/` — scheduled agent orchestration.
- `supabase/functions/control/` — pause/resume/run-now controls.
- `supabase/migrations/` — schema, indexes, constraints, and RLS.
- `src/shared/` — shared types, schemas, constants, and pure utilities.
- `src/components/` — reusable React UI components.
- `src/features/` — feature-level UI composition.
- `context/` — project context and workflow documentation.
- `context/specs/` — implementation specifications.
- `lib/` — small reusable utilities when a module does not belong to a feature boundary.

## Testing

- Test deterministic indicator calculations with fixed fixtures.
- Test risk-gate boundary conditions explicitly.
- Test paper-broker accounting with fees and slippage, for both long and short, including the collateral-exhaustion boundary and the gap-through-exhaustion case (fill must clamp to the exhaustion price, not the observed price).
- Test schema validation against malformed model/provider responses.
- Test idempotency for repeated agent-cycle execution, and for the position-monitor cycle independently.
- Test the agent-cycle-vs-position-monitor concurrent-close race explicitly, both interleavings — must resolve to exactly one close, one trade, one realized P&L every time (`context/specs/trading-domain-contract.md` §6).
- Prefer focused unit tests for deterministic logic over broad test suites in V0.
- Do not treat successful compilation as proof that trading logic is correct.

## Error Handling

- Fail closed for trading decisions.
- If critical market data is stale or unavailable, skip the cycle.
- If news retrieval fails and news is required by the current decision policy, skip the cycle.
- If model output is invalid, do not trade.
- If the risk gate rejects the proposal, record the rejection.
- If paper execution fails, persist the failure and do not fabricate a successful trade.
