import { supabase } from '@/supabase'
import { fetchFullAgentSettings, type FullAgentSettings } from '@/features/settings/queries'
import { strategyDefinitionFor, type StrategyProfile } from '@/shared/strategy/profiles.ts'
import { riskAppetiteThresholds } from '@/shared/risk/appetite-mapping.ts'
import type { AssetSymbol } from '@/shared/market-data/types.ts'

// WEB-2 (2026-10-08) — mirrors supabase/functions/agent-cycle/cycle/
// resolve-account-settings.ts's VariantOverrides/resolveAccountSettings
// and db/experiment-account.ts's ResolvedVariant EXACTLY — duplicated,
// not imported: that code lives under supabase/functions/, which Vite
// cannot resolve from src/web (src/features/home/run-agent.ts's own
// comment states this boundary explicitly). If the backend's merge
// semantics ever change, this must change too — there is no compiler
// link between the two call sites.
export interface VariantOverrides {
  decisionIntervalMinutes: number
  assets: AssetSymbol[]
  newsVetoEnabled: boolean
  managementEnabled: boolean
}

export interface ResolvedVariant extends VariantOverrides {
  id: string
  experimentId: string
  experimentName: string
  variantName: string
}

export function resolveAccountSettings<T extends VariantOverrides>(global: T, variant: VariantOverrides | null): T {
  if (variant === null) return global
  return { ...global, ...variant } as T
}

async function loadVariantForPortfolio(experimentVariantId: string | null): Promise<ResolvedVariant | null> {
  if (experimentVariantId === null) return null
  const { data, error } = await supabase
    .from('experiment_variants')
    .select('id, experiment_id, name, decision_interval_minutes, assets, news_veto_enabled, management_enabled, experiments(name)')
    .eq('id', experimentVariantId)
    .single()
  if (error || !data) throw new Error(`could not load experiment variant ${experimentVariantId}: ${error?.message}`)
  return {
    id: data.id,
    experimentId: data.experiment_id,
    experimentName: (data.experiments as unknown as { name: string } | null)?.name ?? '—',
    variantName: data.name,
    decisionIntervalMinutes: data.decision_interval_minutes,
    assets: data.assets as AssetSymbol[],
    newsVetoEnabled: data.news_veto_enabled,
    managementEnabled: data.management_enabled,
  }
}

export interface StrategyData {
  settings: FullAgentSettings
  strategyProfile: StrategyProfile
  maxTotalNotionalPct: number
  portfolioRiskCeilingMultiplier: number
  startingCapital: number
  globalNewsVetoEnabled: boolean
  globalManagementEnabled: boolean
  // null for the champion (experiment_variant_id is always null) and for
  // any test account not linked to a variant. Never fabricated.
  variant: ResolvedVariant | null
}

export async function loadStrategyData(portfolioId?: string): Promise<StrategyData> {
  const portfolioQuery = supabase.from('portfolios').select('starting_capital, experiment_variant_id')
  const [settings, extra, portfolioRes] = await Promise.all([
    fetchFullAgentSettings(),
    supabase.from('agent_settings').select('strategy_profile, max_total_notional_pct, portfolio_risk_ceiling_multiplier, news_veto_enabled, management_enabled').single(),
    // WEB-2 (2026-10-08) — portfolioId absent resolves is_test=false (the
    // live champion), exactly as before this retrofit.
    (portfolioId ? portfolioQuery.eq('id', portfolioId) : portfolioQuery.eq('is_test', false)).single(),
  ])
  if (extra.error) throw new Error(`could not load strategy config: ${extra.error.message}`)
  if (portfolioRes.error) throw new Error(`could not load portfolio: ${portfolioRes.error.message}`)

  const variant = await loadVariantForPortfolio(portfolioRes.data.experiment_variant_id)

  return {
    settings,
    strategyProfile: extra.data.strategy_profile as StrategyProfile,
    maxTotalNotionalPct: Number(extra.data.max_total_notional_pct),
    portfolioRiskCeilingMultiplier: Number(extra.data.portfolio_risk_ceiling_multiplier),
    startingCapital: Number(portfolioRes.data.starting_capital),
    globalNewsVetoEnabled: extra.data.news_veto_enabled,
    globalManagementEnabled: extra.data.management_enabled,
    variant,
  }
}

export { strategyDefinitionFor, riskAppetiteThresholds }
