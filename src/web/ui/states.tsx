// Loading/error/empty states — the web equivalent of
// @/components/states/*, rebuilt on this app's own tokens. Kept distinct
// per ui-context.md's standing rule: "Never hide system failures behind
// an empty UI" — error and empty must never share a visual treatment.

export function LoadingState({ message = 'Loading…' }: { message?: string }) {
  return (
    <div role="status" className="glass flex items-center gap-3 p-6">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-w-border border-t-w-accent" />
      <span className="wt-body text-w-muted">{message}</span>
    </div>
  )
}

export function ErrorState({
  title,
  description,
  onRetry,
}: {
  title: string
  description?: string
  onRetry?: () => void
}) {
  return (
    <div role="alert" className="glass border-w-neg/30 p-6">
      <div className="wt-title text-w-neg mb-1">{title}</div>
      {description ? <div className="wt-body-sm text-w-muted mb-4">{description}</div> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="wt-body-sm rounded-md border border-w-border px-3 py-1.5 text-w-text transition-colors hover:bg-w-glass-strong"
        >
          Try again
        </button>
      ) : null}
    </div>
  )
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="glass p-10 text-center">
      <div className="wt-title text-w-text mb-1">{title}</div>
      {description ? <div className="wt-body-sm text-w-muted">{description}</div> : null}
    </div>
  )
}
