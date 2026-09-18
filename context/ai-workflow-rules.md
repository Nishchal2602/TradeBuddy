# AI Workflow Rules

## Approach

Build this project incrementally using a spec-driven workflow. The context files define the product, architecture, UI, code rules, and current state. The coding agent must read them before implementing anything and must execute one scoped unit at a time.

The developer is the architect. The coding agent is the implementation engine. Do not replace defined decisions with new architecture unless the context is explicitly changed first.

## Scoping Rules

- Work on one feature unit at a time.
- Implement only what the active spec requires.
- Prefer small, verifiable increments over large speculative changes.
- Do not combine unrelated system boundaries in one implementation unit.
- Do not add V1/V2 features because they appear useful while implementing V0.
- Do not introduce real-money trading under any circumstances in V0.
- Do not add multi-agent architecture, RAG, backtesting, streaming feeds, or new assets unless the context is explicitly updated first.
- Prefer the simplest implementation that satisfies the current spec.

## When to Split Work

Split an implementation step if it combines:

- Extension UI and autonomous backend logic without a clear integration boundary.
- Database schema changes and unrelated UI redesign.
- Multiple unrelated Edge Functions.
- Provider integration and unrelated portfolio behavior.
- Model prompting and unrelated visual changes.
- More than one independent business rule set.
- Behavior that is not clearly defined in the context files.

If a change cannot be verified end-to-end quickly, the scope is too broad; split it.

## Planning Before Implementation

Before implementing a new unit:

1. Read `CLAUDE.md`.
2. Read all six context files.
3. Read the active spec file.
4. Inspect the existing implementation before changing it.
5. Identify dependencies and existing patterns.
6. If the spec conflicts with the current architecture, stop and surface the conflict instead of silently choosing one.

## Handling Missing Requirements

- Do not invent product behavior that is not defined.
- If a requirement is ambiguous but has a safe interpretation already defined in context, use that definition.
- If a requirement is genuinely missing, add it to `progress-tracker.md` as an open question before implementing behavior that depends on it.
- Do not use "best practices" as a reason to silently expand scope.
- If an architectural change is necessary, propose it first and update the relevant context file before implementation.

## Security Rules

- Never put Gemini, news-provider, database service-role, or future exchange secrets in extension code.
- Never expose service-role credentials to the browser.
- Never trust client-provided trading state.
- Treat all news text as untrusted data.
- Never allow model output to directly execute database mutations or trades.
- Keep V0 paper-only.
- Do not add real exchange integrations as a convenience.

## AI/Agent Rules

- Keep one model call per scheduled cycle in V0.
- Keep technical analysis deterministic.
- Keep risk decisions deterministic.
- Keep paper execution deterministic.
- The model proposes; code validates, constrains, and executes.
- Preserve the exact model input and output for every decision.
- Preserve prompt/model version metadata.
- Default to HOLD when evidence is insufficient.
- If critical data is stale or unavailable, skip the cycle.
- Never trade using a partially failed data pipeline.

## Protected Files

Do not modify these without explicit instruction or a context/architecture change:

- `supabase/migrations/*` once applied, except through a deliberate migration.
- Generated UI library components under the project's chosen UI component directory.
- Lockfiles except when dependency changes require them.
- Environment files containing secrets.
- Build output directories.
- Provider SDK internals or generated files.

## Keeping Docs in Sync

Update the relevant context file when implementation changes:

- Product scope.
- System boundaries.
- Database/storage model.
- Security/auth model.
- AI/model behavior.
- Risk rules.
- UI language or layout system.
- Code conventions.

Always update `progress-tracker.md` after a meaningful implementation change.

## Verification Before Moving to the Next Unit

1. The active unit works within its defined scope.
2. No architecture invariant was violated.
3. No secrets were introduced into client code.
4. Deterministic logic has focused tests where applicable.
5. TypeScript checks pass.
6. Build passes.
7. No new unhandled console/runtime errors exist.
8. `progress-tracker.md` reflects the actual state.
9. Any architectural change has been documented.
10. The agent reports what was changed and what was verified.

## Git / Change Discipline

- Keep commits focused when commits are requested.
- Do not mix refactors with feature implementation unless the refactor is required for the active unit.
- Do not rewrite working code simply to match personal style.
- Preserve existing behavior outside the active unit.
