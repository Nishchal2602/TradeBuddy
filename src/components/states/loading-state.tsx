import { Loader2 } from 'lucide-react'

export interface LoadingStateProps {
  message?: string
}

/** Reserve for a genuine wait (initial fetch, a triggered action in
 * flight) — never as a substitute for handling the empty or error case. */
export function LoadingState({ message = 'Loading…' }: LoadingStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-text-muted" role="status">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
      <p className="type-body-sm">{message}</p>
    </div>
  )
}
