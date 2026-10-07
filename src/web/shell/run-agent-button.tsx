import { useState } from 'react'
import { Play } from 'lucide-react'
import { invokeAgentCycle } from '@/features/home/run-agent'

type RunState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; message: string; tone: 'success' | 'neutral' | 'error' }

// Reuses invokeAgentCycle() unchanged — the identical anon-key
// functions.invoke('agent-cycle', {trigger:'manual'}) path the extension's
// own Home screen already uses. No new security surface: the anon key is
// already public by design, so this is a second caller of an existing
// endpoint, not a new exposure (WEB-1 plan).
export function RunAgentButton({ onRan, portfolioId }: { onRan?: () => void; portfolioId?: string }) {
  const [state, setState] = useState<RunState>({ status: 'idle' })

  const handleClick = async () => {
    setState({ status: 'running' })
    try {
      const result = await invokeAgentCycle(portfolioId)
      if (result.status === 'completed') {
        setState({ status: 'done', message: `Cycle complete — ${result.decisions.length} decisions made.`, tone: 'success' })
      } else if (result.status === 'duplicate_tick') {
        setState({ status: 'done', message: 'Already ran for the current window — try again once it rolls over.', tone: 'neutral' })
      } else if (result.status === 'already_running') {
        setState({ status: 'done', message: 'A cycle is already running right now.', tone: 'neutral' })
      } else if (result.status === 'skipped') {
        setState({ status: 'done', message: result.detail ?? 'Cycle skipped.', tone: 'neutral' })
      } else {
        setState({ status: 'done', message: result.detail ?? 'The cycle failed.', tone: 'error' })
      }
      onRan?.()
    } catch (error) {
      setState({ status: 'done', message: error instanceof Error ? error.message : 'Could not run the agent.', tone: 'error' })
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={state.status === 'running'}
        className="wt-body-sm flex items-center gap-2 rounded-md border border-w-accent/40 bg-w-accent-dim px-4 py-2.5 text-w-accent transition-colors hover:bg-w-accent/20 disabled:opacity-60"
      >
        <Play aria-hidden="true" className="h-3.5 w-3.5" />
        {state.status === 'running' ? 'Running…' : 'Run agent'}
      </button>
      {state.status === 'done' ? (
        <div
          className={`wt-body-sm max-w-xs text-right ${
            state.tone === 'success' ? 'text-w-pos' : state.tone === 'error' ? 'text-w-neg' : 'text-w-muted'
          }`}
        >
          {state.message}
        </div>
      ) : null}
    </div>
  )
}
