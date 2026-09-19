import { useState } from 'react'
import { TrendingUp, Sparkles } from 'lucide-react'
import { AppShell } from '@/components/shell/app-shell'
import type { TabId } from '@/components/shell/bottom-nav'
import { Card, CardHeader, CardTitle, Panel } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Stat, StatGrid } from '@/components/ui/stat'
import { ProgressBar } from '@/components/ui/progress-bar'
import { LoadingState } from '@/components/states/loading-state'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'

/**
 * UI Step 1: design system + popup shell only. Every tab body below is a
 * placeholder — Steps 2-5 replace each with real Supabase-backed content.
 * The Home tab additionally previews the primitives themselves (Card,
 * Badge, Button, Stat, ProgressBar) against representative values, so
 * this step's own verification exercises real rendered content rather
 * than empty boxes; it is not feature work.
 */
export function App() {
  const [tab, setTab] = useState<TabId>('home')

  return (
    <div className="h-[600px] w-[420px] overflow-hidden">
      <AppShell status="paused" active={tab} onChange={setTab}>
        {tab === 'home' ? <HomePreview /> : null}
        {tab === 'positions' ? (
          <EmptyState title="No open positions" description="BTC and ETH are both flat. Positions land here in Step 4." />
        ) : null}
        {tab === 'activity' ? <LoadingState message="Loading activity…" /> : null}
        {tab === 'settings' ? (
          <ErrorState
            title="Could not reach Supabase"
            description="Settings and risk controls land in Step 5 — this placeholder demonstrates the error state."
            onRetry={() => {}}
          />
        ) : null}
      </AppShell>
    </div>
  )
}

function HomePreview() {
  return (
    <div className="flex flex-col gap-2.5 p-3">
      <Card>
        <CardHeader>
          <CardTitle>
            <TrendingUp className="h-4 w-4 text-accent-primary" aria-hidden="true" />
            Portfolio
          </CardTitle>
          <Badge variant="accent">Design preview</Badge>
        </CardHeader>
        <StatGrid columns={3}>
          <Stat label="NAV" value="$10,284.00" variant="accent" />
          <Stat label="Unrealized P&L" value="+$284.10" sublabel="+2.84%" variant="success" />
          <Stat label="Next cycle" value="01:42:18" />
        </StatGrid>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <Sparkles className="h-4 w-4 text-accent-primary" aria-hidden="true" />
            Component preview
          </CardTitle>
        </CardHeader>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="long">Open long</Badge>
          <Badge variant="short">Open short</Badge>
          <Badge variant="hold">Hold</Badge>
          <Badge variant="flat">Flat</Badge>
          <Badge variant="warning">Stale</Badge>
          <Badge variant="count">3</Badge>
        </div>
        <Panel className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="type-label-xs text-text-secondary">Confidence</span>
            <span className="type-data-sm text-text-primary">72%</span>
          </div>
          <ProgressBar value={72} variant="accent" />
        </Panel>
        <div className="flex gap-2">
          <Button variant="primary" size="sm">
            Run now
          </Button>
          <Button variant="secondary" size="sm">
            Pause
          </Button>
          <Button variant="danger" size="sm">
            Close
          </Button>
        </div>
      </Card>
    </div>
  )
}
