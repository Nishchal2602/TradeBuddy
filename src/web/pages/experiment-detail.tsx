import { useCallback, useState } from 'react'
import { useNow } from '@/hooks/use-now'
import { formatUsd, formatAgo } from '@/format'
import { PageHeader } from '../shell/page-header'
import { GlassCard, GlassCardHeader } from '../ui/glass-card'
import { LoadingState, ErrorState, EmptyState } from '../ui/states'
import { DataTable, type Column } from '../ui/data-table'
import { Badge } from '../ui/badge'
import { Select } from '../ui/select'
import { NDisclosure } from '../ui/n-disclosure'
import { MultiSeriesLineChart, type ChartSeries } from '../ui/multi-line-chart'
import { SERIES_PALETTE } from '../ui/chart-utils'
import { usePoll } from '../data/use-poll'
import { loadExperimentDetail, diffConfigs, type VariantRow, type AccountRow, type ExperimentDetailData, type ConfigFieldDiff } from '../data/experiment-detail'
import { loadExperimentPerformance, type AccountNavSeries } from '../data/experiment-performance'
import { loadExperimentDecisionStats, loadExperimentRunStats, type AccountDecisionStats, type ExperimentRunStatsResult } from '../data/experiment-analysis'
import { composeExperimentReport } from '../data/experiment-report'
import { EXPERIMENT_STATUS_LABEL, EXPERIMENT_STATUS_VARIANT, NO_CANDIDATE_REASON_LABEL } from '../data/display'
import { hrefFor } from '../router'

interface CombinedData {
  detail: ExperimentDetailData | null
  performance: AccountNavSeries[]
  decisionStats: AccountDecisionStats[]
  runStats: ExperimentRunStatsResult
}

async function loadCombined(experimentId: string): Promise<CombinedData> {
  const detail = await loadExperimentDetail(experimentId)
  if (!detail) return { detail: null, performance: [], decisionStats: [], runStats: { perAccount: [], recentIssues: [] } }

  const portfolioIds = detail.accounts.map((a) => a.portfolioId)
  const [performance, decisionStats, runStats] = await Promise.all([
    loadExperimentPerformance(detail.accounts.map((a) => ({ portfolioId: a.portfolioId, name: a.name, variantName: a.variantName, startingCapital: a.startingCapital }))),
    loadExperimentDecisionStats(portfolioIds),
    loadExperimentRunStats(portfolioIds),
  ])
  return { detail, performance, decisionStats, runStats }
}

function pickDefaultBaseline(variants: VariantRow[]): string | null {
  const control = variants.find((v) => /control|base/i.test(v.name))
  if (control) return control.id
  const sorted = [...variants].sort((a, b) => a.name.localeCompare(b.name))
  return sorted[0]?.id ?? null
}

export function ExperimentDetailPage({ experimentId }: { experimentId: string }) {
  const loader = useCallback(() => loadCombined(experimentId), [experimentId])
  const { state, refresh } = usePoll(loader, 60_000)
  const now = useNow()
  const [baselineId, setBaselineId] = useState<string | null>(null)
  const [showAllFields, setShowAllFields] = useState(false)

  if (state.status === 'loading') return <LoadingState message="Loading experiment…" />
  if (state.status === 'error') return <ErrorState title="Could not load this experiment" description={state.message} onRetry={refresh} />

  const { detail, performance, decisionStats, runStats } = state.data
  if (!detail) return <EmptyState title="Experiment not found" description="It may have been removed, or the id is wrong." />

  const { header, variants, accounts } = detail
  const resolvedBaselineId = baselineId ?? pickDefaultBaseline(variants)
  const baseline = variants.find((v) => v.id === resolvedBaselineId) ?? variants[0] ?? null

  const decisionsByPortfolio = new Map(decisionStats.map((d) => [d.portfolioId, d]))
  const runsByPortfolio = new Map(runStats.perAccount.map((r) => [r.portfolioId, r]))

  const report = composeExperimentReport(detail, performance, decisionStats, runStats)

  const chartSeries: ChartSeries[] = performance.map((p, i) => ({
    id: p.portfolioId,
    label: p.name,
    color: SERIES_PALETTE[i % SERIES_PALETTE.length] ?? SERIES_PALETTE[0],
    points: p.cumulativePnlSeries,
  }))

  const accountColumns: Column<AccountRow>[] = [
    {
      header: 'Account',
      render: (a) => (
        <a href={hrefFor('/', a.portfolioId)} target="_blank" rel="noopener noreferrer" className="wt-body-sm text-w-accent hover:underline">
          {a.name} ↗
        </a>
      ),
    },
    { header: 'Variant', render: (a) => (a.variantName ? <Badge variant="accent">{a.variantName}</Badge> : <span className="text-w-faint">—</span>) },
    {
      header: 'Starting capital',
      render: (a) => <span className="tabular">{formatUsd(a.startingCapital)}</span>,
      align: 'right',
    },
    { header: 'Cash', render: (a) => <span className="tabular">{formatUsd(a.cash)}</span>, align: 'right' },
  ]

  const variantColumns: Column<VariantRow>[] = [
    { header: 'Variant', render: (v) => <span className="wt-body-sm text-w-text">{v.name}</span> },
    { header: 'Cadence', render: (v) => <span className="tabular">{v.decisionIntervalMinutes} min</span>, align: 'right' },
    { header: 'Assets', render: (v) => <span className="text-w-muted">{v.assets.join(', ')}</span> },
    {
      header: 'Jev',
      render: (v) => (
        <span className="wt-body-sm text-w-muted">
          veto {v.newsVetoEnabled ? 'on' : 'off'} · mgmt {v.managementEnabled ? 'on' : 'off'}
        </span>
      ),
    },
    { header: 'Config', render: (v) => <span className="text-w-muted">{v.configPresetName}</span> },
    {
      header: 'Frozen',
      render: (v) => (v.frozenAt ? <Badge variant="pos">Frozen</Badge> : <Badge variant="muted">Designing</Badge>),
    },
  ]

  return (
    <div>
      <a href={hrefFor('/experiments')} className="wt-body-sm text-w-muted hover:text-w-text mb-6 inline-block">
        ← Back to experiments
      </a>

      <PageHeader
        crumb={`Workspace / Experiments / ${header.name}`}
        title={header.name}
        subtitle={header.hypothesis}
        right={<Badge variant={EXPERIMENT_STATUS_VARIANT[header.status]}>{EXPERIMENT_STATUS_LABEL[header.status]}</Badge>}
      />

      <div className="glass mb-6 flex flex-wrap items-center gap-3 px-5 py-3">
        {header.preRegisteredAt ? <span className="wt-body-sm text-w-muted">Pre-registered {formatAgo(header.preRegisteredAt, now)}</span> : null}
        {header.startedAt ? (
          <>
            <span className="text-w-faint">·</span>
            <span className="wt-body-sm text-w-muted">Started {formatAgo(header.startedAt, now)}</span>
          </>
        ) : null}
        {header.endedAt ? (
          <>
            <span className="text-w-faint">·</span>
            <span className="wt-body-sm text-w-muted">Ended {formatAgo(header.endedAt, now)}</span>
          </>
        ) : null}
      </div>

      <GlassCard className="mb-6 p-0">
        <div className="p-6 pb-0">
          <GlassCardHeader eyebrow="Assignments" title={`Accounts in this experiment (${accounts.length})`} />
        </div>
        {accounts.length === 0 ? (
          <p className="wt-body-sm text-w-muted p-6 pt-0">No accounts assigned yet.</p>
        ) : (
          <DataTable columns={accountColumns} rows={accounts} keyFor={(a) => a.portfolioId} />
        )}
      </GlassCard>

      <GlassCard className="mb-6 p-0">
        <div className="p-6 pb-0">
          <GlassCardHeader eyebrow="Configuration" title={`Variants (${variants.length})`} />
        </div>
        {variants.length === 0 ? (
          <p className="wt-body-sm text-w-muted p-6 pt-0">No variants defined yet.</p>
        ) : (
          <DataTable columns={variantColumns} rows={variants} keyFor={(v) => v.id} />
        )}
      </GlassCard>

      <GlassCard className="mb-6">
        <GlassCardHeader
          eyebrow="Reliability"
          title="Experiment metrics"
          right={
            <span className="wt-body-sm text-w-muted">
              {accounts.length} account{accounts.length === 1 ? '' : 's'} · 1 shared tick per due cadence
            </span>
          }
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {accounts.map((a) => {
            const runs = runsByPortfolio.get(a.portfolioId)
            return (
              <div key={a.portfolioId} className="border-w-border-soft rounded-md border p-4">
                <div className="wt-label text-w-muted mb-1">{a.name}</div>
                <div className="wt-stat tabular text-w-text">{runs?.totalRuns ?? 0}</div>
                <div className="wt-body-sm text-w-muted mt-1">total runs recorded</div>
                {runs?.latestDecisionRun ? (
                  <div className="wt-label text-w-faint mt-2">last decision {formatAgo(runs.latestDecisionRun.startedAt, now)}</div>
                ) : null}
              </div>
            )
          })}
        </div>
      </GlassCard>

      <GlassCard className="mb-6">
        <GlassCardHeader
          eyebrow="Strategy comparison"
          title="What's different from the baseline"
          right={
            variants.length > 0 ? (
              <Select
                value={resolvedBaselineId ?? ''}
                options={variants.map((v) => v.id)}
                onChange={setBaselineId}
                labels={Object.fromEntries(variants.map((v) => [v.id, `vs. ${v.name}`]))}
              />
            ) : undefined
          }
        />
        {!baseline ? (
          <p className="wt-body-sm text-w-muted">No variants to compare.</p>
        ) : (
          <div className="flex flex-col gap-6">
            {variants
              .filter((v) => v.id !== baseline.id)
              .map((v) => {
                const allDiffs = diffConfigs(baseline.config, v.config)
                const differing = allDiffs.filter((d) => d.differs)
                const rows = showAllFields ? allDiffs : differing
                return (
                  <div key={v.id}>
                    <div className="wt-body-sm text-w-text mb-2">
                      <span className="text-w-accent">{v.name}</span> vs <span className="text-w-muted">{baseline.name}</span> —{' '}
                      {differing.length} of {allDiffs.length} fields differ
                    </div>
                    {differing.length === 0 ? (
                      <p className="wt-body-sm text-w-muted">Identical to the baseline.</p>
                    ) : (
                      <DataTable
                        columns={
                          [
                            { header: 'Field', render: (d: ConfigFieldDiff) => <span className="wt-body-sm text-w-text">{d.path}</span> },
                            {
                              header: `${baseline.name} (baseline)`,
                              render: (d: ConfigFieldDiff) => <span className="wt-num tabular text-w-muted">{JSON.stringify(d.baseValue)}</span>,
                            },
                            {
                              header: v.name,
                              render: (d: ConfigFieldDiff) => (
                                <span className={`wt-num tabular ${d.differs ? 'text-w-accent' : 'text-w-muted'}`}>{JSON.stringify(d.variantValue)}</span>
                              ),
                            },
                          ] as Column<ConfigFieldDiff>[]
                        }
                        rows={rows}
                        keyFor={(d) => d.path}
                      />
                    )}
                  </div>
                )
              })}
            <button
              type="button"
              onClick={() => setShowAllFields((s) => !s)}
              className="wt-body-sm self-start text-w-accent hover:underline"
            >
              {showAllFields ? 'Show only differing fields' : 'Show all fields (full auditability)'}
            </button>
          </div>
        )}
      </GlassCard>

      <GlassCard className="mb-6">
        <GlassCardHeader eyebrow="Performance" title="Cumulative P&L, by account" />
        {chartSeries.length === 0 ? (
          <p className="wt-body-sm text-w-muted">No NAV history recorded yet.</p>
        ) : (
          <MultiSeriesLineChart series={chartSeries} formatValue={formatUsd} formatTime={(t) => new Date(t).toLocaleString()} />
        )}
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {performance.map((p) => (
            <div key={p.portfolioId} className="border-w-border-soft rounded-md border p-4">
              <div className="wt-label text-w-muted mb-1">{p.name}</div>
              <div className={`wt-stat tabular ${p.latestCumulativePnl !== null && p.latestCumulativePnl >= 0 ? 'text-w-pos' : 'text-w-neg'}`}>
                {p.latestCumulativePnl !== null ? `${p.latestCumulativePnl >= 0 ? '+' : ''}${formatUsd(p.latestCumulativePnl)}` : '—'}
              </div>
              <div className="wt-body-sm text-w-muted mt-1">on {formatUsd(p.startingCapital)} starting capital</div>
            </div>
          ))}
        </div>
      </GlassCard>

      <GlassCard className="mb-6">
        <GlassCardHeader eyebrow="Decision & trade analysis" title="What each account has done" />
        <div className="flex flex-col gap-6">
          {accounts.map((a) => {
            const stats = decisionsByPortfolio.get(a.portfolioId)
            if (!stats) return null
            return (
              <div key={a.portfolioId} className="border-b border-w-border-soft pb-6 last:border-b-0 last:pb-0">
                <div className="mb-3 flex items-center justify-between">
                  <div className="wt-body-sm text-w-text">{a.name}</div>
                  <a href={hrefFor('/decisions', a.portfolioId)} target="_blank" rel="noopener noreferrer" className="wt-body-sm text-w-accent hover:underline">
                    View full decisions →
                  </a>
                </div>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Stat label="Decisions" value={String(stats.totalDecisions)} />
                  <Stat label="Shadow candidates" value={String(stats.shadowCandidateCount)} sublabel="counterfactual, never sent to the model" />
                  <Stat label="Open positions" value={String(stats.openPositionCount)} />
                  <Stat label="Real Jev calls" value={String(stats.modelCallBuckets.realCall)} />
                </div>
                <div className="mt-3">
                  <NDisclosure
                    n={stats.closedPositionCount}
                    label={`win/loss on closed positions: ${stats.winCount} win${stats.winCount === 1 ? '' : 's'}, ${stats.lossCount} loss${stats.lossCount === 1 ? '' : 'es'} (never blended with open-position unrealized P&L).`}
                  />
                </div>
                {Object.keys(stats.byNoCandidateReason).length > 0 ? (
                  <div className="wt-label text-w-faint mt-2">
                    no-candidate reasons:{' '}
                    {Object.entries(stats.byNoCandidateReason)
                      .map(([reason, count]) => `${NO_CANDIDATE_REASON_LABEL[reason] ?? reason} (${count})`)
                      .join(', ')}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </GlassCard>

      <GlassCard className="mb-6">
        <GlassCardHeader eyebrow="Failure & reliability" title="Run health, per account" />
        <p className="wt-body-sm text-w-muted mb-4">
          A dashboard limitation worth stating plainly: a duplicate or already-running tick never writes an agent_runs row at all (the
          insert itself failed) — so it can never appear in the breakdown below. Only genuinely completed, skipped, or failed runs are
          observable here.
        </p>
        <div className="flex flex-col gap-4">
          {accounts.map((a) => {
            const runs = runsByPortfolio.get(a.portfolioId)
            if (!runs) return null
            return (
              <div key={a.portfolioId} className="border-w-border-soft rounded-md border p-4">
                <div className="wt-body-sm text-w-text mb-2">{a.name}</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(runs.byStatusAndKind).map(([key, count]) => (
                    <Badge key={key} variant={key.endsWith(':failed') ? 'neg' : key.endsWith(':skipped') ? 'accent' : 'muted'}>
                      {key} · {count}
                    </Badge>
                  ))}
                </div>
                {Object.keys(runs.bySkipReason).length > 0 ? (
                  <div className="wt-label text-w-faint mt-2">
                    skip reasons: {Object.entries(runs.bySkipReason).map(([reason, count]) => `${reason} (${count})`).join(', ')}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
        {runStats.recentIssues.length > 0 ? (
          <div className="mt-4">
            <div className="wt-label text-w-muted mb-2">Recent issues</div>
            <ul className="flex flex-col gap-2">
              {runStats.recentIssues.map((issue) => (
                <li key={issue.runId} className="wt-body-sm text-w-muted">
                  <span className="text-w-text">{accounts.find((a) => a.portfolioId === issue.portfolioId)?.name ?? issue.portfolioId.slice(0, 8)}</span>{' '}
                  · {issue.kind}:{issue.status} — {issue.errorDetail ?? issue.skipReason} ({formatAgo(issue.startedAt, now)})
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </GlassCard>

      <GlassCard>
        <GlassCardHeader eyebrow="Report" title="Generated experiment report" />
        <div className="wt-body-sm glass border-w-border-soft text-w-muted mb-6 px-5 py-3">
          No composite score or ranking is computed anywhere on this page — each variant&apos;s statistics are shown on their own terms,
          side by side.
        </div>
        <div className="flex flex-col gap-6">
          {report.sections.map((section) => (
            <div key={section.variantId} className="border-w-border-soft rounded-md border p-4">
              <div className="wt-title text-w-text mb-3">{section.variantName}</div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Accounts" value={String(section.accounts.length)} />
                <Stat
                  label="Cumulative P&L"
                  value={section.performance.latestCumulativePnl !== null ? formatUsd(section.performance.latestCumulativePnl) : '—'}
                />
                <Stat label="Decisions" value={String(section.decisions.totalDecisions)} />
                <Stat label="Failed runs" value={String(section.reliability.failedRuns)} />
              </div>
              <div className="mt-3">
                <NDisclosure
                  n={section.decisions.closedPositionCount}
                  label={`${section.decisions.winCount} win(s), ${section.decisions.lossCount} loss(es) on closed positions.`}
                />
              </div>
            </div>
          ))}
        </div>
      </GlassCard>
    </div>
  )
}

function Stat({ label, value, sublabel }: { label: string; value: string; sublabel?: string }) {
  return (
    <div>
      <div className="wt-label text-w-muted mb-1">{label}</div>
      <div className="wt-num tabular text-w-text">{value}</div>
      {sublabel ? <div className="wt-label text-w-faint mt-0.5">{sublabel}</div> : null}
    </div>
  )
}
