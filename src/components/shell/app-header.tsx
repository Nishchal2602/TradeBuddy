import { LineChart } from 'lucide-react'

/** Compact top header (ui-context.md § Layout Patterns): identity, agent
 * mode. NAV/P&L move into the Home screen's own portfolio card in Step 2
 * — cramming them into a 56px header alongside status left no room to
 * read any of it at this popup's width.
 *
 * V0 execution mode: manual-only (2026-09-19) — this used to show a live
 * RUNNING/PAUSED pulse derived from agent_settings.is_paused, back when
 * that flag gated an eventual automatic schedule. Now that the decision
 * cycle never runs except from an explicit click (Home's "Run agent"),
 * is_paused is permanently false and that pulse would just mean "the
 * agent is autonomously active" — exactly the impression this mode is
 * built to avoid. A static MANUAL badge replaces it; no props, no fetch. */
export function AppHeader() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-default px-3">
      <div className="flex items-center gap-1.5">
        <LineChart className="h-5 w-5 text-accent-primary" aria-hidden="true" />
        <span className="type-headline-sm text-text-primary">TradeBuddy</span>
      </div>
      <div className="type-label-xs flex items-center gap-1 rounded-md bg-accent-subtle px-1.5 py-0.5 text-accent-primary">MANUAL</div>
    </header>
  )
}
