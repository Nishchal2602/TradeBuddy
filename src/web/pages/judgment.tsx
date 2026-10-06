import { PageHeader } from '../shell/page-header'
import { GlassCard, GlassCardHeader } from '../ui/glass-card'
import { LoadingState, ErrorState } from '../ui/states'
import { Badge } from '../ui/badge'
import { DistributionBar } from '../ui/distribution-bar'
import { NDisclosure } from '../ui/n-disclosure'
import { usePoll } from '../data/use-poll'
import { loadJudgmentData, JEV_VETO_THRESHOLD, type JudgmentCase } from '../data/judgment'
import { hrefFor } from '../router'

const FAILURE_MODE_LABEL: Record<string, string> = {
  MOMENTUM_EXHAUSTION: 'Momentum exhaustion',
  COUNTER_TREND_PRESSURE: 'Counter-trend pressure',
  WEAK_VOLUME_CONFIRMATION: 'Weak volume confirmation',
  RANGE_COMPRESSION: 'Range compression',
  STRUCTURE_BREAK: 'Structure break',
  NONE: 'No material vulnerability',
}

function CaseCard({ c }: { c: JudgmentCase }) {
  return (
    <GlassCard>
      <GlassCardHeader
        eyebrow={new Date(c.decidedAt).toLocaleString()}
        title={
          <a href={hrefFor(`/decisions/${c.id}`)} className="hover:text-w-accent">
            {c.asset} · {c.action}
          </a>
        }
        right={
          c.entryGateMode ? (
            <Badge variant={c.entryGateMode === 'blocking' ? 'neg' : 'muted'}>
              {c.entryGateMode === 'blocking' ? 'Blocking' : 'Advisory'}
            </Badge>
          ) : undefined
        }
      />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <div>
          <div className="wt-label text-w-muted mb-2">News veto (blocking)</div>
          {c.jevNewsVetoProbability !== null ? (
            <div>
              <div className="wt-stat tabular text-w-text">{c.jevNewsVetoProbability.toFixed(2)}</div>
              <div className="wt-label text-w-faint">vs {JEV_VETO_THRESHOLD.toFixed(2)} threshold (provisional)</div>
            </div>
          ) : (
            <span className="text-w-faint">—</span>
          )}
        </div>
        <div>
          <div className="wt-label text-w-muted mb-2">
            Entry quality — <span className="text-w-accent">{c.entryQuality ?? '—'}</span>
          </div>
          {c.entryQualityDistribution ? <DistributionBar distribution={c.entryQualityDistribution} chosen={c.entryQuality} /> : <span className="text-w-faint">—</span>}
        </div>
        <div>
          <div className="wt-label text-w-muted mb-2">
            Failure risk — <span className="text-w-accent">{c.failureRisk ?? '—'}</span>
          </div>
          {c.failureRiskDistribution ? <DistributionBar distribution={c.failureRiskDistribution} chosen={c.failureRisk} /> : <span className="text-w-faint">—</span>}
        </div>
      </div>
      {c.failureModeDistribution ? (
        <div className="mt-6">
          <div className="wt-label text-w-muted mb-2">
            Failure mode — <span className="text-w-accent">{FAILURE_MODE_LABEL[c.failureMode ?? ''] ?? c.failureMode}</span>
          </div>
          <DistributionBar distribution={c.failureModeDistribution} chosen={c.failureMode} labels={FAILURE_MODE_LABEL} />
        </div>
      ) : null}
    </GlassCard>
  )
}

export function JudgmentPage() {
  const { state, refresh } = usePoll(loadJudgmentData)

  if (state.status === 'loading') return <LoadingState message="Loading AI judgment data…" />
  if (state.status === 'error') return <ErrorState title="Could not load judgment data" description={state.message} onRetry={refresh} />

  const { data } = state

  return (
    <div>
      <PageHeader
        crumb="Workspace / AI Judgment"
        title="What Jev actually says."
        subtitle="Every model-produced judgment, shown with its real sample size — not blended into one confidence score."
      />

      <div className="mb-6 flex flex-col gap-2">
        <NDisclosure n={data.totalRealJevCalls} label="total genuine Jev calls across the project's history (veto + management questions)." />
        <NDisclosure n={data.totalVetoVerdicts} label={`news-veto verdicts recorded (${data.vetoAllowCount} allowed, ${data.totalVetoVerdicts - data.vetoAllowCount} vetoed).`} />
        <NDisclosure n={data.cases.length} label="candidates carrying the full advisory layer set (entry quality + failure risk/mode) — this system's thinnest data." />
      </div>

      <div className="wt-body-sm glass border-w-border-soft text-w-muted mb-6 px-5 py-3">
        No composite score is computed anywhere on this page, by design — a weighted blend of veto/entry/adversarial signals would be
        invented policy ahead of evidence. Each layer is shown on its own terms, with its own distribution.
      </div>

      {data.cases.length === 0 ? (
        <GlassCard>
          <p className="wt-body-sm text-w-muted">No candidate has reached the advisory layers yet.</p>
        </GlassCard>
      ) : (
        <div className="flex flex-col gap-6">
          {data.cases.map((c) => (
            <CaseCard key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  )
}
