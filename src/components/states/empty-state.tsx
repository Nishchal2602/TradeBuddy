import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
}

/** A genuinely empty, non-error result — "no decisions yet," "no open
 * positions." Never used for a failure; see ErrorState for that
 * (ui-context.md: "Never hide system failures behind an empty UI"). */
export function EmptyState({ icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
      <div className="mb-1 text-text-muted">{icon ?? <Inbox className="h-5 w-5" aria-hidden="true" />}</div>
      <p className="type-body-md text-text-secondary">{title}</p>
      {description ? <p className="type-body-sm text-text-muted">{description}</p> : null}
    </div>
  )
}
