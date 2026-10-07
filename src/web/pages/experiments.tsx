import { PageHeader } from '../shell/page-header'
import { GlassCard } from '../ui/glass-card'
import { LoadingState, ErrorState, EmptyState } from '../ui/states'
import { DataTable, type Column } from '../ui/data-table'
import { Badge } from '../ui/badge'
import { usePoll } from '../data/use-poll'
import { loadExperimentsList, type ExperimentListRow } from '../data/experiments'
import { EXPERIMENT_STATUS_LABEL, EXPERIMENT_STATUS_VARIANT } from '../data/display'
import { navigate } from '../router'

export function ExperimentsPage() {
  const { state, refresh } = usePoll(loadExperimentsList, 30_000)

  const columns: Column<ExperimentListRow>[] = [
    { header: 'Name', render: (e) => <span className="wt-body-sm text-w-text">{e.name}</span> },
    { header: 'Status', render: (e) => <Badge variant={EXPERIMENT_STATUS_VARIANT[e.status]}>{EXPERIMENT_STATUS_LABEL[e.status]}</Badge> },
    {
      header: 'Hypothesis',
      render: (e) => (
        <span className="wt-body-sm text-w-muted line-clamp-1 max-w-md" title={e.hypothesis}>
          {e.hypothesis}
        </span>
      ),
    },
    { header: 'Variants', render: (e) => <span className="tabular">{e.variantCount}</span>, align: 'right' },
    { header: 'Accounts', render: (e) => <span className="tabular">{e.portfolioCount}</span>, align: 'right' },
    { header: 'Started', render: (e) => <span className="text-w-muted">{e.startedAt ? new Date(e.startedAt).toLocaleDateString() : '—'}</span> },
  ]

  return (
    <div>
      <PageHeader
        crumb="Workspace / Experiments"
        title="Every experiment, pre-registered and tracked."
        subtitle="Compare configs, cadences, and accounts side by side — never a composite score, always the real sample size."
      />

      {state.status === 'loading' ? <LoadingState message="Loading experiments…" /> : null}
      {state.status === 'error' ? <ErrorState title="Could not load experiments" description={state.message} onRetry={refresh} /> : null}
      {state.status === 'ready' && state.data.length === 0 ? (
        <EmptyState title="No experiments yet" description="Experiments are seeded directly against the database today — none exist for this project yet." />
      ) : null}
      {state.status === 'ready' && state.data.length > 0 ? (
        <GlassCard className="p-0">
          <DataTable columns={columns} rows={state.data} keyFor={(e) => e.id} onRowClick={(e) => navigate(`/experiments/${e.id}`)} />
        </GlassCard>
      ) : null}
    </div>
  )
}
