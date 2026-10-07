import { useCallback, useState } from 'react'
import { useNow } from '@/hooks/use-now'
import { formatUsd, formatAgo } from '@/format'
import { PageHeader } from '../shell/page-header'
import { RunAgentButton } from '../shell/run-agent-button'
import { StatRow } from '../ui/stat-row'
import { GlassCard, GlassCardHeader } from '../ui/glass-card'
import { LoadingState, ErrorState } from '../ui/states'
import { DataTable, type Column } from '../ui/data-table'
import { LineChart } from '../ui/line-chart'
import { Badge } from '../ui/badge'
import { usePoll } from '../data/use-poll'
import { loadOverviewData, type OpenPositionRow, type RecentDecisionRow } from '../data/overview'
import { ACTION_LABEL, ACTION_VARIANT, RISK_STATUS_LABEL, RISK_STATUS_VARIANT, modelCallLabel, isShadowCandidate } from '../data/display'
import { hrefFor, navigate } from '../router'
import { unrealizedPnl } from '@/format'

export function OverviewPage({ portfolioId }: { portfolioId?: string }) {
  const loader = useCallback(() => loadOverviewData(portfolioId), [portfolioId])
  const { state, refresh } = usePoll(loader)
  const [chartMode, setChartMode] = useState<'pnl' | 'nav'>('pnl')
  const now = useNow()

  if (state.status === 'loading') return <LoadingState message="Loading your workspace…" />
  if (state.status === 'error') return <ErrorState title="Could not load the overview" description={state.message} onRetry={refresh} />

  const { data } = state

  const positionColumns: Column<OpenPositionRow>[] = [
    { header: 'Asset', render: (p) => <span className="wt-num text-w-text">{p.asset}</span> },
    {
      header: 'Side',
      render: (p) => <Badge variant={p.direction === 'long' ? 'pos' : 'neg'}>{p.direction.toUpperCase()}</Badge>,
    },
    { header: 'Quantity', render: (p) => <span className="tabular">{p.quantity}</span>, align: 'right' },
    { header: 'Entry', render: (p) => <span className="tabular">{formatUsd(p.entryPrice)}</span>, align: 'right' },
    {
      header: 'Mark',
      render: (p) => {
        const quote = data.prices.get(p.asset)
        return <span className="tabular">{quote ? formatUsd(quote.price) : '—'}</span>
      },
      align: 'right',
    },
    {
      header: 'Unrealized P&L',
      render: (p) => {
        const quote = data.prices.get(p.asset)
        if (!quote) return <span className="text-w-muted">—</span>
        const pnl = unrealizedPnl(p.direction, p.entryPrice, quote.price, p.quantity)
        return <span className={`tabular ${pnl >= 0 ? 'text-w-pos' : 'text-w-neg'}`}>{pnl >= 0 ? '+' : ''}{formatUsd(pnl)}</span>
      },
      align: 'right',
    },
  ]

  const decisionColumns: Column<RecentDecisionRow>[] = [
    { header: 'Time', render: (d) => <span className="text-w-muted">{formatAgo(d.decidedAt, now)}</span> },
    { header: 'Asset', render: (d) => <span className="wt-num text-w-text">{d.asset}</span> },
    { header: 'Action', render: (d) => <Badge variant={ACTION_VARIANT[d.action]}>{ACTION_LABEL[d.action]}</Badge> },
    {
      header: 'Type',
      render: (d) =>
        isShadowCandidate(d.decisionType, d.riskStatus) ? (
          <Badge variant="muted">Shadow candidate</Badge>
        ) : d.decisionType === 'management' ? (
          <span className="text-w-muted">Management</span>
        ) : d.decisionType === 'candidate' ? (
          <span className="text-w-muted">Candidate</span>
        ) : (
          <span className="text-w-faint">—</span>
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
  ]

  return (
    <div>
      <PageHeader
        crumb="Workspace / Overview"
        title="Your agent. At a glance."
        subtitle="A measured approach to the market. Here's where things stand."
        right={<RunAgentButton onRan={refresh} portfolioId={portfolioId} />}
      />

      <div className="glass mb-6 flex items-center gap-3 px-5 py-3">
        <span className={`h-2 w-2 rounded-full ${data.isPaused ? 'bg-w-muted' : 'bg-w-accent'}`} />
        <span className="wt-body-sm text-w-text">{data.isPaused ? 'Agent paused' : 'Agent running'}</span>
        <span className="text-w-faint">·</span>
        <span className="wt-body-sm text-w-muted">
          {data.strategyProfile} · {data.decisionIntervalMinutes}-min cadence
        </span>
        {data.lastDecisionRun ? (
          <>
            <span className="text-w-faint">·</span>
            <span className="wt-body-sm text-w-muted">Last cycle {formatAgo(data.lastDecisionRun.startedAt, now)}</span>
          </>
        ) : null}
      </div>

      <StatRow
        items={[
          { label: 'Portfolio value', value: data.nav !== null ? formatUsd(data.nav) : '—' },
          { label: 'Available cash', value: formatUsd(data.cash) },
          { label: 'Open positions', value: String(data.openPositions.length) },
          {
            label: 'Total P&L',
            value: (
              <span className={data.totalPnl !== null && data.totalPnl >= 0 ? 'text-w-pos' : 'text-w-neg'}>
                {data.totalPnl !== null ? `${data.totalPnl >= 0 ? '+' : ''}${formatUsd(data.totalPnl)}` : '—'}
              </span>
            ),
            sublabel: `on ${formatUsd(data.startingCapital)} contributed`,
          },
        ]}
      />

      <GlassCard className="mt-6">
        <GlassCardHeader
          eyebrow="Performance"
          title={chartMode === 'pnl' ? 'Cumulative P&L' : 'Net asset value'}
          right={
            <div className="flex gap-1 rounded-md border border-w-border p-0.5">
              <button
                type="button"
                onClick={() => setChartMode('pnl')}
                className={`wt-label rounded px-2.5 py-1 ${chartMode === 'pnl' ? 'bg-w-accent-dim text-w-accent' : 'text-w-muted'}`}
              >
                P&L
              </button>
              <button
                type="button"
                onClick={() => setChartMode('nav')}
                className={`wt-label rounded px-2.5 py-1 ${chartMode === 'nav' ? 'bg-w-accent-dim text-w-accent' : 'text-w-muted'}`}
              >
                NAV
              </button>
            </div>
          }
        />
        {chartMode === 'pnl' ? (
          <p className="wt-body-sm text-w-muted mb-4">
            Realized + unrealized P&L only — immune to capital added to the budget. This is the honest performance series.
          </p>
        ) : (
          <p className="wt-body-sm text-w-muted mb-4">
            Cash + open positions. Rises on both trading gains AND any capital added to the budget — markers below show contributions.
          </p>
        )}
        <LineChart
          points={chartMode === 'pnl' ? data.pnlSeries : data.navSeries}
          markers={chartMode === 'nav' ? data.capitalMarkers : []}
          formatValue={formatUsd}
          formatTime={(t) => new Date(t).toLocaleString()}
        />
      </GlassCard>

      <GlassCard className="mt-6">
        <GlassCardHeader eyebrow="Portfolio" title="Open positions" />
        {data.openPositions.length === 0 ? (
          <p className="wt-body-sm text-w-muted">No open positions right now.</p>
        ) : (
          <DataTable columns={positionColumns} rows={data.openPositions} keyFor={(p) => p.asset} />
        )}
      </GlassCard>

      <GlassCard className="mt-6">
        <GlassCardHeader
          eyebrow="Audit trail"
          title="Recent decisions"
          right={
            <a href={hrefFor('/decisions', portfolioId)} className="wt-body-sm text-w-accent hover:underline">
              View all →
            </a>
          }
        />
        {data.recentDecisions.length === 0 ? (
          <p className="wt-body-sm text-w-muted">No decisions recorded yet.</p>
        ) : (
          <DataTable
            columns={decisionColumns}
            rows={data.recentDecisions}
            keyFor={(d) => d.id}
            onRowClick={(d) => navigate(`/decisions/${d.id}`, portfolioId)}
          />
        )}
      </GlassCard>
    </div>
  )
}
