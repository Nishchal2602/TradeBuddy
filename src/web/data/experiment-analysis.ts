import { supabase } from '@/supabase'
import type { Action } from '@/shared/decisions/types.ts'
import { isShadowCandidate } from './display'

export interface AccountDecisionStats {
  portfolioId: string
  totalDecisions: number
  byAction: Partial<Record<Action, number>>
  shadowCandidateCount: number
  byNoCandidateReason: Record<string, number>
  modelCallBuckets: { realCall: number; callFailed: number; notCalled: number }
  openPositionCount: number
  closedPositionCount: number
  realizedTradeCount: number
  // Computed from CLOSED positions' realized_pnl only — never blended
  // with an open position's unrealized P&L (two different measurement
  // populations).
  winCount: number
  lossCount: number
}

const DECISIONS_LIMIT = 4000
const TRADES_LIMIT = 2000

export async function loadExperimentDecisionStats(portfolioIds: string[]): Promise<AccountDecisionStats[]> {
  if (portfolioIds.length === 0) return []

  const [decisionsRes, tradesRes, positionsRes] = await Promise.all([
    supabase
      .from('agent_decisions')
      .select('portfolio_id, action, decision_type, risk_status, no_candidate_reason, model_version')
      .in('portfolio_id', portfolioIds)
      .order('decided_at', { ascending: false })
      .limit(DECISIONS_LIMIT),
    supabase.from('trades').select('portfolio_id').in('portfolio_id', portfolioIds).order('executed_at', { ascending: false }).limit(TRADES_LIMIT),
    supabase.from('positions').select('portfolio_id, status, realized_pnl').in('portfolio_id', portfolioIds),
  ])
  if (decisionsRes.error) throw new Error(`could not load decisions: ${decisionsRes.error.message}`)
  if (tradesRes.error) throw new Error(`could not load trades: ${tradesRes.error.message}`)
  if (positionsRes.error) throw new Error(`could not load positions: ${positionsRes.error.message}`)

  return portfolioIds.map((portfolioId) => {
    const decisions = (decisionsRes.data ?? []).filter((d) => d.portfolio_id === portfolioId)
    const trades = (tradesRes.data ?? []).filter((t) => t.portfolio_id === portfolioId)
    const positions = (positionsRes.data ?? []).filter((p) => p.portfolio_id === portfolioId)

    const byAction: Partial<Record<Action, number>> = {}
    const byNoCandidateReason: Record<string, number> = {}
    let shadowCandidateCount = 0
    const modelCallBuckets = { realCall: 0, callFailed: 0, notCalled: 0 }

    for (const d of decisions) {
      const action = d.action as Action
      byAction[action] = (byAction[action] ?? 0) + 1
      if (isShadowCandidate(d.decision_type, d.risk_status)) shadowCandidateCount++
      if (d.no_candidate_reason) byNoCandidateReason[d.no_candidate_reason] = (byNoCandidateReason[d.no_candidate_reason] ?? 0) + 1
      if (d.model_version === 'not-called') modelCallBuckets.notCalled++
      else if (d.model_version === 'call-failed') modelCallBuckets.callFailed++
      else modelCallBuckets.realCall++
    }

    const openPositions = positions.filter((p) => p.status === 'open')
    const closedPositions = positions.filter((p) => p.status === 'closed')
    const winCount = closedPositions.filter((p) => p.realized_pnl !== null && Number(p.realized_pnl) > 0).length
    const lossCount = closedPositions.filter((p) => p.realized_pnl !== null && Number(p.realized_pnl) <= 0).length

    return {
      portfolioId,
      totalDecisions: decisions.length,
      byAction,
      shadowCandidateCount,
      byNoCandidateReason,
      modelCallBuckets,
      openPositionCount: openPositions.length,
      closedPositionCount: closedPositions.length,
      realizedTradeCount: trades.length,
      winCount,
      lossCount,
    }
  })
}

export interface AccountRunStats {
  portfolioId: string
  totalRuns: number
  byStatusAndKind: Record<string, number>
  bySkipReason: Record<string, number>
  latestDecisionRun: { marketTickId: string | null; startedAt: string; status: string } | null
}

export interface RecentIssueRow {
  portfolioId: string
  runId: string
  kind: string
  status: string
  skipReason: string | null
  errorDetail: string | null
  startedAt: string
}

export interface ExperimentRunStatsResult {
  perAccount: AccountRunStats[]
  recentIssues: RecentIssueRow[]
}

const RUNS_LIMIT = 2000
const RECENT_ISSUES_LIMIT = 20

// WEB-2 (2026-10-08) — a real, permanent dashboard limitation, not an
// oversight: `duplicate_tick`/`already_running` are RETURN-VALUE-ONLY
// signals produced by a failed (23505) agent_runs insert — confirmed by
// reading agent-cycle/index.ts, position-monitor/index.ts, and
// cycle-dispatcher/index.ts directly. Since the insert itself failed, no
// row is ever written for either case, so neither can ever appear in
// this (or any) agent_runs-based breakdown. skip_reason's two real,
// observed values are free-text strings (agent-cycle's freshness gate,
// position-monitor's all-stale case) — bucketed here by exact string,
// never a fixed enum.
export async function loadExperimentRunStats(portfolioIds: string[]): Promise<ExperimentRunStatsResult> {
  if (portfolioIds.length === 0) return { perAccount: [], recentIssues: [] }

  const { data, error } = await supabase
    .from('agent_runs')
    .select('id, portfolio_id, kind, status, skip_reason, error_detail, started_at, market_tick_id')
    .in('portfolio_id', portfolioIds)
    .order('started_at', { ascending: false })
    .limit(RUNS_LIMIT)
  if (error) throw new Error(`could not load agent runs: ${error.message}`)

  const rows = data ?? []

  const perAccount: AccountRunStats[] = portfolioIds.map((portfolioId) => {
    const accountRows = rows.filter((r) => r.portfolio_id === portfolioId)
    const byStatusAndKind: Record<string, number> = {}
    const bySkipReason: Record<string, number> = {}
    for (const r of accountRows) {
      const key = `${r.kind}:${r.status}`
      byStatusAndKind[key] = (byStatusAndKind[key] ?? 0) + 1
      if (r.status === 'skipped' && r.skip_reason) bySkipReason[r.skip_reason] = (bySkipReason[r.skip_reason] ?? 0) + 1
    }
    const latestDecisionRun = accountRows.find((r) => r.kind === 'decision')
    return {
      portfolioId,
      totalRuns: accountRows.length,
      byStatusAndKind,
      bySkipReason,
      latestDecisionRun: latestDecisionRun
        ? { marketTickId: latestDecisionRun.market_tick_id, startedAt: latestDecisionRun.started_at, status: latestDecisionRun.status }
        : null,
    }
  })

  const recentIssues: RecentIssueRow[] = rows
    .filter((r) => r.error_detail !== null || (r.status === 'skipped' && r.skip_reason !== null))
    .slice(0, RECENT_ISSUES_LIMIT)
    .map((r) => ({
      portfolioId: r.portfolio_id,
      runId: r.id,
      kind: r.kind,
      status: r.status,
      skipReason: r.skip_reason,
      errorDetail: r.error_detail,
      startedAt: r.started_at,
    }))

  return { perAccount, recentIssues }
}
