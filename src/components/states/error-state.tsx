import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface ErrorStateProps {
  title: string
  description?: string
  onRetry?: () => void
}

/** A provider failure, a stale-data skip, a risk rejection the user needs
 * to see — anything the system could quietly swallow into an EmptyState
 * but must not (ui-context.md: "Never hide system failures behind an
 * empty UI"). Deliberately uses the error color and icon so it can never
 * be mistaken for EmptyState at a glance. */
export function ErrorState({ title, description, onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 py-10 text-center" role="alert">
      <TriangleAlert className="mb-1 h-5 w-5 text-state-error" aria-hidden="true" />
      <p className="type-body-md text-state-error">{title}</p>
      {description ? <p className="type-body-sm text-text-muted">{description}</p> : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  )
}
