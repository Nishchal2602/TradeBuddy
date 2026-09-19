import { useEffect, useState } from 'react'
import { AppShell } from '@/components/shell/app-shell'
import type { TabId } from '@/components/shell/bottom-nav'
import { EmptyState } from '@/components/states/empty-state'
import { LoadingState } from '@/components/states/loading-state'
import { ErrorState } from '@/components/states/error-state'
import { HomeScreen } from '@/features/home/home-screen'
import { fetchAgentSettings } from '@/features/home/queries'
import { DecisionDetailScreen } from '@/features/decision-detail/decision-detail-screen'

/**
 * UI Step 3: Home can push into Decision-detail. Positions, Activity, and
 * Settings remain Step 1's placeholders — Steps 4-5 replace each in turn.
 */
export function App() {
  const [tab, setTab] = useState<TabId>('home')
  // A separate, lightweight fetch from HomeScreen's own — the header
  // needs is_paused regardless of which tab is active, and lifting
  // useHomeData() itself up would mean guessing at what Positions/
  // Activity/Settings will eventually need from it before those screens
  // exist. Fails closed (defaults to 'paused') rather than assuming the
  // agent is running before the real value is known.
  const [isPaused, setIsPaused] = useState<boolean | null>(null)
  // Decision-detail is not a fifth tab — it's a full-screen push with its
  // own back-arrow header and deliberately no bottom nav (matching the
  // reference designs' own detail screen), so it's tracked independently
  // of `tab` rather than as a TabId. Reset when the user navigates back;
  // which tab was active underneath is untouched.
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchAgentSettings()
      .then((settings) => {
        if (!cancelled) setIsPaused(settings.isPaused)
      })
      .catch(() => {
        // The header degrades to its fail-closed default; HomeScreen's
        // own ErrorState is where a real Supabase failure is surfaced.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (selectedDecisionId) {
    return (
      <div className="flex h-[600px] w-[420px] flex-col overflow-hidden bg-bg-base text-text-primary">
        <DecisionDetailScreen decisionId={selectedDecisionId} onBack={() => setSelectedDecisionId(null)} />
      </div>
    )
  }

  return (
    <div className="h-[600px] w-[420px] overflow-hidden">
      <AppShell status={isPaused === false ? 'running' : 'paused'} active={tab} onChange={setTab}>
        {tab === 'home' ? <HomeScreen onSelectDecision={setSelectedDecisionId} /> : null}
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
