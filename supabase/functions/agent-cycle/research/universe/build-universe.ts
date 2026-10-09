import type { SupabaseClient } from '@supabase/supabase-js'
import type { ResearchSymbol } from '../types.ts'
import { evaluateEligibility } from './eligibility.ts'

// DT-1 (2026-10-09, Order-of-Work step 4) — the PIT universe ranking
// itself (plan §5.3): "Ranking: mean daily quote volume over the
// preceding 30 days. N = min(20, eligible)." A6 (Stage A, confirmed
// 2026-10-08): rank the TRUE top-20 including BTC/ETH (they are
// genuinely the most liquid; excluding them from the ranking step would
// silently redefine the universe), then exclude them from the PRIMARY
// analysis only -- this module therefore does NOT exclude BTC/ETH from
// membership, it only ranks. Exclusion for the primary happens
// downstream, at analysis time.
//
// Separately, an asset already marked `excluded` in research_contracts
// (stablecoin / leveraged-index / exchange-token / wrapped / lst) is
// filtered out BEFORE ranking, not merely deprioritized -- those are not
// "low-ranked ordinary assets," they are not candidates at all.

export interface DailyVolumeSample {
  closeTimeIso: string
  // NaN for a bar ingested before quote_volume existed (fetch-historical-
  // bars.ts's own convention) -- NEVER silently averaged into a mean.
  quoteVolume: number
}

export interface RankedUniverseMember {
  underlyingId: ResearchSymbol
  rank: number
  advUsd30d: number
}

export interface RankingExclusion {
  underlyingId: ResearchSymbol
  reason: string
}

export interface RankUniverseResult {
  members: RankedUniverseMember[]
  excluded: RankingExclusion[]
}

// Pure. `dailyBarsByAsset` should carry EVERY daily bar this asset has
// ever had (eligibility needs the full history, not just the 30-day
// ranking window) for assets not already marked excluded in
// research_contracts. `excludedAssetIds` is the research_contracts-derived
// exclusion set, applied first.
export function rankUniverseAtFormation(
  dailyBarsByAsset: ReadonlyMap<ResearchSymbol, readonly DailyVolumeSample[]>,
  excludedAssetIds: ReadonlySet<ResearchSymbol>,
  formationDateIso: string,
  opts: { lookbackDays?: number; maxUniverseSize?: number; minHistoryDays?: number; maxStalenessDays?: number } = {},
): RankUniverseResult {
  const lookbackDays = opts.lookbackDays ?? 30
  const maxUniverseSize = opts.maxUniverseSize ?? 20
  const formationMs = new Date(formationDateIso).getTime()
  const lookbackStartMs = formationMs - lookbackDays * 86_400_000

  const excludedOut: RankingExclusion[] = []
  const candidates: { underlyingId: ResearchSymbol; advUsd30d: number }[] = []

  for (const [underlyingId, bars] of dailyBarsByAsset) {
    if (excludedAssetIds.has(underlyingId)) {
      excludedOut.push({ underlyingId, reason: 'excluded asset class (research_contracts)' })
      continue
    }

    const eligibility = evaluateEligibility(
      bars.map((b) => b.closeTimeIso),
      formationDateIso,
      { minHistoryDays: opts.minHistoryDays, maxStalenessDays: opts.maxStalenessDays },
    )
    if (!eligibility.eligible) {
      excludedOut.push({ underlyingId, reason: eligibility.reason! })
      continue
    }

    const windowSamples = bars.filter((b) => {
      const ms = new Date(b.closeTimeIso).getTime()
      return ms >= lookbackStartMs && ms < formationMs
    })
    if (windowSamples.length === 0) {
      excludedOut.push({ underlyingId, reason: `no volume samples in the ${lookbackDays}-day ranking window` })
      continue
    }
    // Never silently average through an unknown (NaN) volume value --
    // an asset whose window contains even one pre-quote_volume bar is
    // excluded from THIS formation's ranking, not given a corrupted
    // partial mean. Re-ingesting 1d bars with quote_volume resolves this
    // permanently, not a per-run workaround.
    const hasUnknownVolume = windowSamples.some((s) => !Number.isFinite(s.quoteVolume))
    if (hasUnknownVolume) {
      excludedOut.push({ underlyingId, reason: 'one or more bars in the ranking window has no quote_volume (pre-2026-10-09 ingestion)' })
      continue
    }

    const advUsd30d = windowSamples.reduce((sum, s) => sum + s.quoteVolume, 0) / windowSamples.length
    candidates.push({ underlyingId, advUsd30d })
  }

  candidates.sort((a, b) => b.advUsd30d - a.advUsd30d)
  const top = candidates.slice(0, maxUniverseSize)
  const members: RankedUniverseMember[] = top.map((c, i) => ({ underlyingId: c.underlyingId, rank: i + 1, advUsd30d: c.advUsd30d }))

  for (const c of candidates.slice(maxUniverseSize)) {
    excludedOut.push({ underlyingId: c.underlyingId, reason: `ranked below the top ${maxUniverseSize}` })
  }

  return { members, excluded: excludedOut }
}

export interface UniverseMembershipRow {
  formationDate: string // YYYY-MM-DD
  underlyingId: ResearchSymbol
  rank: number
  advUsd30d: number
  universeVersion: string
}

function toDbRow(row: UniverseMembershipRow) {
  return {
    formation_date: row.formationDate,
    underlying_id: row.underlyingId,
    rank: row.rank,
    adv_usd_30d: row.advUsd30d,
    universe_version: row.universeVersion,
  }
}

export async function upsertUniverseMembership(supabase: SupabaseClient, rows: readonly UniverseMembershipRow[]): Promise<void> {
  if (rows.length === 0) return
  const { error } = await supabase.from('research_universe_membership').upsert(rows.map(toDbRow), { onConflict: 'formation_date,underlying_id,universe_version' })
  if (error) throw new Error(`upsertUniverseMembership: ${error.message}`)
}
