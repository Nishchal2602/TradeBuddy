import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

const valueColor = {
  default: 'text-text-primary',
  success: 'text-state-success',
  error: 'text-state-error',
  accent: 'text-accent-primary',
} as const

export interface StatProps {
  label: string
  value: ReactNode
  sublabel?: string
  variant?: keyof typeof valueColor
  className?: string
}

/** One caption/value/sub-caption stack — the recurring 3-column metric-row
 * unit (NAV, exposure, P&L, cash) seen throughout the reference designs.
 * Compose several inside StatGrid. */
export function Stat({ label, value, sublabel, variant = 'default', className }: StatProps) {
  return (
    <div className={cn('flex flex-col', className)}>
      <span className="type-label-xs text-text-secondary">{label}</span>
      <span className={cn('type-data-md mt-0.5 font-semibold', valueColor[variant])}>{value}</span>
      {sublabel ? <span className="type-label-xs mt-0.5 text-text-muted">{sublabel}</span> : null}
    </div>
  )
}

export interface StatGridProps {
  columns?: 2 | 3 | 4
  children: ReactNode
  className?: string
}

const columnClass = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
} as const

export function StatGrid({ columns = 3, children, className }: StatGridProps) {
  return <div className={cn('grid gap-1', columnClass[columns], className)}>{children}</div>
}
