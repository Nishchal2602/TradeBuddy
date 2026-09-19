import { useEffect, useState } from 'react'
import { ArrowLeft, Brain, Newspaper, TrendingUp, Activity, Scale, Target, Link2, CalendarClock } from 'lucide-react'
import { Card, Panel } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Stat, StatGrid } from '@/components/ui/stat'
import { SectionHeader } from '@/components/ui/section-header'
import { LoadingState } from '@/components/states/loading-state'
import { ErrorState } from '@/components/states/error-state'
import { ACTION_LABEL, ACTION_BADGE_VARIANT, RISK_STATUS_LABEL, RISK_STATUS_BADGE_VARIANT } from '@/features/decisions/display'
import { formatUsd, formatPct, formatAgo, unrealizedPnl } from '@/features/home/format'
import { useDecisionDetail } from './use-decision-detail'
import type { DecisionDetailViewModel } from './use-decision-detail'
import type { TechnicalIndicators } from './queries'
import type { PositionDetail } from '@/features/positions/queries'

export interface DecisionDetailScreenProps {
  decisionId: string
  onBack: () => void
}

export function DecisionDetailScreen({ decisionId, onBack }: DecisionDetailScreenProps) {
  const state = useDecisionDetail(decisionId)
  // Same reasoning as home-screen.tsx: a controlled, periodically-updated
  // value rather than calling Date.now() directly during render (impure —
  // React may re-invoke a render function without an actual clock tick
  // having occurred, which would make "time ago" labels inconsistent
  // within what should be one logical render).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border-default px-2">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack} aria-label="Back">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <span className="type-headline-sm text-text-primary">Decision detail</span>
      </div>

      {state.status === 'loading' ? <LoadingState message="Loading decision…" /> : null}
      {state.status === 'not-found' ? <ErrorState title="Decision not found" description="It may have been from a different portfolio, or the id is stale." /> : null}
      {state.status === 'error' ? <ErrorState title="Could not load this decision" description={state.message} onRetry={state.refresh} /> : null}
      {state.status === 'ready' ? <DecisionDetailContent data={state.data} now={now} /> : null}
    </div>
  )
}

function DecisionDetailContent({ data, now }: { data: DecisionDetailViewModel; now: number }) {
  const { decision, evidence, citedNews, position, currentPrice } = data
  const isOpenAction = decision.action === 'OPEN_LONG' || decision.action === 'OPEN_SHORT'
  const hasRiskDetail = decision.riskStatus !== 'not_applicable'

  return (
    <div className="flex flex-col gap-2.5 p-3">
      {/* Action / confidence / driver */}
      <Card>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="type-headline-md text-text-primary">{decision.asset}</span>
          <Badge variant={ACTION_BADGE_VARIANT[decision.action]}>{ACTION_LABEL[decision.action]}</Badge>
          <Badge variant="accent">{Math.round(decision.confidence * 100)}% confidence</Badge>
          <Badge variant="neutral">{decision.primaryDriver}</Badge>
        </div>
      </Card>

      {/* Thesis / reasons */}
      <Card>
        <SectionHeader icon={<Brain className="h-4 w-4 text-accent-primary" aria-hidden="true" />} title="Thesis" />
        {decision.reasons.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {decision.reasons.map((reason, i) => {
              const cited = reason.type === 'NEWS' ? citedNews.get(reason.newsId) : undefined
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
        ) : (
          <p className="type-body-sm text-text-muted">No reasons were recorded for this decision.</p>
        )}

        {decision.invalidation.length > 0 ? (
          <div className="flex flex-col gap-0.5 border-t border-border-default pt-2">
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
      </Card>

      {/* Technical evidence */}
      <Card>
        <SectionHeader icon={<Activity className="h-4 w-4 text-accent-primary" aria-hidden="true" />} title="Technical evidence" />
        {evidence.indicators ? <IndicatorGrid indicators={evidence.indicators} /> : <p className="type-body-sm text-text-muted">Not recorded for this decision.</p>}
      </Card>

      {/* News evidence */}
      <Card>
        <SectionHeader icon={<Newspaper className="h-4 w-4 text-accent-primary" aria-hidden="true" />} title="News evidence" count={evidence.news.length} />
        {evidence.news.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {evidence.news.map((item) => (
              <Panel key={item.id} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between">
                  <span className="type-label-xs text-text-muted">{item.source}</span>
                  <span className="type-label-xs text-text-muted">{Math.round(item.ageMinutes)}m before decision</span>
                </div>
                <span className="type-body-sm font-medium text-text-primary">{item.headline}</span>
                {item.summary ? <span className="type-body-sm text-text-secondary">{item.summary}</span> : null}
              </Panel>
            ))}
          </div>
        ) : (
          <p className="type-body-sm text-text-muted">No news was available to the model for this asset at decision time.</p>
        )}
      </Card>

      {/* SL/TP proposal (opens only) */}
      {isOpenAction ? (
        <Card>
          <SectionHeader icon={<Target className="h-4 w-4 text-accent-primary" aria-hidden="true" />} title="Stop-loss / take-profit" />
          <StatGrid columns={2}>
            <Stat
              label="PROPOSED"
              value={decision.proposedStopLossPct !== null ? `SL ${formatPct(decision.proposedStopLossPct * 100)} / TP ${formatPct((decision.proposedTakeProfitPct ?? 0) * 100)}` : '—'}
            />
            <Stat
              label="COMPUTED PRICE"
              value={decision.computedStopLossPrice !== null ? `${formatUsd(decision.computedStopLossPrice)} / ${formatUsd(decision.computedTakeProfitPrice ?? 0)}` : 'Not computed (rejected before sizing)'}
            />
          </StatGrid>
        </Card>
      ) : null}

      {/* Risk gate */}
      {hasRiskDetail ? (
        <Card>
          <SectionHeader icon={<Scale className="h-4 w-4 text-accent-primary" aria-hidden="true" />} title="Risk gate" right={<Badge variant={RISK_STATUS_BADGE_VARIANT[decision.riskStatus]}>{RISK_STATUS_LABEL[decision.riskStatus]}</Badge>} />
          {decision.riskReason ? <p className="type-body-sm text-text-secondary">{decision.riskReason}</p> : null}
          <StatGrid columns={2}>
            <Stat label="MIN CONFIDENCE" value={formatPct(decision.effectiveMinConfidence * 100)} />
            <Stat label="RISK BUDGET" value={formatPct(decision.effectiveRiskBudgetPct * 100)} />
            <Stat label="SINGLE-TRADE CAP" value={formatPct(decision.effectiveSingleTradeCapPct * 100)} />
            <Stat label="ASSET EXPOSURE CAP" value={formatPct(decision.effectiveAssetExposureCapPct * 100)} />
          </StatGrid>
          {decision.approvedSizePct !== null ? (
            <div className="flex items-center justify-between border-t border-border-default pt-2">
              <span className="type-label-xs text-text-muted">APPROVED SIZE</span>
              <span className="type-data-md text-text-primary">
                {formatPct(decision.approvedSizePct * 100)} of NAV{decision.sizeCapApplied ? ` (clamped by ${decision.sizeCapApplied.replace('_', ' ')})` : ''}
              </span>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* Position linkage */}
      {decision.positionId ? <PositionLinkageCard position={position} currentPrice={currentPrice} now={now} /> : null}

      {/* Timestamps / metadata */}
      <Card>
        <SectionHeader icon={<CalendarClock className="h-4 w-4 text-accent-primary" aria-hidden="true" />} title="Metadata" />
        <div className="flex flex-col gap-1">
          <MetaRow label="Decided" value={formatAgo(decision.decidedAt, now)} />
          <MetaRow label="Model" value={decision.modelVersion} />
          <MetaRow label="Prompt version" value={decision.promptVersion} />
          <MetaRow label="Run" value={decision.runId} mono />
        </div>
      </Card>
    </div>
  )
}

function IndicatorGrid({ indicators }: { indicators: TechnicalIndicators }) {
  const entries: { label: string; value: string }[] = []
  if (indicators.rsi14 !== undefined) entries.push({ label: 'RSI (14)', value: indicators.rsi14.toFixed(1) })
  if (indicators.ema20 !== undefined) entries.push({ label: 'EMA 20', value: formatUsd(indicators.ema20) })
  if (indicators.ema50 !== undefined) entries.push({ label: 'EMA 50', value: formatUsd(indicators.ema50) })
  if (indicators.macdHistogram !== undefined) entries.push({ label: 'MACD HIST', value: indicators.macdHistogram.toFixed(2) })
  if (indicators.atrPct !== undefined) entries.push({ label: 'ATR %', value: formatPct(indicators.atrPct) })
  if (indicators.volumeRatio !== undefined) entries.push({ label: 'VOL RATIO', value: `${indicators.volumeRatio.toFixed(2)}×` })
  if (indicators.distanceFromSevenDayHighPct !== undefined) entries.push({ label: '7D HIGH DIST', value: formatPct(indicators.distanceFromSevenDayHighPct, { signed: true }) })
  if (indicators.distanceFromSevenDayLowPct !== undefined) entries.push({ label: '7D LOW DIST', value: formatPct(indicators.distanceFromSevenDayLowPct, { signed: true }) })

  if (entries.length === 0) return <p className="type-body-sm text-text-muted">Not recorded for this decision.</p>

  return (
    <StatGrid columns={2}>
      {entries.map((entry) => (
        <Stat key={entry.label} label={entry.label} value={entry.value} />
      ))}
    </StatGrid>
  )
}

function PositionLinkageCard({ position, currentPrice, now }: { position: PositionDetail | null; currentPrice: number | null; now: number }) {
  return (
    <Card>
      <SectionHeader icon={<Link2 className="h-4 w-4 text-accent-primary" aria-hidden="true" />} title="Linked position" />
      {!position ? (
        <p className="type-body-sm text-text-muted">This decision's position could not be loaded.</p>
      ) : position.status === 'open' ? (
        <>
          <div className="flex items-center justify-between">
            <Badge variant={position.direction === 'long' ? 'long' : 'short'}>{position.direction === 'long' ? 'OPEN LONG' : 'OPEN SHORT'}</Badge>
            {currentPrice !== null ? (
              <span
                className={
                  unrealizedPnl(position.direction, position.entryPrice, currentPrice, position.quantity) >= 0
                    ? 'type-data-md font-semibold text-state-success'
                    : 'type-data-md font-semibold text-state-error'
                }
              >
                {unrealizedPnl(position.direction, position.entryPrice, currentPrice, position.quantity) >= 0 ? '+' : ''}
                {formatUsd(unrealizedPnl(position.direction, position.entryPrice, currentPrice, position.quantity))}
              </span>
            ) : null}
          </div>
          <StatGrid columns={4}>
            <Stat label="ENTRY" value={formatUsd(position.entryPrice)} />
            <Stat label="MARK" value={currentPrice !== null ? formatUsd(currentPrice) : '—'} />
            <Stat label="STOP" value={formatUsd(position.stopLossPrice)} variant="error" />
            <Stat label="TARGET" value={formatUsd(position.takeProfitPrice)} variant="success" />
          </StatGrid>
          <span className="type-label-xs text-text-muted">Opened {formatAgo(position.openedAt, now)}</span>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <Badge variant="flat">CLOSED{position.closeReason ? ` · ${position.closeReason.replace('_', ' ').toUpperCase()}` : ''}</Badge>
            {position.realizedPnl !== null ? (
              <span className={position.realizedPnl >= 0 ? 'type-data-md font-semibold text-state-success' : 'type-data-md font-semibold text-state-error'}>
                {position.realizedPnl >= 0 ? '+' : ''}
                {formatUsd(position.realizedPnl)}
              </span>
            ) : null}
          </div>
          <StatGrid columns={2}>
            <Stat label="ENTRY" value={formatUsd(position.entryPrice)} />
            <Stat label="CLOSED" value={position.closedAt ? formatAgo(position.closedAt, now) : '—'} />
          </StatGrid>
        </>
      )}
    </Card>
  )
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="type-label-xs text-text-muted">{label}</span>
      <span className={mono ? 'type-data-sm truncate text-text-secondary' : 'type-body-sm text-text-secondary'}>{value}</span>
    </div>
  )
}
