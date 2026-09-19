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
  status: 'completed' | 'skipped' | 'duplicate_tick' | 'failed'
  runId?: string
  decisions: { asset: string; action: string; riskStatus: string }[]
  detail?: string
}

export async function invokeAgentCycle(): Promise<AgentCycleRunResult> {
  const { data, error } = await supabase.functions.invoke<AgentCycleRunResult>('agent-cycle')
  if (error) throw new Error(`could not run the agent: ${error.message}`)
  if (!data) throw new Error('the agent cycle returned no result')
  return data
}
