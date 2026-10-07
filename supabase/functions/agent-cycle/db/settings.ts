import type { SupabaseClient } from '@supabase/supabase-js'
import type { RiskAppetite } from '../../../../src/shared/risk/appetite-mapping.ts'
import type { SlTpBounds } from '../../../../src/shared/risk/sl-tp.ts'
import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { StrategyProfile } from '../../../../src/shared/strategy/profiles.ts'

// EXP-1 Stage E3 (2026-10-07) — extracted from agent-cycle/index.ts (its
// original, sole home since the 2026-09-xx settings-resolution pass)
// into its own module so cycle-dispatcher can read the SAME global
// settings agent-cycle itself resolves every cycle (strategyProfile,
// the news-lookback/staleness constants via strategy/registry.ts's
// strategyFor(), and the fallback asset list), rather than duplicating
// the read a second time with its own column list to drift out of sync.
// Behavior unchanged from where it lived — same "extract once a second
// real caller exists" discipline as row-mappers.ts/market-bars.ts/
// db/news.ts before it.

export interface Settings {
  decisionIntervalMinutes: number
  newsLookbackOverlapMinutes: number
  maxDataStalenessMinutes: number
  assets: AssetSymbol[]
  feeBps: number
  slippageBps: number
  riskAppetite: RiskAppetite
  isPaused: boolean
  maxSingleTradePct: number
  maxAssetExposurePct: number
  stopOutReentryBlockMinutes: number
  slTpBounds: SlTpBounds
  // trading-strategy-v1.md §17 / §10 — resolved once per cycle, same as
  // every other setting above; portfolioRiskCeilingUsd/maxTotalNotionalUsd
  // themselves are NAV-dependent and computed fresh per asset below, not
  // stored here.
  portfolioRiskCeilingMultiplier: number
  maxTotalNotionalPct: number
  drawdownBreakerFloorPct: number
  newsVetoEnabled: boolean
  // Phase 2.1 (2026-09-23) — gates ONLY the portfolio-management layer
  // (HOLD/ADD/REDUCE/CLOSE/MODIFY_PROTECTION on an already-open
  // position), independent of newsVetoEnabled above (which gates ONLY
  // the entry-veto layer). The two shared one flag for the first hour of
  // Phase 2's deployment — a real defect, see
  // cycle/collect-candidates.ts's own comment for the fix.
  managementEnabled: boolean
  // Phase 2 (2026-09-22/23) — provisional minimum-trade-notional floor;
  // applies to ADD and a partial REDUCE only, never to a full CLOSE.
  minTradeNotionalPct: number
  minTradeNotionalUsd: number
  // Strategy profiles (2026-09-23) — which strategy generates every
  // asset's candidate this cycle. Read fresh every run (no in-memory
  // cache to go stale); resolved once into a full StrategyDefinition via
  // strategy/registry.ts's strategyFor() immediately below, in
  // runAgentCycle. Pass 1 of this migration: wiring only — resolving
  // 'balanced' produces byte-identical behavior to before this column
  // existed (src/shared/strategy/profiles.ts's own test suite proves
  // this), so nothing downstream changes yet.
  strategyProfile: StrategyProfile
  // Strategy V4 (2026-10-01) — perpetual-funding rate for a short
  // position (broker/accounting.ts's computeFundingAccrual) and the two
  // new intraday_ls-only monitor exits' own thresholds (plan §4.2/§4.3).
  // Global settings, not per-profile overrides — same discipline as
  // feeBps/slippageBps above, which every profile already shares.
  shortFundingBpsPerDay: number
  timeStopMinutes: number
  maxHoldMinutes: number
}

export async function readSettings(supabase: SupabaseClient): Promise<Settings> {
  const { data, error } = await supabase.from('agent_settings').select('*').single()
  if (error || !data) throw new Error(`could not read agent_settings: ${error?.message}`)
  return {
    decisionIntervalMinutes: data.decision_interval_minutes,
    newsLookbackOverlapMinutes: data.news_lookback_overlap_minutes,
    maxDataStalenessMinutes: data.max_data_staleness_minutes,
    assets: data.assets,
    feeBps: data.fee_bps,
    slippageBps: data.slippage_bps,
    riskAppetite: data.risk_appetite,
    isPaused: data.is_paused,
    maxSingleTradePct: Number(data.max_single_trade_pct),
    maxAssetExposurePct: Number(data.max_asset_exposure_pct),
    stopOutReentryBlockMinutes: data.stop_out_reentry_block_minutes,
    slTpBounds: {
      minStopLossPct: Number(data.min_stop_loss_pct),
      maxStopLossPct: Number(data.max_stop_loss_pct),
      minTakeProfitPct: Number(data.min_take_profit_pct),
      maxTakeProfitPct: Number(data.max_take_profit_pct),
    },
    portfolioRiskCeilingMultiplier: Number(data.portfolio_risk_ceiling_multiplier),
    maxTotalNotionalPct: Number(data.max_total_notional_pct),
    drawdownBreakerFloorPct: Number(data.drawdown_breaker_floor_pct),
    newsVetoEnabled: data.news_veto_enabled,
    managementEnabled: data.management_enabled,
    minTradeNotionalPct: Number(data.min_trade_notional_pct),
    minTradeNotionalUsd: Number(data.min_trade_notional_usd),
    strategyProfile: data.strategy_profile,
    shortFundingBpsPerDay: Number(data.short_funding_bps_per_day),
    timeStopMinutes: data.time_stop_minutes,
    maxHoldMinutes: data.max_hold_minutes,
  }
}
