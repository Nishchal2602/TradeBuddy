import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchPortfolio } from '@/features/home/queries'
import { fetchLatestRun } from '@/features/system-status/queries'
import type { LatestRunSummary } from '@/features/system-status/queries'
import { fetchFullAgentSettings } from './queries'
import type { FullAgentSettings } from './queries'

export interface SettingsViewModel {
  settings: FullAgentSettings
  latestDecisionRun: LatestRunSummary | null
  latestMonitorRun: LatestRunSummary | null
}

export type SettingsDataState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: SettingsViewModel }

const REFRESH_INTERVAL_MS = 30_000

export function useSettingsData(): SettingsDataState & { refresh: () => void } {
  const [state, setState] = useState<SettingsDataState>({ status: 'loading' })
  const latestRequestId = useRef(0)

  const refresh = useCallback(() => {
    const requestId = ++latestRequestId.current
    fetchPortfolio()
      .then((portfolio) =>
        Promise.all([fetchFullAgentSettings(), fetchLatestRun(portfolio.id, 'decision'), fetchLatestRun(portfolio.id, 'monitor')]),
      )
      .then(([settings, latestDecisionRun, latestMonitorRun]) => {
        if (latestRequestId.current === requestId) setState({ status: 'ready', data: { settings, latestDecisionRun, latestMonitorRun } })
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
