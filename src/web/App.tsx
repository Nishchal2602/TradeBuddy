import { useEffect, useState } from 'react'
import { useRoute } from './router'
import type { Route } from './router'
import { Sidebar } from './shell/sidebar'
import { AccountContextBar } from './shell/account-context-bar'
import { OverviewPage } from './pages/overview'
import { DecisionsPage } from './pages/decisions'
import { DecisionDetailPage } from './pages/decision-detail'
import { PositionsPage } from './pages/positions'
import { JudgmentPage } from './pages/judgment'
import { StrategyPage } from './pages/strategy'
import { ExperimentsPage } from './pages/experiments'
import { ExperimentDetailPage } from './pages/experiment-detail'
import { ErrorState } from './ui/states'
import { loadAccountContext, type AccountContext } from './data/account'

type AccountState = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: AccountContext }

function routePortfolioId(route: Route): string | undefined {
  return route.name === 'experiments' || route.name === 'experiment-detail' ? undefined : route.portfolioId
}

// Keyed by portfolioId in the component below — a fresh mount per account
// means accountState's own lazy initial value is always correct for THIS
// portfolioId with no separate "reset to idle" transition to manage, and
// the effect below never needs a synchronous setState call of its own
// (only its async .then()/.catch() continuations do).
function AppShell({ route, portfolioId }: { route: Route; portfolioId?: string }) {
  const [accountState, setAccountState] = useState<AccountState>(() => (portfolioId ? { status: 'loading' } : { status: 'idle' }))

  useEffect(() => {
    if (!portfolioId) return
    let cancelled = false
    loadAccountContext(portfolioId)
      .then((data) => {
        if (!cancelled) setAccountState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (!cancelled) setAccountState({ status: 'error', message: error instanceof Error ? error.message : 'Could not load this account.' })
      })
    return () => {
      cancelled = true
    }
  }, [portfolioId])

  if (portfolioId && accountState.status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-w-bg p-10">
        <ErrorState title="Could not load this account" description={accountState.message} />
      </div>
    )
  }

  const accountName = accountState.status === 'ready' ? accountState.data.name : null

  return (
    <div className="flex min-h-screen bg-w-bg">
      <Sidebar active={route.name} portfolioId={portfolioId} accountName={accountName} />
      <main className="min-w-0 flex-1 px-12 py-10">
        <div className="mx-auto max-w-[1120px]">
          {portfolioId ? <AccountContextBar portfolioId={portfolioId} name={accountName} /> : null}
          {route.name === 'overview' ? <OverviewPage portfolioId={portfolioId} /> : null}
          {route.name === 'decisions' ? <DecisionsPage portfolioId={portfolioId} /> : null}
          {route.name === 'decision-detail' ? <DecisionDetailPage decisionId={route.id} portfolioId={portfolioId} /> : null}
          {route.name === 'positions' ? <PositionsPage portfolioId={portfolioId} /> : null}
          {route.name === 'judgment' ? <JudgmentPage portfolioId={portfolioId} /> : null}
          {route.name === 'strategy' ? <StrategyPage portfolioId={portfolioId} /> : null}
          {route.name === 'experiments' ? <ExperimentsPage /> : null}
          {route.name === 'experiment-detail' ? <ExperimentDetailPage experimentId={route.id} /> : null}
        </div>
      </main>
    </div>
  )
}

export function App() {
  const route = useRoute()
  const portfolioId = routePortfolioId(route)
  return <AppShell key={portfolioId ?? 'champion'} route={route} portfolioId={portfolioId} />
}
