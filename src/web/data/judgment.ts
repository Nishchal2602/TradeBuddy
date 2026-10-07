import { supabase } from '@/supabase'
import type { AssetSymbol } from '@/shared/market-data/types.ts'
import type { Action } from '@/shared/decisions/types.ts'

export interface JudgmentCase {
  id: string
  asset: AssetSymbol
  action: Action
  decidedAt: string
  jevNewsVetoProbability: number | null
  entryQuality: 'ENTER' | 'SKIP' | null
  entryQualityDistribution: Record<string, number> | null
  entryGateMode: 'advisory' | 'blocking' | null
  failureRisk: 'LOW' | 'MEDIUM' | 'HIGH' | null
  failureRiskDistribution: Record<string, number> | null
  failureMode: string | null
  failureModeDistribution: Record<string, number> | null
}

export interface JudgmentData {
  totalRealJevCalls: number
  totalVetoVerdicts: number
  vetoAllowCount: number
  cases: JudgmentCase[]
}

const JEV_VETO_THRESHOLD = 0.7

// WEB-2 (2026-10-08) — closes a live data-mixing gap: this previously had
// no portfolio scoping at all and read across every portfolio in the
// database. portfolioId absent now resolves is_test=false (the live
// champion), matching every other page's own convention.
export async function loadJudgmentData(portfolioId?: string): Promise<JudgmentData> {
  const portfolioQuery = supabase.from('portfolios').select('id')
  const { data: portfolio, error: portfolioError } = await (
    portfolioId ? portfolioQuery.eq('id', portfolioId) : portfolioQuery.eq('is_test', false)
  ).single()
  if (portfolioError) throw new Error(`could not load portfolio: ${portfolioError.message}`)
  const resolvedPortfolioId = portfolio.id as string

  const [callsRes, vetoRes, casesRes] = await Promise.all([
    supabase.from('agent_decisions').select('id', { count: 'exact', head: true }).eq('portfolio_id', resolvedPortfolioId).like('model_version', 'jev%'),
    supabase.from('agent_decisions').select('model_vetoed').eq('portfolio_id', resolvedPortfolioId).not('model_vetoed', 'is', null),
    supabase
      .from('agent_decisions')
      .select('id, asset, action, decided_at, jev_news_veto_probability, entry_quality, entry_quality_distribution, entry_gate_mode, failure_risk, failure_risk_distribution, failure_mode, failure_mode_distribution')
      .eq('portfolio_id', resolvedPortfolioId)
      .or('jev_news_veto_probability.not.is.null,entry_quality.not.is.null,failure_risk.not.is.null')
      .order('decided_at', { ascending: false }),
  ])
  if (callsRes.error) throw new Error(`could not count Jev calls: ${callsRes.error.message}`)
  if (vetoRes.error) throw new Error(`could not load veto verdicts: ${vetoRes.error.message}`)
  if (casesRes.error) throw new Error(`could not load advisory cases: ${casesRes.error.message}`)

  const vetoVerdicts = vetoRes.data ?? []

  return {
    totalRealJevCalls: callsRes.count ?? 0,
    totalVetoVerdicts: vetoVerdicts.length,
    vetoAllowCount: vetoVerdicts.filter((v) => v.model_vetoed === false).length,
    cases: (casesRes.data ?? []).map((d) => ({
      id: d.id,
      asset: d.asset as AssetSymbol,
      action: d.action as Action,
      decidedAt: d.decided_at,
      jevNewsVetoProbability: d.jev_news_veto_probability === null ? null : Number(d.jev_news_veto_probability),
      entryQuality: d.entry_quality,
      entryQualityDistribution: d.entry_quality_distribution,
      entryGateMode: d.entry_gate_mode,
      failureRisk: d.failure_risk,
      failureRiskDistribution: d.failure_risk_distribution,
      failureMode: d.failure_mode,
      failureModeDistribution: d.failure_mode_distribution,
    })),
  }
}

export { JEV_VETO_THRESHOLD }
