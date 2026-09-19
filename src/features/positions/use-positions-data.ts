import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssetSymbol } from '@/shared/market-data/types.ts'
import { fetchLatestMarketPrices } from '@/features/market-data/queries'
import type { LatestMarketPrice } from '@/features/market-data/queries'
import { fetchAgentSettings, fetchPortfolio } from '@/features/home/queries'
import { fetchPositionSummaries } from './queries'
import type { AssetPositionSummary } from './queries'

export interface PositionsViewModel {
  assets: AssetSymbol[]
  summaries: AssetPositionSummary[]
  prices: Map<AssetSymbol, LatestMarketPrice>
}

export type PositionsDataState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: PositionsViewModel }

async function loadPositionsData(): Promise<PositionsViewModel> {
  const settings = await fetchAgentSettings()
  const portfolio = await fetchPortfolio()
  const [summaries, prices] = await Promise.all([fetchPositionSummaries(portfolio.id, settings.assets), fetchLatestMarketPrices(settings.assets)])
  return { assets: settings.assets, summaries, prices }
}

// Same polling shape as Home's useHomeData (30s, request-id guarded
// against out-of-order responses) — a live position's mark price and
// unrealized P&L are exactly the kind of thing this screen exists to
// keep current, same reasoning as Home's own dashboard.
const REFRESH_INTERVAL_MS = 30_000

export function usePositionsData(): PositionsDataState & { refresh: () => void } {
  const [state, setState] = useState<PositionsDataState>({ status: 'loading' })
  const latestRequestId = useRef(0)

  const refresh = useCallback(() => {
    const requestId = ++latestRequestId.current
    loadPositionsData()
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
