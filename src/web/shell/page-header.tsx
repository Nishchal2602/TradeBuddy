import type { ReactNode } from 'react'

export function PageHeader({
  crumb,
  title,
  subtitle,
  right,
}: {
  crumb: string
  title: string
  subtitle?: string
  right?: ReactNode
}) {
  return (
    <div className="mb-8 flex items-start justify-between gap-6">
      <div>
        <div className="wt-label text-w-muted mb-2">{crumb}</div>
        <h1 className="wt-display text-w-text">{title}</h1>
        {subtitle ? <p className="wt-body text-w-muted mt-2 max-w-2xl">{subtitle}</p> : null}
      </div>
      {right}
    </div>
  )
}
