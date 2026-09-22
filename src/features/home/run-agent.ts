import { supabase } from '@/supabase'

// The one real control action in the extension (everything in queries.ts
// is read-only) — kept in its own file for exactly that reason. Invokes
// agent-cycle directly with the anon key as bearer token (V0 execution
// mode: manual-only, 2026-09-19) — no separate `control` wrapper Edge
// Function; agent-cycle's own service-role client does the actual
// privileged work, same as every scheduled/direct invocation before this.

/** Mirrors agent-cycle/index.ts's CycleSummary — that file is Deno-only
 * (imports supabase/functions/... paths that don't resolve under Vite),
 * so this is a parallel, hand-kept-in-sync shape rather than a shared
 * import, same tradeoff every other Edge-Function-only type in this
 * codebase makes. */
export interface AgentCycleRunResult {
  status: 'completed' | 'skipped' | 'duplicate_tick' | 'already_running' | 'failed'
  runId?: string
  decisions: { asset: string; action: string; riskStatus: string }[]
  detail?: string
}

// trigger: 'manual' ("manual idempotency" plan, 2026-09-22) — every click
// of this button IS a manual invocation, so this is never anything else.
// Its absence (a future scheduled caller sending no body, or an
// unrecognized value) is exactly what agent-cycle's own parseTrigger
// treats as 'scheduled' — the more restrictive default — so an
// extension build that somehow failed to send this would revert to the
// OLD bucketed behavior, not a worse one.
export async function invokeAgentCycle(): Promise<AgentCycleRunResult> {
  const { data, error } = await supabase.functions.invoke<AgentCycleRunResult>('agent-cycle', { body: { trigger: 'manual' } })
  if (error) throw new Error(`could not run the agent: ${error.message}`)
  if (!data) throw new Error('the agent cycle returned no result')
  return data
}
