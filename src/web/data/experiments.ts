import { supabase } from '@/supabase'
import type { ExperimentStatus } from '@/shared/experiments/types.ts'

export interface ExperimentListRow {
  id: string
  name: string
  hypothesis: string
  status: ExperimentStatus
  preRegisteredAt: string | null
  startedAt: string | null
  endedAt: string | null
  variantCount: number
  portfolioCount: number
  createdAt: string
}

// WEB-2 (2026-10-08) — parallel queries merged client-side, the one
// established pattern every src/web/data/*.ts file already follows
// (never a server-side join). Today returns exactly one row
// (exp1-e4-dry-run) — the list shape exists because experiments are
// meant to recur (EXP-1's own "make this scalable" goal), not because
// today's single row needs it.
export async function loadExperimentsList(): Promise<ExperimentListRow[]> {
  const { data: experiments, error: experimentsError } = await supabase
    .from('experiments')
    .select('id, name, hypothesis, status, pre_registered_at, started_at, ended_at, created_at')
    .order('created_at', { ascending: false })
  if (experimentsError) throw new Error(`could not load experiments: ${experimentsError.message}`)
  if (!experiments || experiments.length === 0) return []

  const experimentIds = experiments.map((e) => e.id)

  const [variantsRes, portfoliosRes] = await Promise.all([
    supabase.from('experiment_variants').select('id, experiment_id').in('experiment_id', experimentIds),
    supabase.from('portfolios').select('id, experiment_variant_id').eq('is_test', true).not('experiment_variant_id', 'is', null),
  ])
  if (variantsRes.error) throw new Error(`could not load experiment variants: ${variantsRes.error.message}`)
  if (portfoliosRes.error) throw new Error(`could not load portfolios: ${portfoliosRes.error.message}`)

  const experimentIdByVariantId = new Map((variantsRes.data ?? []).map((v) => [v.id, v.experiment_id]))

  const variantCountByExperiment = new Map<string, number>()
  for (const v of variantsRes.data ?? []) {
    variantCountByExperiment.set(v.experiment_id, (variantCountByExperiment.get(v.experiment_id) ?? 0) + 1)
  }

  const portfolioCountByExperiment = new Map<string, number>()
  for (const p of portfoliosRes.data ?? []) {
    const experimentId = p.experiment_variant_id ? experimentIdByVariantId.get(p.experiment_variant_id) : undefined
    if (!experimentId) continue
    portfolioCountByExperiment.set(experimentId, (portfolioCountByExperiment.get(experimentId) ?? 0) + 1)
  }

  return experiments.map((e) => ({
    id: e.id,
    name: e.name,
    hypothesis: e.hypothesis,
    status: e.status as ExperimentStatus,
    preRegisteredAt: e.pre_registered_at,
    startedAt: e.started_at,
    endedAt: e.ended_at,
    createdAt: e.created_at,
    variantCount: variantCountByExperiment.get(e.id) ?? 0,
    portfolioCount: portfolioCountByExperiment.get(e.id) ?? 0,
  }))
}
