import { LayoutGrid, Wallet, History, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'

export type TabId = 'home' | 'positions' | 'activity' | 'settings'

const TABS: { id: TabId; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'home', label: 'Home', icon: LayoutGrid },
  { id: 'positions', label: 'Positions', icon: Wallet },
  { id: 'activity', label: 'Activity', icon: History },
  { id: 'settings', label: 'Settings', icon: Settings },
]

export interface BottomNavProps {
  active: TabId
  onChange: (tab: TabId) => void
}

/** Four-tab primary navigation (ui-context.md § Layout Patterns implies a
 * Decision Feed / Positions / Controls split; Activity — the audit log of
 * every cycle including HOLD/skipped/rejected — is its own tab rather than
 * folded into Home, since "never hide system failures" needs a place a
 * user can always reach). 44px touch targets throughout. */
export function BottomNav({ active, onChange }: BottomNavProps) {
  return (
    <nav className="flex h-14 shrink-0 items-center justify-around border-t border-border-default" aria-label="Primary">
      {TABS.map(({ id, label, icon: Icon }) => {
        const isActive = id === active
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 transition-colors',
              isActive ? 'text-accent-primary' : 'text-text-secondary hover:text-text-primary',
            )}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
            <span className={cn('type-label-xs', isActive && 'font-bold')}>{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
