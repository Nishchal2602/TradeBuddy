import { useEffect, useState } from 'react'
import { AppShell } from '@/components/shell/app-shell'
import type { TabId } from '@/components/shell/bottom-nav'
import { HomeScreen } from '@/features/home/home-screen'
import { fetchAgentSettings } from '@/features/home/queries'
import { DecisionDetailScreen } from '@/features/decision-detail/decision-detail-screen'
import { PositionsScreen } from '@/features/positions/positions-screen'
import { ActivityScreen } from '@/features/activity/activity-screen'
import { SettingsScreen } from '@/features/settings/settings-screen'

/**
 * UI Step 5: Settings is real, Supabase-backed content — the last tab.
 * Pause/resume/run-now remain presentation-only throughout the app (see
 * settings-screen.tsx's own comment): no control Edge Function exists to
 * wire them to safely, and building one is backend work a UI step has no
 * business doing on its own initiative.
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
  // which tab was active underneath is untouched. Both Positions and
  // Activity (UI Step 4) can also push into it now, alongside Home.
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchAgentSettings()
      .then((settings) => {
        if (!cancelled) setIsPaused(settings.isPaused)
      })
      .catch(() => {
        // The header degrades to its fail-closed default; each screen's
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
        {tab === 'positions' ? <PositionsScreen onSelectDecision={setSelectedDecisionId} /> : null}
        {tab === 'activity' ? <ActivityScreen onSelectDecision={setSelectedDecisionId} /> : null}
        {tab === 'settings' ? <SettingsScreen /> : null}
      </AppShell>
    </div>
  )
}
