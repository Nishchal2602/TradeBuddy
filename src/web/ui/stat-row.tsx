import type { ReactNode } from 'react'

export interface StatItem {
  label: string
  value: ReactNode
  sublabel?: ReactNode
}

// Four columns separated by vertical rules (the mockup's shape), not four
// boxed tiles — matches the attached design's Overview stat row exactly.
export function StatRow({ items }: { items: StatItem[] }) {
  return (
    <div className="glass grid grid-cols-1 divide-y divide-w-border-soft p-0 sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="p-6">
          <div className="wt-label text-w-muted mb-2">{item.label}</div>
          <div className="wt-stat tabular text-w-text">{item.value}</div>
          {item.sublabel ? <div className="wt-body-sm text-w-muted mt-1">{item.sublabel}</div> : null}
        </div>
      ))}
    </div>
  )
}
