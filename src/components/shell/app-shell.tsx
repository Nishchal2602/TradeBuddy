import type { ReactNode } from 'react'
import { AppHeader, type AppHeaderProps } from './app-header'
import { BottomNav, type BottomNavProps } from './bottom-nav'

export interface AppShellProps extends AppHeaderProps, BottomNavProps {
  children: ReactNode
}

/** The popup frame: fixed-height header and nav, a scrolling body between
 * them. Plain flexbox rather than `position: fixed` — the popup is
 * already a bounded, non-scrolling viewport (420x600, see App.tsx), so
 * there's no page-level scroll for fixed positioning to survive, and flex
 * avoids the stacking-context complications fixed positioning would add
 * for no benefit here. */
export function AppShell({ status, active, onChange, children }: AppShellProps) {
  return (
    <div className="flex h-full w-full flex-col bg-bg-base text-text-primary">
      <AppHeader status={status} />
      <main className="flex flex-1 flex-col overflow-y-auto">{children}</main>
      <BottomNav active={active} onChange={onChange} />
    </div>
  )
}
