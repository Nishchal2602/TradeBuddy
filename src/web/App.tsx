import { useRoute } from './router'
import { Sidebar } from './shell/sidebar'
import { OverviewPage } from './pages/overview'
import { DecisionsPage } from './pages/decisions'
import { DecisionDetailPage } from './pages/decision-detail'
import { PositionsPage } from './pages/positions'
import { JudgmentPage } from './pages/judgment'
import { StrategyPage } from './pages/strategy'

export function App() {
  const route = useRoute()

  return (
    <div className="flex min-h-screen bg-w-bg">
      <Sidebar active={route.name} />
      <main className="min-w-0 flex-1 px-12 py-10">
        <div className="mx-auto max-w-[1120px]">
          {route.name === 'overview' ? <OverviewPage /> : null}
          {route.name === 'decisions' ? <DecisionsPage /> : null}
          {route.name === 'decision-detail' ? <DecisionDetailPage decisionId={route.id} /> : null}
          {route.name === 'positions' ? <PositionsPage /> : null}
          {route.name === 'judgment' ? <JudgmentPage /> : null}
          {route.name === 'strategy' ? <StrategyPage /> : null}
        </div>
      </main>
    </div>
  )
}
