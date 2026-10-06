import type { ReactNode } from 'react'

export function GlassCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`glass p-6 ${className}`}>{children}</div>
}

export function GlassCardHeader({ eyebrow, title, right }: { eyebrow?: string; title: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        {eyebrow ? <div className="wt-label text-w-accent mb-1">{eyebrow}</div> : null}
        <div className="wt-title text-w-text">{title}</div>
      </div>
      {right}
    </div>
  )
}
