import { supabase } from '@/supabase'
import type { AssetSymbol } from '@/shared/market-data/types.ts'
import type { Action, RiskStatus } from '@/shared/decisions/types.ts'
import type { Direction, CloseReason } from '@/shared/positions/types.ts'

// Activity merges events from three independent tables into one
// chronological feed. Each table is fetched once, capped, and correlated
// in application code — not per-row queries — since this project has no
// server-side view/RPC for "the activity feed" and inventing one purely
// for a read-only UI screen would be new backend surface a UI step has
// no business adding.

export type ActivityEvent = DecisionEvent | AutomaticCloseEvent | RunIssueEvent

export interface DecisionEvent {
  kind: 'decision'
  timestamp: string
  decisionId: string
  asset: AssetSymbol
  action: Action
  confidence: number
  riskStatus: RiskStatus
  riskReason: string | null
  /** Set only when this decision actually executed a trade — an approved
   * or clamped OPEN/CLOSE, not a HOLD or a rejection. realizedPnl is only
   * meaningful for a CLOSE (an OPEN has none yet). */
  executedTrade: { fillPrice: number; realizedPnl: number | null } | null
}

export interface AutomaticCloseEvent {
  kind: 'automatic_close'
  timestamp: string
  tradeId: string
  positionId: string
  asset: AssetSymbol
  direction: Direction | null
  triggerReason: Extract<CloseReason, 'stop_loss' | 'take_profit' | 'collateral_exhausted'>
  fillPrice: number
  realizedPnl: number | null
}

export interface RunIssueEvent {
  kind: 'run_issue'
  timestamp: string
  runId: string
  runKind: 'decision' | 'monitor'
  status: 'skipped' | 'failed'
  reason: string | null
}

interface DecisionRow {
  id: string
  asset: AssetSymbol
  action: Action
  confidence: number
  risk_status: RiskStatus
  risk_reason: string | null
  decided_at: string
}

interface TradeRow {
  id: string
  position_id: string
  asset: AssetSymbol
  decision_id: string | null
  trigger_reason: CloseReason | null
  fill_price: number
  executed_at: string
}

interface PositionOutcome {
  direction: Direction
  realizedPnl: number | null
}

async function fetchDecisionRows(portfolioId: string, limit: number): Promise<DecisionRow[]> {
  const { data, error } = await supabase
    .from('agent_decisions')
    .select('id, asset, action, confidence, risk_status, risk_reason, decided_at')
    .eq('portfolio_id', portfolioId)
    .order('decided_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`could not load decisions: ${error.message}`)
  return (data ?? []).map((row) => ({ ...row, confidence: Number(row.confidence) }))
}

async function fetchTradeRows(portfolioId: string, limit: number): Promise<TradeRow[]> {
  const { data, error } = await supabase
    .from('trades')
    .select('id, position_id, asset, decision_id, trigger_reason, fill_price, executed_at')
    .eq('portfolio_id', portfolioId)
    .order('executed_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`could not load trades: ${error.message}`)
  return (data ?? []).map((row) => ({ ...row, fill_price: Number(row.fill_price) }))
}

/** Direction/realized_pnl for whatever positions the fetched trades
 * reference — looked up once by id rather than embedding a join per
 * trade, so both the decision-linked and automatic branches below share
 * one lookup. */
async function fetchPositionOutcomes(positionIds: string[]): Promise<Map<string, PositionOutcome>> {
  if (positionIds.length === 0) return new Map()
  const { data, error } = await supabase.from('positions').select('id, direction, realized_pnl').in('id', positionIds)
  if (error) throw new Error(`could not load position outcomes: ${error.message}`)
  return new Map((data ?? []).map((row) => [row.id, { direction: row.direction, realizedPnl: row.realized_pnl === null ? null : Number(row.realized_pnl) }]))
}

async function fetchRunIssueRows(portfolioId: string, limit: number) {
  const { data, error } = await supabase
    .from('agent_runs')
    .select('id, kind, status, skip_reason, error_detail, started_at')
    .eq('portfolio_id', portfolioId)
    .in('status', ['skipped', 'failed'])
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`could not load run history: ${error.message}`)
  return data ?? []
}

const EVENTS_PER_TABLE = 50

export async function fetchActivityEvents(portfolioId: string): Promise<ActivityEvent[]> {
  const [decisions, trades, runIssues] = await Promise.all([
    fetchDecisionRows(portfolioId, EVENTS_PER_TABLE),
    fetchTradeRows(portfolioId, EVENTS_PER_TABLE),
    fetchRunIssueRows(portfolioId, EVENTS_PER_TABLE),
  ])

  const positionIds = [...new Set(trades.map((t) => t.position_id))]
  const outcomes = await fetchPositionOutcomes(positionIds)

  const tradesByDecisionId = new Map(trades.filter((t): t is TradeRow & { decision_id: string } => t.decision_id !== null).map((t) => [t.decision_id, t]))

  const decisionEvents: DecisionEvent[] = decisions.map((d) => {
    const trade = tradesByDecisionId.get(d.id)
    return {
      kind: 'decision',
      timestamp: d.decided_at,
      decisionId: d.id,
      asset: d.asset,
      action: d.action,
      confidence: d.confidence,
      riskStatus: d.risk_status,
      riskReason: d.risk_reason,
      executedTrade: trade ? { fillPrice: trade.fill_price, realizedPnl: outcomes.get(trade.position_id)?.realizedPnl ?? null } : null,
    }
  })

  const automaticEvents: AutomaticCloseEvent[] = trades
    .filter((t) => t.decision_id === null && t.trigger_reason !== null && t.trigger_reason !== 'agent_close')
    .map((t) => ({
      kind: 'automatic_close',
      timestamp: t.executed_at,
      tradeId: t.id,
      positionId: t.position_id,
      asset: t.asset,
      direction: outcomes.get(t.position_id)?.direction ?? null,
      triggerReason: t.trigger_reason as Extract<CloseReason, 'stop_loss' | 'take_profit' | 'collateral_exhausted'>,
      fillPrice: t.fill_price,
      realizedPnl: outcomes.get(t.position_id)?.realizedPnl ?? null,
    }))

  const runIssueEvents: RunIssueEvent[] = runIssues.map((r) => ({
    kind: 'run_issue',
    timestamp: r.started_at,
    runId: r.id,
    runKind: r.kind,
    status: r.status,
    reason: r.skip_reason ?? r.error_detail,
  }))

  return [...decisionEvents, ...automaticEvents, ...runIssueEvents].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, EVENTS_PER_TABLE)
}
