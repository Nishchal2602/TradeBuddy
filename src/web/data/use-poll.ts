import { useCallback, useEffect, useRef, useState } from 'react'

// One generic version of the extension's hand-rolled per-screen data-hook
// pattern (use-home-data.ts / use-positions-data.ts / etc. each duplicate
// REFRESH_INTERVAL_MS = 30_000 and an identical four-part shape). This app
// has five pages doing the same thing, so it's generalized here instead of
// copy-pasted a sixth time — still no react-query/SWR, matching this
// repo's existing minimalism (WEB-1 plan, Architecture).
//
// `loader` identity is a real signal, not incidental: a STABLE loader
// (every page except Decisions passes a module-level function reference,
// so it never changes) behaves like a plain mount-effect + interval. The
// Decisions page passes `() => loadDecisions(filters)`, a new closure
// every time filters change — which is exactly what should force an
// immediate reload (not wait out the remaining interval) and restart the
// 30s timer from that point.

export type PollState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T }

export interface UsePollResult<T> {
  state: PollState<T>
  refresh: () => void
}

const DEFAULT_INTERVAL_MS = 30_000

export function usePoll<T>(loader: () => Promise<T>, intervalMs = DEFAULT_INTERVAL_MS): UsePollResult<T> {
  const [state, setState] = useState<PollState<T>>({ status: 'loading' })
  const latestRequestId = useRef(0)

  const run = useCallback(() => {
    const requestId = ++latestRequestId.current
    loader()
      .then((data) => {
        if (requestId === latestRequestId.current) setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (requestId === latestRequestId.current) {
          setState({ status: 'error', message: error instanceof Error ? error.message : 'Something went wrong.' })
        }
      })
  }, [loader])

  useEffect(() => {
    run()
    const id = setInterval(run, intervalMs)
    return () => clearInterval(id)
  }, [run, intervalMs])

  return { state, refresh: run }
}
