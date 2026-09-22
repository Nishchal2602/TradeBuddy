// Pure identity/dedup logic for the decision cycle's idempotency key,
// split out of index.ts (2026-09-22, "manual idempotency" plan) so it's
// independently testable and so the two responsibilities the old single
// bucketed key conflated are visible as separate, named concepts:
//
//   (a) tick dedup   — "the 06:00 cron tick fired twice, run it once"
//   (b) concurrency  — "don't run two decision cycles at the same time"
//
// Manual and scheduled triggers get disjoint key namespaces
// (`decision-manual-<ms-precision iso>` vs `decision-<floored-iso>`), so
// every deliberate manual click is independently runnable within the
// same 3-hour bucket, while a retried/duplicate scheduled tick still
// collides exactly as it always has. Key uniqueness is NOT what provides
// (b) — that's the new partial unique index on agent_runs
// (kind='decision' AND status='running'), enforced by Postgres. A key
// that's merely unique-per-click says nothing about whether two clicks
// are running at the same instant; see the migration's own comment for
// why open_position_atomic specifically depends on (b) actually holding.

export type CycleTrigger = 'manual' | 'scheduled'

// supabase-js's `invoke('agent-cycle')` with no options sends no body at
// all, so this must accept anything — undefined, {}, an already-parsed
// null, an unrecognized shape — and default to 'scheduled', the MORE
// restrictive of the two (tick dedup, not per-click uniqueness). A
// future cron job that forgets to pass `{trigger:'scheduled'}` still
// gets correct behavior; only an explicit 'manual' opts into the looser
// one. Never the reverse default — an accidental 'manual' default would
// silently disable tick dedup for a real scheduled invocation.
export function parseTrigger(body: unknown): CycleTrigger {
  if (body && typeof body === 'object' && 'trigger' in body && (body as { trigger: unknown }).trigger === 'manual') {
    return 'manual'
  }
  return 'scheduled'
}

export function floorToIntervalIso(nowIso: string, intervalMinutes: number): string {
  const intervalMs = intervalMinutes * 60_000
  const floored = Math.floor(new Date(nowIso).getTime() / intervalMs) * intervalMs
  return new Date(floored).toISOString()
}

// Scheduled: unchanged from the pre-split behavior — one key per
// decisionIntervalMinutes bucket, so a retried/duplicate cron tick
// collides and is rejected exactly as it always has (a literal-string
// regression test guards this). Manual: unique per invocation
// (millisecond-precision nowIso), so every deliberate click gets its own
// key — this is the actual bug fix; concurrency safety for simultaneous
// manual clicks comes from the mutex index, not from this key.
export function buildDecisionIdempotencyKey(trigger: CycleTrigger, nowIso: string, decisionIntervalMinutes: number): string {
  if (trigger === 'manual') return `decision-manual-${nowIso}`
  return `decision-${floorToIntervalIso(nowIso, decisionIntervalMinutes)}`
}

// A 'running' decision row older than this is certainly dead — an Edge
// Function crash or timeout before its own catch block ran, far beyond
// both any plausible cycle duration and any Edge Function wall-clock
// limit. Reaped just before the mutex-guarded insert (index.ts) so a
// genuinely abandoned row can never permanently wedge every future
// manual click behind a run that will never complete.
const STALE_RUN_MINUTES = 10

export function staleRunCutoffIso(nowIso: string): string {
  return new Date(new Date(nowIso).getTime() - STALE_RUN_MINUTES * 60_000).toISOString()
}

// Distinguishes the two ways an agent_runs insert can hit 23505, so the
// caller can report the accurate one rather than collapsing both into
// the old single 'duplicate_tick':
//   - agent_runs_idempotency_key_unique -> this exact tick/click already
//     has a row (scheduled: the same bucket; manual: the same millisecond
//     — vanishingly unlikely, but not impossible)
//   - agent_runs_one_running_decision_idx -> a DIFFERENT run is currently
//     'running' right now (the new mutex)
// Falls back to trigger-based inference when the error text names
// neither constraint explicitly (a driver/version difference, not
// expected but not fatal to guess correctly): a manual key is
// millisecond-precision, so a same-key collision is realistically only
// ever the mutex firing, not two clicks landing in the identical
// millisecond.
export function classifyRunInsertConflict(errorMessage: string, trigger: CycleTrigger): 'already_running' | 'duplicate_tick' {
  if (errorMessage.includes('agent_runs_one_running_decision_idx')) return 'already_running'
  if (errorMessage.includes('agent_runs_idempotency_key_unique')) return 'duplicate_tick'
  return trigger === 'manual' ? 'already_running' : 'duplicate_tick'
}
