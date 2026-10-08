import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { Bias } from '../strategy/intraday-ls/bias.ts'
import type { ArmFamily, ArmId, Direction } from '../strategy/intraday-ls/detectors.ts'
import type { ShadowCause } from '../strategy/intraday-ls/detect-all-opportunities.ts'

// STRAT-1 P3 (2026-10-08) — same pure-row-shaping / one-impure-write split
// as db/market-bars.ts. upsertShadowCandidates uses `ignoreDuplicates: true`
// deliberately: the unique key is the MARKET EVENT
// (asset, arm_id, trigger_bar_ts, detector_version), never the run or
// portfolio, so the first cycle/account to observe an event wins and every
// later rescan of the same bar is a harmless no-op, never an overwrite.

export interface ShadowCandidateRow {
  asset: AssetSymbol
  armId: ArmId | 'baseline_long' | 'baseline_short'
  armFamily: ArmFamily | 'baseline'
  direction: Direction
  detectorVersion: string
  triggerBarTs: string
  regimeDaily: 'UP' | 'DOWN'
  regime4h: 'Up' | 'Down'
  biasResolved: Bias
  shadowCause: ShadowCause | 'baseline'
  triggerBarClose: number
  referencePrice: number
  stopLossPct: number
  takeProfitPct: number
  stopLossPrice: number
  takeProfitPrice: number
  atrPct: number | null
  rsi14: number | null
  ret60mPct: number | null
  hourOfDay: number
  dayOfWeek: number
  strategyConfigHash: string | null
  portfolioId: string
  runId: string
}

function toDbRow(row: ShadowCandidateRow) {
  return {
    asset: row.asset,
    arm_id: row.armId,
    arm_family: row.armFamily,
    direction: row.direction,
    detector_version: row.detectorVersion,
    trigger_bar_ts: row.triggerBarTs,
    regime_daily: row.regimeDaily,
    regime_4h: row.regime4h,
    bias_resolved: row.biasResolved,
    shadow_cause: row.shadowCause,
    trigger_bar_close: row.triggerBarClose,
    reference_price: row.referencePrice,
    stop_loss_pct: row.stopLossPct,
    take_profit_pct: row.takeProfitPct,
    stop_loss_price: row.stopLossPrice,
    take_profit_price: row.takeProfitPrice,
    atr_pct: row.atrPct,
    rsi14: row.rsi14,
    ret_60m_pct: row.ret60mPct,
    hour_of_day: row.hourOfDay,
    day_of_week: row.dayOfWeek,
    strategy_config_hash: row.strategyConfigHash,
    portfolio_id: row.portfolioId,
    run_id: row.runId,
  }
}

// Non-fatal on failure — observational telemetry for the reward loop,
// never a trading action, same discipline as upsertMarketBars and the
// occupied-asset shadow insert in index.ts. A failure here must never
// block the real candidate's own dispatch.
export async function insertShadowCandidates(supabase: SupabaseClient, rows: readonly ShadowCandidateRow[]): Promise<void> {
  if (rows.length === 0) return
  const { error } = await supabase
    .from('shadow_candidates')
    .upsert(rows.map(toDbRow), { onConflict: 'asset,arm_id,trigger_bar_ts,detector_version', ignoreDuplicates: true })
  if (error) {
    console.error(`insertShadowCandidates: could not insert ${rows.length} shadow row(s): ${error.message}`)
  }
}
