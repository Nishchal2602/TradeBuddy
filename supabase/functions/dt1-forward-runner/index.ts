import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssetSymbol } from '../../../src/shared/market-data/types.ts'
import type { Direction, Position } from '../../../src/shared/positions/types.ts'
import { derivePositionState } from '../../../src/shared/positions/types.ts'
import type { RecentStopLossClose, RiskGateContext } from '../../../src/shared/risk/gate.ts'
import { evaluateRiskGate } from '../../../src/shared/risk/gate.ts'
import { closePosition, openPosition } from '../agent-cycle/broker/accounting.ts'
import { CoinGeckoMarketDataProvider } from '../agent-cycle/providers/coingecko.ts'
import { fetchRecentPricePoints } from '../agent-cycle/providers/coingecko.ts'
import { rowToPosition } from '../agent-cycle/db/row-mappers.ts'
import { findFirstTrigger, resolveFillPrice } from '../position-monitor/triggers.ts'
import { calculateATRPercent, InsufficientDataError } from '../agent-cycle/indicators/calculate.ts'
import { evaluateTrendRegime } from '../agent-cycle/strategy/regime.ts'
import { buildCandidateProposal } from '../agent-cycle/strategy/rules.ts'
import { R4_DAILY_TREND_CONFIG } from '../../../src/shared/strategy/daily-trend-presets.ts'
import { computeDailyTrendConfigHash } from '../agent-cycle/research/daily-trend-config.ts'

// DT-1 forward paper experiment (2026-10-09) — user decision (option 3):
// run DT-1's historical backtest as an explicitly underpowered research
// exercise WHILE starting a parallel 5-day FORWARD paper-trading test of
// R4's exact daily-trend config, live, on BTC/ETH only. User's own
// explicit implementation choice: "standalone daily cron, isolated from
// live trading code" — this function is never called by, and never calls
// into, agent-cycle/position-monitor/cycle-dispatcher. It owns BOTH the
// once-daily regime decision AND its own 10-minute stop-loss/take-profit
// protection check (cron: dt1-forward-runner-10min, */10 * * * *).
//
// Every strategy/risk/broker primitive below is the SAME pure function
// R4's own backtest (research/baseline-daily-trend.ts) calls — this file
// is deliberately a live-data shell around those functions, never a
// second implementation. See that file's inner loop (lines ~154-327) for
// the reference this mirrors.
//
// Two single-asset portfolios (dt1-forward-btc, dt1-forward-eth),
// $10,000 each — exactly how R4 itself backtested BTC and ETH (DT-1 plan
// §5.4: N single-asset sleeves, never a shared-NAV combined portfolio,
// which would newly activate portfolio_risk/total_notional caps R4's own
// per-asset runs never exercised).
//
// Positions are tagged opened_under_strategy_profile='balanced' — the
// EXACT literal R4's own backtest engine uses (baseline-daily-trend.ts
// line ~304) for this identical strategy. Verified live (2026-10-09)
// before relying on it: agent_settings.strategy_profile='intraday_ls' and
// the active intraday_ls config has givebackEnabledForIntradayLs=false,
// so position-monitor's giveback-ratchet EXIT (gated on the GLOBAL active
// profile, not a position's own tag — see position-monitor/plan.ts) is
// currently inert for ANY position regardless of tag. This function does
// NOT rely on position-monitor at all, by design (its own 10-minute tick
// below is the sole protection mechanism for these two positions) — the
// note above is recorded only so a future reader understands why
// 'balanced' was safe to reuse rather than inventing a new tag that would
// have required widening positions.opened_under_strategy_profile's own
// CHECK constraint.

const ASSETS: Array<{ asset: AssetSymbol; portfolioLabel: string }> = [
  { asset: 'BTC', portfolioLabel: 'dt1-forward-btc' },
  { asset: 'ETH', portfolioLabel: 'dt1-forward-eth' },
]

const STRATEGY_VERSION = 'dt1-forward-daily-trend-v1'

function floorToTenMinutesIso(nowIso: string): string {
  const ms = new Date(nowIso).getTime()
  const floored = Math.floor(ms / 600_000) * 600_000
  return new Date(floored).toISOString()
}

function utcDateString(iso: string): string {
  return iso.slice(0, 10) // ISO strings are always UTC ('Z'-suffixed) in this codebase
}

interface PortfolioRow {
  id: string
  cash: string | number
}

async function loadPortfolio(supabase: SupabaseClient, label: string): Promise<PortfolioRow> {
  const { data, error } = await supabase.from('portfolios').select('id, cash').eq('label', label).single()
  if (error || !data) throw new Error(`could not load portfolio '${label}': ${error?.message ?? 'not found'}`)
  return data as PortfolioRow
}

async function loadOpenPosition(supabase: SupabaseClient, portfolioId: string, asset: string): Promise<Position | null> {
  const { data, error } = await supabase.from('positions').select('*').eq('portfolio_id', portfolioId).eq('asset', asset).eq('status', 'open').maybeSingle()
  if (error) throw new Error(`could not load open position for ${asset}: ${error.message}`)
  return data ? rowToPosition(data as Record<string, unknown>) : null
}

async function loadRecentStopLossClose(supabase: SupabaseClient, portfolioId: string, asset: string): Promise<RecentStopLossClose | null> {
  const { data, error } = await supabase
    .from('positions')
    .select('direction, closed_at')
    .eq('portfolio_id', portfolioId)
    .eq('asset', asset)
    .eq('close_reason', 'stop_loss')
    .order('closed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`could not load recent stop-loss close for ${asset}: ${error.message}`)
  if (!data) return null
  return { direction: data.direction as Direction, closedAt: data.closed_at as string }
}

async function loadPeakNav(supabase: SupabaseClient, portfolioId: string, startingCapital: number): Promise<number> {
  const { data, error } = await supabase.from('nav_snapshots').select('nav').eq('portfolio_id', portfolioId).order('nav', { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error(`could not load peak NAV: ${error.message}`)
  return data ? Math.max(Number(data.nav), startingCapital) : startingCapital
}

async function hasTodaysRegimeDecision(supabase: SupabaseClient, portfolioId: string, asset: string, runDate: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('dt1_forward_decisions')
    .select('id')
    .eq('portfolio_id', portfolioId)
    .eq('asset', asset)
    .eq('run_date', runDate)
    .eq('decision_kind', 'daily_regime')
    .maybeSingle()
  if (error) throw new Error(`could not check today's regime decision: ${error.message}`)
  return data !== null
}

interface ForwardDecisionRow {
  portfolio_id: string
  asset: string
  run_date: string
  decision_kind: 'daily_regime' | 'protection_exit'
  regime?: string | null
  daily_close?: number | null
  daily_ma?: number | null
  atr_pct?: number | null
  action: 'OPEN_LONG' | 'HOLD' | 'CLOSE'
  close_trigger?: string | null
  stop_loss_price?: number | null
  take_profit_price?: number | null
  approved_size_pct?: number | null
  risk_status: string
  risk_reason?: string | null
  strategy_config_hash: string
  position_id?: string | null
}

async function insertForwardDecision(supabase: SupabaseClient, row: ForwardDecisionRow): Promise<void> {
  const { error } = await supabase.from('dt1_forward_decisions').insert(row)
  if (error) console.error(`could not insert dt1_forward_decisions row (${row.decision_kind}, ${row.asset}): ${error.message}`)
}

// trades.decision_id is nullable (for an automatic stop/target exit) but,
// when SET, carries a real FK into agent_decisions(id) — NOT NULL on that
// side of the relation. So every OPEN_LONG/agent-initiated-CLOSE needs a
// genuine agent_decisions row to reference, exactly like the live
// agent-cycle path. This is a MINIMAL row satisfying that schema (never
// reused/extended — dt1_forward_decisions, above, is the real audit
// layer for this strategy); Jev-specific fields are honestly sentinel-
// valued ('not-called'/'n/a'), matching this project's own established
// convention for a cycle where the model was never invoked.
interface AgentDecisionInsert {
  runId: string
  portfolioId: string
  asset: string
  action: 'OPEN_LONG' | 'HOLD' | 'CLOSE'
  reasons: unknown
  invalidation: unknown
  riskStatus: string
  riskReason?: string | null
  approvedSizePct?: number | null
  effectiveMinConfidence: number
  inputPayload: unknown
  outputPayload: unknown
}

async function insertAgentDecision(supabase: SupabaseClient, input: AgentDecisionInsert): Promise<string> {
  const risk = R4_DAILY_TREND_CONFIG.risk
  const { data, error } = await supabase
    .from('agent_decisions')
    .insert({
      run_id: input.runId,
      portfolio_id: input.portfolioId,
      asset: input.asset,
      action: input.action,
      confidence: 1, // vacuous by design — effective_min_confidence: 0 below gates nothing on it, same as every deterministic strategy in this project
      primary_driver: 'TECHNICAL',
      reasons: input.reasons,
      invalidation: input.invalidation,
      risk_status: input.riskStatus,
      risk_reason: input.riskReason ?? null,
      approved_size_pct: input.approvedSizePct ?? null,
      effective_min_confidence: input.effectiveMinConfidence,
      input_payload: input.inputPayload,
      output_payload: input.outputPayload,
      prompt_version: 'n/a-deterministic-only',
      model_version: 'not-called',
      // Denormalized sizing-cap columns every agent_decisions row must
      // carry (CFG-1's own observability work) — here they are simply
      // R4_DAILY_TREND_CONFIG's own frozen risk envelope, never a
      // per-cycle resolution against agent_settings/strategy_configs
      // (this strategy reads neither).
      effective_risk_budget_pct: risk.effectiveRiskBudgetPct,
      effective_single_trade_cap_pct: risk.effectiveSingleTradeCapPct,
      effective_asset_exposure_cap_pct: risk.effectiveAssetExposureCapPct,
      effective_portfolio_risk_ceiling_pct: risk.portfolioRiskCeilingMultiplier * risk.effectiveRiskBudgetPct,
      effective_max_total_notional_pct: risk.maxTotalNotionalPct,
      strategy_version: STRATEGY_VERSION,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`could not insert agent_decisions row: ${error?.message ?? 'no row returned'}`)
  return (data as { id: string }).id
}

// Mirrors agent-cycle/index.ts's own open_position_atomic / close_position_atomic
// call shape exactly (same RPCs, same parameter names) — this function never
// writes positions/trades directly, only through the same atomic path every
// other position-mutating code path in this project uses.
async function persistOpen(supabase: SupabaseClient, portfolioId: string, decisionId: string, openRes: ReturnType<typeof openPosition>): Promise<number> {
  const { position, trade } = openRes
  const { data, error } = await supabase.rpc('open_position_atomic', {
    p_position_id: position.id,
    p_portfolio_id: portfolioId,
    p_asset: position.asset,
    p_direction: position.direction,
    p_quantity: position.quantity,
    p_entry_price: position.entryPrice,
    p_cost_basis: position.costBasis,
    p_stop_loss_price: position.stopLossPrice,
    p_take_profit_price: position.takeProfitPrice,
    p_opened_at: position.openedAt,
    p_opened_by_decision_id: decisionId,
    p_trade_id: trade.id,
    p_side: trade.side,
    p_reference_price: trade.referencePrice,
    p_fill_price: trade.fillPrice,
    p_fee: trade.fee,
    p_slippage_cost: trade.slippageCost,
    p_gross_value: trade.grossValue,
    p_net_cash_delta: trade.netCashDelta,
    p_executed_at: trade.executedAt,
    p_intent: trade.intent,
    p_decision_id: decisionId,
    p_strategy_profile: position.openedUnderStrategyProfile,
  })
  if (error) throw new Error(`open_position_atomic failed: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  return Number(row?.cash_after ?? openRes.cashAfter)
}

async function persistClose(supabase: SupabaseClient, decisionId: string | null, closeRes: ReturnType<typeof closePosition>): Promise<number> {
  const { closedPosition, trade, realizedPnl } = closeRes
  const { data, error } = await supabase.rpc('close_position_atomic', {
    p_position_id: closedPosition.id,
    p_closed_at: closedPosition.closedAt,
    p_realized_pnl: realizedPnl,
    p_close_reason: closedPosition.closeReason,
    p_closed_by_decision_id: decisionId,
    p_trade_id: trade.id,
    p_side: trade.side,
    p_quantity: trade.quantity,
    p_reference_price: trade.referencePrice,
    p_fill_price: trade.fillPrice,
    p_fee: trade.fee,
    p_slippage_cost: trade.slippageCost,
    p_gross_value: trade.grossValue,
    p_net_cash_delta: trade.netCashDelta,
    p_executed_at: trade.executedAt,
    p_intent: trade.intent,
    p_decision_id: decisionId,
    p_trigger_reason: trade.triggerReason,
    p_funding_cost: trade.fundingCost,
  })
  if (error) throw new Error(`close_position_atomic failed: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row?.won_race) throw new Error('close_position_atomic lost the concurrent-close race (unexpected for an isolated single-writer portfolio)')
  return Number(row.cash_after)
}

async function claimTick(supabase: SupabaseClient, portfolioId: string, nowIso: string): Promise<string | null> {
  const idempotencyKey = `dt1-forward-${floorToTenMinutesIso(nowIso)}`
  const { data, error } = await supabase
    .from('agent_runs')
    .insert({ portfolio_id: portfolioId, idempotency_key: idempotencyKey, status: 'running', started_at: nowIso })
    .select('id')
    .single()
  if (error) {
    if (error.code === '23505') return null // duplicate tick for this 10-min window — already claimed
    throw new Error(`could not claim tick: ${error.message}`)
  }
  return (data as { id: string }).id
}

async function finishRun(supabase: SupabaseClient, runId: string, status: 'completed' | 'failed', errorDetail?: string): Promise<void> {
  await supabase.from('agent_runs').update({ status, completed_at: new Date().toISOString(), error_detail: errorDetail ?? null }).eq('id', runId)
}

async function writeNavSnapshot(supabase: SupabaseClient, portfolioId: string, runId: string, cash: number, position: Position | null, currentPrice: number | undefined, realizedPnlCum: number): Promise<void> {
  const positionsValue = position && currentPrice !== undefined
    ? position.direction === 'long' ? position.quantity * currentPrice : position.costBasis + (position.entryPrice - currentPrice) * position.quantity
    : 0
  const unrealizedPnl = position && currentPrice !== undefined
    ? (position.direction === 'long' ? (currentPrice - position.entryPrice) * position.quantity : (position.entryPrice - currentPrice) * position.quantity)
    : 0
  const nav = cash + Math.max(positionsValue, 0)
  await supabase.from('nav_snapshots').insert({
    portfolio_id: portfolioId,
    run_id: runId,
    cash,
    positions_value: Math.max(positionsValue, 0),
    nav,
    unrealized_pnl: unrealizedPnl,
    realized_pnl_cum: realizedPnlCum,
  })
}

async function sumRealizedPnl(supabase: SupabaseClient, portfolioId: string, asset: string): Promise<number> {
  const { data, error } = await supabase.from('trades').select('realized_pnl').eq('portfolio_id', portfolioId).eq('asset', asset)
  if (error) throw new Error(`could not sum realized pnl: ${error.message}`)
  // Diagnostic-only (nav_snapshots display), never a decision input — the
  // actual cash balance (persisted via the atomic RPCs) is what drives
  // every sizing/gate decision, not this derived figure.
  return (data ?? []).reduce((sum, t) => sum + Number((t as { realized_pnl: number | null }).realized_pnl ?? 0), 0)
}

async function processAssetPortfolio(supabase: SupabaseClient, asset: AssetSymbol, portfolioLabel: string, coingeckoApiKey: string | undefined, configHash: string): Promise<{ asset: AssetSymbol; ok: boolean; detail?: string }> {
  const nowIso = new Date().toISOString()
  const portfolio = await loadPortfolio(supabase, portfolioLabel)
  const portfolioId = portfolio.id
  let cash = Number(portfolio.cash)

  const runId = await claimTick(supabase, portfolioId, nowIso)
  if (!runId) {
    console.log(`[${asset}] duplicate tick for this 10-minute window — already claimed, skipping`)
    return { asset, ok: true, detail: 'duplicate_tick' }
  }

  try {
    let openPos = await loadOpenPosition(supabase, portfolioId, asset)
    let latestPrice: number | undefined

    // --- Step 1: protection check (every tick, if a position is open) ---
    if (openPos) {
      const pointsByAsset = await fetchRecentPricePoints([asset], fetch, undefined, coingeckoApiKey)
      const points = pointsByAsset[asset] ?? []
      latestPrice = points.length > 0 ? points[points.length - 1]!.price : undefined
      const trigger = findFirstTrigger(openPos.direction, openPos.stopLossPrice, openPos.takeProfitPrice, points)
      if (trigger.triggered) {
        const fillPrice = resolveFillPrice(trigger)
        const closeRes = closePosition({
          position: openPos,
          attemptedFillPrice: fillPrice,
          feeBps: R4_DAILY_TREND_CONFIG.risk.feeBps,
          slippageBps: R4_DAILY_TREND_CONFIG.risk.slippageBps,
          closeReason: trigger.reason,
          decisionId: null,
          startingCash: cash,
          nowIso: trigger.triggeredAt,
          shortFundingBpsPerDay: 0, // R4 is long/flat only — never a short, never funding
        })
        cash = await persistClose(supabase, null, closeRes)
        await insertForwardDecision(supabase, {
          portfolio_id: portfolioId,
          asset,
          run_date: utcDateString(trigger.triggeredAt),
          decision_kind: 'protection_exit',
          action: 'CLOSE',
          close_trigger: trigger.reason as 'stop_loss' | 'take_profit',
          risk_status: 'not_applicable',
          strategy_config_hash: configHash,
          position_id: closeRes.closedPosition.id,
        })
        openPos = null
        console.log(`[${asset}] protection exit: ${trigger.reason} at ${fillPrice}`)
      }
    }

    // --- Step 2: the once-daily regime decision ---
    const today = utcDateString(nowIso)
    const alreadyDecidedToday = await hasTodaysRegimeDecision(supabase, portfolioId, asset, today)
    if (!alreadyDecidedToday) {
      const provider = new CoinGeckoMarketDataProvider(fetch, undefined, coingeckoApiKey)
      const [marketData] = await provider.getMarketData([asset])
      if (!marketData) throw new Error(`no market data returned for ${asset}`)
      latestPrice = marketData.price

      let atrPct: number
      try {
        atrPct = calculateATRPercent(marketData.candles, R4_DAILY_TREND_CONFIG.strategy.atrPeriod)
      } catch (e) {
        if (e instanceof InsufficientDataError) {
          console.log(`[${asset}] insufficient 4h candle data for ATR — skipping today's regime decision`)
          await finishRun(supabase, runId, 'completed')
          await writeNavSnapshot(supabase, portfolioId, runId, cash, openPos, latestPrice, await sumRealizedPnl(supabase, portfolioId, asset))
          return { asset, ok: true, detail: 'insufficient_atr_data' }
        }
        throw e
      }

      let regime
      try {
        regime = evaluateTrendRegime(marketData.dailyCloseSeries)
      } catch (e) {
        console.log(`[${asset}] insufficient daily close data for regime (${e instanceof Error ? e.message : String(e)}) — skipping today's regime decision`)
        await finishRun(supabase, runId, 'completed')
        await writeNavSnapshot(supabase, portfolioId, runId, cash, openPos, latestPrice, await sumRealizedPnl(supabase, portfolioId, asset))
        return { asset, ok: true, detail: 'insufficient_regime_data' }
      }

      const currentState = derivePositionState(openPos)
      const candidate = buildCandidateProposal({ asset, currentState, regime, atrPct })
      const inputPayload = { regime: regime.regime, dailyClose: regime.dailyClose, dailyMa: regime.dailyMa, atrPct, price: marketData.price }

      if (candidate.action === 'CLOSE' && openPos) {
        const decisionId = await insertAgentDecision(supabase, {
          runId, portfolioId, asset, action: 'CLOSE',
          reasons: candidate.reasons, invalidation: candidate.invalidation,
          riskStatus: 'not_applicable', effectiveMinConfidence: R4_DAILY_TREND_CONFIG.risk.effectiveMinConfidence,
          inputPayload, outputPayload: { action: 'CLOSE', closeReason: 'agent_close' },
        })
        const closeRes = closePosition({
          position: openPos,
          attemptedFillPrice: marketData.price,
          feeBps: R4_DAILY_TREND_CONFIG.risk.feeBps,
          slippageBps: R4_DAILY_TREND_CONFIG.risk.slippageBps,
          closeReason: 'agent_close',
          decisionId,
          startingCash: cash,
          nowIso,
          shortFundingBpsPerDay: 0,
        })
        cash = await persistClose(supabase, decisionId, closeRes)
        await insertForwardDecision(supabase, {
          portfolio_id: portfolioId, asset, run_date: today, decision_kind: 'daily_regime',
          regime: regime.regime, daily_close: regime.dailyClose, daily_ma: regime.dailyMa, atr_pct: atrPct,
          action: 'CLOSE', close_trigger: 'agent_close', risk_status: 'not_applicable',
          strategy_config_hash: configHash, position_id: closeRes.closedPosition.id,
        })
        openPos = null
        console.log(`[${asset}] regime flip — CLOSE`)
      } else if (candidate.action === 'OPEN_LONG') {
        const recentStopLossClose = await loadRecentStopLossClose(supabase, portfolioId, asset)
        const peakNav = await loadPeakNav(supabase, portfolioId, R4_DAILY_TREND_CONFIG.risk.startingCapitalUsd)
        const risk = R4_DAILY_TREND_CONFIG.risk
        const context: RiskGateContext = {
          currentState: 'FLAT',
          entryPrice: marketData.price,
          nav: cash, // FLAT — no open position exists in this single-asset portfolio
          cash,
          effectiveMinConfidence: risk.effectiveMinConfidence,
          effectiveRiskBudgetPct: risk.effectiveRiskBudgetPct,
          effectiveSingleTradeCapPct: risk.effectiveSingleTradeCapPct,
          effectiveAssetExposureCapPct: risk.effectiveAssetExposureCapPct,
          slTpBounds: R4_DAILY_TREND_CONFIG.slTpBounds,
          currentAssetExposureUsd: 0,
          stopOutReentryBlockMinutes: risk.stopOutReentryBlockMinutes,
          recentStopLossClose,
          nowIso,
          portfolioRiskCeilingUsd: risk.portfolioRiskCeilingMultiplier * risk.effectiveRiskBudgetPct * cash,
          otherOpenPositionsRiskAtStopUsd: 0, // single-asset portfolio — never another open position to aggregate
          maxTotalNotionalUsd: risk.maxTotalNotionalPct * cash,
          otherSameDirectionNotionalUsd: 0,
          peakNav,
          drawdownBreakerFloorPct: risk.drawdownBreakerFloorPct,
          openPosition: null,
          feeBps: risk.feeBps,
          slippageBps: risk.slippageBps,
          minTradeNotionalPct: 0,
          minTradeNotionalUsd: 0,
        }
        const gateResult = evaluateRiskGate(candidate, context)
        const decisionId = await insertAgentDecision(supabase, {
          runId, portfolioId, asset, action: 'OPEN_LONG',
          reasons: candidate.reasons, invalidation: candidate.invalidation,
          riskStatus: gateResult.riskStatus, riskReason: gateResult.riskReason,
          approvedSizePct: gateResult.approvedSizePct,
          effectiveMinConfidence: risk.effectiveMinConfidence,
          inputPayload, outputPayload: { riskStatus: gateResult.riskStatus, approvedSizePct: gateResult.approvedSizePct, computedStopLossPrice: gateResult.computedStopLossPrice, computedTakeProfitPrice: gateResult.computedTakeProfitPrice },
        })
        let openedPositionId: string | null = null
        if ((gateResult.riskStatus === 'approved' || gateResult.riskStatus === 'clamped') && gateResult.approvedSizePct !== null) {
          const notionalUsd = gateResult.approvedSizePct * cash
          const openRes = openPosition({
            asset,
            direction: 'long',
            referencePrice: marketData.price,
            notionalUsd,
            stopLossPrice: gateResult.computedStopLossPrice!,
            takeProfitPrice: gateResult.computedTakeProfitPrice!,
            feeBps: risk.feeBps,
            slippageBps: risk.slippageBps,
            portfolioId,
            decisionId,
            startingCash: cash,
            nowIso,
            strategyProfile: 'balanced', // the exact literal R4's own backtest engine uses for this strategy
          })
          cash = await persistOpen(supabase, portfolioId, decisionId, openRes)
          openedPositionId = openRes.position.id
          openPos = openRes.position // the final NAV snapshot below must see the position this tick just opened, not the stale pre-tick null
          console.log(`[${asset}] OPEN_LONG approved, size=${gateResult.approvedSizePct}`)
        } else {
          console.log(`[${asset}] OPEN_LONG rejected: ${gateResult.riskReason}`)
        }
        await insertForwardDecision(supabase, {
          portfolio_id: portfolioId, asset, run_date: today, decision_kind: 'daily_regime',
          regime: regime.regime, daily_close: regime.dailyClose, daily_ma: regime.dailyMa, atr_pct: atrPct,
          action: 'OPEN_LONG', stop_loss_price: gateResult.computedStopLossPrice, take_profit_price: gateResult.computedTakeProfitPrice,
          approved_size_pct: gateResult.approvedSizePct, risk_status: gateResult.riskStatus, risk_reason: gateResult.riskReason,
          strategy_config_hash: configHash, position_id: openedPositionId,
        })
      } else {
        await insertAgentDecision(supabase, {
          runId, portfolioId, asset, action: 'HOLD',
          reasons: candidate.reasons, invalidation: candidate.invalidation,
          riskStatus: 'not_applicable', effectiveMinConfidence: R4_DAILY_TREND_CONFIG.risk.effectiveMinConfidence,
          inputPayload, outputPayload: { action: 'HOLD' },
        })
        await insertForwardDecision(supabase, {
          portfolio_id: portfolioId, asset, run_date: today, decision_kind: 'daily_regime',
          regime: regime.regime, daily_close: regime.dailyClose, daily_ma: regime.dailyMa, atr_pct: atrPct,
          action: 'HOLD', risk_status: 'not_applicable',
          strategy_config_hash: configHash, position_id: openPos?.id ?? null,
        })
        console.log(`[${asset}] HOLD (regime=${regime.regime})`)
      }
    }

    await finishRun(supabase, runId, 'completed')
    await writeNavSnapshot(supabase, portfolioId, runId, cash, openPos, latestPrice, await sumRealizedPnl(supabase, portfolioId, asset))
    return { asset, ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`[${asset}] run failed: ${message}`)
    await finishRun(supabase, runId, 'failed', message)
    return { asset, ok: false, detail: message }
  }
}

Deno.serve(async (_req) => {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const coingeckoApiKey = Deno.env.get('COINGECKO_API_KEY') || undefined
  const configHash = await computeDailyTrendConfigHash(R4_DAILY_TREND_CONFIG)

  const settled = await Promise.allSettled(
    ASSETS.map(({ asset, portfolioLabel }) => processAssetPortfolio(supabase, asset, portfolioLabel, coingeckoApiKey, configHash)),
  )
  // Every real failure is caught INSIDE processAssetPortfolio (so the run's
  // own agent_runs row gets marked 'failed' with a reason) and returned as
  // {ok:false}, never re-thrown — so allSettled's own 'rejected' branch
  // should structurally never fire here. Checked anyway, defensively, for
  // a truly unexpected throw (e.g. a bug in processAssetPortfolio itself
  // before its try/catch starts).
  const results = settled.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { asset: ASSETS[i]!.asset, ok: false, detail: String(r.reason) },
  )
  const failures = results.filter((r) => !r.ok)
  for (const f of failures) console.error('dt1-forward-runner tick failure:', f)

  return new Response(
    JSON.stringify({ strategyVersion: STRATEGY_VERSION, configHash, results }),
    { headers: { 'Content-Type': 'application/json' }, status: failures.length === ASSETS.length ? 500 : 200 },
  )
})
