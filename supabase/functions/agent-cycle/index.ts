import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CoinGeckoMarketDataProvider, fetchIntradayMarketData } from './providers/coingecko.ts'
import { RssNewsProvider } from './providers/rss-news.ts'
import { requestPortfolioDecisions, JEV_QUESTION_VERSION, JEV_VETO_THRESHOLD, MANAGEMENT_QUESTION_VERSION } from './model/jev/provider.ts'
import type { VetoOutcome, ManagementOutcome } from './model/jev/provider.ts'
import type { AggressiveManagementContext } from './model/jev/management-question.ts'
import type { EntryOpportunityInput, EntryOutcome } from './model/jev/entry-question.ts'
import { ENTRY_QUESTION_VERSION } from './model/jev/entry-question.ts'
import { buildPortfolioConstraints, buildAssetInput, buildRiskGateContext, checkMarketDataFreshness, aggregateOtherOpenPositionsRisk } from './cycle/build-context.ts'
import type { PersistedNewsItem } from './cycle/build-context.ts'
import { evaluateTrendRegime } from './strategy/regime.ts'
import { buildCandidateProposal, vetoedHoldProposal } from './strategy/rules.ts'
import { applyVetoOutcome } from './cycle/apply-veto.ts'
import { applyManagementOutcome } from './cycle/apply-management.ts'
import type { ManagementPositionContext } from './cycle/apply-management.ts'
import { collectModelCandidates, shouldCallModel } from './cycle/collect-candidates.ts'
import { planDecisionExecution } from './cycle/plan-decision.ts'
import { derivePrimaryDriver, citedNewsIds } from './cycle/decision-record.ts'
import { computeNav } from './broker/accounting.ts'
import { rowToPosition, toIsoZ } from './db/row-mappers.ts'
import { toQuoteRow } from './db/quote-rows.ts'
import { buildDecisionIdempotencyKey, classifyRunInsertConflict, parseTrigger, staleRunCutoffIso } from './cycle/idempotency.ts'
import type { CycleTrigger } from './cycle/idempotency.ts'
import { checkStrategyDataSufficiency, clearsEntryTradeabilityFloor, detectAggressiveOpportunity, intradayFeaturesFor, managementAtrPctFor, protectionForEntry, strategyFor } from './strategy/registry.ts'
import type { StrategyProfile } from '../../../src/shared/strategy/profiles.ts'
import type { OpportunitySignal } from './strategy/aggressive/detectors.ts'
import type { IntradayMarketData } from './strategy/aggressive/types.ts'
import { stopLossPctFor, takeProfitPctFor } from './strategy/rules.ts'
import { computePositionPnlR, computePriceR } from './strategy/aggressive/protection.ts'
import { riskAppetiteThresholds } from '../../../src/shared/risk/appetite-mapping.ts'
import type { RiskAppetite } from '../../../src/shared/risk/appetite-mapping.ts'
import type { SlTpBounds } from '../../../src/shared/risk/sl-tp.ts'
import type { RecentStopLossClose } from '../../../src/shared/risk/gate.ts'
import { evaluateRiskGate } from '../../../src/shared/risk/gate.ts'
import { deriveRiskBasedNotional } from '../../../src/shared/risk/sizing.ts'
import type { AssetSymbol, NormalizedMarketData } from '../../../src/shared/market-data/types.ts'
import type { Position } from '../../../src/shared/positions/types.ts'
import type { InvalidationCondition, Action, ModelDecisionProposal } from '../../../src/shared/decisions/types.ts'
import type { RegimeResult } from '../../../src/shared/strategy/types.ts'
import type { AssetInput, ModelCallPayload, RecentDecisionInput } from './model/payload.ts'
import type { NormalizedNewsItem } from '../../../src/shared/news/types.ts'

// The thin I/O shell around the pure decision core (cycle/build-context.ts,
// cycle/plan-decision.ts, cycle/decision-record.ts) and every
// already-tested building block from Steps 2-6 — architecture.md's Agent
// Cycle, 14 steps (step 14, "surface to the extension," needs no code
// here: the extension reads persisted state via its existing anon-key
// REST access). No accounting math, risk logic, or model-calling logic
// lives in this file.

interface Settings {
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
}

async function readSettings(supabase: SupabaseClient): Promise<Settings> {
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
  }
}

// Upserts on external_id (dedupes a story re-seen inside the overlapping
// lookback window) and returns every row — new or pre-existing — with its
// real news_items.id, since reasons[].newsId (src/shared/decisions/
// types.ts) is validated as a UUID the model cites back: only a
// persisted item has one. Only the columns this upsert actually sets are
// touched on a pre-existing row (PostgREST's merge-duplicates resolution
// updates exactly the provided columns) — ingested_at's own DEFAULT
// now() is never re-applied to an already-ingested story.
async function persistNews(supabase: SupabaseClient, items: NormalizedNewsItem[]): Promise<Map<string, PersistedNewsItem>> {
  if (items.length === 0) return new Map()
  const { data, error } = await supabase
    .from('news_items')
    .upsert(
      items.map((i) => ({
        external_id: i.externalId,
        source: i.source,
        headline: i.headline,
        summary: i.summary,
        url: i.url,
        assets: i.assets,
        published_at: i.publishedAt,
        raw: i.raw,
      })),
      { onConflict: 'external_id' },
    )
    .select('id, external_id, source, headline, summary, published_at')
  if (error) throw new Error(`could not persist news_items: ${error.message}`)

  const byExternalId = new Map<string, PersistedNewsItem>()
  for (const row of data ?? []) {
    byExternalId.set(row.external_id, {
      id: row.id,
      source: row.source,
      headline: row.headline,
      summary: row.summary,
      publishedAt: toIsoZ(row.published_at),
    })
  }
  return byExternalId
}

async function readOpenPosition(supabase: SupabaseClient, portfolioId: string, asset: AssetSymbol): Promise<Position | null> {
  const { data, error } = await supabase.from('positions').select('*').eq('portfolio_id', portfolioId).eq('asset', asset).eq('status', 'open').maybeSingle()
  if (error) throw new Error(`could not read open position for ${asset}: ${error.message}`)
  return data ? rowToPosition(data) : null
}

async function readRecentStopLossClose(supabase: SupabaseClient, portfolioId: string, asset: AssetSymbol): Promise<RecentStopLossClose | null> {
  const { data, error } = await supabase
    .from('positions')
    .select('direction, closed_at')
    .eq('portfolio_id', portfolioId)
    .eq('asset', asset)
    .eq('close_reason', 'stop_loss')
    .order('closed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`could not read recent stop-loss close for ${asset}: ${error.message}`)
  return data ? { direction: data.direction, closedAt: toIsoZ(data.closed_at) } : null
}

// trading-strategy-v1.md §17.3 — the portfolio's own highest-ever NAV.
// Stateless (max(nav_snapshots.nav), no new table); read once at the top
// of the cycle, not re-read as this run's own nav moves, since a
// snapshot for THIS run isn't written until the very end (see the
// bottom of runAgentCycle) — "peak" here means the peak as of the start
// of this cycle, exactly what the drawdown breaker is meant to compare
// against. A portfolio with no snapshots yet (its very first cycle)
// returns 0, matching gate.ts's own `peakNav > 0` guard for that case.
async function readPeakNav(supabase: SupabaseClient, portfolioId: string): Promise<number> {
  const { data, error } = await supabase
    .from('nav_snapshots')
    .select('nav')
    .eq('portfolio_id', portfolioId)
    .order('nav', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`could not read peak NAV: ${error.message}`)
  return data ? Number(data.nav) : 0
}

// The most recent non-empty invalidation recorded against this position —
// not necessarily its opening decision, since a later HOLD may have
// already reaffirmed or revised it (prompt.ts's invalidation section).
// Walked in application code (limit 10, newest first) rather than
// filtered for "non-empty jsonb array" in the query itself, to avoid
// depending on PostgREST JSONB filter syntax this codebase hasn't
// otherwise needed — a position can't realistically go 10 decisions
// without one, since an OPEN always requires non-empty invalidation.
async function readOpenInvalidation(supabase: SupabaseClient, positionId: string): Promise<InvalidationCondition[]> {
  const { data, error } = await supabase
    .from('agent_decisions')
    .select('invalidation')
    .eq('position_id', positionId)
    .order('decided_at', { ascending: false })
    .limit(10)
  if (error) throw new Error(`could not read prior invalidation for position ${positionId}: ${error.message}`)
  for (const row of data ?? []) {
    const invalidation = row.invalidation as InvalidationCondition[]
    if (invalidation.length > 0) return invalidation
  }
  return []
}

async function readRecentDecisions(supabase: SupabaseClient, portfolioId: string, asset: AssetSymbol, limit = 3): Promise<RecentDecisionInput[]> {
  const { data, error } = await supabase
    .from('agent_decisions')
    .select('decided_at, action, confidence, invalidation')
    .eq('portfolio_id', portfolioId)
    .eq('asset', asset)
    .order('decided_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`could not read recent decisions for ${asset}: ${error.message}`)
  return (data ?? []).reverse().map((row) => ({
    decidedAt: toIsoZ(row.decided_at),
    action: row.action as Action,
    confidence: Number(row.confidence),
    invalidation: row.invalidation as InvalidationCondition[],
  }))
}

export interface CycleSummary {
  status: 'completed' | 'skipped' | 'duplicate_tick' | 'already_running' | 'failed'
  runId?: string
  decisions: { asset: AssetSymbol; action: string; riskStatus: string }[]
  detail?: string
}

export interface CycleDeps {
  supabase: SupabaseClient
  // Gemini removed entirely (2026-09-22) — Jev is the sole model
  // provider, no fallback. A single key, not an array: the old
  // multi-key rotation loop existed because Gemini's free tier issued
  // several keys; TypeSafe's is a normal single-key API.
  typesafeApiKey: string
  // deno-lint-ignore no-explicit-any
  fetchImpl?: any
  // The single instant the whole cycle's business logic treats as "now"
  // (idempotency bucket, staleness checks, decided_at, etc.) — captured
  // once at request start so every check inside one cycle agrees on the
  // same clock reading. agent_runs.completed_at deliberately does NOT
  // reuse this value (2026-09-22 fix) — every completion site instead
  // calls `new Date().toISOString()` at the moment it actually completes,
  // so a run's real wall-clock duration is measurable. Reusing nowIso
  // here previously meant every single row recorded an identical
  // started_at/completed_at and therefore an artifactual 0.00s duration,
  // regardless of how long the cycle actually took.
  nowIso: string
  // "Manual idempotency" plan (2026-09-22) — manual (the extension's Run
  // agent button) gets a per-click key so multiple deliberate clicks in
  // one 3-hour window all execute; scheduled (a future cron, once one
  // exists) keeps the unchanged bucketed key. See cycle/idempotency.ts.
  trigger: CycleTrigger
  // CoinGecko Demo API key (2026-09-22) — optional, same "degrade to the
  // stricter keyless rate limit rather than throw" reasoning as every
  // other optional param coingecko.ts threads this through. Read from
  // Deno.env.get('COINGECKO_API_KEY') by the Deno.serve handler below;
  // kept here (not read directly inside this function) so tests can
  // inject a fixed value without touching real env vars.
  coingeckoApiKey?: string
}

// Aggressive V3.1 profit recycling (2026-09-23) — assembles the
// Aggressive-only management context (cycle/collect-candidates.ts's
// CandidateSource.aggressive, forwarded verbatim into
// ManagementCandidateInput.aggressive) for one open position, or
// undefined when it doesn't apply. This is the fix for the diagnosis
// finding that a real Jev management call previously carried NONE of
// this state — only the 13 required JevPositionSnapshot fields.
//
// undefined (no Aggressive context sent this cycle) whenever:
//   - the active profile isn't 'aggressive' (Balanced's snapshot must stay
//     byte-identical — see management-question.test.ts)
//   - there is no open position for this asset
//   - no intraday data was fetched for this asset this cycle (mirrors
//     managementAtrPctFor's own "never silently fall back" discipline)
//   - the position's immutable ruler was never captured (a legacy
//     position the guarded backfill excluded because its stop had
//     already moved before this migration — profile-recycling plan §5.5)
function buildAggressiveManagementContext(
  strategyProfile: StrategyProfile,
  openPosition: Position | null,
  intraday: IntradayMarketData | undefined,
  currentPrice: number,
  feeBps: number,
  slippageBps: number,
  nowIso: string,
): AggressiveManagementContext | undefined {
  if (strategyProfile !== 'aggressive' || !openPosition || !intraday) return undefined
  const { initialEntryPrice, initialStopLossPrice, initialRiskUsd } = openPosition
  if (initialEntryPrice === null || initialEntryPrice === undefined) return undefined
  if (initialStopLossPrice === null || initialStopLossPrice === undefined) return undefined
  if (initialRiskUsd === null || initialRiskUsd === undefined) return undefined

  const features = intradayFeaturesFor(intraday)
  // Deterministic broker round-trip cost for the CURRENT quantity, both
  // sides — the same formula buildPositionSnapshot's own
  // estimatedRoundTripCostPct uses, in USD rather than a percentage
  // (computeCostR's numerator wants an absolute dollar figure against the
  // immutable initialRiskUsd denominator).
  const currentRoundTripCostUsd = ((2 * (feeBps + slippageBps)) / 10_000) * openPosition.quantity * currentPrice

  return {
    initialEntryPrice,
    initialStopLossPrice,
    initialRiskUsd,
    partialRealizedPnlUsd: openPosition.partialRealizedPnlUsd ?? 0,
    sampledMfeR: openPosition.sampledMfeR ?? null,
    sampledMaeR: openPosition.sampledMaeR ?? null,
    minutesSinceEntry: (new Date(nowIso).getTime() - new Date(openPosition.openedAt).getTime()) / 60_000,
    currentRoundTripCostUsd,
    ret15mPct: features.ret15mPct,
    ret30mPct: features.ret30mPct,
    ret60mPct: features.ret60mPct,
    realizedVol5m: features.realizedVol5m,
    volumeTrendRatio: features.volumeTrendRatio,
    sampledDayHighPct: features.sampledDayHighPct,
    sampledDayLowPct: features.sampledDayLowPct,
  }
}

export async function runAgentCycle(deps: CycleDeps): Promise<CycleSummary> {
  const { supabase, typesafeApiKey, nowIso, trigger, coingeckoApiKey } = deps
  const fetchImpl = deps.fetchImpl ?? fetch

  const settings = await readSettings(supabase)
  // Strategy profiles (2026-09-23), Pass 1 — resolved once per cycle,
  // read fresh from settings every time (no stale in-memory selection
  // across cycles). `strategy.strategyVersion` is 'v1-regime' for
  // 'balanced' — the exact pre-existing literal — so this line alone
  // changes nothing observable yet; see strategy/registry.ts.
  const strategy = strategyFor(settings.strategyProfile)

  const { data: portfolio, error: portfolioError } = await supabase.from('portfolios').select('id, cash').single()
  if (portfolioError || !portfolio) {
    return { status: 'failed', decisions: [], detail: `could not read portfolio: ${portfolioError?.message}` }
  }

  if (settings.isPaused) {
    // Deliberately not even an agent_runs row: a paused agent producing an
    // endless stream of "skipped, paused" run records every cadence would
    // just be noise in the run history until someone unpauses it.
    return { status: 'skipped', decisions: [], detail: 'agent_settings.is_paused is true' }
  }

  // Reap any decision run abandoned mid-cycle (an Edge Function
  // crash/timeout before its own catch block could mark it failed) —
  // otherwise a single dead 'running' row would permanently wedge
  // agent_runs_one_running_decision_idx (the mutex below) for every
  // future click. Idempotent and harmless to race: two requests reaping
  // the same stale row both just no-op past the already-updated row: 0.
  await supabase
    .from('agent_runs')
    .update({ status: 'failed', error_detail: 'run abandoned: still running past the staleness cutoff, reaped by a later invocation', completed_at: new Date().toISOString() })
    .eq('kind', 'decision')
    .eq('status', 'running')
    .lt('started_at', staleRunCutoffIso(nowIso))

  const idempotencyKey = buildDecisionIdempotencyKey(trigger, nowIso, settings.decisionIntervalMinutes)
  const { data: run, error: runInsertError } = await supabase
    .from('agent_runs')
    .insert({ portfolio_id: portfolio.id, idempotency_key: idempotencyKey, status: 'running', kind: 'decision', started_at: nowIso })
    .select('id')
    .single()

  if (runInsertError) {
    if (runInsertError.code === '23505') {
      const conflict = classifyRunInsertConflict(runInsertError.message, trigger)
      return conflict === 'already_running'
        ? { status: 'already_running', decisions: [], detail: 'another decision cycle is currently running' }
        : { status: 'duplicate_tick', decisions: [], detail: 'this tick was already handled by another invocation (in progress or completed)' }
    }
    return { status: 'failed', decisions: [], detail: `could not create agent_runs row: ${runInsertError.message}` }
  }
  const runId: string = run.id

  try {
    const marketProvider = new CoinGeckoMarketDataProvider(fetchImpl, undefined, coingeckoApiKey)
    const newsProvider = new RssNewsProvider(fetchImpl)

    const marketData = await marketProvider.getMarketData(settings.assets)
    const latestPriceByAsset = new Map(marketData.map((m) => [m.asset, m.price]))

    // Best-effort ("market_quotes plan", 2026-09-21): this cycle already
    // holds this exact data from the getMarketData call above, so
    // upserting it into market_quotes costs zero extra CoinGecko requests
    // and keeps a manual run's displayed quote from sitting stale until
    // the next 5-minute market-refresh tick (supabase/migrations/
    // 20260921095012_market_quotes.sql). Placed BEFORE the freshness gate
    // below on purpose — fail-closed governs whether this cycle trades,
    // not whether the UI shows the price CoinGecko actually just
    // returned, so even a cycle this gate is about to skip still updates
    // the display quote. A failure here must never fail the decision
    // cycle itself — it is a side write to a display-only table, not a
    // trading action.
    const { error: quotesError } = await supabase.from('market_quotes').upsert(marketData.map(toQuoteRow), { onConflict: 'asset' })
    if (quotesError) console.error(`agent-cycle: could not upsert market_quotes: ${quotesError.message}`)

    const freshness = checkMarketDataFreshness(marketData, settings.maxDataStalenessMinutes, nowIso)
    if (!freshness.fresh) {
      await supabase.from('agent_runs').update({ status: 'skipped', skip_reason: freshness.reason, completed_at: new Date().toISOString() }).eq('id', runId)
      return { status: 'skipped', runId, decisions: [], detail: freshness.reason }
    }

    const lookbackMinutes = settings.decisionIntervalMinutes + settings.newsLookbackOverlapMinutes
    // A news-provider failure does NOT fail the whole cycle (trading-
    // strategy-v1.md §12 Failure semantics) — V1's entry decision itself
    // (strategy/regime.ts) never reads news at all, and CLOSE must always
    // stay actionable regardless. An empty rawNews here only feeds
    // through to the veto step below, which fails closed on its own when
    // this happened and veto is actually enabled (see vetoCallFailedReason).
    let rawNews: NormalizedNewsItem[] = []
    let newsProviderFailedReason: string | null = null
    try {
      rawNews = await newsProvider.getRecentNews(settings.assets, lookbackMinutes)
    } catch (error) {
      newsProviderFailedReason = error instanceof Error ? error.message : String(error)
    }
    const persistedByExternalId = await persistNews(supabase, rawNews)

    const appetite = riskAppetiteThresholds(settings.riskAppetite)
    const peakNav = await readPeakNav(supabase, portfolio.id)

    // Live view of open positions across the whole cycle, refreshed as
    // each asset's own action executes — later assets in this same loop
    // must see the true NAV impact of earlier ones (e.g. BTC closing
    // frees up NAV that ETH's sizing should reflect), not a snapshot
    // taken once at the top of the run.
    const openPositionsByAsset = new Map<AssetSymbol, Position>()
    for (const asset of settings.assets) {
      const p = await readOpenPosition(supabase, portfolio.id, asset)
      if (p) openPositionsByAsset.set(asset, p)
    }

    let runningCash = Number(portfolio.cash)
    let realizedPnlThisRun = 0
    const currentNav = () =>
      computeNav(
        runningCash,
        [...openPositionsByAsset.values()].map((p) => ({
          direction: p.direction,
          quantity: p.quantity,
          entryPrice: p.entryPrice,
          costBasis: p.costBasis,
          currentPrice: latestPriceByAsset.get(p.asset) ?? p.entryPrice,
        })),
      )

    const decisions: { asset: AssetSymbol; action: string; riskStatus: string }[] = []

    // --- Pass 1: per-asset regime evaluation + deterministic candidate
    // synthesis (trading-strategy-v1.md §7 / §14-15 / §20). No model
    // call, no gate, no execution — purely reading market/DB state and
    // deriving what EACH asset would do in isolation. Nav/cash are
    // untouched here, so there is no ordering dependency between assets
    // in this pass (unlike Pass 2 below).
    interface PassOneResult {
      asset: AssetSymbol
      assetMarketData: NormalizedMarketData
      assetInput: AssetInput
      regime: RegimeResult
      candidate: ModelDecisionProposal
      openPosition: Position | null
      recentStopLossClose: RecentStopLossClose | null
      // Strategy profiles, Pass 2 — populated ONLY for 'aggressive' cycles,
      // and only for a FLAT asset where the deterministic opportunity
      // detector fired AND the result clears the tradeability floor. Never
      // set for 'balanced' (stays undefined). Consumed by Pass 3 to decide
      // whether to normalize a Jev ENTER answer into a real OPEN_LONG
      // candidate — computing it here does NOT itself change what trades;
      // see cycle/collect-candidates.ts and the batched-call section below,
      // neither of which reads this field.
      aggressiveEntryContext?: {
        opportunity: OpportunitySignal
        atrTargetDistancePct: number
        estimatedRoundTripCostPct: number
      }
    }

    // Strategy profiles, Pass 2 — the additive intraday feed, fetched ONCE
    // per cycle, ONLY when the selected profile actually needs it. A
    // 'balanced' cycle makes zero extra requests (intradayByAsset stays
    // {}), preserving that profile's existing 1+3N CoinGecko cost exactly.
    const intradayByAsset: Partial<Record<AssetSymbol, IntradayMarketData>> =
      settings.strategyProfile === 'aggressive'
        ? await fetchIntradayMarketData(settings.assets, fetchImpl, undefined, coingeckoApiKey)
        : {}

    const passOneResults: PassOneResult[] = []
    for (const asset of settings.assets) {
      const assetMarketData = marketData.find((m) => m.asset === asset)
      if (!assetMarketData) throw new Error(`no market data returned for ${asset} despite passing freshness check — should be unreachable`)

      const openPosition = openPositionsByAsset.get(asset) ?? null
      const openInvalidation = openPosition ? await readOpenInvalidation(supabase, openPosition.id) : []
      const recentDecisions = await readRecentDecisions(supabase, portfolio.id, asset)
      const recentStopLossClose = await readRecentStopLossClose(supabase, portfolio.id, asset)

      const news = rawNews
        .filter((n) => n.assets.includes(asset))
        .map((n) => persistedByExternalId.get(n.externalId))
        .filter((n): n is PersistedNewsItem => !!n)

      const regime = evaluateTrendRegime(assetMarketData.dailyCloseSeries)

      const assetInput: AssetInput = buildAssetInput({
        asset,
        marketData: assetMarketData,
        news,
        openPosition,
        openInvalidation,
        recentDecisions,
        recentStopLossClose,
        stopOutReentryBlockMinutes: settings.stopOutReentryBlockMinutes,
        nowIso,
        regime,
      })

      await supabase.from('market_snapshots').insert({
        run_id: runId,
        asset,
        price: assetMarketData.price,
        change_1h_pct: assetMarketData.change1hPct,
        change_24h_pct: assetMarketData.change24hPct,
        change_7d_pct: assetMarketData.change7dPct,
        indicators: assetInput.market.indicators,
        recent_closes: assetInput.market.recentCloses,
        provider: assetMarketData.provider,
        data_as_of: assetMarketData.dataAsOf,
      })

      const candidate = buildCandidateProposal({
        asset,
        currentState: assetInput.state,
        regime,
        atrPct: assetInput.market.indicators.atrPct,
      })

      // Strategy profiles, Pass 2 — Aggressive opportunity detection for a
      // FLAT asset. Entirely additive: computes context Pass 3 may later
      // use to normalize a real candidate, but does not itself alter
      // `candidate` (still Balanced's own regime-based value above,
      // completely unused for entry purposes once profile is aggressive —
      // Pass 3 is where that gets resolved). Never runs for 'balanced'.
      // Gated on newsVetoEnabled (not a new, separate setting) — this
      // question is an entry-side gate exactly like the veto's, sharing
      // the same underlying news context, so the one existing flag
      // governs whether ANY entry-quality evaluation happens this cycle.
      let aggressiveEntryContext: PassOneResult['aggressiveEntryContext']
      if (settings.strategyProfile === 'aggressive' && settings.newsVetoEnabled && openPosition === null) {
        const intraday = intradayByAsset[asset]
        const sufficiency = checkStrategyDataSufficiency('aggressive', assetMarketData, intraday)
        if (sufficiency.ok && intraday) {
          const opportunity = detectAggressiveOpportunity(intraday)
          if (opportunity) {
            const atr30Pct = managementAtrPctFor('aggressive', assetMarketData, intraday)
            const { takeProfitPct: atrTargetDistancePct } = protectionForEntry('aggressive', atr30Pct, stopLossPctFor, takeProfitPctFor)
            const estimatedRoundTripCostPct = (2 * (settings.feeBps + settings.slippageBps)) / 10_000
            if (clearsEntryTradeabilityFloor('aggressive', atrTargetDistancePct, estimatedRoundTripCostPct)) {
              aggressiveEntryContext = { opportunity, atrTargetDistancePct, estimatedRoundTripCostPct }
            }
          }
        }
      }

      passOneResults.push({ asset, assetMarketData, assetInput, regime, candidate, openPosition, recentStopLossClose, aggressiveEntryContext })
    }

    // --- Batched veto + management call (Gemini -> Jev migration,
    // 2026-09-22; Phase 2 "portfolio management," 2026-09-22/23; Phase 2.1
    // "decouple entry eligibility from position management," 2026-09-23)
    // ------------------------------------------------------------------
    // At most ONE model call this cycle, covering BOTH kinds of candidate
    // in the SAME request: veto questions for FLAT assets with an
    // OPEN_LONG candidate (trading-strategy-v1.md §11-12, unchanged), and
    // management questions for OPEN assets whose regime is still intact
    // this cycle (Pass 1's own candidate is HOLD — a regime-flip CLOSE is
    // authoritative and never routed through Jev at all — the thesis-
    // invalidation rule is not Jev-overridable in either direction).
    //
    // Collection and the call decision are two SEPARATE, independently
    // testable functions (cycle/collect-candidates.ts) — Phase 2 gated
    // both behind news_veto_enabled alone, which silently disabled
    // management whenever the entry veto was turned off (two unrelated
    // product decisions sharing one switch). Each candidate type now has
    // its own flag, read only by its own branch inside
    // collectModelCandidates. No fallback provider exists — a failed call
    // fails every candidate of BOTH kinds closed (veto -> HOLD; management
    // -> unmanaged HOLD), never an implicit approval or an implicit
    // action. See CLAUDE.md's "news-provider failure" invariant: a failed
    // news fetch fails BOTH layers closed for the cycle, deliberately — a
    // quiet cycle can mean the model was never called, not that it chose
    // HOLD; agent_decisions.model_version ('jev-*' vs 'call-failed' vs
    // 'not-called') is what disambiguates the two after the fact.
    const { vetoCandidates, managementCandidates } = collectModelCandidates(
      passOneResults.map((r) => ({
        asset: r.asset,
        candidate: r.candidate,
        openPosition: r.openPosition,
        news: r.assetInput.news,
        currentPrice: r.assetMarketData.price,
        atrPct: r.assetInput.market.indicators.atrPct,
        aggressive: buildAggressiveManagementContext(
          settings.strategyProfile,
          r.openPosition,
          intradayByAsset[r.asset],
          r.assetMarketData.price,
          settings.feeBps,
          settings.slippageBps,
          nowIso,
        ),
      })),
      {
        newsVetoEnabled: settings.newsVetoEnabled,
        managementEnabled: settings.managementEnabled,
        feeBps: settings.feeBps,
        slippageBps: settings.slippageBps,
        minStopLossPct: settings.slTpBounds.minStopLossPct,
      },
      nowIso,
    )

    // Strategy profiles, Pass 2 — the Aggressive-only entry-opportunity
    // list, built from Pass 1's per-asset context. Empty whenever the
    // profile is 'balanced' (aggressiveEntryContext is never set on that
    // path), so requestPortfolioDecisions below receives entryOpportunities
    // = [] for Balanced — proven byte-identical to this parameter not
    // existing at all (model/jev/provider.test.ts's 18 pre-existing tests).
    const entryOpportunities: EntryOpportunityInput[] = passOneResults.flatMap((r) => {
      if (!r.aggressiveEntryContext) return []
      const intraday = intradayByAsset[r.asset]
      if (!intraday) return [] // unreachable — aggressiveEntryContext is only ever set alongside a present intraday fetch
      const features = intradayFeaturesFor(intraday)
      return [{
        asset: r.asset,
        kind: r.aggressiveEntryContext.opportunity.kind,
        atrTargetDistancePct: r.aggressiveEntryContext.atrTargetDistancePct,
        estimatedRoundTripCostPct: r.aggressiveEntryContext.estimatedRoundTripCostPct,
        ret15mPct: features.ret15mPct,
        ret30mPct: features.ret30mPct,
        ret60mPct: features.ret60mPct,
        realizedVol5m: features.realizedVol5m,
        volumeTrendRatio: features.volumeTrendRatio,
        sampledDayHighPct: features.sampledDayHighPct,
        sampledDayLowPct: features.sampledDayLowPct,
      }]
    })

    const vetoOutcomeByAsset = new Map<AssetSymbol, VetoOutcome>()
    const managementOutcomeByAsset = new Map<AssetSymbol, ManagementOutcome>()
    // Strategy profiles, Pass 2 — always empty for 'balanced'. Computed
    // here but NOT YET consumed to change any candidate (see Pass 3).
    const entryOutcomeByAsset = new Map<AssetSymbol, EntryOutcome>()
    // Seeded from a news-provider failure, but only when at least one
    // model layer is actually on — disabling BOTH means news stops
    // mattering to the model at all, so a feed outage shouldn't block
    // trading in that mode. Fails every candidate of both kinds closed
    // without spending an API call on a request we already know is
    // missing its news context.
    const anyModelLayerEnabled = settings.newsVetoEnabled || settings.managementEnabled
    let modelCallFailedReason: string | null =
      anyModelLayerEnabled && newsProviderFailedReason
        ? `news retrieval failed, blocking model-assisted decisions this cycle: ${newsProviderFailedReason}`
        : null
    let modelVersion: string | null = null
    let modelRawRequest: unknown = null
    let modelRawResponse: unknown = null

    // Strategy profiles, Pass 2 — entryOpportunities can make a call
    // necessary even when shouldCallModel's own veto/management-only view
    // says no (e.g. an Aggressive FLAT asset whose Balanced-regime
    // candidate is HOLD, so it never entered vetoCandidates, yet a
    // detector fired independently). modelCallFailedReason === null is
    // checked again explicitly for clarity, though shouldCallModel already
    // encodes the identical guard for its own two lists.
    if (shouldCallModel(vetoCandidates, managementCandidates, modelCallFailedReason) || (entryOpportunities.length > 0 && modelCallFailedReason === null)) {
      try {
        // NAV/cash/exposure as of right now (Pass 1 has made no
        // executions yet) — the same instant the existing veto call has
        // always used, just now also passed to the management side of
        // the same request.
        const navForCall = currentNav()
        const totalExposureUsd = [...openPositionsByAsset.values()].reduce(
          (sum, p) => sum + p.quantity * (latestPriceByAsset.get(p.asset) ?? p.entryPrice),
          0,
        )
        const totalExposurePct = navForCall > 0 ? totalExposureUsd / navForCall : 0

        const portfolioResult = await requestPortfolioDecisions(
          vetoCandidates,
          managementCandidates,
          navForCall,
          runningCash,
          totalExposurePct,
          typesafeApiKey,
          fetchImpl,
          {},
          entryOpportunities,
        )
        for (const outcome of portfolioResult.vetoOutcomes) vetoOutcomeByAsset.set(outcome.asset, outcome)
        for (const outcome of portfolioResult.managementOutcomes) managementOutcomeByAsset.set(outcome.asset, outcome)
        for (const outcome of portfolioResult.entryOutcomes) entryOutcomeByAsset.set(outcome.asset, outcome)
        modelVersion = portfolioResult.modelVersion
        modelRawRequest = portfolioResult.rawRequest
        modelRawResponse = portfolioResult.rawResponse
      } catch (error) {
        modelCallFailedReason = error instanceof Error ? error.message : String(error)
      }
    }

    // --- Pass 2: apply the veto/management outcome (if any), then proceed
    // through the risk gate -> planDecisionExecution -> atomic RPCs ->
    // persistence, per asset, in order — later assets in this pass DO see
    // earlier ones' executed effects on cash/openPositionsByAsset, same as
    // the single-pass loop this replaces.
    for (const r of passOneResults) {
      const { asset, assetMarketData, assetInput, candidate, openPosition, recentStopLossClose } = r

      // Strategy profiles, Pass 3 — candidate normalization. Balanced's
      // `candidate` (Pass 1, unchanged) passes straight through as
      // `effectiveCandidate` and every branch below behaves exactly as
      // before. For Aggressive, Balanced's own regime-derived OPEN_LONG/
      // CLOSE signals are neutralized to HOLD here, BEFORE the veto/
      // management branches (which key on candidate.action) ever see
      // them — Aggressive must never open on Balanced's 50DMA signal, and
      // must never auto-close on a regime flip either; its entries come
      // only from its own opportunity detector (below) and its exits only
      // from Jev's management judgment + deterministic tightening. The
      // 50DMA regime stays available as CONTEXT (assetInput.regime is
      // unchanged either way), never a hard trigger, for this profile.
      let effectiveCandidate: ModelDecisionProposal = candidate
      if (settings.strategyProfile === 'aggressive') {
        if (candidate.action === 'OPEN_LONG') {
          effectiveCandidate = {
            asset,
            action: 'HOLD',
            confidence: 1,
            horizonHours: null,
            reasons: [{ type: 'TECHNICAL', text: 'Aggressive strategy — entries are decided by the short-horizon opportunity detector, not the daily trend regime' }],
            invalidation: [],
          }
        } else if (openPosition && candidate.action === 'CLOSE') {
          effectiveCandidate = {
            asset,
            action: 'HOLD',
            confidence: 1,
            horizonHours: null,
            reasons: [{ type: 'TECHNICAL', text: 'Aggressive strategy — exits are decided by Jev management and deterministic tightening, not the daily trend regime' }],
            invalidation: [{ text: 'Managed by short-horizon Jev evaluation (HOLD/ADD/REDUCE/CLOSE/MODIFY_PROTECTION), not the daily trend regime' }],
          }
        }
      }

      let finalProposal: ModelDecisionProposal = effectiveCandidate
      let modelVetoedValue: boolean | null = null
      let modelVersionForRow = 'not-called'
      // Which question set this row's prompt_version reflects — veto by
      // default (matches pre-Phase-2 behavior for every not-called row),
      // overridden to the management version specifically when this
      // asset was a management candidate (whether or not the call
      // actually succeeded — the version describes which question WOULD
      // apply, same as JEV_QUESTION_VERSION already did for a failed/
      // not-called veto row).
      let promptVersionForRow: string = JEV_QUESTION_VERSION
      let outputPayloadForRow: unknown = null
      // Phase 2 (2026-09-22/23) provenance — null unless this asset was a
      // management candidate this cycle (see agent_decisions' own new
      // columns, migration 20260923060000).
      let proposedActionForRow: string | null = null
      let proposedActionConfidenceForRow: number | null = null
      let proposedAdjustNotionalForRow: number | null = null
      let executedAdjustNotionalForRow: number | null = null
      let stopLossPriceBeforeForRow: number | null = null
      let stopLossPriceAfterForRow: number | null = null
      let takeProfitPriceBeforeForRow: number | null = null
      let takeProfitPriceAfterForRow: number | null = null
      let protectionRejectionReasonForRow: string | null = null
      // Strategy profiles (2026-09-23) — Aggressive-only, null on every
      // Balanced row and on any Aggressive row that never reached the
      // entry-normalization branch below (see migration
      // 20260923150000_strategy_profiles.sql's own column comments).
      let expectedMovePctForRow: number | null = null
      let estimatedRoundTripCostPctForRow: number | null = null
      let moveToCostRatioForRow: number | null = null
      // Aggressive V3.1 profit recycling (2026-09-23) — the two R metrics
      // (never conflated — see protection.ts's own module comment),
      // profit state at decision time, and the disambiguation field that
      // resolves "model chose HOLD" vs "model wanted something else and
      // deterministic code silently normalized it away" (the live ETH
      // MODIFY_PROTECTION/KEEP-KEEP case the diagnosis surfaced). All null
      // on every Balanced row.
      let positionPnlRForRow: number | null = null
      let priceRForRow: number | null = null
      let sampledMfeRForRow: number | null = null
      let givebackRForRow: number | null = null
      let minutesSinceEntryForRow: number | null = null
      let actionNormalizationReasonForRow: string | null = null

      // Computed once, up front, so both branches below (and the sizing/
      // gate context further down) can reuse the identical value rather
      // than recomputing currentNav() redundantly mid-branch.
      const nav = currentNav()

      if (effectiveCandidate.action === 'OPEN_LONG') {
        if (modelCallFailedReason !== null) {
          modelVersionForRow = 'call-failed'
          outputPayloadForRow = { provider: 'typesafe-jev', error: modelCallFailedReason }
          finalProposal = vetoedHoldProposal(asset, `veto call failed, failing closed: ${modelCallFailedReason}`)
          // modelVetoedValue stays null — no completed model verdict this
          // cycle (AgentDecision.modelVetoed's own doc comment); the
          // failure itself is fully captured in the proposal's reasons
          // text and in outputPayloadForRow above instead.
        } else {
          const outcome = vetoOutcomeByAsset.get(asset)
          if (outcome) {
            // modelVersion/modelRawRequest/modelRawResponse are always set
            // together with vetoOutcomeByAsset entries (the same
            // successful-call branch above) — never null here by
            // construction.
            modelVersionForRow = modelVersion!
            // noul/derivedVeto are per-asset even though request/response
            // are the shared batch payload (every candidate in one call
            // legitimately shares the same raw request/response). Jev
            // returns no rationale text; noul is the raw calibrated
            // probability, persisted verbatim so the provisional
            // threshold (model/jev/question.ts) can be revisited later
            // as a query over real observations rather than a replay.
            outputPayloadForRow = {
              provider: 'typesafe-jev',
              request: modelRawRequest,
              response: modelRawResponse,
              threshold: JEV_VETO_THRESHOLD,
              noul: outcome.noul,
              derivedVeto: outcome.veto,
            }
            modelVetoedValue = outcome.veto
            // The ALLOW-is-strict-pass-through guarantee lives in this
            // function, not here — see cycle/apply-veto.ts's own comment
            // and cycle/apply-veto.test.ts for the regression test.
            finalProposal = applyVetoOutcome(effectiveCandidate, asset, outcome, assetInput.news.length)
          }
          // else: news_veto_enabled is false — this candidate was never
          // collected (cycle/collect-candidates.ts's own veto branch
          // reads only this flag), so no call was ever attempted for it;
          // it proceeds unvetoed, and the row correctly records
          // "not-called" / null.
        }
      } else if (openPosition && effectiveCandidate.action === 'HOLD') {
        // Phase 2 — portfolio management. Only reached when Pass 1's own
        // deterministic candidate for this OPEN position is HOLD (the
        // regime is intact) — a regime-flip CLOSE never reaches here, and
        // is never overridable by Jev (see the batched-call comment
        // above).
        stopLossPriceBeforeForRow = openPosition.stopLossPrice
        takeProfitPriceBeforeForRow = openPosition.takeProfitPrice
        promptVersionForRow = MANAGEMENT_QUESTION_VERSION

        if (modelCallFailedReason !== null) {
          modelVersionForRow = 'call-failed'
          outputPayloadForRow = { provider: 'typesafe-jev', error: modelCallFailedReason }
          // finalProposal stays as candidate (HOLD) — unmanaged this
          // cycle. No ADD, no REDUCE, no Jev-originated CLOSE, no
          // protection change; the position's existing SL/TP keep
          // protecting it exactly as before, and position-monitor is
          // entirely unaffected.
        } else {
          const outcome = managementOutcomeByAsset.get(asset)
          if (outcome) {
            modelVersionForRow = modelVersion!
            proposedActionForRow = outcome.action
            proposedActionConfidenceForRow = outcome.actionConfidence

            // Strategy profiles (2026-09-23) — MOVE_CLOSER/MOVE_OUT steps
            // one ATR unit (apply-management.ts's buildTargetProposal), so
            // this must be the SAME ATR the strategy itself reasons in:
            // Balanced's 4h figure is unchanged; Aggressive must use its
            // own 30m ATR (registry.ts's managementAtrPctFor — its own
            // comment already says the 4-hourly figure is "incoherent" at
            // this horizon). Falls back to the 4h figure only if 30m data
            // is momentarily too thin for ATR(14) — a coarser step for
            // one cycle, not a crash of the whole cycle over one field.
            let managementAtrPct = assetInput.market.indicators.atrPct
            if (settings.strategyProfile === 'aggressive') {
              const intraday = intradayByAsset[asset]
              if (intraday && intraday.ohlc30m.length >= 15) {
                managementAtrPct = managementAtrPctFor('aggressive', assetMarketData, intraday)
              }
            }

            const positionContext: ManagementPositionContext = {
              direction: openPosition.direction,
              entryPrice: openPosition.entryPrice,
              currentPrice: assetMarketData.price,
              stopLossPrice: openPosition.stopLossPrice,
              takeProfitPrice: openPosition.takeProfitPrice,
              atrPct: managementAtrPct,
              minStopLossPct: settings.slTpBounds.minStopLossPct,
            }
            finalProposal = applyManagementOutcome(effectiveCandidate, asset, outcome, positionContext)

            // Aggressive V3.1 profit recycling (2026-09-23) — the same
            // context buildAggressiveManagementContext already assembled
            // for the Jev call above (a pure, cheap-to-recompute
            // function), read here purely for PROVENANCE: the R metrics
            // this decision was actually made under.
            const aggContext = buildAggressiveManagementContext(
              settings.strategyProfile, openPosition, intradayByAsset[asset], assetMarketData.price, settings.feeBps, settings.slippageBps, nowIso,
            )
            if (aggContext) {
              const unrealizedPnlUsd = openPosition.direction === 'long'
                ? (assetMarketData.price - openPosition.entryPrice) * openPosition.quantity
                : (openPosition.entryPrice - assetMarketData.price) * openPosition.quantity
              positionPnlRForRow = computePositionPnlR(unrealizedPnlUsd, aggContext.partialRealizedPnlUsd, aggContext.initialRiskUsd)
              priceRForRow = computePriceR(assetMarketData.price, aggContext.initialEntryPrice, aggContext.initialStopLossPrice, openPosition.direction)
              sampledMfeRForRow = aggContext.sampledMfeR
              givebackRForRow = aggContext.sampledMfeR === null ? null : Math.max(0, aggContext.sampledMfeR - positionPnlRForRow)
              minutesSinceEntryForRow = aggContext.minutesSinceEntry

              // profile-recycling plan §4.4 — the remaining_upside answer
              // finally populates these on a MANAGEMENT row (previously
              // null on every Aggressive decision; Pass 3 only ever set
              // them on the entry branch).
              if (outcome.remainingUpsideExpectedMovePct !== undefined) {
                const estimatedRoundTripCostPct = (2 * (settings.feeBps + settings.slippageBps)) / 10_000
                expectedMovePctForRow = outcome.remainingUpsideExpectedMovePct
                estimatedRoundTripCostPctForRow = estimatedRoundTripCostPct
                moveToCostRatioForRow = outcome.remainingUpsideExpectedMovePct / estimatedRoundTripCostPct
              }
            }

            // The disambiguation the diagnosis showed was previously
            // impossible without hand-parsing output_payload: Jev chose
            // MODIFY_PROTECTION but BOTH stopIntent and targetIntent
            // resolved to "no change" (apply-management.ts's own KEEP/
            // KEEP normalization), so finalProposal fell back to the
            // unchanged candidate — action reads HOLD, but this was NOT
            // the model genuinely choosing HOLD.
            if (outcome.action === 'MODIFY_PROTECTION' && finalProposal.action !== 'MODIFY_PROTECTION') {
              actionNormalizationReasonForRow = 'modify_protection_noop_both_intents_keep'
            }

            // Observability-only figures (migration plan §12) — the
            // UNCAPPED amount Jev's magnitude implies, computed via the
            // same exported pure sizing function the gate itself calls
            // (reuse, not a second implementation of its math). The
            // ACTUAL executed amount (post-cap) is set further below,
            // once the gate result is known.
            if (outcome.action === 'ADD') {
              const riskBasedMaxAdd = deriveRiskBasedNotional(nav, appetite.riskBudgetPct, assetMarketData.price, openPosition.stopLossPrice)
              proposedAdjustNotionalForRow = riskBasedMaxAdd * outcome.addMagnitude
            } else if (outcome.action === 'REDUCE') {
              proposedAdjustNotionalForRow = outcome.reduceMagnitude * openPosition.quantity * assetMarketData.price
            }

            outputPayloadForRow = {
              provider: 'typesafe-jev',
              request: modelRawRequest,
              response: modelRawResponse,
              managementOutcome: outcome,
            }
          }
          // else: management_enabled is false — this position was never
          // collected (cycle/collect-candidates.ts's own management
          // branch reads only that flag, independent of
          // news_veto_enabled), so no call was ever attempted for it; it
          // proceeds unmanaged (HOLD stands), and the row correctly
          // records "not-called" / null.
        }
      } else if (settings.strategyProfile === 'aggressive' && !openPosition && effectiveCandidate.action === 'HOLD' && r.aggressiveEntryContext) {
        // Strategy profiles, Pass 3 — Aggressive candidate normalization.
        // Reached ONLY when Pass 2 detected a genuine opportunity for this
        // FLAT asset AND it cleared the tradeability floor
        // (r.aggressiveEntryContext is required) — Jev can only ever ADD
        // an OPEN_LONG here by answering ENTER; it can never originate one
        // where no detector fired, the exact same containment discipline
        // as the veto's ALLOW-is-a-pass-through guarantee
        // (cycle/apply-veto.ts).
        promptVersionForRow = ENTRY_QUESTION_VERSION
        if (modelCallFailedReason !== null) {
          modelVersionForRow = 'call-failed'
          outputPayloadForRow = { provider: 'typesafe-jev', error: modelCallFailedReason }
          // finalProposal stays HOLD (effectiveCandidate) — no entry.
        } else {
          const entryOutcome = entryOutcomeByAsset.get(asset)
          if (entryOutcome) {
            modelVersionForRow = modelVersion!
            expectedMovePctForRow = entryOutcome.expectedMovePct
            estimatedRoundTripCostPctForRow = r.aggressiveEntryContext.estimatedRoundTripCostPct
            moveToCostRatioForRow = entryOutcome.expectedMovePct / r.aggressiveEntryContext.estimatedRoundTripCostPct
            outputPayloadForRow = {
              provider: 'typesafe-jev',
              request: modelRawRequest,
              response: modelRawResponse,
              opportunityKind: r.aggressiveEntryContext.opportunity.kind,
              entryOutcome,
            }
            if (entryOutcome.enter) {
              const intraday = intradayByAsset[asset]!
              const atr30Pct = managementAtrPctFor('aggressive', assetMarketData, intraday)
              const { stopLossPct, takeProfitPct } = protectionForEntry('aggressive', atr30Pct, stopLossPctFor, takeProfitPctFor)
              finalProposal = {
                asset,
                action: 'OPEN_LONG',
                confidence: entryOutcome.enterConfidence,
                horizonHours: null,
                reasons: [{ type: 'TECHNICAL', text: `Aggressive ${r.aggressiveEntryContext.opportunity.kind} detected; Jev judged the opportunity worth entering` }],
                invalidation: [{ text: 'Managed by short-horizon Jev evaluation (HOLD/ADD/REDUCE/CLOSE/MODIFY_PROTECTION), not the daily trend regime' }],
                stopLossPct,
                takeProfitPct,
              }
            }
            // else: entryOutcome.enter === false (SKIP) — finalProposal
            // stays HOLD.
          }
          // else: no entryOutcome — should be unreachable given
          // r.aggressiveEntryContext was set (the same condition that put
          // this asset into entryOpportunities in Pass 2), but left as a
          // safe no-op rather than throwing, matching the veto/management
          // branches' own equivalent "not collected" fallthrough above.
        }
      }

      // Deterministic dynamic tightening (the old agent-cycle-only, Jev-
      // click-gated two-rung schedule) was retired 2026-09-23 — its
      // profit-locking rung was provably dead code (a stop above entry is
      // unrepresentable under positions_sl_tp_ordering_valid) and its
      // surviving rung only approximated breakeven. Superseded by the
      // monitor-enforced giveback ratchet (position-monitor/giveback.ts),
      // which runs automatically every 10 minutes instead of only on a
      // manual "Run agent" click — the direct fix for the diagnosis
      // finding that R was previously sampled only at decision cycles and
      // so missed intraday peaks entirely. See strategy/registry.ts's own
      // comment at the old call site for the full reasoning.

      const payload: ModelCallPayload = {
        portfolio: { cash: runningCash, nav, constraints: buildPortfolioConstraints(appetite.minConfidence, settings.slTpBounds) },
        assets: [assetInput],
      }

      const { otherOpenPositionsRiskAtStopUsd, otherSameDirectionNotionalUsd } = aggregateOtherOpenPositionsRisk(
        [...openPositionsByAsset.values()],
        asset,
        latestPriceByAsset,
      )
      const portfolioRiskCeilingUsd = settings.portfolioRiskCeilingMultiplier * appetite.riskBudgetPct * nav
      const maxTotalNotionalUsd = settings.maxTotalNotionalPct * nav

      const gateContext = buildRiskGateContext({
        asset,
        entryPrice: assetMarketData.price,
        nav,
        cash: runningCash,
        openPosition,
        appetite,
        maxSingleTradePct: settings.maxSingleTradePct,
        maxAssetExposurePct: settings.maxAssetExposurePct,
        slTpBounds: settings.slTpBounds,
        stopOutReentryBlockMinutes: settings.stopOutReentryBlockMinutes,
        recentStopLossClose,
        nowIso,
        portfolioRiskCeilingUsd,
        otherOpenPositionsRiskAtStopUsd,
        maxTotalNotionalUsd,
        otherSameDirectionNotionalUsd,
        peakNav,
        drawdownBreakerFloorPct: settings.drawdownBreakerFloorPct,
        feeBps: settings.feeBps,
        slippageBps: settings.slippageBps,
        minTradeNotionalPct: settings.minTradeNotionalPct,
        minTradeNotionalUsd: settings.minTradeNotionalUsd,
      })
      const gateResult = evaluateRiskGate(finalProposal, gateContext)

      // Phase 2 — finalize the executed-side provenance now that the gate
      // has actually run, and apply the one normalization the gate itself
      // signals rather than rejects: an ADD/REDUCE below the minimum
      // trade notional comes back `not_applicable` (§4/§9 of the
      // migration plan — "not a rejection, nothing was wrong, just too
      // small to be worth a fill"), which is normalized here to the
      // ORIGINAL HOLD candidate for persistence. Reusing this SAME gate
      // result is deliberate: `not_applicable` already means exactly what
      // a HOLD's own risk status means ("nothing to gate"), so no second
      // gate call is needed.
      if (finalProposal.action === 'ADD') {
        if (gateResult.riskStatus === 'approved' || gateResult.riskStatus === 'clamped') {
          executedAdjustNotionalForRow = gateResult.approvedAdjustNotionalUsd
        } else if (gateResult.riskStatus === 'not_applicable') {
          // effectiveCandidate, NOT the raw candidate — for an Aggressive
          // position whose underlying Balanced regime already flipped to
          // CLOSE this cycle (neutralized to HOLD above), reverting to
          // the raw candidate here would silently resurrect that
          // regime-driven CLOSE the moment an ADD comes back too small to
          // fill, defeating the whole point of the neutralization.
          finalProposal = effectiveCandidate
          actionNormalizationReasonForRow = 'add_reduce_below_min_notional'
        }
      } else if (finalProposal.action === 'REDUCE') {
        if (gateResult.riskStatus === 'approved') {
          executedAdjustNotionalForRow = (gateResult.approvedReduceQuantity ?? 0) * assetMarketData.price
        } else if (gateResult.riskStatus === 'not_applicable') {
          finalProposal = effectiveCandidate
          actionNormalizationReasonForRow = 'add_reduce_below_min_notional'
        }
      } else if (finalProposal.action === 'MODIFY_PROTECTION') {
        if (gateResult.riskStatus === 'approved') {
          stopLossPriceAfterForRow = gateResult.computedStopLossPrice
          takeProfitPriceAfterForRow = gateResult.computedTakeProfitPrice
        } else if (gateResult.riskStatus === 'rejected') {
          // A genuine rejection (e.g. a widen attempt) stays visible as a
          // rejected MODIFY_PROTECTION in the decision feed — unlike the
          // ADD/REDUCE-too-small case above, this is NOT a normalization;
          // Jev's request was denied, and that denial is exactly what
          // should show up, matching how a rejected OPEN_LONG is
          // persisted as action='OPEN_LONG', risk_status='rejected'.
          protectionRejectionReasonForRow = gateResult.riskReason
        }
      }

      const decisionId = crypto.randomUUID()
      const plan = planDecisionExecution({
        asset,
        portfolioId: portfolio.id,
        proposal: finalProposal,
        gateResult,
        openPosition,
        nav,
        referencePrice: assetMarketData.price,
        feeBps: settings.feeBps,
        slippageBps: settings.slippageBps,
        startingCash: runningCash,
        decisionId,
        nowIso,
      })

      // For an OPEN, position_id must start null: the position doesn't
      // exist in the DB yet (it's only created by open_position_atomic,
      // below), and positions.opened_by_decision_id itself has a FK back
      // to this decision row — so the decision must be inserted first,
      // with position_id filled in by a follow-up update once the
      // position genuinely exists. For everything else (HOLD/CLOSE on an
      // existing position, or no position at all), the position this
      // decision is about already exists (or doesn't), so it's known now.
      const initialPositionId = plan.kind === 'open' ? null : (openPosition?.id ?? null)

      const { error: decisionInsertError } = await supabase.from('agent_decisions').insert({
        id: decisionId,
        run_id: runId,
        portfolio_id: portfolio.id,
        asset,
        position_id: initialPositionId,
        action: finalProposal.action,
        confidence: finalProposal.confidence,
        primary_driver: derivePrimaryDriver(finalProposal.reasons),
        proposed_stop_loss_pct: finalProposal.action === 'OPEN_LONG' || finalProposal.action === 'OPEN_SHORT' ? finalProposal.stopLossPct : null,
        proposed_take_profit_pct: finalProposal.action === 'OPEN_LONG' || finalProposal.action === 'OPEN_SHORT' ? finalProposal.takeProfitPct : null,
        horizon_hours: finalProposal.horizonHours,
        reasons: finalProposal.reasons,
        invalidation: finalProposal.invalidation,
        cited_news_ids: citedNewsIds(finalProposal.reasons),
        risk_status: gateResult.riskStatus,
        risk_reason: gateResult.riskReason,
        approved_size_pct: gateResult.approvedSizePct,
        computed_stop_loss_price: gateResult.computedStopLossPrice,
        computed_take_profit_price: gateResult.computedTakeProfitPrice,
        effective_min_confidence: appetite.minConfidence,
        effective_risk_budget_pct: appetite.riskBudgetPct,
        effective_single_trade_cap_pct: settings.maxSingleTradePct,
        effective_asset_exposure_cap_pct: settings.maxAssetExposurePct,
        effective_portfolio_risk_ceiling_pct: settings.portfolioRiskCeilingMultiplier * appetite.riskBudgetPct,
        effective_max_total_notional_pct: settings.maxTotalNotionalPct,
        size_cap_applied: gateResult.sizeCapApplied,
        // Phase 2 (2026-09-22/23) provenance — null on every pre-Phase-2
        // row and on any row where no management question was ever asked
        // (see the field-by-field comments above where each is set).
        proposed_action: proposedActionForRow,
        proposed_action_confidence: proposedActionConfidenceForRow,
        proposed_adjust_notional: proposedAdjustNotionalForRow,
        executed_adjust_notional: executedAdjustNotionalForRow,
        stop_loss_price_before: stopLossPriceBeforeForRow,
        stop_loss_price_after: stopLossPriceAfterForRow,
        take_profit_price_before: takeProfitPriceBeforeForRow,
        take_profit_price_after: takeProfitPriceAfterForRow,
        protection_rejection_reason: protectionRejectionReasonForRow,
        input_payload: payload,
        output_payload: outputPayloadForRow,
        prompt_version: promptVersionForRow,
        model_version: modelVersionForRow,
        strategy_version: strategy.strategyVersion,
        model_vetoed: modelVetoedValue,
        // Strategy profiles, Pass 3 (2026-09-23) — null for Balanced and
        // for any Aggressive row that isn't an entry-normalization row
        // (see the aggressiveEntryContext branch above where each is set).
        expected_move_pct: expectedMovePctForRow,
        estimated_round_trip_cost_pct: estimatedRoundTripCostPctForRow,
        move_to_cost_ratio: moveToCostRatioForRow,
        // Aggressive V3.1 profit recycling (2026-09-23) — null for every
        // Balanced row (see this file's own aggregate comment at each
        // local's declaration above).
        position_pnl_r: positionPnlRForRow,
        price_r: priceRForRow,
        sampled_mfe_r: sampledMfeRForRow,
        giveback_r: givebackRForRow,
        minutes_since_entry: minutesSinceEntryForRow,
        action_normalization_reason: actionNormalizationReasonForRow,
        decided_at: nowIso,
      })
      if (decisionInsertError) throw new Error(`could not insert agent_decisions for ${asset}: ${decisionInsertError.message}`)

      let finalRiskStatus: string = gateResult.riskStatus

      if (plan.kind === 'open') {
        const { position, trade } = plan.openResult
        const { data: rpcData, error: rpcError } = await supabase.rpc('open_position_atomic', {
          p_position_id: position.id,
          p_portfolio_id: portfolio.id,
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
        })
        if (rpcError) throw new Error(`open_position_atomic failed for ${asset}: ${rpcError.message}`)
        runningCash = Number((Array.isArray(rpcData) ? rpcData[0] : rpcData)?.cash_after ?? runningCash)
        openPositionsByAsset.set(asset, position)
        // Follow-up now that the position genuinely exists — see the
        // initialPositionId comment above for why this can't be set on
        // the original insert.
        const { error: linkError } = await supabase.from('agent_decisions').update({ position_id: position.id }).eq('id', decisionId)
        if (linkError) throw new Error(`could not link decision ${decisionId} to its new position ${position.id}: ${linkError.message}`)
        // The immutable R-ruler (initial_entry_price/initial_stop_loss_
        // price/initial_risk_usd) and high_water_tracked_from are set
        // atomically INSIDE open_position_atomic as of 2026-09-23 (the
        // aggressive profit-recycling migration) — previously a follow-up
        // UPDATE lived here, which left a permanently null (and so
        // permanently untracked) ruler if the process crashed between the
        // RPC call and this line. Set for EVERY new position, Balanced or
        // Aggressive (migration plan §3.7): high-water state is sampled
        // regardless of the active profile, only the giveback EXIT is
        // Aggressive-gated, at monitor-tick time.
      } else if (plan.kind === 'close') {
        const { trade, realizedPnl, closedPosition } = plan.closeResult
        const { data: rpcData, error: rpcError } = await supabase.rpc('close_position_atomic', {
          p_position_id: closedPosition.id,
          p_closed_at: closedPosition.closedAt,
          p_realized_pnl: realizedPnl,
          p_close_reason: closedPosition.closeReason,
          p_closed_by_decision_id: closedPosition.closedByDecisionId,
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
        })
        if (rpcError) throw new Error(`close_position_atomic failed for ${asset}: ${rpcError.message}`)
        const outcome = Array.isArray(rpcData) ? rpcData[0] : rpcData
        openPositionsByAsset.delete(asset) // either this call closed it, or another path already did — either way it's no longer open
        if (!outcome?.won_race) {
          // The position monitor closed it first between this cycle's read
          // and this attempt (trading-domain-contract.md §6) — the
          // decision already persisted above must now be revised to
          // reflect what actually happened, not what the gate assumed.
          finalRiskStatus = 'rejected'
          await supabase.from('agent_decisions').update({
            risk_status: finalRiskStatus,
            risk_reason: 'position already closed by another path (lost the concurrent-close race)',
          }).eq('id', decisionId)
        } else {
          runningCash = Number(outcome.cash_after ?? runningCash)
          realizedPnlThisRun += realizedPnl
        }
      } else if (plan.kind === 'add') {
        // Phase 2 (2026-09-22/23) — ADD. adjust_position_atomic mutates
        // the ONE open row in place (quantity/entry_price/cost_basis) —
        // never a second position row; positions_one_open_per_asset_idx
        // stays satisfied throughout. p_realized_pnl is null: nothing is
        // realized on an ADD.
        const { updatedPosition, trade } = plan.addResult
        const { data: rpcData, error: rpcError } = await supabase.rpc('adjust_position_atomic', {
          p_position_id: updatedPosition.id,
          p_new_quantity: updatedPosition.quantity,
          p_new_entry_price: updatedPosition.entryPrice,
          p_new_cost_basis: updatedPosition.costBasis,
          p_realized_pnl: null,
          p_trade_id: trade.id,
          p_side: trade.side,
          p_trade_quantity: trade.quantity,
          p_reference_price: trade.referencePrice,
          p_fill_price: trade.fillPrice,
          p_fee: trade.fee,
          p_slippage_cost: trade.slippageCost,
          p_gross_value: trade.grossValue,
          p_net_cash_delta: trade.netCashDelta,
          p_executed_at: trade.executedAt,
          p_intent: trade.intent,
          p_decision_id: decisionId,
        })
        if (rpcError) throw new Error(`adjust_position_atomic (ADD) failed for ${asset}: ${rpcError.message}`)
        const outcome = Array.isArray(rpcData) ? rpcData[0] : rpcData
        if (!outcome?.won_race) {
          // The position monitor closed it first between this cycle's
          // read and this attempt — same race shape as a CLOSE, failing
          // safely: no cash movement, no position mutation, nothing
          // executes.
          finalRiskStatus = 'rejected'
          await supabase.from('agent_decisions').update({
            risk_status: finalRiskStatus,
            risk_reason: 'position already closed by another path before the ADD could execute',
          }).eq('id', decisionId)
        } else {
          runningCash = Number(outcome.cash_after ?? runningCash)
          openPositionsByAsset.set(asset, updatedPosition)
        }
      } else if (plan.kind === 'reduce') {
        // Phase 2 — REDUCE. Same RPC as ADD (both only ever mutate
        // quantity/entry_price/cost_basis on the one open row) —
        // p_realized_pnl is populated here (the realized portion), unlike
        // ADD's null.
        const { updatedPosition, trade, realizedPnl, partialRealizedPnlDelta } = plan.reduceResult
        const { data: rpcData, error: rpcError } = await supabase.rpc('adjust_position_atomic', {
          p_position_id: updatedPosition.id,
          p_new_quantity: updatedPosition.quantity,
          p_new_entry_price: updatedPosition.entryPrice,
          p_new_cost_basis: updatedPosition.costBasis,
          p_realized_pnl: realizedPnl,
          p_trade_id: trade.id,
          p_side: trade.side,
          p_trade_quantity: trade.quantity,
          p_reference_price: trade.referencePrice,
          p_fill_price: trade.fillPrice,
          p_fee: trade.fee,
          p_slippage_cost: trade.slippageCost,
          p_gross_value: trade.grossValue,
          p_net_cash_delta: trade.netCashDelta,
          p_executed_at: trade.executedAt,
          p_intent: trade.intent,
          p_decision_id: decisionId,
          // Aggressive V3.1 (2026-09-23) — accumulated into
          // positions.partial_realized_pnl_usd inside the RPC, never
          // replaced. This is what keeps positionPnlR continuous across a
          // REDUCE (protection.ts's computePositionPnlR) — without it, a
          // deliberate profit harvest would crater the unrealized-only
          // figure and misreport as giveback. Deliberately the NET figure
          // (realizedPnl - fee), not the gross `realizedPnl` used for
          // p_realized_pnl above — positionPnlR is the economic figure
          // the giveback ratchet protects, and a sunk, already-paid fee
          // must reduce it; trades.realized_pnl itself stays gross,
          // matching this codebase's existing convention of reporting
          // P&L and fees as separate line items.
          p_partial_realized_pnl_delta: partialRealizedPnlDelta,
        })
        if (rpcError) throw new Error(`adjust_position_atomic (REDUCE) failed for ${asset}: ${rpcError.message}`)
        const outcome = Array.isArray(rpcData) ? rpcData[0] : rpcData
        if (!outcome?.won_race) {
          finalRiskStatus = 'rejected'
          await supabase.from('agent_decisions').update({
            risk_status: finalRiskStatus,
            risk_reason: 'position already closed by another path before the REDUCE could execute',
          }).eq('id', decisionId)
        } else {
          runningCash = Number(outcome.cash_after ?? runningCash)
          openPositionsByAsset.set(asset, updatedPosition)
          realizedPnlThisRun += realizedPnl
        }
      } else if (plan.kind === 'modifyProtection') {
        // Phase 2 — MODIFY_PROTECTION. No trade, no cash effect — just
        // the two position fields the gate already fully validated
        // (ordering, configured bounds, exhaustion, and that a stop never
        // widens).
        const { updatedPosition } = plan
        const { data: rpcData, error: rpcError } = await supabase.rpc('modify_protection_atomic', {
          p_position_id: updatedPosition.id,
          p_stop_loss_price: updatedPosition.stopLossPrice,
          p_take_profit_price: updatedPosition.takeProfitPrice,
        })
        if (rpcError) throw new Error(`modify_protection_atomic failed for ${asset}: ${rpcError.message}`)
        const outcome = Array.isArray(rpcData) ? rpcData[0] : rpcData
        if (!outcome?.won_race) {
          finalRiskStatus = 'rejected'
          await supabase.from('agent_decisions').update({
            risk_status: finalRiskStatus,
            risk_reason: 'position already closed by another path before protection could be modified',
          }).eq('id', decisionId)
        } else {
          openPositionsByAsset.set(asset, updatedPosition)
        }
      }

      decisions.push({ asset, action: finalProposal.action, riskStatus: finalRiskStatus })
    }

    // Fresh, authoritative NAV for this run's snapshot — re-read cash
    // rather than trusting runningCash's in-memory projection, same
    // reasoning as the position monitor's own nav_snapshot step (a
    // concurrent monitor close during this very cycle could have moved
    // cash independently of anything tracked here).
    const { data: freshPortfolio } = await supabase.from('portfolios').select('cash').eq('id', portfolio.id).single()
    const cash = Number(freshPortfolio?.cash ?? runningCash)
    const { data: freshOpenRows } = await supabase.from('positions').select('*').eq('portfolio_id', portfolio.id).eq('status', 'open')
    const freshOpenPositions = (freshOpenRows ?? []).map(rowToPosition)
    const finalNav = computeNav(cash, freshOpenPositions.map((p) => ({ direction: p.direction, quantity: p.quantity, entryPrice: p.entryPrice, costBasis: p.costBasis, currentPrice: latestPriceByAsset.get(p.asset) ?? p.entryPrice })))
    const positionsValue = finalNav - cash
    const unrealizedPnl = freshOpenPositions.reduce((sum, p) => {
      const current = latestPriceByAsset.get(p.asset) ?? p.entryPrice
      return sum + (p.direction === 'long' ? (current - p.entryPrice) * p.quantity : (p.entryPrice - current) * p.quantity)
    }, 0)
    const { data: priorNav } = await supabase.from('nav_snapshots').select('realized_pnl_cum').eq('portfolio_id', portfolio.id).order('captured_at', { ascending: false }).limit(1).maybeSingle()
    const realizedPnlCum = Number(priorNav?.realized_pnl_cum ?? 0) + realizedPnlThisRun

    await supabase.from('nav_snapshots').insert({
      portfolio_id: portfolio.id,
      run_id: runId,
      cash,
      positions_value: positionsValue,
      nav: finalNav,
      unrealized_pnl: unrealizedPnl,
      realized_pnl_cum: realizedPnlCum,
    })

    await supabase.from('agent_runs').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', runId)

    return { status: 'completed', runId, decisions }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await supabase.from('agent_runs').update({ status: 'failed', error_detail: message, completed_at: new Date().toISOString() }).eq('id', runId)
    return { status: 'failed', runId, decisions: [], detail: message }
  }
}

// V0 execution mode: manual-only (2026-09-19) — this function is invoked
// directly by the Chrome extension's own "Run agent" button (the anon key
// as bearer token, same trust model as its existing read-only queries; no
// separate `control` wrapper — see progress-tracker.md's Architecture
// Decisions). That makes this the first request this function ever
// receives from an actual browser origin rather than a server-to-server
// caller (a cron job, or this session's own direct-invocation live
// checks) — none of which are subject to CORS, a browser-only
// enforcement mechanism. Supabase does not add CORS headers to Edge
// Function responses on its own; without handling it here, every
// extension-triggered call would fail in the browser before this code
// ever ran.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // Body is optional — a future cron caller, and this session's own
  // direct-invocation checks, typically send none at all. req.json()
  // throws on an empty/missing body; that failure is swallowed here
  // rather than treated as a real error, since parseTrigger's own
  // fail-safe default (scheduled) already handles an unparseable body
  // exactly the same way it handles an absent trigger field.
  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = undefined
  }
  const trigger = parseTrigger(body)

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  // Gemini removed entirely (2026-09-22) — Jev is the sole model
  // provider, no fallback. Falls back to '' (never undefined) when
  // unset, matching CycleDeps.typesafeApiKey's required-string type;
  // requestVetoDecisions' own `if (!apiKey)` check turns an empty string
  // into an immediate JevCallError, which the veto block's existing
  // try/catch already fails closed to HOLD from — no special-casing
  // needed here for "key not configured."
  const typesafeApiKey = Deno.env.get('TYPESAFE_API_KEY') ?? ''
  // CoinGecko Demo key (2026-09-22) — undefined (not empty string) when
  // unset, so coingecko.ts's own `apiKey ?` check degrades to keyless
  // access rather than sending an empty header value.
  const coingeckoApiKey = Deno.env.get('COINGECKO_API_KEY') || undefined
  const summary = await runAgentCycle({ supabase, typesafeApiKey, nowIso: new Date().toISOString(), trigger, coingeckoApiKey })
  return new Response(JSON.stringify(summary), { headers: { ...corsHeaders, 'content-type': 'application/json' } })
})
