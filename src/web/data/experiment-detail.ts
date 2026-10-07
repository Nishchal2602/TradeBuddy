import { supabase } from '@/supabase'
import type { AssetSymbol } from '@/shared/market-data/types.ts'
import type { IntradayLsConfig } from '@/shared/strategy/config-schema.ts'
import type { ExperimentStatus } from '@/shared/experiments/types.ts'

export interface ExperimentHeader {
  id: string
  name: string
  hypothesis: string
  status: ExperimentStatus
  preRegisteredAt: string | null
  startedAt: string | null
  endedAt: string | null
  notes: string | null
}

export interface VariantRow {
  id: string
  name: string
  decisionIntervalMinutes: number
  assets: AssetSymbol[]
  newsVetoEnabled: boolean
  managementEnabled: boolean
  frozenAt: string | null
  strategyConfigId: string
  configPresetName: string
  configHash: string
  config: IntradayLsConfig
}

export interface AccountRow {
  portfolioId: string
  label: string | null
  name: string
  variantId: string | null
  variantName: string | null
  startingCapital: number
  cash: number
}

export interface ExperimentDetailData {
  header: ExperimentHeader
  variants: VariantRow[]
  accounts: AccountRow[]
}

// WEB-2 (2026-10-08) — a genuine 2-phase fetch: variants must be known
// before configs/accounts can be scoped, so this is NOT one flat
// Promise.all. Parallel queries within each phase, merged client-side —
// the established pattern every src/web/data/*.ts file follows.
export async function loadExperimentDetail(experimentId: string): Promise<ExperimentDetailData | null> {
  const { data: experiment, error: experimentError } = await supabase
    .from('experiments')
    .select('id, name, hypothesis, status, pre_registered_at, started_at, ended_at, notes')
    .eq('id', experimentId)
    .maybeSingle()
  if (experimentError) throw new Error(`could not load experiment: ${experimentError.message}`)
  if (!experiment) return null

  const { data: variantRows, error: variantsError } = await supabase
    .from('experiment_variants')
    .select('id, name, strategy_config_id, decision_interval_minutes, assets, news_veto_enabled, management_enabled, frozen_at')
    .eq('experiment_id', experimentId)
    .order('name')
  if (variantsError) throw new Error(`could not load experiment variants: ${variantsError.message}`)

  const variantIds = (variantRows ?? []).map((v) => v.id)
  const configIds = [...new Set((variantRows ?? []).map((v) => v.strategy_config_id))]

  const [configsRes, portfoliosRes] = await Promise.all([
    configIds.length > 0
      ? supabase.from('strategy_configs').select('id, preset_name, config, config_hash').in('id', configIds)
      : Promise.resolve({ data: [], error: null }),
    variantIds.length > 0
      ? // is_test=true is redundant with experiment_variant_id IN (...) alone
        // structurally excluding the champion (its own experiment_variant_id
        // is always null) — kept explicit anyway, per this codebase's own
        // established discipline of never relying on an implicit structural
        // property (overview.ts's own is_test=false comment is the same
        // reasoning, applied in reverse here).
        supabase.from('portfolios').select('id, label, name, experiment_variant_id, starting_capital, cash').in('experiment_variant_id', variantIds).eq('is_test', true)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (configsRes.error) throw new Error(`could not load strategy configs: ${configsRes.error.message}`)
  if (portfoliosRes.error) throw new Error(`could not load portfolios: ${portfoliosRes.error.message}`)

  const configById = new Map((configsRes.data ?? []).map((c) => [c.id, c]))
  const variantNameById = new Map((variantRows ?? []).map((v) => [v.id, v.name]))

  const variants: VariantRow[] = (variantRows ?? []).map((v) => {
    const config = configById.get(v.strategy_config_id)
    if (!config) throw new Error(`strategy_configs row ${v.strategy_config_id} (variant "${v.name}") could not be resolved`)
    return {
      id: v.id,
      name: v.name,
      decisionIntervalMinutes: v.decision_interval_minutes,
      assets: v.assets as AssetSymbol[],
      newsVetoEnabled: v.news_veto_enabled,
      managementEnabled: v.management_enabled,
      frozenAt: v.frozen_at,
      strategyConfigId: v.strategy_config_id,
      configPresetName: config.preset_name,
      configHash: config.config_hash,
      config: config.config as IntradayLsConfig,
    }
  })

  const accounts: AccountRow[] = (portfoliosRes.data ?? []).map((p) => ({
    portfolioId: p.id,
    label: p.label,
    name: p.name,
    variantId: p.experiment_variant_id,
    variantName: p.experiment_variant_id ? (variantNameById.get(p.experiment_variant_id) ?? null) : null,
    startingCapital: Number(p.starting_capital),
    cash: Number(p.cash),
  }))

  return {
    header: {
      id: experiment.id,
      name: experiment.name,
      hypothesis: experiment.hypothesis,
      status: experiment.status as ExperimentStatus,
      preRegisteredAt: experiment.pre_registered_at,
      startedAt: experiment.started_at,
      endedAt: experiment.ended_at,
      notes: experiment.notes,
    },
    variants,
    accounts,
  }
}

// --- Config-diff mechanism — pure, zero queries ---

export interface ConfigFieldDiff {
  path: string
  baseValue: unknown
  variantValue: unknown
  differs: boolean
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Recurses through PLAIN-OBJECT fields only (arms, and each arm's own
// {enabled, rewardRiskRatio}) until it hits a scalar or an array —
// naturally terminates because IntradayLsConfig has no cyclic structure
// and a schema-bounded depth (arms -> armId -> scalar fields, 2 levels;
// everything else is 1 level). Array-valued fields (directionPolicy's
// own values) are NOT descended into — "which arms are eligible under
// LONG" reads as one fact, not N — they're compared and rendered as one
// leaf row. JSON.stringify is the comparator, not `!==`: every value
// crossed a network boundary as JSON, so two structurally-identical
// nested objects are never the same JS reference — valid SPECIFICALLY
// because both sides come from the same Zod schema (IntradayLsConfig),
// which always serializes object keys in the same declared order — not
// a general-purpose deep-equal.
function flattenField(path: string, baseValue: unknown, variantValue: unknown): ConfigFieldDiff[] {
  if (isPlainObject(baseValue) && isPlainObject(variantValue)) {
    const keys = new Set([...Object.keys(baseValue), ...Object.keys(variantValue)])
    return [...keys].flatMap((k) => flattenField(`${path}.${k}`, baseValue[k], variantValue[k]))
  }
  return [{ path, baseValue, variantValue, differs: JSON.stringify(baseValue) !== JSON.stringify(variantValue) }]
}

// No `is_control`/`is_baseline` column exists on experiment_variants —
// picking a baseline is a UI convention only, never load-bearing: the
// caller chooses which variant to diff against (see experiments.tsx's
// own baseline-selection heuristic), this function just does the diff.
export function diffConfigs(base: IntradayLsConfig, variant: IntradayLsConfig): ConfigFieldDiff[] {
  const keys = (Object.keys(base) as (keyof IntradayLsConfig)[]).filter((k) => k !== 'presetName')
  return keys.flatMap((key) => flattenField(key, base[key], variant[key]))
}
