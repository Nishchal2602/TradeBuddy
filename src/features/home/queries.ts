import { supabase } from '@/supabase'
import type { AssetSymbol } from '@/shared/market-data/types.ts'
import type { Direction } from '@/shared/positions/types.ts'
import type { Action, PrimaryDriver, Reason, InvalidationCondition, RiskStatus } from '@/shared/decisions/types.ts'

// Read-only queries against the real schema (anon key, RLS select-only —
// src/supabase.ts). No indicator math, no risk logic, no trading
// decisions computed here — this file only shapes rows that already
// exist into what home-screen.tsx renders (architecture.md: the
// extension is a read/control surface, never the autonomous engine).

export interface AgentSettingsSummary {
  isPaused: boolean
  decisionIntervalMinutes: number
  maxDataStalenessMinutes: number
  assets: AssetSymbol[]
}

export async function fetchAgentSettings(): Promise<AgentSettingsSummary> {
  const { data, error } = await supabase
    .from('agent_settings')
    .select('is_paused, decision_interval_minutes, max_data_staleness_minutes, assets')
    .single()
  if (error) throw new Error(`could not load agent settings: ${error.message}`)
  return {
    isPaused: data.is_paused,
    decisionIntervalMinutes: data.decision_interval_minutes,
    maxDataStalenessMinutes: data.max_data_staleness_minutes,
    assets: data.assets,
  }
}

export interface PortfolioSummary {
  id: string
  cash: number
  startingCapital: number
}

export async function fetchPortfolio(): Promise<PortfolioSummary> {
  const { data, error } = await supabase.from('portfolios').select('id, cash, starting_capital').single()
  if (error) throw new Error(`could not load portfolio: ${error.message}`)
  return { id: data.id, cash: Number(data.cash), startingCapital: Number(data.starting_capital) }
}

export interface LatestNav {
  cash: number
  positionsValue: number
  nav: number
  unrealizedPnl: number
  realizedPnlCum: number
  capturedAt: string
}

/** Most recent nav_snapshot for the portfolio — the authoritative NAV/P&L
 * figure. Null only before the very first cycle has ever run. */
export async function fetchLatestNav(portfolioId: string): Promise<LatestNav | null> {
  const { data, error } = await supabase
    .from('nav_snapshots')
    .select('cash, positions_value, nav, unrealized_pnl, realized_pnl_cum, captured_at')
    .eq('portfolio_id', portfolioId)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`could not load NAV: ${error.message}`)
  if (!data) return null
  return {
    cash: Number(data.cash),
    positionsValue: Number(data.positions_value),
    nav: Number(data.nav),
    unrealizedPnl: Number(data.unrealized_pnl),
    realizedPnlCum: Number(data.realized_pnl_cum),
    capturedAt: data.captured_at,
  }
}

export interface OpenPositionSummary {
  asset: AssetSymbol
  direction: Direction
  quantity: number
  entryPrice: number
  stopLossPrice: number
  takeProfitPrice: number
  openedAt: string
}

export async function fetchOpenPositions(portfolioId: string): Promise<OpenPositionSummary[]> {
  const { data, error } = await supabase
    .from('positions')
    .select('asset, direction, quantity, entry_price, stop_loss_price, take_profit_price, opened_at')
    .eq('portfolio_id', portfolioId)
    .eq('status', 'open')
  if (error) throw new Error(`could not load open positions: ${error.message}`)
  return (data ?? []).map((row) => ({
    asset: row.asset,
    direction: row.direction,
    quantity: Number(row.quantity),
    entryPrice: Number(row.entry_price),
    stopLossPrice: Number(row.stop_loss_price),
    takeProfitPrice: Number(row.take_profit_price),
    openedAt: row.opened_at,
  }))
}

export interface LatestDecision {
  id: string
  asset: AssetSymbol
  action: Action
  confidence: number
  primaryDriver: PrimaryDriver
  reasons: Reason[]
  invalidation: InvalidationCondition[]
  riskStatus: RiskStatus
  riskReason: string | null
  proposedStopLossPct: number | null
  proposedTakeProfitPct: number | null
  computedStopLossPrice: number | null
  computedTakeProfitPrice: number | null
  decidedAt: string
}

/** The single most recent decision across both assets — "latest agent
 * decision" is one card, not one per asset (that's what the Activity tab,
 * Step 4, is for). Carries its own `id` so Home's card can link into
 * Decision-detail (UI Step 3) without a second round-trip. */
export async function fetchLatestDecision(portfolioId: string): Promise<LatestDecision | null> {
  const { data, error } = await supabase
    .from('agent_decisions')
    .select(
      'id, asset, action, confidence, primary_driver, reasons, invalidation, risk_status, risk_reason, proposed_stop_loss_pct, proposed_take_profit_pct, computed_stop_loss_price, computed_take_profit_price, decided_at',
    )
    .eq('portfolio_id', portfolioId)
    .order('decided_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`could not load the latest decision: ${error.message}`)
  if (!data) return null
  return {
    id: data.id,
    asset: data.asset,
    action: data.action,
    confidence: Number(data.confidence),
    primaryDriver: data.primary_driver,
    reasons: data.reasons,
    invalidation: data.invalidation,
    riskStatus: data.risk_status,
    riskReason: data.risk_reason,
    proposedStopLossPct: data.proposed_stop_loss_pct === null ? null : Number(data.proposed_stop_loss_pct),
    proposedTakeProfitPct: data.proposed_take_profit_pct === null ? null : Number(data.proposed_take_profit_pct),
    computedStopLossPrice: data.computed_stop_loss_price === null ? null : Number(data.computed_stop_loss_price),
    computedTakeProfitPrice: data.computed_take_profit_price === null ? null : Number(data.computed_take_profit_price),
    decidedAt: data.decided_at,
  }
}

