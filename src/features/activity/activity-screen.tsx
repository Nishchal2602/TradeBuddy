import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Brain, ShieldAlert, SkipForward, XCircle, ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingState } from '@/components/states/loading-state'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { ACTION_LABEL, ACTION_BADGE_VARIANT, RISK_STATUS_LABEL, RISK_STATUS_BADGE_VARIANT, CLOSE_REASON_LABEL, CLOSE_REASON_BADGE_VARIANT } from '@/features/decisions/display'
import { formatUsd, formatAgo } from '@/features/home/format'
import { useActivityData } from './use-activity-data'
import type { ActivityEvent, DecisionEvent, AutomaticCloseEvent, RunIssueEvent } from './queries'

export interface ActivityScreenProps {
  onSelectDecision?: (decisionId: string) => void
}

export function ActivityScreen({ onSelectDecision }: ActivityScreenProps) {
  const state = useActivityData()

  if (state.status === 'loading') return <LoadingState message="Loading activity…" />
  if (state.status === 'error') return <ErrorState title="Could not load activity" description={state.message} onRetry={state.refresh} />
  if (state.events.length === 0) return <EmptyState title="No activity yet" description="Decisions, trades, and any skipped or failed cycles will appear here." />

  return <ActivityContent events={state.events} onSelectDecision={onSelectDecision} />
}

function ActivityContent({ events, onSelectDecision }: { events: ActivityEvent[]; onSelectDecision?: (decisionId: string) => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex flex-col gap-2 p-3">
      {events.map((event) => {
        switch (event.kind) {
          case 'decision':
            return <DecisionEventCard key={`decision-${event.decisionId}`} event={event} now={now} onSelectDecision={onSelectDecision} />
          case 'automatic_close':
            return <AutomaticCloseEventCard key={`auto-${event.tradeId}`} event={event} now={now} />
          case 'run_issue':
            return <RunIssueEventCard key={`run-${event.runId}`} event={event} now={now} />
        }
      })}
    </div>
  )
}

function EventRow({ icon, title, badge, timestamp, now, children, footer }: {
  icon: ReactNode
  title: ReactNode
  badge?: ReactNode
  timestamp: string
  now: number
  children?: ReactNode
  footer?: ReactNode
}) {
  return (
    <Card className="gap-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {icon}
          {title}
          {badge}
        </div>
        <span className="type-label-xs text-text-muted">{formatAgo(timestamp, now)}</span>
      </div>
      {children}
      {footer}
    </Card>
  )
}

function DecisionEventCard({ event, now, onSelectDecision }: { event: DecisionEvent; now: number; onSelectDecision?: (decisionId: string) => void }) {
  const isRejectedOrClamped = event.riskStatus === 'rejected' || event.riskStatus === 'clamped'
  return (
    <EventRow
      icon={<Brain className="h-4 w-4 shrink-0 text-accent-primary" aria-hidden="true" />}
      title={<span className="type-headline-sm text-text-primary">{event.asset}</span>}
      badge={<Badge variant={ACTION_BADGE_VARIANT[event.action]}>{ACTION_LABEL[event.action]}</Badge>}
      timestamp={event.timestamp}
      now={now}
      footer={
        <div className="flex items-center justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="accent">{Math.round(event.confidence * 100)}% conf.</Badge>
            {isRejectedOrClamped ? <Badge variant={RISK_STATUS_BADGE_VARIANT[event.riskStatus]}>{RISK_STATUS_LABEL[event.riskStatus]}</Badge> : null}
            {event.executedTrade ? (
              <span className="type-data-sm text-text-secondary">
                filled {formatUsd(event.executedTrade.fillPrice)}
                {event.executedTrade.realizedPnl !== null ? (
                  <span className={event.executedTrade.realizedPnl >= 0 ? 'ml-1 font-semibold text-state-success' : 'ml-1 font-semibold text-state-error'}>
                    {event.executedTrade.realizedPnl >= 0 ? '+' : ''}
                    {formatUsd(event.executedTrade.realizedPnl)}
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
          {onSelectDecision ? (
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onSelectDecision(event.decisionId)} aria-label="View decision detail">
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      }
    >
      {isRejectedOrClamped && event.riskReason ? <p className="type-body-sm text-text-secondary">{event.riskReason}</p> : null}
    </EventRow>
  )
}

function AutomaticCloseEventCard({ event, now }: { event: AutomaticCloseEvent; now: number }) {
  return (
    <EventRow
      icon={<ShieldAlert className="h-4 w-4 shrink-0 text-accent-primary" aria-hidden="true" />}
      title={<span className="type-headline-sm text-text-primary">{event.asset}</span>}
      badge={<Badge variant={CLOSE_REASON_BADGE_VARIANT[event.triggerReason]}>{CLOSE_REASON_LABEL[event.triggerReason]}</Badge>}
      timestamp={event.timestamp}
      now={now}
      footer={
        <div className="flex items-center gap-1.5">
          <span className="type-body-sm text-text-secondary">
            {event.direction ? (event.direction === 'long' ? 'Long' : 'Short') : 'Position'} closed automatically at {formatUsd(event.fillPrice)}
          </span>
          {event.realizedPnl !== null ? (
            <span className={event.realizedPnl >= 0 ? 'type-data-sm font-semibold text-state-success' : 'type-data-sm font-semibold text-state-error'}>
              {event.realizedPnl >= 0 ? '+' : ''}
              {formatUsd(event.realizedPnl)}
            </span>
          ) : null}
        </div>
      }
    />
  )
}

const RUN_KIND_LABEL: Record<RunIssueEvent['runKind'], string> = { decision: 'Decision cycle', monitor: 'Position monitor' }

function RunIssueEventCard({ event, now }: { event: RunIssueEvent; now: number }) {
  const isFailed = event.status === 'failed'
  return (
    <EventRow
      icon={isFailed ? <XCircle className="h-4 w-4 shrink-0 text-state-error" aria-hidden="true" /> : <SkipForward className="h-4 w-4 shrink-0 text-state-warning" aria-hidden="true" />}
      title={<span className="type-headline-sm text-text-primary">{RUN_KIND_LABEL[event.runKind]}</span>}
      badge={<Badge variant={isFailed ? 'error' : 'warning'}>{isFailed ? 'FAILED' : 'SKIPPED'}</Badge>}
      timestamp={event.timestamp}
      now={now}
    >
      <p className="type-body-sm text-text-secondary">{event.reason ?? 'No further detail was recorded.'}</p>
    </EventRow>
  )
}
