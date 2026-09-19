import { useEffect, useState } from 'react'
import { ShieldCheck, Play, Pause, SlidersHorizontal, Coins, Server, Timer } from 'lucide-react'
import { Card, Panel } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Stat, StatGrid } from '@/components/ui/stat'
import { SectionHeader } from '@/components/ui/section-header'
import { LoadingState } from '@/components/states/loading-state'
import { ErrorState } from '@/components/states/error-state'
import { formatPct, formatAgo } from '@/features/home/format'
import { riskAppetiteThresholds } from '@/shared/risk/appetite-mapping.ts'
import type { RiskAppetite } from '@/shared/risk/appetite-mapping.ts'
import type { LatestRunSummary } from '@/features/system-status/queries'
import { useSettingsData } from './use-settings-data'
import type { SettingsViewModel } from './use-settings-data'

const RISK_APPETITES: RiskAppetite[] = ['conservative', 'balanced', 'aggressive']

function formatDuration(minutes: number): string {
  if (minutes % 60 === 0 && minutes >= 60) return `${minutes / 60}h`
  return `${minutes}m`
}

export function SettingsScreen() {
  const state = useSettingsData()

  if (state.status === 'loading') return <LoadingState message="Loading settings…" />
  if (state.status === 'error') return <ErrorState title="Could not load settings" description={state.message} onRetry={state.refresh} />

  return <SettingsContent data={state.data} />
}

function SettingsContent({ data }: { data: SettingsViewModel }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const { settings } = data
  const appetite = riskAppetiteThresholds(settings.riskAppetite)

  return (
    <div className="flex flex-col gap-2.5 p-3">
      <Card className="flex-row items-start gap-2">
        <div className="rounded-md bg-state-success-subtle p-1">
          <ShieldCheck className="h-4 w-4 text-state-success" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="type-label-md text-state-success">Paper trading — non-custodial</span>
          <p className="type-body-sm text-text-secondary">No real funds, exchange keys, or leverage are involved. Every trade shown in this extension is simulated.</p>
        </div>
      </Card>

      <Card>
        <SectionHeader icon={<Server className="h-4 w-4 text-accent-primary" aria-hidden="true" />} title="Agent runtime" />
        <div className="flex items-center justify-between">
          <Badge variant={settings.isPaused ? 'neutral' : 'success'}>{settings.isPaused ? 'PAUSED' : 'RUNNING'}</Badge>
          <div className="flex gap-1.5">
            {settings.isPaused ? (
              <Button variant="primary" size="sm" title="Presentation only — control actions require a server-side endpoint not yet built.">
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                Resume
              </Button>
            ) : (
              <Button variant="secondary" size="sm" title="Presentation only — control actions require a server-side endpoint not yet built.">
                <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                Pause
              </Button>
            )}
            <Button variant="secondary" size="sm" title="Presentation only — control actions require a server-side endpoint not yet built.">
              Run now
            </Button>
          </div>
        </div>
        <StatGrid columns={2}>
          <Stat label="DECISION CADENCE" value={`Every ${formatDuration(settings.decisionIntervalMinutes)}`} />
          <Stat label="POSITION MONITOR" value={`Every ${formatDuration(settings.monitorIntervalMinutes)}`} />
        </StatGrid>
      </Card>

      <Card>
        <SectionHeader icon={<SlidersHorizontal className="h-4 w-4 text-accent-primary" aria-hidden="true" />} title="Risk appetite" />
        <div className="grid grid-cols-3 gap-1.5 rounded-md bg-bg-elevated p-1">
          {RISK_APPETITES.map((option) => (
            <div
              key={option}
              className={
                option === settings.riskAppetite
                  ? 'rounded bg-accent-primary py-1.5 text-center type-label-md font-semibold text-text-primary'
                  : 'rounded py-1.5 text-center type-label-md text-text-muted'
              }
              title="Read-only — reflects the configured value; changing it isn't wired to a control endpoint yet."
            >
              {option.toUpperCase()}
            </div>
          ))}
        </div>
        <StatGrid columns={2}>
          <Stat label="MIN CONFIDENCE" value={formatPct(appetite.minConfidence * 100)} />
          <Stat label="RISK BUDGET / TRADE" value={formatPct(appetite.riskBudgetPct * 100)} />
        </StatGrid>
        <Panel className="flex flex-col gap-1.5">
          <span className="type-label-xs text-text-muted">HARD LIMITS (APPLY REGARDLESS OF APPETITE)</span>
          <StatGrid columns={2}>
            <Stat label="MAX SINGLE TRADE" value={formatPct(settings.maxSingleTradePct * 100)} />
            <Stat label="MAX ASSET EXPOSURE" value={formatPct(settings.maxAssetExposurePct * 100)} />
            <Stat label="STOP-LOSS RANGE" value={`${formatPct(settings.minStopLossPct * 100)} – ${formatPct(settings.maxStopLossPct * 100)}`} />
            <Stat label="TAKE-PROFIT RANGE" value={`${formatPct(settings.minTakeProfitPct * 100)} – ${formatPct(settings.maxTakeProfitPct * 100)}`} />
          </StatGrid>
        </Panel>
      </Card>

      <Card>
        <SectionHeader icon={<Coins className="h-4 w-4 text-accent-primary" aria-hidden="true" />} title="Supported assets" count={settings.assets.length} />
        <div className="flex flex-col gap-1.5">
          {settings.assets.map((asset) => (
            <div key={asset} className="flex items-center justify-between rounded-md bg-bg-elevated p-2">
              <span className="type-body-md font-medium text-text-primary">{asset}</span>
              <Badge variant="accent">1× PAPER, LONG/SHORT</Badge>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionHeader icon={<Timer className="h-4 w-4 text-accent-primary" aria-hidden="true" />} title="System status" />
        <RunStatusRow label="Decision cycle" run={data.latestDecisionRun} now={now} />
        <RunStatusRow label="Position monitor" run={data.latestMonitorRun} now={now} />
        <StatGrid columns={2}>
          <Stat label="SIMULATED FEE" value={formatPct(settings.feeBps / 100)} sublabel="per side" />
          <Stat label="SIMULATED SLIPPAGE" value={formatPct(settings.slippageBps / 100)} sublabel="per side" />
        </StatGrid>
      </Card>
    </div>
  )
}

function RunStatusRow({ label, run, now }: { label: string; run: LatestRunSummary | null; now: number }) {
  const variant = !run ? 'neutral' : run.status === 'completed' ? 'success' : run.status === 'failed' ? 'error' : run.status === 'skipped' ? 'warning' : 'neutral'
  return (
    <div className="flex items-center justify-between py-1">
      <span className="type-body-sm text-text-secondary">{label}</span>
      <div className="flex items-center gap-1.5">
        {run ? <span className="type-label-xs text-text-muted">{formatAgo(run.startedAt, now)}</span> : null}
        <Badge variant={variant}>{run ? run.status.toUpperCase() : 'NO RUNS YET'}</Badge>
      </div>
    </div>
  )
}
