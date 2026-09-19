import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchPortfolio } from '@/features/home/queries'
import { fetchActivityEvents } from './queries'
import type { ActivityEvent } from './queries'

export type ActivityDataState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; events: ActivityEvent[] }

const REFRESH_INTERVAL_MS = 30_000

export function useActivityData(): ActivityDataState & { refresh: () => void } {
  const [state, setState] = useState<ActivityDataState>({ status: 'loading' })
  const latestRequestId = useRef(0)

  const refresh = useCallback(() => {
    const requestId = ++latestRequestId.current
    fetchPortfolio()
      .then((portfolio) => fetchActivityEvents(portfolio.id))
      .then((events) => {
        if (latestRequestId.current === requestId) setState({ status: 'ready', events })
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
