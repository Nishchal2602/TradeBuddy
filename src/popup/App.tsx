import { useState } from 'react'
import { AppShell } from '@/components/shell/app-shell'
import type { TabId } from '@/components/shell/bottom-nav'
import { HomeScreen } from '@/features/home/home-screen'
import { DecisionDetailScreen } from '@/features/decision-detail/decision-detail-screen'
import { PositionsScreen } from '@/features/positions/positions-screen'
import { ActivityScreen } from '@/features/activity/activity-screen'
import { SettingsScreen } from '@/features/settings/settings-screen'

/**
 * UI Step 5: Settings is real, Supabase-backed content — the last tab.
 *
 * V0 execution mode: manual-only (2026-09-19) — the header no longer
 * tracks agent_settings.is_paused (see app-header.tsx); it's a static
 * MANUAL badge now, so there's nothing left for App.tsx to fetch for it.
 * Home's own "Run agent" button is the one real control action in the
 * extension. Settings' Pause/Resume/Run-now remain presentation-only
 * (see settings-screen.tsx's own comment): no control Edge Function
 * exists to wire those specific buttons to safely.
 */
export function App() {
  const [tab, setTab] = useState<TabId>('home')
  // Decision-detail is not a fifth tab — it's a full-screen push with its
  // own back-arrow header and deliberately no bottom nav (matching the
  // reference designs' own detail screen), so it's tracked independently
  // of `tab` rather than as a TabId. Reset when the user navigates back;
  // which tab was active underneath is untouched. Both Positions and
  // Activity (UI Step 4) can also push into it now, alongside Home.
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null)

  if (selectedDecisionId) {
    return (
      <div className="flex h-[600px] w-[420px] flex-col overflow-hidden bg-bg-base text-text-primary">
        <DecisionDetailScreen decisionId={selectedDecisionId} onBack={() => setSelectedDecisionId(null)} />
      </div>
    )
  }

  return (
    <div className="h-[600px] w-[420px] overflow-hidden">
      <AppShell active={tab} onChange={setTab}>
        {tab === 'home' ? <HomeScreen onSelectDecision={setSelectedDecisionId} /> : null}
        {tab === 'positions' ? <PositionsScreen onSelectDecision={setSelectedDecisionId} /> : null}
        {tab === 'activity' ? <ActivityScreen onSelectDecision={setSelectedDecisionId} /> : null}
        {tab === 'settings' ? <SettingsScreen /> : null}
      </AppShell>
    </div>
  )
}
