import { LayoutGrid, ListTree, Wallet, Brain, SlidersHorizontal } from 'lucide-react'
import type { Route } from '../router'
import { hrefFor } from '../router'

const NAV_ITEMS: { route: Route['name']; path: string; label: string; icon: typeof LayoutGrid }[] = [
  { route: 'overview', path: '/', label: 'Overview', icon: LayoutGrid },
  { route: 'decisions', path: '/decisions', label: 'Decisions', icon: ListTree },
  { route: 'positions', path: '/positions', label: 'Positions & Trades', icon: Wallet },
  { route: 'judgment', path: '/judgment', label: 'AI Judgment', icon: Brain },
  { route: 'strategy', path: '/strategy', label: 'Strategy & Settings', icon: SlidersHorizontal },
]

export function Sidebar({ active }: { active: Route['name'] }) {
  const activeRoute = active === 'decision-detail' ? 'decisions' : active

  return (
    <aside className="glass-raised flex w-[232px] shrink-0 flex-col justify-between">
      <div>
        <div className="px-5 py-6">
          <div className="wt-title text-w-text">TradeBuddy</div>
          <div className="wt-label text-w-muted mt-1">Personal workspace</div>
        </div>

        <nav className="flex flex-col gap-0.5 px-3">
          {NAV_ITEMS.map(({ route, path, label, icon: Icon }) => {
            const isActive = route === activeRoute
            return (
              <a
                key={route}
                href={hrefFor(path)}
                className={`flex items-center gap-2.5 rounded-md px-3 py-2.5 transition-colors ${
                  isActive ? 'wt-nav-active bg-w-accent-dim text-w-accent' : 'wt-nav text-w-muted hover:bg-w-glass-strong hover:text-w-text'
                }`}
              >
                <Icon aria-hidden="true" className="h-4 w-4" />
                {label}
              </a>
            )
          })}
        </nav>

        <div className="mx-3 mt-6">
          <div className="glass border-w-accent/20 p-3.5">
            <div className="wt-label text-w-accent">Paper trading</div>
            <div className="wt-body-sm text-w-muted mt-1">Real markets. Simulated capital. No funds at risk.</div>
          </div>
        </div>
      </div>

      <div className="border-t border-w-border-soft px-5 py-4">
        <div className="wt-body-sm text-w-text">V0 Paper Portfolio</div>
        <div className="wt-label text-w-muted mt-0.5">Solo workspace</div>
      </div>
    </aside>
  )
}
