import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssetSymbol } from '@/shared/market-data/types.ts'
import { fetchLatestMarketPrices, fetchNewsHeadlines } from '@/features/market-data/queries'
import type { LatestMarketPrice, NewsHeadline } from '@/features/market-data/queries'
import { fetchLatestRun } from '@/features/system-status/queries'
import type { LatestRunSummary } from '@/features/system-status/queries'
import { fetchAgentSettings, fetchPortfolio, fetchLatestNav, fetchOpenPositions, fetchLatestDecision } from './queries'
import type { AgentSettingsSummary, PortfolioSummary, LatestNav, OpenPositionSummary, LatestDecision } from './queries'

export interface HomeViewModel {
  settings: AgentSettingsSummary
  portfolio: PortfolioSummary
  nav: LatestNav | null
  positions: OpenPositionSummary[]
  prices: Map<AssetSymbol, LatestMarketPrice>
  latestDecision: LatestDecision | null
  citedNews: Map<string, NewsHeadline>
  latestRun: LatestRunSummary | null
  latestMonitorRun: LatestRunSummary | null
}

export type HomeDataState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: HomeViewModel }

async function loadHomeData(): Promise<HomeViewModel> {
  const settings = await fetchAgentSettings()
  const portfolio = await fetchPortfolio()

  const [nav, positions, prices, latestDecision, latestRun, latestMonitorRun] = await Promise.all([
    fetchLatestNav(portfolio.id),
    fetchOpenPositions(portfolio.id),
    fetchLatestMarketPrices(settings.assets),
    fetchLatestDecision(portfolio.id),
    fetchLatestRun(portfolio.id, 'decision'),
    fetchLatestRun(portfolio.id, 'monitor'),
  ])

  const newsIds = latestDecision?.reasons.filter((r) => r.type === 'NEWS').map((r) => r.newsId) ?? []
  const citedNews = await fetchNewsHeadlines(newsIds)

  return { settings, portfolio, nav, positions, prices, latestDecision, citedNews, latestRun, latestMonitorRun }
}

// Polled, not subscribed — Supabase Realtime would work but is genuinely
// new infrastructure this step doesn't need yet; a plain interval refetch
// is enough to keep the "next cycle" countdown and status roughly current
// without introducing a data-fetching library or a subscription lifecycle
// (code-standards.md: don't add a dependency the current requirement
// doesn't need). 30s balances staying current against a 2-asset,
// anon-key, RLS-select-only workload that's cheap to over-fetch.
const REFRESH_INTERVAL_MS = 30_000

export function useHomeData(): HomeDataState & { refresh: () => void } {
  const [state, setState] = useState<HomeDataState>({ status: 'loading' })
  // Guards against an interval tick's response arriving after a later
  // tick's — with 30s polling and no request library, two in-flight
  // requests overlapping is possible; only the most recently *started*
  // request's result is ever applied, regardless of resolution order.
  const latestRequestId = useRef(0)

  const refresh = useCallback(() => {
    const requestId = ++latestRequestId.current
    loadHomeData()
      .then((data) => {
        if (latestRequestId.current === requestId) setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (latestRequestId.current === requestId) {
          setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      })
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [refresh])

  return { ...state, refresh }
}
