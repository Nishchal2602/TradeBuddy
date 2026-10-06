// Renders a Jev Choice/Score answer's FULL persisted probability
// distribution, not just the winning label — CLAUDE.md: "the winning
// label alone discards the most analytically valuable data in the row."
// One horizontal bar per option, the chosen option highlighted in accent.

export function DistributionBar({
  distribution,
  chosen,
  labels,
}: {
  distribution: Record<string, number>
  chosen: string | null
  labels?: Record<string, string>
}) {
  const entries = Object.entries(distribution).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return <div className="wt-body-sm text-w-muted">No distribution recorded.</div>

  return (
    <div className="flex flex-col gap-2">
      {entries.map(([option, p]) => {
        const isChosen = option === chosen
        return (
          <div key={option} className="flex items-center gap-3">
            <div className={`wt-label w-40 shrink-0 truncate ${isChosen ? 'text-w-accent' : 'text-w-muted'}`}>
              {labels?.[option] ?? option}
            </div>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-w-glass-strong">
              <div
                className={`h-full rounded-full ${isChosen ? 'bg-w-accent' : 'bg-w-faint'}`}
                style={{ width: `${Math.max(2, p * 100)}%` }}
              />
            </div>
            <div className="wt-num tabular w-12 shrink-0 text-right text-w-text">{(p * 100).toFixed(0)}%</div>
          </div>
        )
      })}
    </div>
  )
}
