import { useCallback } from 'react'
import { useNow } from '@/hooks/use-now'
import { formatUsd, formatAgo } from '@/format'
import { PageHeader } from '../shell/page-header'
import { GlassCard, GlassCardHeader } from '../ui/glass-card'
import { LoadingState, ErrorState } from '../ui/states'
import { DataTable, type Column } from '../ui/data-table'
import { Badge } from '../ui/badge'
import { usePoll } from '../data/use-poll'
import { loadPositionsData, type PositionRow, type TradeRow } from '../data/positions'
import { CLOSE_REASON_LABEL, CLOSE_REASON_VARIANT } from '../data/display'

export function PositionsPage({ portfolioId }: { portfolioId?: string }) {
  const loader = useCallback(() => loadPositionsData(portfolioId), [portfolioId])
  const { state, refresh } = usePoll(loader)
  const now = useNow()

  if (state.status === 'loading') return <LoadingState message="Loading positions & trades…" />
  if (state.status === 'error') return <ErrorState title="Could not load positions" description={state.message} onRetry={refresh} />

  const { positions, trades } = state.data
  const open = positions.filter((p) => p.status === 'open')
  const closed = positions.filter((p) => p.status === 'closed')

  const rColumns = (p: PositionRow) => {
    if (p.latestPositionPnlR === null && p.latestPriceR === null) return <span className="text-w-faint">—</span>
    return (
      <span className="wt-body-sm text-w-muted">
        {p.latestPriceR !== null ? `priceR ${p.latestPriceR.toFixed(2)}` : '—'}
        {' · '}
        {p.latestPositionPnlR !== null ? `pnlR ${p.latestPositionPnlR.toFixed(2)}` : '—'}
      </span>
    )
  }

  const trackingCell = (p: PositionRow) => {
    if (!p.highWaterTrackedFrom) return <span className="text-w-faint">not tracked — permanently ineligible</span>
    if (p.givebackFloorR === null) return <span className="text-w-muted">tracked, not armed</span>
    return <span className="text-w-accent">armed at {p.givebackFloorR.toFixed(2)}R</span>
  }

  const openColumns: Column<PositionRow>[] = [
    { header: 'Asset', render: (p) => <span className="wt-num text-w-text">{p.asset}</span> },
    { header: 'Side', render: (p) => <Badge variant={p.direction === 'long' ? 'pos' : 'neg'}>{p.direction.toUpperCase()}</Badge> },
    { header: 'Qty', render: (p) => <span className="tabular">{p.quantity}</span>, align: 'right' },
    { header: 'Entry', render: (p) => <span className="tabular">{formatUsd(p.entryPrice)}</span>, align: 'right' },
    { header: 'Stop', render: (p) => <span className="tabular text-w-neg">{formatUsd(p.stopLossPrice)}</span>, align: 'right' },
    { header: 'Target', render: (p) => <span className="tabular text-w-pos">{formatUsd(p.takeProfitPrice)}</span>, align: 'right' },
    { header: 'Opened', render: (p) => <span className="text-w-muted">{formatAgo(p.openedAt, now)}</span> },
    { header: 'Profile', render: (p) => <span className="text-w-muted">{p.openedUnderStrategyProfile ?? '—'}</span> },
    { header: 'R metrics', render: rColumns },
    { header: 'Giveback floor', render: trackingCell },
  ]

  const closedColumns: Column<PositionRow>[] = [
    { header: 'Asset', render: (p) => <span className="wt-num text-w-text">{p.asset}</span> },
    { header: 'Side', render: (p) => <Badge variant={p.direction === 'long' ? 'pos' : 'neg'}>{p.direction.toUpperCase()}</Badge> },
    {
      header: 'Realized P&L',
      render: (p) => (
        <span className={`tabular ${p.realizedPnl !== null && p.realizedPnl >= 0 ? 'text-w-pos' : 'text-w-neg'}`}>
          {p.realizedPnl !== null ? `${p.realizedPnl >= 0 ? '+' : ''}${formatUsd(p.realizedPnl)}` : '—'}
        </span>
      ),
      align: 'right',
    },
    {
      header: 'Close reason',
      render: (p) => (p.closeReason ? <Badge variant={CLOSE_REASON_VARIANT[p.closeReason]}>{CLOSE_REASON_LABEL[p.closeReason]}</Badge> : '—'),
    },
    { header: 'Closed', render: (p) => <span className="text-w-muted">{p.closedAt ? formatAgo(p.closedAt, now) : '—'}</span> },
  ]

  const tradeColumns: Column<TradeRow>[] = [
    { header: 'Time', render: (t) => <span className="text-w-muted">{formatAgo(t.executedAt, now)}</span> },
    { header: 'Asset', render: (t) => <span className="wt-num text-w-text">{t.asset}</span> },
    { header: 'Intent', render: (t) => <span className="wt-body-sm text-w-text">{t.intent}</span> },
    { header: 'Qty', render: (t) => <span className="tabular">{t.quantity}</span>, align: 'right' },
    { header: 'Reference', render: (t) => <span className="tabular text-w-muted">{formatUsd(t.referencePrice)}</span>, align: 'right' },
    { header: 'Fill', render: (t) => <span className="tabular">{formatUsd(t.fillPrice)}</span>, align: 'right' },
    { header: 'Fee', render: (t) => <span className="tabular text-w-muted">{formatUsd(t.fee)}</span>, align: 'right' },
    {
      header: 'Funding',
      render: (t) => <span className="tabular text-w-muted">{t.fundingCost > 0 ? formatUsd(t.fundingCost) : '—'}</span>,
      align: 'right',
    },
    {
      header: 'Realized P&L',
      render: (t) =>
        t.realizedPnl !== null ? (
          <span className={`tabular ${t.realizedPnl >= 0 ? 'text-w-pos' : 'text-w-neg'}`}>
            {t.realizedPnl >= 0 ? '+' : ''}
            {formatUsd(t.realizedPnl)}
          </span>
        ) : (
          <span className="text-w-faint">—</span>
        ),
      align: 'right',
    },
    { header: 'Reason', render: (t) => <span className="text-w-muted">{t.triggerReason ?? 'agent decision'}</span> },
  ]

  return (
    <div>
      <PageHeader crumb="Workspace / Positions & Trades" title="What the agent is holding." subtitle="Every position and every fill, in full." />

      <GlassCard className="mb-6">
        <GlassCardHeader eyebrow="Live" title={`Open positions (${open.length})`} />
        {open.length === 0 ? (
          <p className="wt-body-sm text-w-muted">No open positions right now.</p>
        ) : (
          <DataTable columns={openColumns} rows={open} keyFor={(p) => p.id} />
        )}
      </GlassCard>

      <GlassCard className="mb-6">
        <GlassCardHeader eyebrow="History" title={`Closed positions (${closed.length})`} />
        {closed.length === 0 ? (
          <p className="wt-body-sm text-w-muted">No positions have closed yet.</p>
        ) : (
          <DataTable columns={closedColumns} rows={closed} keyFor={(p) => p.id} />
        )}
      </GlassCard>

      <GlassCard>
        <GlassCardHeader eyebrow="Ledger" title={`Trades (${trades.length})`} />
        {trades.length === 0 ? (
          <p className="wt-body-sm text-w-muted">No trades have executed yet.</p>
        ) : (
          <DataTable columns={tradeColumns} rows={trades} keyFor={(t) => t.id} />
        )}
      </GlassCard>
    </div>
  )
}
