import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchLatestMarketPrices, fetchNewsHeadlines } from '@/features/market-data/queries'
import type { NewsHeadline } from '@/features/market-data/queries'
import { fetchPositionById } from '@/features/positions/queries'
import type { PositionDetail } from '@/features/positions/queries'
import { fetchDecisionById, parseEvidence } from './queries'
import type { DecisionDetail, DecisionEvidence } from './queries'

export interface DecisionDetailViewModel {
  decision: DecisionDetail
  evidence: DecisionEvidence
  citedNews: Map<string, NewsHeadline>
  position: PositionDetail | null
  /** Only populated when the linked position is still open — a closed
   * position's own realized_pnl/close price is already the complete
   * story, and there is no "current" price to mark it against. */
  currentPrice: number | null
}

export type DecisionDetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'not-found' }
  | { status: 'ready'; data: DecisionDetailViewModel }

// Not polled, unlike Home — a decision's own core fields never change
// once persisted (the one exception, a lost-race CLOSE revision, only
// touches risk_status/risk_reason on a *different* decision than the one
// that lost, per trading-domain-contract.md §6), so there's nothing here
// that benefits from a background refresh the way Home's live dashboard
// does. A manual refresh (ErrorState's retry, or a future explicit
// action) is enough for the one thing that *can* change while viewing —
// a still-open linked position's price/status.
async function loadDecisionDetail(decisionId: string): Promise<DecisionDetailViewModel | null> {
  const decision = await fetchDecisionById(decisionId)
  if (!decision) return null

  const evidence = parseEvidence(decision.inputPayload, decision.asset)

  const newsIds = decision.reasons.filter((r) => r.type === 'NEWS').map((r) => r.newsId)
  const [citedNews, position] = await Promise.all([
    fetchNewsHeadlines(newsIds),
    decision.positionId ? fetchPositionById(decision.positionId) : Promise.resolve(null),
  ])

  let currentPrice: number | null = null
  if (position && position.status === 'open') {
    const prices = await fetchLatestMarketPrices([position.asset])
    currentPrice = prices.get(position.asset)?.price ?? null
  }

  return { decision, evidence, citedNews, position, currentPrice }
}

export function useDecisionDetail(decisionId: string): DecisionDetailState & { refresh: () => void } {
  const [state, setState] = useState<DecisionDetailState>({ status: 'loading' })
  const latestRequestId = useRef(0)

  // Deliberately does not reset state to 'loading' itself — a useCallback
  // that synchronously calls setState as its first action, invoked from
  // an effect, is exactly the "cascading render" shape react/oxlint flags
  // (and rightly: on mount the state is already 'loading' by its initial
  // value, so that reset would just be a wasted identical re-render).
  // retry() below adds the reset back for the one case that actually
  // wants it — a manual click after an error — from a click handler,
  // which isn't the pattern the lint rule is about.
  const refresh = useCallback(() => {
    const requestId = ++latestRequestId.current
    loadDecisionDetail(decisionId)
      .then((data) => {
        if (latestRequestId.current !== requestId) return
        setState(data ? { status: 'ready', data } : { status: 'not-found' })
      })
      .catch((error: unknown) => {
        if (latestRequestId.current === requestId) {
          setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      })
  }, [decisionId])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    refresh()
  }, [refresh])

  useEffect(() => {
    refresh()
    // refresh is recreated when decisionId changes (its own dependency),
    // so this effect correctly re-fetches on navigation to a different
    // decision without needing decisionId listed a second time.
  }, [refresh])

  return { ...state, refresh: retry }
}
