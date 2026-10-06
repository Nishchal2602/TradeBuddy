// §6B invariant I5: "every emitted statistic carries n and its MDE; below
// power it prints 'not actionable', not a point estimate." The AI
// Judgment page is the thinnest data in the system (n=2 at the time this
// page was built) — this banner is the mechanical guard against
// presenting that as a confident result, placed above every section on
// that page rather than left to each chart's own judgment.
export function NDisclosure({ n, label }: { n: number; label: string }) {
  const thin = n < 25
  return (
    <div className={`wt-body-sm rounded-md border px-4 py-3 ${thin ? 'border-w-accent/30 bg-w-accent-dim text-w-text' : 'border-w-border-soft text-w-muted'}`}>
      <span className="wt-label text-w-accent mr-2">n = {n}</span>
      {label}
      {thin ? ' — too few observations to read as a trend; shown for transparency, not as a verdict.' : ''}
    </div>
  )
}
