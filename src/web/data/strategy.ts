import { supabase } from '@/supabase'
import { fetchFullAgentSettings, type FullAgentSettings } from '@/features/settings/queries'
import { strategyDefinitionFor, type StrategyProfile } from '@/shared/strategy/profiles.ts'
import { riskAppetiteThresholds } from '@/shared/risk/appetite-mapping.ts'

export interface StrategyData {
  settings: FullAgentSettings
  strategyProfile: StrategyProfile
  maxTotalNotionalPct: number
  portfolioRiskCeilingMultiplier: number
  startingCapital: number
}

export async function loadStrategyData(): Promise<StrategyData> {
  const [settings, extra, portfolio] = await Promise.all([
    fetchFullAgentSettings(),
    supabase.from('agent_settings').select('strategy_profile, max_total_notional_pct, portfolio_risk_ceiling_multiplier').single(),
    supabase.from('portfolios').select('starting_capital').single(),
  ])
  if (extra.error) throw new Error(`could not load strategy config: ${extra.error.message}`)
  if (portfolio.error) throw new Error(`could not load portfolio: ${portfolio.error.message}`)

  return {
    settings,
    strategyProfile: extra.data.strategy_profile as StrategyProfile,
    maxTotalNotionalPct: Number(extra.data.max_total_notional_pct),
    portfolioRiskCeilingMultiplier: Number(extra.data.portfolio_risk_ceiling_multiplier),
    startingCapital: Number(portfolio.data.starting_capital),
  }
}

export { strategyDefinitionFor, riskAppetiteThresholds }
