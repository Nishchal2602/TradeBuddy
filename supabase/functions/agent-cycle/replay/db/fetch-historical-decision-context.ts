import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssetSymbol } from '../../../../../src/shared/market-data/types.ts'
import type { Direction } from '../../../../../src/shared/positions/types.ts'
import { toIsoZ } from '../../db/row-mappers.ts'
import { IntradayLsConfig } from '../../../../../src/shared/strategy/config-schema.ts'

// CFG-1 Stage 2 (2026-10-06) — the per-decision audit-trail reads the
// golden-replay driver needs, kept in their own impure-shell module (zero
// logic beyond plain selects + the one point-in-time predicate each
// needs). A "golden window" row is a REPRODUCTION target: everything
// here is the REAL, already-happened state production read or wrote —
// never a simulation, never a different config than the row's own
// (see the Stage 2 plan's governing invariant).

export interface RealDecisionRow {
  id: string
  runId: string
  asset: AssetSymbol
  decidedAt: string
  action: string
  strategyConfigHash: string | null
  regimeState: string | null
  eligibleArms: string[] | null
  noCandidateReason: string | null
  armId: string | null
  direction: Direction | null
  bias: string | null
}

// Every intraday_ls candidate-eligible row in the window, oldest first —
// the exact set the driver replays and compares against. Scoped to
// strategy_config_hash IS NOT NULL (pre-Stage-1A rows carry no config
// provenance and are excluded, same discipline as market_bars'
// ingested_at exclusion).
//
// ALSO scoped to decision_type IN (NULL, 'candidate') — found live
// (2026-10-07), not assumed: an occupied asset produces TWO rows per
// (run_id, asset) (CLAUDE.md's own "occupied-asset shadow candidates"
// entry) — a 'management' row that deliberately carries NO arm_id/bias/
// opportunity_bar_ts, and a separate 'candidate' shadow row that does.
// detectCandidate recomputes the detection layer only (independent of
// occupancy), so its output can only ever match the CANDIDATE row — an
// unfiltered fetch pulls the management row too and reports a false
// mismatch that has nothing to do with replay correctness. NULL is
// included alongside 'candidate' to mirror this project's own
// `coalesce(decision_type, 'candidate')` convention (the unique index's
// own semantics) — in practice this window postdates the column
// existing at all, so every row already has one set.
export async function fetchRealDecisionsInWindow(
  supabase: SupabaseClient,
  fromIso: string,
  toIso: string,
): Promise<RealDecisionRow[]> {
  const { data, error } = await supabase
    .from('agent_decisions')
    .select('id, run_id, asset, decided_at, action, strategy_config_hash, regime_state, eligible_arms, no_candidate_reason, arm_id, direction, bias')
    .gte('decided_at', fromIso)
    .lte('decided_at', toIso)
    .not('strategy_config_hash', 'is', null)
    .or('decision_type.is.null,decision_type.eq.candidate')
    .order('decided_at', { ascending: true })
  if (error) throw new Error(`fetchRealDecisionsInWindow: ${error.message}`)
  return (data ?? []).map((r) => ({
    id: r.id,
    runId: r.run_id,
    asset: r.asset,
    decidedAt: toIsoZ(r.decided_at),
    action: r.action,
    strategyConfigHash: r.strategy_config_hash,
    regimeState: r.regime_state,
    eligibleArms: r.eligible_arms,
    noCandidateReason: r.no_candidate_reason,
    armId: r.arm_id,
    direction: r.direction,
    bias: r.bias,
  }))
}

// The exact spot price that cycle's own Pass 1 read (market_snapshots is
// written unconditionally, once per asset per run, with a flat `price`
// column — see the Stage 2 plan's live-input inventory, row 5: this is
// NOT reconstructible from market_bars at all). One row per (run_id,
// asset) by construction.
export async function fetchHistoricalPrice(supabase: SupabaseClient, runId: string, asset: AssetSymbol): Promise<number> {
  const { data, error } = await supabase
    .from('market_snapshots')
    .select('price')
    .eq('run_id', runId)
    .eq('asset', asset)
    .single()
  if (error) throw new Error(`fetchHistoricalPrice: no market_snapshots row for run ${runId}/${asset}: ${error.message}`)
  return Number(data.price)
}

export interface HistoricalPosition {
  asset: AssetSymbol
  direction: Direction
}

// Positions genuinely open AT the exact instant asOfIso, reconstructed
// from the full (not just currently-open) positions table — a position
// counts as open at T iff opened_at <= T AND (closed_at IS NULL OR
// closed_at > T). This is REPRODUCTION of real history, never a
// simulated counterfactual portfolio (the Stage 2 plan's governing
// invariant) — these are the SAME positions production actually had.
export async function fetchOpenPositionsAsOf(supabase: SupabaseClient, portfolioId: string, asOfIso: string): Promise<HistoricalPosition[]> {
  const { data, error } = await supabase
    .from('positions')
    .select('asset, direction, opened_at, closed_at')
    .eq('portfolio_id', portfolioId)
    .lte('opened_at', asOfIso)
    .or(`closed_at.is.null,closed_at.gt.${asOfIso}`)
  if (error) throw new Error(`fetchOpenPositionsAsOf: ${error.message}`)
  return (data ?? []).map((r) => ({ asset: r.asset, direction: r.direction }))
}

export interface HistoricalAccountState {
  cash: number
  nav: number
  capturedAt: string
}

// The most recent nav_snapshot not AFTER asOfIso — real historical
// cash/NAV, never simulated.
export async function fetchAccountStateAsOf(supabase: SupabaseClient, portfolioId: string, asOfIso: string): Promise<HistoricalAccountState | null> {
  const { data, error } = await supabase
    .from('nav_snapshots')
    .select('cash, nav, captured_at')
    .eq('portfolio_id', portfolioId)
    .lte('captured_at', asOfIso)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`fetchAccountStateAsOf: ${error.message}`)
  if (!data) return null
  return { cash: Number(data.cash), nav: Number(data.nav), capturedAt: toIsoZ(data.captured_at) }
}

// The SAME query index.ts's own readLastConsumedOpportunityBarTs runs,
// with the ONE addition that makes this safe for replay: bounded to
// strictly BEFORE the row being replayed. An unbounded query (today's
// live max) would read decisions that happened AFTER the point being
// replayed — reading the future. agent_decisions is this project's
// immutable, append-only audit trail, so this bound is sufficient (see
// the Stage 2 plan's live-input inventory, lastConsumedBarTs row).
export async function fetchLastConsumedOpportunityBarTsBefore(
  supabase: SupabaseClient,
  portfolioId: string,
  asset: AssetSymbol,
  beforeIso: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('agent_decisions')
    .select('opportunity_bar_ts')
    .eq('portfolio_id', portfolioId)
    .eq('asset', asset)
    .not('opportunity_bar_ts', 'is', null)
    .lt('decided_at', beforeIso)
    .order('opportunity_bar_ts', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`fetchLastConsumedOpportunityBarTsBefore: ${error.message}`)
  return data ? toIsoZ(data.opportunity_bar_ts) : null
}

// Loaded by the row's OWN strategy_config_hash — never "currently
// active" (the Stage 2 plan's governing invariant: a reproduction engine
// replays each row under the config it actually ran under, not today's
// active one, which may since have changed).
export async function fetchConfigByHash(supabase: SupabaseClient, configHash: string): Promise<IntradayLsConfig | null> {
  const { data, error } = await supabase
    .from('strategy_configs')
    .select('config')
    .eq('config_hash', configHash)
    .maybeSingle()
  if (error) throw new Error(`fetchConfigByHash: ${error.message}`)
  if (!data) return null
  const parsed = IntradayLsConfig.safeParse(data.config)
  if (!parsed.success) throw new Error(`fetchConfigByHash: stored config for hash ${configHash} failed schema validation: ${parsed.error.message}`)
  return parsed.data
}
