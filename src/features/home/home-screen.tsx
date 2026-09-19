import { useState } from 'react'
import { TrendingUp, TrendingDown, Play, Bot, Brain, Clock, ShieldAlert, CircleAlert, Newspaper, ChevronRight } from 'lucide-react'
import { useNow } from '@/hooks/use-now'
import { Card, CardHeader, CardTitle, Panel } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/ui/status-dot'
import { Stat, StatGrid } from '@/components/ui/stat'
import { SectionHeader } from '@/components/ui/section-header'
import { LoadingState } from '@/components/states/loading-state'
import { ErrorState } from '@/components/states/error-state'
import { ACTION_LABEL, ACTION_BADGE_VARIANT, RISK_STATUS_LABEL, RISK_STATUS_BADGE_VARIANT } from '@/features/decisions/display'
import type { AssetSymbol } from '@/shared/market-data/types.ts'
import type { LatestMarketPrice } from '@/features/market-data/queries'
import { useHomeData } from './use-home-data'
import type { HomeViewModel } from './use-home-data'
import type { OpenPositionSummary } from './queries'
import { invokeAgentCycle } from './run-agent'
import type { AgentCycleRunResult } from './run-agent'
import { formatUsd, formatPct, formatAgo, unrealizedPnl } from '@/format'

export interface HomeScreenProps {
  /** UI Step 3: tapping the latest decision pushes the Decision-detail
   * screen. Home has no navigation state of its own — App.tsx owns it,
   * same reasoning as lifting is_paused: Home doesn't need to know what
   * happens after selection, only that it did. */
  onSelectDecision?: (decisionId: string) => void
}

export function HomeScreen({ onSelectDecision }: HomeScreenProps) {
  const state = useHomeData()

  if (state.status === 'loading') return <LoadingState message="Loading portfolio…" />
  if (state.status === 'error') {
    return <ErrorState title="Could not load portfolio" description={state.message} onRetry={state.refresh} />
  }

  return <HomeContent data={state.data} onSelectDecision={onSelectDecision} onRan={state.refresh} />
}

function HomeContent({
  data,
  onSelectDecision,
  onRan,
}: {
  data: HomeViewModel
  onSelectDecision?: (decisionId: string) => void
  onRan: () => void
}) {
  // A 30s-updated "now" rather than a per-second ticking clock — the same
  // interval as the data poll itself (use-home-data.ts), which already
  // keeps this reasonably current; a live-ticking countdown would need
  // its own separate interval for a cosmetic improvement nothing in the
  // brief asked for.
  const now = useNow()

  return (
    <div className="flex flex-col gap-2.5 p-3">
      <PortfolioCard data={data} now={now} />
      <AgentCard data={data} now={now} onRan={onRan} />
      <RunStatusBanner run={data.latestRun} />
      <PositionsCard data={data} now={now} />
      <LatestDecisionCard data={data} now={now} onSelectDecision={onSelectDecision} />
    </div>
  )
}

// --- Portfolio ---------------------------------------------------------

function PortfolioCard({ data, now }: { data: HomeViewModel; now: number }) {
  const { nav } = data
  const pnl = nav?.unrealizedPnl ?? 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <TrendingUp className="h-4 w-4 text-accent-primary" aria-hidden="true" />
          Portfolio
        </CardTitle>
      </CardHeader>

      {nav ? (
        <StatGrid columns={2}>
          <Stat label="NAV" value={formatUsd(nav.nav)} variant="accent" />
          <Stat
            label="Unrealized P&L"
            value={`${pnl >= 0 ? '+' : ''}${formatUsd(pnl)}`}
            sublabel={formatPct((pnl / data.portfolio.startingCapital) * 100, { signed: true })}
            variant={pnl > 0 ? 'success' : pnl < 0 ? 'error' : 'default'}
          />
        </StatGrid>
      ) : (
        <p className="type-body-sm text-text-muted">No cycles have run yet — NAV appears after the first one.</p>
      )}

      <div className="flex items-center justify-between border-t border-border-default pt-2">
        <span className="type-label-xs text-text-muted">
          Cash {formatUsd(data.portfolio.cash)} · Realized P&L {nav ? formatUsd(nav.realizedPnlCum) : formatUsd(0)}
        </span>
        {nav ? (
          <span className="type-label-xs flex items-center gap-1 text-text-muted">
            <Clock className="h-3 w-3" aria-hidden="true" />
            {formatAgo(nav.capturedAt, now)}
          </span>
        ) : null}
      </div>
    </Card>
  )
}

// --- Agent control --------------------------------------------------------

type RunFeedback = { tone: 'success' | 'info' | 'error'; message: string }

function describeRunResult(result: AgentCycleRunResult): RunFeedback {
  switch (result.status) {
    case 'completed': {
      const count = result.decisions.length
      return { tone: 'success', message: `Cycle complete — ${count} decision${count === 1 ? '' : 's'} made.` }
    }
    case 'duplicate_tick':
      // agent-cycle's idempotency key floors to the configured 3-hour
      // decision_interval_minutes bucket regardless of trigger source —
      // a second manual click inside the same window is a real, expected
      // no-op (23505 unique-violation path), not a failure to explain
      // away as an error.
      return { tone: 'info', message: 'Already ran for the current window — try again once it rolls over.' }
    case 'skipped':
      return { tone: 'info', message: result.detail ?? 'Cycle skipped.' }
    case 'failed':
      return { tone: 'error', message: result.detail ?? 'The cycle failed.' }
  }
}

function AgentCard({ data, now, onRan }: { data: HomeViewModel; now: number; onRan: () => void }) {
  const [running, setRunning] = useState(false)
  const [feedback, setFeedback] = useState<RunFeedback | null>(null)

  const handleRun = async () => {
    setRunning(true)
    setFeedback(null)
    try {
      const result = await invokeAgentCycle()
      setFeedback(describeRunResult(result))
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setRunning(false)
      onRan()
    }
  }

  const feedbackClass =
    feedback?.tone === 'error' ? 'type-body-sm text-state-error' : feedback?.tone === 'success' ? 'type-body-sm text-state-success' : 'type-body-sm text-text-secondary'

  return (
    <Card>
      <SectionHeader icon={<Bot className="h-4 w-4 text-accent-primary" aria-hidden="true" />} title="Agent" />

      <StatGrid columns={2}>
        <Stat label="AGENT MODE" value="Manual" />
        <Stat label="LAST AGENT RUN" value={data.latestRun ? formatAgo(data.latestRun.startedAt, now) : 'Never run yet'} />
      </StatGrid>

      <Button variant="primary" size="md" className="w-full" onClick={handleRun} disabled={running}>
        <Play className="h-3.5 w-3.5" aria-hidden="true" />
        {running ? 'Running…' : 'Run agent'}
      </Button>

      {feedback ? (
        <p className={feedbackClass}>{feedback.message}</p>
      ) : (
        <p className="type-body-sm text-text-muted">The agent only decides when you run it — it never trades on its own.</p>
      )}

      <div className="flex items-center justify-between border-t border-border-default pt-2">
        <div className="flex items-center gap-1.5">
          <StatusDot variant="success" pulse />
          <span className="type-label-xs text-text-muted">POSITION MONITOR</span>
        </div>
        <div className="flex items-center gap-1.5">
          {data.latestMonitorRun ? <span className="type-label-xs text-text-muted">{formatAgo(data.latestMonitorRun.startedAt, now)}</span> : null}
          <Badge variant="success">ACTIVE</Badge>
        </div>
      </div>
    </Card>
  )
}

// --- Run status / freshness --------------------------------------------

function RunStatusBanner({ run }: { run: HomeViewModel['latestRun'] }) {
  // Healthy or never-run is not an error — nothing to say. A failed or
  // skipped latest run must stay visible regardless of which tab someone
  // is on (ui-context.md: "Never hide system failures behind an empty
  // UI") rather than only surfacing inside Activity's history.
  if (!run || run.status === 'completed' || run.status === 'running') return null

  const isFailed = run.status === 'failed'
  return (
    <Card className={isFailed ? 'border-state-error/40' : 'border-state-warning/40'}>
      <div className="flex items-start gap-2">
        <ShieldAlert className={isFailed ? 'h-4 w-4 shrink-0 text-state-error' : 'h-4 w-4 shrink-0 text-state-warning'} aria-hidden="true" />
        <div className="flex flex-col gap-0.5">
          <span className={isFailed ? 'type-label-md text-state-error' : 'type-label-md text-state-warning'}>
            {isFailed ? 'Last decision cycle failed' : 'Last decision cycle was skipped'}
          </span>
          <span className="type-body-sm text-text-secondary">{run.errorDetail ?? run.skipReason ?? 'No further detail was recorded.'}</span>
        </div>
      </div>
    </Card>
  )
}

// --- Positions -----------------------------------------------------------

function PositionsCard({ data, now }: { data: HomeViewModel; now: number }) {
  return (
    <Card>
      <SectionHeader icon={<TrendingUp className="h-4 w-4 text-accent-primary" aria-hidden="true" />} title="Positions" count={data.positions.length} />
      <div className="flex flex-col gap-1.5">
        {data.settings.assets.map((asset) => {
          const position = data.positions.find((p) => p.asset === asset)
          const price = data.prices.get(asset)
          return position ? (
            <OpenPositionRow key={asset} position={position} price={price} now={now} />
          ) : (
            <FlatAssetRow key={asset} asset={asset} price={price} />
          )
        })}
      </div>
    </Card>
  )
}

function OpenPositionRow({ position, price, now }: { position: OpenPositionSummary; price: LatestMarketPrice | undefined; now: number }) {
  const current = price?.price ?? position.entryPrice
  const pnl = unrealizedPnl(position.direction, position.entryPrice, current, position.quantity)
  return (
    <Panel className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="type-headline-sm text-text-primary">{position.asset}</span>
          <Badge variant={position.direction === 'long' ? 'long' : 'short'}>{position.direction === 'long' ? 'LONG' : 'SHORT'}</Badge>
        </div>
        <span className={pnl >= 0 ? 'type-data-md font-semibold text-state-success' : 'type-data-md font-semibold text-state-error'}>
          {pnl >= 0 ? '+' : ''}
          {formatUsd(pnl)}
        </span>
      </div>
      <StatGrid columns={4}>
        <Stat label="ENTRY" value={formatUsd(position.entryPrice)} />
        <Stat label="MARK" value={formatUsd(current)} />
        <Stat label="STOP" value={formatUsd(position.stopLossPrice)} variant="error" />
        <Stat label="TARGET" value={formatUsd(position.takeProfitPrice)} variant="success" />
      </StatGrid>
      <span className="type-label-xs text-text-muted">Opened {formatAgo(position.openedAt, now)}</span>
    </Panel>
  )
}

function FlatAssetRow({ asset, price }: { asset: AssetSymbol; price: LatestMarketPrice | undefined }) {
  const change = price?.change24hPct ?? null
  return (
    <Panel className="flex items-center justify-between">
      <div className="flex items-center gap-1.5">
        <span className="type-headline-sm text-text-primary">{asset}</span>
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
    </Panel>
  )
}

// --- Latest decision -----------------------------------------------------

function LatestDecisionCard({ data, now, onSelectDecision }: { data: HomeViewModel; now: number; onSelectDecision?: (decisionId: string) => void }) {
  const decision = data.latestDecision
  if (!decision) {
    return (
      <Card>
        <SectionHeader icon={<Brain className="h-4 w-4 text-accent-primary" aria-hidden="true" />} title="Latest decision" />
        <p className="type-body-sm text-text-muted">No decisions recorded yet.</p>
      </Card>
    )
  }

  const isOpen = decision.action === 'OPEN_LONG' || decision.action === 'OPEN_SHORT'
  const showRisk = decision.riskStatus === 'rejected' || decision.riskStatus === 'clamped'

  return (
    <Card>
      <SectionHeader
        icon={<Brain className="h-4 w-4 text-accent-primary" aria-hidden="true" />}
        title="Latest decision"
        right={<span className="type-label-xs text-text-muted">{formatAgo(decision.decidedAt, now)}</span>}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="type-headline-sm text-text-primary">{decision.asset}</span>
        <Badge variant={ACTION_BADGE_VARIANT[decision.action]}>{ACTION_LABEL[decision.action]}</Badge>
        <Badge variant="accent">{Math.round(decision.confidence * 100)}% conf.</Badge>
        <Badge variant="neutral">{decision.primaryDriver}</Badge>
      </div>

      {decision.reasons.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {decision.reasons.map((reason, i) => {
            const cited = reason.type === 'NEWS' ? data.citedNews.get(reason.newsId) : undefined
            return (
              <li key={i} className="type-body-sm flex items-start gap-1.5 text-text-secondary">
                {reason.type === 'NEWS' ? (
                  <Newspaper className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-primary" aria-hidden="true" />
                ) : (
                  <TrendingUp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
                )}
                <span>
                  {cited ? <span className="text-text-primary">{cited.headline} — </span> : null}
                  {reason.text}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}

      {isOpen && decision.computedStopLossPrice !== null && decision.computedTakeProfitPrice !== null ? (
        <Panel className="grid grid-cols-2 gap-1.5">
          <Stat label="STOP LOSS" value={formatUsd(decision.computedStopLossPrice)} variant="error" />
          <Stat label="TAKE PROFIT" value={formatUsd(decision.computedTakeProfitPrice)} variant="success" />
        </Panel>
      ) : null}

      {decision.invalidation.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <span className="type-label-xs text-text-muted">INVALIDATION (thesis, not the stop-loss)</span>
          <ul className="flex flex-col gap-0.5">
            {decision.invalidation.map((cond, i) => (
              <li key={i} className="type-body-sm text-text-secondary">
                · {cond.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {showRisk ? (
        <div className="flex items-start gap-1.5 rounded-md bg-state-error-subtle p-1.5">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-state-error" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <Badge variant={RISK_STATUS_BADGE_VARIANT[decision.riskStatus]}>{RISK_STATUS_LABEL[decision.riskStatus]}</Badge>
            {decision.riskReason ? <span className="type-body-sm text-text-secondary">{decision.riskReason}</span> : null}
          </div>
        </div>
      ) : null}

      {onSelectDecision ? (
        <Button variant="ghost" size="sm" className="justify-between" onClick={() => onSelectDecision(decision.id)}>
          View full detail
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      ) : null}
    </Card>
  )
}
