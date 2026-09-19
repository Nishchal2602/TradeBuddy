import { supabase } from '@/supabase'

// Generalized out of home/queries.ts's original fetchLatestDecisionRun
// (UI Step 5) — Settings needs the identical query for BOTH run kinds
// ("last decision cycle" and "last position monitor cycle"), not just
// decision. Same "move it once a second real consumer needs the same
// shape" call as market-data/queries.ts and positions/queries.ts before
// it.

export interface LatestRunSummary {
  kind: 'decision' | 'monitor'
  status: 'running' | 'completed' | 'skipped' | 'failed'
  startedAt: string
  skipReason: string | null
  errorDetail: string | null
}

/** Most recent run of the given kind (any status) — a `failed`/`skipped`
 * latest run must be visible, not silently indistinguishable from a
 * healthy one (ui-context.md: "never hide system failures behind an
 * empty UI"). */
export async function fetchLatestRun(portfolioId: string, kind: 'decision' | 'monitor'): Promise<LatestRunSummary | null> {
  const { data, error } = await supabase
    .from('agent_runs')
    .select('kind, status, started_at, skip_reason, error_detail')
    .eq('portfolio_id', portfolioId)
    .eq('kind', kind)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`could not load the latest ${kind} run: ${error.message}`)
  if (!data) return null
  return {
    kind: data.kind,
    status: data.status,
    startedAt: data.started_at,
    skipReason: data.skip_reason,
    errorDetail: data.error_detail,
  }
}
