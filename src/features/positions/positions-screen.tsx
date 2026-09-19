import { TrendingUp, TrendingDown, ChevronRight } from 'lucide-react'
import { useNow } from '@/hooks/use-now'
import { Card, Panel } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Stat, StatGrid } from '@/components/ui/stat'
import { LoadingState } from '@/components/states/loading-state'
import { ErrorState } from '@/components/states/error-state'
import { CLOSE_REASON_LABEL, CLOSE_REASON_BADGE_VARIANT } from '@/features/decisions/display'
import { formatUsd, formatPct, formatAgo, unrealizedPnl } from '@/format'
import type { AssetSymbol } from '@/shared/market-data/types.ts'
import { usePositionsData } from './use-positions-data'
import type { PositionsViewModel } from './use-positions-data'
import type { AssetPositionSummary, PositionDetail } from './queries'
import type { LatestMarketPrice } from '@/features/market-data/queries'

export interface PositionsScreenProps {
  onSelectDecision?: (decisionId: string) => void
}

export function PositionsScreen({ onSelectDecision }: PositionsScreenProps) {
  const state = usePositionsData()

  if (state.status === 'loading') return <LoadingState message="Loading positions…" />
  if (state.status === 'error') return <ErrorState title="Could not load positions" description={state.message} onRetry={state.refresh} />

  return <PositionsContent data={state.data} onSelectDecision={onSelectDecision} />
}

function PositionsContent({ data, onSelectDecision }: { data: PositionsViewModel; onSelectDecision?: (decisionId: string) => void }) {
  const now = useNow()

  return (
    <div className="flex flex-col gap-2.5 p-3">
      {data.summaries.map((summary) => (
        <AssetCard key={summary.asset} summary={summary} price={data.prices.get(summary.asset)} now={now} onSelectDecision={onSelectDecision} />
      ))}
    </div>
  )
}

function AssetCard({
  summary,
  price,
  now,
  onSelectDecision,
}: {
  summary: AssetPositionSummary
  price: LatestMarketPrice | undefined
  now: number
  onSelectDecision?: (decisionId: string) => void
}) {
  if (summary.open) return <OpenPositionCard position={summary.open} price={price} now={now} onSelectDecision={onSelectDecision} />
  return <FlatAssetCard asset={summary.asset} price={price} lastClosed={summary.lastClosed} now={now} onSelectDecision={onSelectDecision} />
}

function OpenPositionCard({
  position,
  price,
  now,
  onSelectDecision,
}: {
  position: PositionDetail
  price: LatestMarketPrice | undefined
  now: number
  onSelectDecision?: (decisionId: string) => void
}) {
  const current = price?.price ?? position.entryPrice
  const pnl = unrealizedPnl(position.direction, position.entryPrice, current, position.quantity)
  return (
    <Card>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="type-headline-md text-text-primary">{position.asset}</span>
          <Badge variant={position.direction === 'long' ? 'long' : 'short'}>{position.direction === 'long' ? 'OPEN LONG' : 'OPEN SHORT'}</Badge>
        </div>
        <span className={pnl >= 0 ? 'type-data-lg font-semibold text-state-success' : 'type-data-lg font-semibold text-state-error'}>
          {pnl >= 0 ? '+' : ''}
          {formatUsd(pnl)}
        </span>
      </div>
      <Panel className="flex items-center justify-between">
        <Stat label="QUANTITY" value={position.quantity.toFixed(6)} />
        <Stat label="COST BASIS" value={formatUsd(position.costBasis)} />
      </Panel>
      <StatGrid columns={4}>
        <Stat label="ENTRY" value={formatUsd(position.entryPrice)} />
        <Stat label="MARK" value={formatUsd(current)} />
        <Stat label="STOP" value={formatUsd(position.stopLossPrice)} variant="error" />
        <Stat label="TARGET" value={formatUsd(position.takeProfitPrice)} variant="success" />
      </StatGrid>
      <div className="flex items-center justify-between border-t border-border-default pt-2">
        <span className="type-label-xs text-text-muted">Opened {formatAgo(position.openedAt, now)}</span>
        {onSelectDecision && position.openedByDecisionId ? (
          <Button variant="ghost" size="sm" onClick={() => onSelectDecision(position.openedByDecisionId!)}>
            Opening decision
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </Card>
  )
}

function FlatAssetCard({
  asset,
  price,
  lastClosed,
  now,
  onSelectDecision,
}: {
  asset: AssetSymbol
  price: LatestMarketPrice | undefined
  lastClosed: PositionDetail | null
  now: number
  onSelectDecision?: (decisionId: string) => void
}) {
  const change = price?.change24hPct ?? null
  // Prefer the decision that actually closed it (agent-initiated); an
  // automatic exit (stop-loss/take-profit/collateral-exhausted) has no
  // closing decision at all (trading-domain-contract.md §4 — those trades
  // carry a trigger_reason, not a decision_id), so the opening decision is
  // the next most useful thing to link to instead of nothing.
  const linkedDecisionId = lastClosed?.closedByDecisionId ?? lastClosed?.openedByDecisionId ?? null

  return (
    <Card>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="type-headline-md text-text-primary">{asset}</span>
          <Badge variant="flat">FLAT</Badge>
        </div>
        {price ? (
          <div className="flex items-center gap-1.5">
            <span className="type-data-md text-text-primary">{formatUsd(price.price)}</span>
            {change !== null ? (
              <span className={change >= 0 ? 'type-label-xs flex items-center gap-0.5 text-state-success' : 'type-label-xs flex items-center gap-0.5 text-state-error'}>
                {change >= 0 ? <TrendingUp className="h-3 w-3" aria-hidden="true" /> : <TrendingDown className="h-3 w-3" aria-hidden="true" />}
                {formatPct(change, { signed: true })}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="type-label-xs text-text-muted">No price yet</span>
        )}
      </div>

      {lastClosed ? (
        <Panel className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="type-label-xs text-text-muted">LAST POSITION</span>
            {lastClosed.closeReason ? <Badge variant={CLOSE_REASON_BADGE_VARIANT[lastClosed.closeReason]}>{CLOSE_REASON_LABEL[lastClosed.closeReason]}</Badge> : null}
          </div>
          <div className="flex items-center justify-between">
            <span className="type-body-sm text-text-secondary">
              {lastClosed.direction === 'long' ? 'Long' : 'Short'} from {formatUsd(lastClosed.entryPrice)}, closed {lastClosed.closedAt ? formatAgo(lastClosed.closedAt, now) : ''}
            </span>
            {lastClosed.realizedPnl !== null ? (
              <span className={lastClosed.realizedPnl >= 0 ? 'type-data-sm font-semibold text-state-success' : 'type-data-sm font-semibold text-state-error'}>
                {lastClosed.realizedPnl >= 0 ? '+' : ''}
                {formatUsd(lastClosed.realizedPnl)}
              </span>
            ) : null}
          </div>
          {onSelectDecision && linkedDecisionId ? (
            <Button variant="ghost" size="sm" className="justify-between" onClick={() => onSelectDecision(linkedDecisionId)}>
              {lastClosed.closedByDecisionId ? 'Closing decision' : 'Opening decision'}
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </Panel>
      ) : (
        <p className="type-body-sm text-text-muted">No position history yet for {asset}.</p>
      )}
    </Card>
  )
}
