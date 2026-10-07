import { supabase } from '@/supabase'
import type { AssetSymbol } from '@/shared/market-data/types.ts'
import type { Action, RiskStatus } from '@/shared/decisions/types.ts'
import type { ChartMarker, ChartPoint } from '../ui/line-chart'

export interface OpenPositionRow {
  asset: AssetSymbol
  direction: 'long' | 'short'
  quantity: number
  entryPrice: number
  stopLossPrice: number
  takeProfitPrice: number
  openedAt: string
}

export interface RecentDecisionRow {
  id: string
  asset: AssetSymbol
  action: Action
  riskStatus: RiskStatus
  decisionType: 'candidate' | 'management' | null
  armId: string | null
  modelVersion: string
  decidedAt: string
}

export interface OverviewData {
  isPaused: boolean
  decisionIntervalMinutes: number
  strategyProfile: string
  assets: AssetSymbol[]
  cash: number
  startingCapital: number
  nav: number | null
  positionsValue: number | null
  totalPnl: number | null
  navSeries: ChartPoint[]
  pnlSeries: ChartPoint[]
  capitalMarkers: ChartMarker[]
  openPositions: OpenPositionRow[]
  prices: Map<AssetSymbol, { price: number; change24hPct: number | null }>
  recentDecisions: RecentDecisionRow[]
  lastDecisionRun: { startedAt: string; status: string } | null
  lastMonitorRun: { startedAt: string; status: string } | null
}

// A cash increase this large in one tick cannot come from trading itself
// (fees/slippage move cash by cents-to-dollars per fill, and realized P&L
// settles in the same small increments) — it is a capital contribution.
// Detected generically from the series rather than hardcoding today's
// injection timestamp, so a FUTURE contribution marks itself the same way
// with zero code change.
const CONTRIBUTION_THRESHOLD_USD = 500

export async function loadOverviewData(portfolioId?: string): Promise<OverviewData> {
  const portfolioQuery = supabase.from('portfolios').select('id, cash, starting_capital')
  const [{ data: settings, error: settingsError }, { data: portfolio, error: portfolioError }] = await Promise.all([
    supabase.from('agent_settings').select('is_paused, decision_interval_minutes, strategy_profile, assets').single(),
    // WEB-2 (2026-10-08) — portfolioId absent resolves is_test=false (the
    // live champion), exactly as before this retrofit. Behavior-
    // preserving by construction: the `:` branch below is the unmodified
    // original line.
    (portfolioId ? portfolioQuery.eq('id', portfolioId) : portfolioQuery.eq('is_test', false)).single(),
  ])
  if (settingsError) throw new Error(`could not load agent settings: ${settingsError.message}`)
  if (portfolioError) throw new Error(`could not load portfolio: ${portfolioError.message}`)

  const resolvedPortfolioId = portfolio.id as string
  const assets = settings.assets as AssetSymbol[]

  const [navRes, openPosRes, pricesRes, decisionsRes, decisionRunRes, monitorRunRes] = await Promise.all([
    // Descending + limit, reversed below — NOT ascending + limit. The
    // Supabase-hosted PostgREST endpoint silently caps rows per request
    // (independent of any .limit() asked for) and returning fewer rows
    // than requested is NOT an error — an ascending query would silently
    // return the OLDEST rows and go stale the moment the row count passes
    // the cap, with the UI never knowing anything was truncated. A
    // descending query degrades safely instead: if rows are capped, the
    // CHART loses some early history, but "latest" (data[0]) is always
    // correct regardless of the cap.
    supabase
      .from('nav_snapshots')
      .select('cash, positions_value, nav, unrealized_pnl, realized_pnl_cum, captured_at')
      .eq('portfolio_id', resolvedPortfolioId)
      .order('captured_at', { ascending: false })
      .limit(3000),
    supabase
      .from('positions')
      .select('asset, direction, quantity, entry_price, stop_loss_price, take_profit_price, opened_at')
      .eq('portfolio_id', resolvedPortfolioId)
      .eq('status', 'open'),
    supabase.from('market_quotes').select('asset, price, change_24h_pct').in('asset', assets),
    supabase
      .from('agent_decisions')
      .select('id, asset, action, risk_status, decision_type, arm_id, model_version, decided_at')
      .eq('portfolio_id', resolvedPortfolioId)
      .order('decided_at', { ascending: false })
      .limit(8),
    supabase.from('agent_runs').select('started_at, status').eq('portfolio_id', resolvedPortfolioId).eq('kind', 'decision').order('started_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('agent_runs').select('started_at, status').eq('portfolio_id', resolvedPortfolioId).eq('kind', 'monitor').order('started_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  if (navRes.error) throw new Error(`could not load NAV history: ${navRes.error.message}`)
  if (openPosRes.error) throw new Error(`could not load open positions: ${openPosRes.error.message}`)
  if (pricesRes.error) throw new Error(`could not load prices: ${pricesRes.error.message}`)
  if (decisionsRes.error) throw new Error(`could not load recent decisions: ${decisionsRes.error.message}`)

  // Reverse back to ascending (oldest -> newest) for the chart series and
  // the contribution-marker scan, which both read chronologically forward.
  const navRows = [...(navRes.data ?? [])].reverse()
  const navSeries: ChartPoint[] = []
  const pnlSeries: ChartPoint[] = []
  const capitalMarkers: ChartMarker[] = []
  let prevCash: number | null = null

  for (const row of navRows) {
    const t = new Date(row.captured_at).getTime()
    const cash = Number(row.cash)
    navSeries.push({ t, v: Number(row.nav) })
    pnlSeries.push({ t, v: Number(row.realized_pnl_cum) + Number(row.unrealized_pnl) })
    if (prevCash !== null && cash - prevCash >= CONTRIBUTION_THRESHOLD_USD) {
      capitalMarkers.push({ t, label: `+${(cash - prevCash).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} added to budget` })
    }
    prevCash = cash
  }

  const latest = navRows[navRows.length - 1]

  const prices = new Map<AssetSymbol, { price: number; change24hPct: number | null }>()
  for (const row of pricesRes.data ?? []) {
    prices.set(row.asset as AssetSymbol, { price: Number(row.price), change24hPct: row.change_24h_pct === null ? null : Number(row.change_24h_pct) })
  }

  return {
    isPaused: settings.is_paused,
    decisionIntervalMinutes: settings.decision_interval_minutes,
    strategyProfile: settings.strategy_profile,
    assets,
    cash: Number(portfolio.cash),
    startingCapital: Number(portfolio.starting_capital),
    nav: latest ? Number(latest.nav) : null,
    positionsValue: latest ? Number(latest.positions_value) : null,
    totalPnl: latest ? Number(latest.realized_pnl_cum) + Number(latest.unrealized_pnl) : null,
    navSeries,
    pnlSeries,
    capitalMarkers,
    openPositions: (openPosRes.data ?? []).map((p) => ({
      asset: p.asset as AssetSymbol,
      direction: p.direction as 'long' | 'short',
      quantity: Number(p.quantity),
      entryPrice: Number(p.entry_price),
      stopLossPrice: Number(p.stop_loss_price),
      takeProfitPrice: Number(p.take_profit_price),
      openedAt: p.opened_at,
    })),
    prices,
    recentDecisions: (decisionsRes.data ?? []).map((d) => ({
      id: d.id,
      asset: d.asset as AssetSymbol,
      action: d.action as Action,
      riskStatus: d.risk_status as RiskStatus,
      decisionType: d.decision_type as 'candidate' | 'management' | null,
      armId: d.arm_id,
      modelVersion: d.model_version,
      decidedAt: d.decided_at,
    })),
    lastDecisionRun: decisionRunRes.data ? { startedAt: decisionRunRes.data.started_at, status: decisionRunRes.data.status } : null,
    lastMonitorRun: monitorRunRes.data ? { startedAt: monitorRunRes.data.started_at, status: monitorRunRes.data.status } : null,
  }
}
