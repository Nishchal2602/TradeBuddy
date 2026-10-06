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

export async function loadDecisions(filters: DecisionFilters): Promise<DecisionListRow[]> {
  let query = supabase
    .from('agent_decisions')
    .select('id, asset, action, risk_status, decision_type, arm_id, bias, model_version, strategy_version, approved_size_pct, decided_at')
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
