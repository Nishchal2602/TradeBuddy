import { LineChart } from 'lucide-react'
import { StatusDot } from '@/components/ui/status-dot'
import { cn } from '@/lib/utils'

export interface AppHeaderProps {
  status: 'running' | 'paused'
}

/** Compact top header (ui-context.md § Layout Patterns): identity, agent
 * status. NAV/P&L/next-run move into the Home screen's own portfolio card
 * in Step 2 — cramming them into a 56px header alongside status left no
 * room to read any of it at this popup's width. */
export function AppHeader({ status }: AppHeaderProps) {
  const isRunning = status === 'running'
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-default px-3">
      <div className="flex items-center gap-1.5">
        <LineChart className="h-5 w-5 text-accent-primary" aria-hidden="true" />
        <span className="type-headline-sm text-text-primary">TradeBuddy</span>
      </div>
      <div
        className={cn(
          'type-label-xs flex items-center gap-1 rounded-md px-1.5 py-0.5',
          isRunning ? 'bg-state-success-subtle text-state-success' : 'bg-state-neutral-subtle text-state-neutral',
        )}
      >
        <StatusDot variant={isRunning ? 'success' : 'neutral'} pulse={isRunning} />
        {isRunning ? 'RUNNING' : 'PAUSED'}
      </div>
    </header>
  )
}
