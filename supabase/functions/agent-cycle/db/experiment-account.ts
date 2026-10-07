import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { VariantOverrides } from '../cycle/resolve-account-settings.ts'

// EXP-1 Stage E3 (2026-10-07) — the one read that turns a portfolio's
// bare experiment_variant_id into the resolved treatment
// resolveAccountSettings (cycle/resolve-account-settings.ts) and the
// intraday_ls config-by-hash loader (db/strategy-config.ts's
// loadConfigById) both need. A superset of VariantOverrides — the extra
// identity fields (id/experimentId/strategyConfigId) ride along for
// provenance (agent_runs' own resolved-treatment snapshot) without
// needing a second query.

export interface ResolvedVariant extends VariantOverrides {
  id: string
  experimentId: string
  strategyConfigId: string
}

// null in -> null out: a portfolio with no experiment_variant_id (the
// live champion, always) never touches this table at all.
export async function loadVariantForPortfolio(supabase: SupabaseClient, experimentVariantId: string | null): Promise<ResolvedVariant | null> {
  if (experimentVariantId === null) return null

  const { data, error } = await supabase
    .from('experiment_variants')
    .select('id, experiment_id, strategy_config_id, decision_interval_minutes, assets, news_veto_enabled, management_enabled')
    .eq('id', experimentVariantId)
    .single()
  if (error || !data) throw new Error(`could not load experiment_variants row ${experimentVariantId}: ${error?.message}`)

  return {
    id: data.id,
    experimentId: data.experiment_id,
    strategyConfigId: data.strategy_config_id,
    decisionIntervalMinutes: data.decision_interval_minutes,
    assets: data.assets as AssetSymbol[],
    newsVetoEnabled: data.news_veto_enabled,
    managementEnabled: data.management_enabled,
  }
}
