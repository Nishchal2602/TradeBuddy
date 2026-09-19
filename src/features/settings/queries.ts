import { supabase } from '@/supabase'
import type { AssetSymbol } from '@/shared/market-data/types.ts'
import type { RiskAppetite } from '@/shared/risk/appetite-mapping.ts'

export interface FullAgentSettings {
  isPaused: boolean
  decisionIntervalMinutes: number
  monitorIntervalMinutes: number
  newsLookbackOverlapMinutes: number
  maxDataStalenessMinutes: number
  assets: AssetSymbol[]
  riskAppetite: RiskAppetite
  feeBps: number
  slippageBps: number
  maxSingleTradePct: number
  maxAssetExposurePct: number
  stopOutReentryBlockMinutes: number
  minStopLossPct: number
  maxStopLossPct: number
  minTakeProfitPct: number
  maxTakeProfitPct: number
}

/** The full agent_settings row — Home only ever needed a handful of these
 * columns (features/home/queries.ts's own AgentSettingsSummary); Settings
 * is the one screen whose whole job is showing the rest, so this is a
 * separate, wider read rather than widening Home's summary type for a
 * consumer that isn't Home. */
export async function fetchFullAgentSettings(): Promise<FullAgentSettings> {
  const { data, error } = await supabase.from('agent_settings').select('*').single()
  if (error) throw new Error(`could not load agent settings: ${error.message}`)
  return {
    isPaused: data.is_paused,
    decisionIntervalMinutes: data.decision_interval_minutes,
    monitorIntervalMinutes: data.monitor_interval_minutes,
    newsLookbackOverlapMinutes: data.news_lookback_overlap_minutes,
    maxDataStalenessMinutes: data.max_data_staleness_minutes,
    assets: data.assets,
    riskAppetite: data.risk_appetite,
    feeBps: data.fee_bps,
    slippageBps: data.slippage_bps,
    maxSingleTradePct: Number(data.max_single_trade_pct),
    maxAssetExposurePct: Number(data.max_asset_exposure_pct),
    stopOutReentryBlockMinutes: data.stop_out_reentry_block_minutes,
    minStopLossPct: Number(data.min_stop_loss_pct),
    maxStopLossPct: Number(data.max_stop_loss_pct),
    minTakeProfitPct: Number(data.min_take_profit_pct),
    maxTakeProfitPct: Number(data.max_take_profit_pct),
  }
}
