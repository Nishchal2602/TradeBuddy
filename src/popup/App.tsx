import { useEffect, useState } from 'react'
import { AppShell } from '@/components/shell/app-shell'
import type { TabId } from '@/components/shell/bottom-nav'
import { EmptyState } from '@/components/states/empty-state'
import { LoadingState } from '@/components/states/loading-state'
import { ErrorState } from '@/components/states/error-state'
import { HomeScreen } from '@/features/home/home-screen'
import { fetchAgentSettings } from '@/features/home/queries'

/**
 * UI Step 2: Home is real, Supabase-backed content. Positions, Activity,
 * and Settings remain Step 1's placeholders — Steps 3-5 replace each in
 * turn.
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

  return (
    <div className="h-[600px] w-[420px] overflow-hidden">
      <AppShell status={isPaused === false ? 'running' : 'paused'} active={tab} onChange={setTab}>
        {tab === 'home' ? <HomeScreen /> : null}
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
