import { supabase } from '@/supabase'
import type { AssetSymbol } from '@/shared/market-data/types.ts'
import type { Action, RiskStatus } from '@/shared/decisions/types.ts'

export interface DecisionListRow {
  id: string
  asset: AssetSymbol
  action: Action
  riskStatus: RiskStatus
  decisionType: 'candidate' | 'management' | null
  armId: string | null
  bias: 'LONG' | 'SHORT' | 'NEUTRAL' | null
  modelVersion: string
  strategyVersion: string
  approvedSizePct: number | null
  decidedAt: string
}

export interface DecisionFilters {
  asset?: AssetSymbol
  action?: Action
  riskStatus?: RiskStatus
  decisionType?: 'candidate' | 'management' | 'unset'
}

const PAGE_SIZE = 100

// WEB-2 (2026-10-08) — closes a live data-mixing gap: this query
// previously had no portfolio scoping at all and read across every
// portfolio in the database. portfolioId absent now resolves is_test=false
// (the live champion), matching every other page's own convention.
export async function loadDecisions(filters: DecisionFilters, portfolioId?: string): Promise<DecisionListRow[]> {
  const portfolioQuery = supabase.from('portfolios').select('id')
  const { data: portfolio, error: portfolioError } = await (
    portfolioId ? portfolioQuery.eq('id', portfolioId) : portfolioQuery.eq('is_test', false)
  ).single()
  if (portfolioError) throw new Error(`could not load portfolio: ${portfolioError.message}`)
  const resolvedPortfolioId = portfolio.id as string

  let query = supabase
    .from('agent_decisions')
    .select('id, asset, action, risk_status, decision_type, arm_id, bias, model_version, strategy_version, approved_size_pct, decided_at')
    .eq('portfolio_id', resolvedPortfolioId)
    .order('decided_at', { ascending: false })
    .limit(PAGE_SIZE)

  if (filters.asset) query = query.eq('asset', filters.asset)
  if (filters.action) query = query.eq('action', filters.action)
  if (filters.riskStatus) query = query.eq('risk_status', filters.riskStatus)
  if (filters.decisionType === 'unset') query = query.is('decision_type', null)
  else if (filters.decisionType) query = query.eq('decision_type', filters.decisionType)

  const { data, error } = await query
  if (error) throw new Error(`could not load decisions: ${error.message}`)

  return (data ?? []).map((d) => ({
    id: d.id,
    asset: d.asset as AssetSymbol,
    action: d.action as Action,
    riskStatus: d.risk_status as RiskStatus,
    decisionType: d.decision_type as 'candidate' | 'management' | null,
    armId: d.arm_id,
    bias: d.bias as 'LONG' | 'SHORT' | 'NEUTRAL' | null,
    modelVersion: d.model_version,
    strategyVersion: d.strategy_version,
    approvedSizePct: d.approved_size_pct === null ? null : Number(d.approved_size_pct),
    decidedAt: d.decided_at,
  }))
}
