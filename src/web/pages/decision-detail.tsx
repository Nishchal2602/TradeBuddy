import { useCallback, type ReactNode } from 'react'
import { formatUsd, formatPct } from '@/format'
import { fetchDecisionById, parseEvidence } from '@/features/decision-detail/queries'
import { PageHeader } from '../shell/page-header'
import { GlassCard, GlassCardHeader } from '../ui/glass-card'
import { LoadingState, ErrorState, EmptyState } from '../ui/states'
import { Badge } from '../ui/badge'
import { DistributionBar } from '../ui/distribution-bar'
import { usePoll } from '../data/use-poll'
import { loadDecisionExtra } from '../data/decision-detail'
import { ACTION_LABEL, ACTION_VARIANT, RISK_STATUS_LABEL, RISK_STATUS_VARIANT, modelCallLabel } from '../data/display'
import { hrefFor } from '../router'

const FAILURE_MODE_LABEL: Record<string, string> = {
  MOMENTUM_EXHAUSTION: 'Momentum exhaustion',
  COUNTER_TREND_PRESSURE: 'Counter-trend pressure',
  WEAK_VOLUME_CONFIRMATION: 'Weak volume confirmation',
  RANGE_COMPRESSION: 'Range compression',
  STRUCTURE_BREAK: 'Structure break',
  NONE: 'No material vulnerability',
}

const JEV_VETO_THRESHOLD = 0.7

async function loadCombined(decisionId: string) {
  const [base, extra] = await Promise.all([fetchDecisionById(decisionId), loadDecisionExtra(decisionId)])
  return { base, extra }
}

export function DecisionDetailPage({ decisionId, portfolioId }: { decisionId: string; portfolioId?: string }) {
  const loader = useCallback(() => loadCombined(decisionId), [decisionId])
  const { state, refresh } = usePoll(loader, 60_000)

  if (state.status === 'loading') return <LoadingState message="Loading decision…" />
  if (state.status === 'error') return <ErrorState title="Could not load this decision" description={state.message} onRetry={refresh} />

  const { base, extra } = state.data
  if (!base) return <EmptyState title="Decision not found" description="It may have been from a different portfolio, or the id is wrong." />

  const evidence = parseEvidence(base.inputPayload, base.asset)
  const isShadow = extra?.decisionType === 'candidate' && base.riskStatus === 'rejected' && extra?.armId
  const model = modelCallLabel(base.modelVersion)
  const mismatchedAccount = extra && portfolioId && extra.portfolioId !== portfolioId

  return (
    <div>
      <a href={hrefFor('/decisions', portfolioId)} className="wt-body-sm text-w-muted hover:text-w-text mb-6 inline-block">
        ← Back to decisions
      </a>

      {mismatchedAccount ? (
        <div className="wt-body-sm glass border-w-neg/30 text-w-neg mb-6 px-5 py-3">
          This decision belongs to a different account than the one you&apos;re viewing.{' '}
          <a href={hrefFor(`/decisions/${base.id}`, extra.portfolioId)} className="underline">
            View it in its own account →
          </a>
        </div>
      ) : null}

      <PageHeader
        crumb={`Workspace / Decisions / ${base.asset}`}
        title={`${ACTION_LABEL[base.action]} · ${base.asset}`}
        subtitle={new Date(base.decidedAt).toLocaleString()}
        right={
          <div className="flex flex-col items-end gap-2">
            <Badge variant={ACTION_VARIANT[base.action]}>{ACTION_LABEL[base.action]}</Badge>
            {isShadow ? <Badge variant="muted">Shadow candidate — counterfactual only, never sent to the model</Badge> : null}
          </div>
        }
      />

      {isShadow ? (
        <div className="wt-body-sm glass border-w-border-soft text-w-muted mb-6 px-5 py-3">
          This asset already held an open position when the six-arm detector fired here too. The row is deterministically
          gate-rejected (&quot;position already open&quot;) and intentionally asks the model nothing — it exists purely to measure
          what the one-position-per-asset rule costs, for the reward loop.
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <GlassCard>
          <GlassCardHeader eyebrow="Deterministic" title="Strategy & risk gate" />
          <dl className="flex flex-col gap-3">
            <Row label="Strategy version">{extra?.strategyVersion ?? '—'}</Row>
            {extra?.armId ? (
              <Row label="Arm / Bias">
                {extra.armId} <span className="text-w-muted">· {extra.bias}</span>
              </Row>
            ) : null}
            <Row label="Risk status">
              <Badge variant={RISK_STATUS_VARIANT[base.riskStatus]}>{RISK_STATUS_LABEL[base.riskStatus]}</Badge>
            </Row>
            {base.riskReason ? <Row label="Reason">{base.riskReason}</Row> : null}
            {base.proposedStopLossPct !== null ? <Row label="Stop-loss (proposed)">{formatPct(base.proposedStopLossPct * 100)}</Row> : null}
            {base.proposedTakeProfitPct !== null ? <Row label="Take-profit (proposed)">{formatPct(base.proposedTakeProfitPct * 100)}</Row> : null}
            {base.computedStopLossPrice !== null ? <Row label="Stop-loss (price)">{formatUsd(base.computedStopLossPrice)}</Row> : null}
            {base.computedTakeProfitPrice !== null ? <Row label="Take-profit (price)">{formatUsd(base.computedTakeProfitPrice)}</Row> : null}
            {base.approvedSizePct !== null ? <Row label="Approved size">{formatPct(base.approvedSizePct * 100)}</Row> : null}
            <Row label="Sizing caps (effective)">
              <span className="text-w-muted">
                single-trade {formatPct(base.effectiveSingleTradeCapPct * 100)} · asset {formatPct(base.effectiveAssetExposureCapPct * 100)} ·
                {extra ? ` total-notional ${formatPct(extra.effectiveMaxTotalNotionalPct * 100)}` : ''}
              </span>
            </Row>
            {base.sizeCapApplied ? (
              <Row label="Cap that bound">
                <Badge variant="accent">{base.sizeCapApplied}</Badge>
              </Row>
            ) : null}
            {extra && (extra.priceR !== null || extra.positionPnlR !== null) ? (
              <Row label="R metrics">
                <span className="text-w-muted">
                  {extra.priceR !== null ? `priceR ${extra.priceR.toFixed(2)}` : null}
                  {extra.priceR !== null && extra.positionPnlR !== null ? ' · ' : ''}
                  {extra.positionPnlR !== null ? `positionPnlR ${extra.positionPnlR.toFixed(2)}` : null}
                </span>
                <span className="wt-label text-w-faint ml-2">(two separate metrics — never one &quot;R&quot;)</span>
              </Row>
            ) : null}
          </dl>
        </GlassCard>

        <GlassCard>
          <GlassCardHeader eyebrow="Model" title="Jev — blocking layer" />
          {extra?.jevNewsVetoProbability !== null && extra?.jevNewsVetoProbability !== undefined ? (
            <div>
              <div className="wt-body-sm text-w-muted mb-2">
                News veto probability (<code className="wt-num">noul</code>) — blocks the trade at or above the threshold below.
              </div>
              <div className="flex items-center gap-3">
                <div className="wt-stat tabular text-w-text">{extra.jevNewsVetoProbability.toFixed(2)}</div>
                <div className="wt-body-sm text-w-muted">
                  vs. <span className="text-w-accent">{JEV_VETO_THRESHOLD.toFixed(2)}</span> threshold
                  <span className="wt-label text-w-faint block">provisional — not yet validated against any evaluation study</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="wt-body-sm text-w-muted">
              No veto question was asked this cycle (<Badge variant={model.variant}>{model.label}</Badge>).
            </div>
          )}
          {extra?.vetoPromptVersion ? <div className="wt-label text-w-faint mt-3">prompt {extra.vetoPromptVersion}</div> : null}
        </GlassCard>

        {extra?.entryQuality || extra?.failureRisk ? (
          <GlassCard className="lg:col-span-2">
            <GlassCardHeader
              eyebrow="Model"
              title="Jev — advisory layers"
              right={
                extra.entryGateMode ? (
                  <Badge variant={extra.entryGateMode === 'blocking' ? 'neg' : 'muted'}>
                    {extra.entryGateMode === 'blocking' ? 'Blocking for this profile' : 'Advisory — recorded, never suppresses the trade'}
                  </Badge>
                ) : undefined
              }
            />
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {extra.entryQualityDistribution ? (
                <div>
                  <div className="wt-label text-w-muted mb-2">
                    Entry quality — chose <span className="text-w-accent">{extra.entryQuality}</span>
                    {extra.entryQualityConfidence !== null ? ` (${(extra.entryQualityConfidence * 100).toFixed(0)}% confidence)` : ''}
                  </div>
                  <DistributionBar distribution={extra.entryQualityDistribution} chosen={extra.entryQuality} />
                </div>
              ) : null}
              {extra.expectedMovePct !== null ? (
                <div>
                  <div className="wt-label text-w-muted mb-2">Expected move ({extra.expectedMoveHorizonMinutes}min horizon)</div>
                  <div className="wt-stat tabular text-w-text">{formatPct(extra.expectedMovePct * 100)}</div>
                </div>
              ) : null}
              {extra.failureRiskDistribution ? (
                <div>
                  <div className="wt-label text-w-muted mb-2">
                    Failure risk — chose <span className="text-w-accent">{extra.failureRisk}</span>
                  </div>
                  <DistributionBar distribution={extra.failureRiskDistribution} chosen={extra.failureRisk} />
                </div>
              ) : null}
              {extra.failureModeDistribution ? (
                <div>
                  <div className="wt-label text-w-muted mb-2">
                    Failure mode — chose <span className="text-w-accent">{FAILURE_MODE_LABEL[extra.failureMode ?? ''] ?? extra.failureMode}</span>
                    {extra.failureMode === 'NONE' ? (
                      <span className="wt-label text-w-faint block">means only &quot;no specific vulnerability visible&quot; — not unsure, not a non-match</span>
                    ) : null}
                  </div>
                  <DistributionBar distribution={extra.failureModeDistribution} chosen={extra.failureMode} labels={FAILURE_MODE_LABEL} />
                </div>
              ) : null}
            </div>
          </GlassCard>
        ) : null}

        <GlassCard>
          <GlassCardHeader eyebrow="Evidence" title="Technical indicators" />
          {evidence.indicators ? (
            <dl className="grid grid-cols-2 gap-3">
              {Object.entries(evidence.indicators).map(([k, v]) => (
                <Row key={k} label={k}>
                  <span className="tabular">{typeof v === 'number' ? v.toFixed(2) : String(v)}</span>
                </Row>
              ))}
            </dl>
          ) : (
            <p className="wt-body-sm text-w-muted">No indicator snapshot available for this row.</p>
          )}
        </GlassCard>

        <GlassCard>
          <GlassCardHeader eyebrow="Evidence" title="News considered" />
          {evidence.news.length === 0 ? (
            <p className="wt-body-sm text-w-muted">No news items were in scope for this cycle.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {evidence.news.map((n) => (
                <li key={n.id} className="border-b border-w-border-soft pb-3 last:border-b-0">
                  <div className="wt-body-sm text-w-text">{n.headline}</div>
                  <div className="wt-label text-w-faint mt-1">
                    {n.source} · {Math.round(n.ageMinutes)}m old
                  </div>
                </li>
              ))}
            </ul>
          )}
        </GlassCard>

        <GlassCard className="lg:col-span-2">
          <GlassCardHeader eyebrow="Reasoning" title="Reasons & invalidation" />
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div>
              <div className="wt-label text-w-muted mb-2">Reasons</div>
              {base.reasons.length === 0 ? (
                <p className="wt-body-sm text-w-muted">None recorded.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {base.reasons.map((r, i) => (
                    <li key={i} className="wt-body-sm text-w-text">
                      <Badge variant="muted">{r.type}</Badge> {r.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="wt-label text-w-muted mb-2">Invalidation — the model's thesis, distinct from the stop-loss above</div>
              {base.invalidation.length === 0 ? (
                <p className="wt-body-sm text-w-muted">None recorded.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {base.invalidation.map((c, i) => (
                    <li key={i} className="wt-body-sm text-w-text">
                      {c.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </GlassCard>

        <GlassCard className="lg:col-span-2">
          <GlassCardHeader eyebrow="Provenance" title="Metadata" />
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Row label="Run">{base.runId.slice(0, 8)}</Row>
            <Row label="Prompt version">{base.promptVersion}</Row>
            <Row label="Model">{model.label}</Row>
            {extra?.entryPromptVersion ? <Row label="Entry prompt">{extra.entryPromptVersion}</Row> : null}
            {extra?.adversarialPromptVersion ? <Row label="Adversarial prompt">{extra.adversarialPromptVersion}</Row> : null}
            {extra?.jevCaseId ? <Row label="Case id">{extra.jevCaseId.slice(0, 12)}</Row> : null}
          </dl>
        </GlassCard>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="wt-label text-w-muted">{label}</dt>
      <dd className="wt-body-sm text-w-text mt-0.5">{children}</dd>
    </div>
  )
}
