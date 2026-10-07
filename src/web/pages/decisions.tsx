import { useCallback, useState } from 'react'
import { useNow } from '@/hooks/use-now'
import { formatAgo } from '@/format'
import { ALL_ASSETS } from '@/shared/market-data/types.ts'
import { PageHeader } from '../shell/page-header'
import { GlassCard } from '../ui/glass-card'
import { LoadingState, ErrorState, EmptyState } from '../ui/states'
import { DataTable, type Column } from '../ui/data-table'
import { Badge } from '../ui/badge'
import { Select } from '../ui/select'
import { usePoll } from '../data/use-poll'
import { loadDecisions, type DecisionListRow } from '../data/decisions'
import { ACTION_LABEL, ACTION_VARIANT, RISK_STATUS_LABEL, RISK_STATUS_VARIANT, modelCallLabel, isShadowCandidate } from '../data/display'
import { navigate } from '../router'

const ASSET_OPTIONS = ['all', ...ALL_ASSETS] as const
const ACTION_OPTIONS = ['all', 'OPEN_LONG', 'OPEN_SHORT', 'HOLD', 'CLOSE', 'ADD', 'REDUCE', 'MODIFY_PROTECTION'] as const
const RISK_OPTIONS = ['all', 'approved', 'clamped', 'rejected', 'not_applicable'] as const
const TYPE_OPTIONS = ['all', 'candidate', 'management', 'unset'] as const

export function DecisionsPage({ portfolioId }: { portfolioId?: string }) {
  const [asset, setAsset] = useState<(typeof ASSET_OPTIONS)[number]>('all')
  const [action, setAction] = useState<(typeof ACTION_OPTIONS)[number]>('all')
  const [riskStatus, setRiskStatus] = useState<(typeof RISK_OPTIONS)[number]>('all')
  const [decisionType, setDecisionType] = useState<(typeof TYPE_OPTIONS)[number]>('all')

  const loader = useCallback(
    () =>
      loadDecisions(
        {
          asset: asset === 'all' ? undefined : asset,
          action: action === 'all' ? undefined : action,
          riskStatus: riskStatus === 'all' ? undefined : riskStatus,
          decisionType: decisionType === 'all' ? undefined : decisionType,
        },
        portfolioId,
      ),
    [asset, action, riskStatus, decisionType, portfolioId],
  )
  const { state, refresh } = usePoll(loader, 30_000)
  const now = useNow()

  const columns: Column<DecisionListRow>[] = [
    { header: 'Time', render: (d) => <span className="text-w-muted">{formatAgo(d.decidedAt, now)}</span> },
    { header: 'Asset', render: (d) => <span className="wt-num text-w-text">{d.asset}</span> },
    { header: 'Action', render: (d) => <Badge variant={ACTION_VARIANT[d.action]}>{ACTION_LABEL[d.action]}</Badge> },
    {
      header: 'Arm / Bias',
      render: (d) =>
        d.armId ? (
          <span className="wt-body-sm text-w-text">
            {d.armId}
            <span className="text-w-muted"> · {d.bias}</span>
          </span>
        ) : (
          <span className="text-w-faint">—</span>
        ),
    },
    {
      header: 'Type',
      render: (d) =>
        isShadowCandidate(d.decisionType, d.riskStatus) ? (
          <Badge variant="muted">Shadow candidate</Badge>
        ) : d.decisionType === 'management' ? (
          <span className="wt-body-sm text-w-muted">Management</span>
        ) : d.decisionType === 'candidate' ? (
          <span className="wt-body-sm text-w-muted">Candidate</span>
        ) : (
          <span title="Pre-2026-10-03 row — decision_type did not exist yet" className="text-w-faint">
            n/a
          </span>
        ),
    },
    { header: 'Risk', render: (d) => <Badge variant={RISK_STATUS_VARIANT[d.riskStatus]}>{RISK_STATUS_LABEL[d.riskStatus]}</Badge> },
    {
      header: 'Model',
      render: (d) => {
        const m = modelCallLabel(d.modelVersion)
        return <Badge variant={m.variant}>{m.label}</Badge>
      },
    },
    {
      header: 'Execution',
      render: (d) => {
        const executed = (d.riskStatus === 'approved' || d.riskStatus === 'clamped') && d.action !== 'HOLD'
        return executed ? (
          <span className="text-w-pos">
            Filled{d.approvedSizePct !== null ? ` · ${(d.approvedSizePct * 100).toFixed(1)}%` : ''}
          </span>
        ) : (
          <span className="text-w-muted">No trade</span>
        )
      },
    },
  ]

  return (
    <div>
      <PageHeader
        crumb="Workspace / Decisions"
        title="Every decision has a reason."
        subtitle="A complete audit trail of what your agent considered, decided, and executed."
      />

      <div className="glass mb-6 flex flex-wrap items-center gap-3 px-5 py-3">
        <Select value={asset} options={ASSET_OPTIONS} onChange={setAsset} labels={{ all: 'All assets' }} />
        <Select value={action} options={ACTION_OPTIONS} onChange={setAction} labels={{ all: 'All actions', ...ACTION_LABEL }} />
        <Select value={riskStatus} options={RISK_OPTIONS} onChange={setRiskStatus} labels={{ all: 'All risk statuses', ...RISK_STATUS_LABEL }} />
        <Select
          value={decisionType}
          options={TYPE_OPTIONS}
          onChange={setDecisionType}
          labels={{ all: 'All types', candidate: 'Candidate (incl. shadows)', management: 'Management', unset: 'Pre-10/03 (unset)' }}
        />
      </div>

      {state.status === 'loading' ? <LoadingState message="Loading decisions…" /> : null}
      {state.status === 'error' ? <ErrorState title="Could not load decisions" description={state.message} onRetry={refresh} /> : null}
      {state.status === 'ready' && state.data.length === 0 ? (
        <EmptyState title="No decisions match these filters" description="Try widening the filters above." />
      ) : null}
      {state.status === 'ready' && state.data.length > 0 ? (
        <GlassCard className="p-0">
          <DataTable
            columns={columns}
            rows={state.data}
            keyFor={(d) => d.id}
            onRowClick={(d) => navigate(`/decisions/${d.id}`, portfolioId)}
          />
        </GlassCard>
      ) : null}
      <p className="wt-body-sm text-w-muted mt-4">
        Select a decision to inspect its reasoning, market inputs, and risk checks. Showing the most recent 100 matching rows.
      </p>
    </div>
  )
}
