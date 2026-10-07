import { useCallback } from 'react'
import { formatPct } from '@/format'
import { PageHeader } from '../shell/page-header'
import { GlassCard, GlassCardHeader } from '../ui/glass-card'
import { LoadingState, ErrorState } from '../ui/states'
import { Badge } from '../ui/badge'
import { usePoll } from '../data/use-poll'
import { loadStrategyData, strategyDefinitionFor, riskAppetiteThresholds, resolveAccountSettings, type VariantOverrides } from '../data/strategy'

const ARM_REFERENCE = [
  { arm: 'breakout_long', bias: 'LONG', trigger: 'Close above 8-bar high', confirmation: 'Volume ≥1.2× trend + 60m return matches direction' },
  { arm: 'breakout_short', bias: 'SHORT', trigger: 'Close below 8-bar low', confirmation: 'Volume ≥1.2× trend + 60m return matches direction' },
  { arm: 'pullback_long', bias: 'LONG', trigger: 'Pullback continuation formula', confirmation: 'Current bar closes green' },
  { arm: 'pullback_short', bias: 'SHORT', trigger: 'Mirrored pullback formula', confirmation: 'Current bar closes red' },
  { arm: 'fade_long', bias: 'NEUTRAL', trigger: 'RSI ≤30 near 7-day low', confirmation: '— (NEUTRAL bias only)' },
  { arm: 'fade_short', bias: 'NEUTRAL', trigger: 'RSI ≥70 near 7-day high', confirmation: '— (NEUTRAL bias only)' },
] as const

function Row3({ label, profile, ceiling, effective }: { label: string; profile: string; ceiling: string; effective: string }) {
  return (
    <tr className="border-b border-w-border-soft last:border-b-0">
      <td className="wt-body-sm text-w-text px-4 py-3">{label}</td>
      <td className="wt-num tabular px-4 py-3 text-right text-w-muted">{profile}</td>
      <td className="wt-num tabular px-4 py-3 text-right text-w-muted">{ceiling}</td>
      <td className="wt-num tabular px-4 py-3 text-right text-w-accent">{effective}</td>
    </tr>
  )
}

function Row4({ label, global, override, effective }: { label: string; global: string; override: string; effective: string }) {
  return (
    <tr className="border-b border-w-border-soft last:border-b-0">
      <td className="wt-body-sm text-w-text px-4 py-3">{label}</td>
      <td className="wt-num tabular px-4 py-3 text-right text-w-muted">{global}</td>
      <td className="wt-num tabular px-4 py-3 text-right text-w-muted">{override}</td>
      <td className="wt-num tabular px-4 py-3 text-right text-w-accent">{effective}</td>
    </tr>
  )
}

export function StrategyPage({ portfolioId }: { portfolioId?: string }) {
  const loader = useCallback(() => loadStrategyData(portfolioId), [portfolioId])
  const { state, refresh } = usePoll(loader, 60_000)

  if (state.status === 'loading') return <LoadingState message="Loading strategy & settings…" />
  if (state.status === 'error') return <ErrorState title="Could not load settings" description={state.message} onRetry={refresh} />

  const { data } = state
  const def = strategyDefinitionFor(data.strategyProfile)
  const riskBudgetPct = def.risk.riskBudgetPct ?? riskAppetiteThresholds(data.settings.riskAppetite).riskBudgetPct

  // WEB-2 (2026-10-08) — this account's own effective treatment. For the
  // champion (no variant) `effective` is `globalTreatment` UNCHANGED BY
  // IDENTITY (resolveAccountSettings' own behavior-neutrality guarantee),
  // so every reference to `effective.*` below is byte-identical to the
  // pre-existing `data.settings.assets` reference for the champion.
  const globalTreatment: VariantOverrides = {
    decisionIntervalMinutes: def.decisionIntervalMinutes,
    assets: data.settings.assets,
    newsVetoEnabled: data.globalNewsVetoEnabled,
    managementEnabled: data.globalManagementEnabled,
  }
  const effective = resolveAccountSettings(globalTreatment, data.variant)

  return (
    <div>
      <PageHeader
        crumb="Workspace / Strategy & Settings"
        title="Your rules, consistently applied."
        subtitle="Changes affect the next agent evaluation, never an existing open position."
      />

      <GlassCard className="mb-6">
        <GlassCardHeader eyebrow="Active strategy" title={def.strategyVersion} right={<Badge variant="accent">{data.strategyProfile}</Badge>} />
        <p className="wt-body-sm text-w-muted">
          {data.strategyProfile === 'intraday_ls'
            ? 'Six bias-gated arms trading both directions on 30-minute bars, with a 15-minute decision cadence.'
            : data.strategyProfile === 'aggressive'
              ? 'Two edge-triggered opportunity detectors, long-only, 15-minute cadence over 30-minute signals.'
              : 'Deterministic 50-day trend regime rule, long-only, 3-hour cadence.'}
        </p>
        <div className="wt-body-sm text-w-muted mt-3">
          Decision cadence <span className="text-w-text">{def.decisionIntervalMinutes} min</span> — distinct from the{' '}
          <span className="text-w-text">30-minute</span> signal timeframe the strategy version name encodes.
        </div>
      </GlassCard>

      {portfolioId ? (
        <GlassCard className="mb-6 p-0">
          <div className="p-6 pb-0">
            <GlassCardHeader
              eyebrow="This account"
              title="Treatment"
              right={
                data.variant ? (
                  <Badge variant="accent">
                    {data.variant.experimentName} · {data.variant.variantName}
                  </Badge>
                ) : (
                  <Badge variant="muted">No variant — running global defaults</Badge>
                )
              }
            />
          </div>
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-w-bg-raised">
                <th className="wt-label text-w-muted px-4 py-3 text-left">Setting</th>
                <th className="wt-label text-w-muted px-4 py-3 text-right">Global default</th>
                <th className="wt-label text-w-muted px-4 py-3 text-right">Variant override</th>
                <th className="wt-label text-w-muted px-4 py-3 text-right">Effective for this account</th>
              </tr>
            </thead>
            <tbody>
              <Row4
                label="Decision cadence"
                global={`${def.decisionIntervalMinutes} min`}
                override={data.variant ? `${data.variant.decisionIntervalMinutes} min` : '—'}
                effective={`${effective.decisionIntervalMinutes} min`}
              />
              <Row4
                label="Trading assets"
                global={data.settings.assets.join(', ')}
                override={data.variant ? data.variant.assets.join(', ') : '—'}
                effective={effective.assets.join(', ')}
              />
              <Row4
                label="News veto"
                global={data.globalNewsVetoEnabled ? 'Enabled' : 'Disabled'}
                override={data.variant ? (data.variant.newsVetoEnabled ? 'Enabled' : 'Disabled') : '—'}
                effective={effective.newsVetoEnabled ? 'Enabled' : 'Disabled'}
              />
              <Row4
                label="Portfolio management"
                global={data.globalManagementEnabled ? 'Enabled' : 'Disabled'}
                override={data.variant ? (data.variant.managementEnabled ? 'Enabled' : 'Disabled') : '—'}
                effective={effective.managementEnabled ? 'Enabled' : 'Disabled'}
              />
            </tbody>
          </table>
        </GlassCard>
      ) : null}

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <GlassCard>
          <GlassCardHeader eyebrow="Universe" title="Trading assets" />
          <div className="flex flex-wrap gap-2">
            {effective.assets.map((a) => (
              <Badge key={a} variant="neutral">
                {a} · 1× paper, long/short
              </Badge>
            ))}
          </div>
          <div className="wt-body-sm text-w-muted mt-4">Started with {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(data.startingCapital)} in contributed capital.</div>
        </GlassCard>

        <GlassCard>
          <GlassCardHeader eyebrow="Model & data" title="Jev + CoinGecko" />
          <dl className="flex flex-col gap-2">
            <div className="flex justify-between">
              <dt className="wt-body-sm text-w-muted">News lookback</dt>
              <dd className="wt-num text-w-text">{def.newsLookbackMinutes} min</dd>
            </div>
            <div className="flex justify-between">
              <dt className="wt-body-sm text-w-muted">Max data staleness</dt>
              <dd className="wt-num text-w-text">{def.maxDataStalenessMinutes} min</dd>
            </div>
            <div className="flex justify-between">
              <dt className="wt-body-sm text-w-muted">Monitor cadence</dt>
              <dd className="wt-num text-w-text">{data.settings.monitorIntervalMinutes} min</dd>
            </div>
          </dl>
        </GlassCard>
      </div>

      <GlassCard className="mb-6 p-0">
        <div className="p-6 pb-0">
          <GlassCardHeader eyebrow="Risk controls" title="Three columns, on purpose" />
          <p className="wt-body-sm text-w-muted mb-4 -mt-2">
            This system once had a real bug where the profile-declared value silently diverged from what was actually enforced for weeks.
            One column would hide a recurrence.
          </p>
        </div>
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-w-bg-raised">
              <th className="wt-label text-w-muted px-4 py-3 text-left">Control</th>
              <th className="wt-label text-w-muted px-4 py-3 text-right">Profile value</th>
              <th className="wt-label text-w-muted px-4 py-3 text-right">Settings ceiling</th>
              <th className="wt-label text-w-muted px-4 py-3 text-right">Effective (min)</th>
            </tr>
          </thead>
          <tbody>
            <Row3
              label="Risk budget / cycle"
              profile={formatPct(riskBudgetPct * 100)}
              ceiling="—"
              effective={formatPct(riskBudgetPct * 100)}
            />
            <Row3
              label="Max single-trade size"
              profile={formatPct(def.risk.maxSingleTradePct * 100)}
              ceiling={formatPct(data.settings.maxSingleTradePct * 100)}
              effective={formatPct(Math.min(def.risk.maxSingleTradePct, data.settings.maxSingleTradePct) * 100)}
            />
            <Row3
              label="Max total notional"
              profile={formatPct(def.risk.maxTotalNotionalPct * 100)}
              ceiling={formatPct(data.maxTotalNotionalPct * 100)}
              effective={formatPct(Math.min(def.risk.maxTotalNotionalPct, data.maxTotalNotionalPct) * 100)}
            />
            <Row3
              label="Stop-out re-entry block"
              profile={`${def.risk.stopOutReentryBlockMinutes} min`}
              ceiling="—"
              effective={`${def.risk.stopOutReentryBlockMinutes} min`}
            />
          </tbody>
        </table>
      </GlassCard>

      {data.strategyProfile === 'intraday_ls' ? (
        <GlassCard className="mb-6 p-0">
          <div className="p-6 pb-0">
            <GlassCardHeader eyebrow="intraday_ls" title="Six-arm reference" />
          </div>
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-w-bg-raised">
                <th className="wt-label text-w-muted px-4 py-3 text-left">Arm</th>
                <th className="wt-label text-w-muted px-4 py-3 text-left">Bias</th>
                <th className="wt-label text-w-muted px-4 py-3 text-left">Trigger</th>
                <th className="wt-label text-w-muted px-4 py-3 text-left">Confirmation</th>
              </tr>
            </thead>
            <tbody>
              {ARM_REFERENCE.map((a) => (
                <tr key={a.arm} className="border-b border-w-border-soft last:border-b-0">
                  <td className="wt-body-sm text-w-text px-4 py-3">{a.arm}</td>
                  <td className="wt-body-sm px-4 py-3">
                    <Badge variant={a.bias === 'LONG' ? 'pos' : a.bias === 'SHORT' ? 'neg' : 'muted'}>{a.bias}</Badge>
                  </td>
                  <td className="wt-body-sm text-w-muted px-4 py-3">{a.trigger}</td>
                  <td className="wt-body-sm text-w-muted px-4 py-3">{a.confirmation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </GlassCard>
      ) : null}

      <GlassCard>
        <GlassCardHeader eyebrow="Workspace" title="Execution & fees" />
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div>
            <dt className="wt-label text-w-muted">Execution</dt>
            <dd className="wt-body-sm text-w-text mt-1">Paper only</dd>
          </div>
          <div>
            <dt className="wt-label text-w-muted">Fee / side</dt>
            <dd className="wt-body-sm text-w-text mt-1">{(data.settings.feeBps / 100).toFixed(2)}%</dd>
          </div>
          <div>
            <dt className="wt-label text-w-muted">Slippage / side</dt>
            <dd className="wt-body-sm text-w-text mt-1">{(data.settings.slippageBps / 100).toFixed(2)}%</dd>
          </div>
          <div>
            <dt className="wt-label text-w-muted">Agent status</dt>
            <dd className="wt-body-sm text-w-text mt-1">{data.settings.isPaused ? 'Paused' : 'Running'}</dd>
          </div>
        </dl>
      </GlassCard>

      <p className="wt-body-sm text-w-muted mt-6">Configuration shown is read directly from the live system. This page cannot change it.</p>
    </div>
  )
}
