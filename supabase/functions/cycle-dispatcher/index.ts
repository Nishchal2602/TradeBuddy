import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CoinGeckoMarketDataProvider, fetchIntradayMarketData } from '../agent-cycle/providers/coingecko.ts'
import { RssNewsProvider } from '../agent-cycle/providers/rss-news.ts'
import { persistNews } from '../agent-cycle/db/news.ts'
import { readSettings } from '../agent-cycle/db/settings.ts'
import { toQuoteRow } from '../agent-cycle/db/quote-rows.ts'
import { loadVariantForPortfolio } from '../agent-cycle/db/experiment-account.ts'
import { resolveAccountSettings } from '../agent-cycle/cycle/resolve-account-settings.ts'
import { isCadenceDue } from '../agent-cycle/cycle/cadence.ts'
import { floorToIntervalIso } from '../agent-cycle/cycle/idempotency.ts'
import { strategyFor } from '../agent-cycle/strategy/registry.ts'
import type { MarketTickPayload } from '../agent-cycle/db/market-tick.ts'
import type { AssetSymbol } from '../../../src/shared/market-data/types.ts'
import type { NormalizedNewsItem } from '../../../src/shared/news/types.ts'

// EXP-1 Stage E3 (2026-10-07) — the one place "one fetch, shared by
// every account due this tick" actually happens. Runs on its own pg_cron
// schedule (15-minute grid, wired in E4 — not yet scheduled; this stage
// builds and manually proves the mechanism first, per the plan's own
// "prove the dispatcher via manual invocation against a test account
// before any live cron changes" gate). The live champion is completely
// untouched by this function — it is resolved and scheduled exactly as
// before, via agent-cycle-15min's own direct cron, and is deliberately
// never a member of the `is_test = true` population this file queries.
//
// Three outcomes per tick, by design:
//   - no_due_accounts: the common case today (zero test portfolios
//     exist yet) — returns immediately, zero CoinGecko/news calls, no
//     market_ticks row written at all.
//   - duplicate_tick: another invocation already claimed (or already
//     finished) this exact logical_tick_at slot. A 'fetching' claimant
//     means a real fetch is in flight right now — this invocation does
//     NOT also fetch or fan out (avoids a double-fetch/double-dispatch
//     race). A 'ready' claimant means the SAME tick already completed —
//     this invocation reuses that market_tick_id and still fans out to
//     its own due list, so a retried invocation never silently drops an
//     account the original invocation's own due-list happened to miss.
//   - completed: this invocation itself won the claim (or reused an
//     already-ready tick) and fanned out to every due account.
//
// market_ticks.logical_tick_at unique is what makes "exactly one tick
// per slot" true under concurrent/retried invocations — see that
// column's own migration comment.

export interface DispatchedAccountResult {
  portfolioId: string
  status: string
}

export interface DispatchSummary {
  status: 'completed' | 'no_due_accounts' | 'duplicate_tick' | 'failed'
  logicalTickAt: string
  marketTickId?: string
  dueCount: number
  dispatched: DispatchedAccountResult[]
  detail?: string
}

export interface DispatchDeps {
  supabase: SupabaseClient
  // deno-lint-ignore no-explicit-any
  fetchImpl?: any
  nowIso: string
  coingeckoApiKey?: string
  // Bounded fan-out concurrency — Jev's own client has a 15s timeout with
  // up to 2 retries (model/jev/client.ts), so an unbounded burst risks
  // both provider throttling and this function's own wall-clock. Default
  // chosen to match the plan's own worked design, not tuned against load
  // yet (no real account count exists to tune against).
  concurrency?: number
}

interface DueAccount {
  portfolioId: string
  effectiveCadenceMinutes: number
  effectiveAssets: AssetSymbol[]
}

// A small worker-pool fan-out — no library needed for a bounded number
// of concurrent promises. Every item is attempted exactly once; a
// worker's own thrown error is caught by the caller (dispatchToAccount
// below never lets one escape), so one slow/failing item never stalls
// the pool for the others.
async function runWithConcurrencyLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0
  async function runOne(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++
      await worker(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runOne()))
}

export async function runCycleDispatcher(deps: DispatchDeps): Promise<DispatchSummary> {
  const { supabase, nowIso, coingeckoApiKey } = deps
  const fetchImpl = deps.fetchImpl ?? fetch
  const concurrency = deps.concurrency ?? 8

  // The dispatcher's own cadence is fixed at 15 minutes (the finest
  // cadence any variant may declare — experiment_variants' own CHECK
  // constraint enforces `decision_interval_minutes % 15 = 0`), so every
  // due-or-not cadence's grid coincides with THIS tick grid exactly.
  const logicalTickAt = floorToIntervalIso(nowIso, 15)

  const globalSettings = await readSettings(supabase)
  const strategy = strategyFor(globalSettings.strategyProfile)

  // Only ever test/experiment accounts — the champion (is_test=false) is
  // never a member of this population and is never fanned out to from
  // here, by design (see the module comment above).
  const { data: testPortfolios, error: portfoliosError } = await supabase
    .from('portfolios')
    .select('id, experiment_variant_id')
    .eq('is_test', true)
  if (portfoliosError) {
    return { status: 'failed', logicalTickAt, dueCount: 0, dispatched: [], detail: `could not read test portfolios: ${portfoliosError.message}` }
  }

  const resolved: DueAccount[] = await Promise.all(
    (testPortfolios ?? []).map(async (row): Promise<DueAccount> => {
      const variant = await loadVariantForPortfolio(supabase, row.experiment_variant_id)
      const effectiveSettings = resolveAccountSettings(globalSettings, variant)
      const effectiveCadenceMinutes = variant?.decisionIntervalMinutes ?? strategy.decisionIntervalMinutes
      return { portfolioId: row.id, effectiveCadenceMinutes, effectiveAssets: effectiveSettings.assets }
    }),
  )

  const due = resolved.filter((account) => isCadenceDue(logicalTickAt, account.effectiveCadenceMinutes))

  if (due.length === 0) {
    return { status: 'no_due_accounts', logicalTickAt, dueCount: 0, dispatched: [] }
  }

  const unionAssets = [...new Set(due.flatMap((account) => account.effectiveAssets))] as AssetSymbol[]

  // Claim the tick. The unique index on logical_tick_at is the only
  // thing standing between "two concurrent/retried invocations of the
  // same slot" and "two independent fetches + two independent fan-outs"
  // — see market_ticks' own migration comment for why this race is
  // distinct from (and in addition to) the per-account idempotency key.
  const { data: claimed, error: claimError } = await supabase
    .from('market_ticks')
    .insert({ logical_tick_at: logicalTickAt, assets: unionAssets, status: 'fetching' })
    .select('id, status')
    .single()

  let marketTickId: string
  let needsFetch: boolean

  if (claimError) {
    if (claimError.code !== '23505') {
      return { status: 'failed', logicalTickAt, dueCount: due.length, dispatched: [], detail: `could not claim market_ticks row: ${claimError.message}` }
    }
    const { data: existing, error: existingError } = await supabase
      .from('market_ticks')
      .select('id, status')
      .eq('logical_tick_at', logicalTickAt)
      .single()
    if (existingError || !existing) {
      return { status: 'failed', logicalTickAt, dueCount: due.length, dispatched: [], detail: `lost the tick-claim race but could not read the winning row: ${existingError?.message}` }
    }
    if (existing.status === 'fetching') {
      // Another invocation is actively fetching this tick right now —
      // do not fetch again and do not fan out; that invocation owns
      // both once it finishes.
      return { status: 'duplicate_tick', logicalTickAt, marketTickId: existing.id, dueCount: due.length, dispatched: [], detail: 'another invocation is currently fetching this tick' }
    }
    if (existing.status === 'failed') {
      return { status: 'failed', logicalTickAt, marketTickId: existing.id, dueCount: due.length, dispatched: [], detail: 'this tick already failed on a prior invocation' }
    }
    // existing.status === 'ready' — reuse it, skip straight to fan-out.
    marketTickId = existing.id
    needsFetch = false
  } else {
    marketTickId = claimed.id
    needsFetch = true
  }

  if (needsFetch) {
    try {
      const marketProvider = new CoinGeckoMarketDataProvider(fetchImpl, undefined, coingeckoApiKey)
      const newsProvider = new RssNewsProvider(fetchImpl)

      const marketData = await marketProvider.getMarketData(unionAssets)

      // Same profile-gated fetch as agent-cycle's own Pass 2 — strategy
      // profile is global (never variant-overridable), so this is
      // identical for every due account this tick.
      const intradayByAsset = globalSettings.strategyProfile === 'aggressive' || globalSettings.strategyProfile === 'intraday_ls'
        ? await fetchIntradayMarketData(unionAssets, fetchImpl, undefined, coingeckoApiKey)
        : {}

      const lookbackMinutes = strategy.newsLookbackMinutes + globalSettings.newsLookbackOverlapMinutes
      let rawNews: NormalizedNewsItem[] = []
      try {
        rawNews = await newsProvider.getRecentNews(unionAssets, lookbackMinutes)
      } catch (error) {
        // A news-provider failure must not fail the whole tick (same
        // fail-open-on-news reasoning agent-cycle's own cycle uses) — an
        // empty rawNews here means every due account's own veto layer
        // fails closed this tick, exactly as if that account's own
        // direct fetch had failed the identical way.
        console.error(`cycle-dispatcher: news fetch failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      const persistedByExternalId = await persistNews(supabase, rawNews)

      // Same "side write, never fails the cycle" discipline as
      // agent-cycle's own market_quotes upsert — done ONCE here for the
      // whole tick, never repeated per account (agent-cycle's own
      // sharedTick branch skips this for exactly that reason).
      const { error: quotesError } = await supabase.from('market_quotes').upsert(marketData.map(toQuoteRow), { onConflict: 'asset' })
      if (quotesError) console.error(`cycle-dispatcher: could not upsert market_quotes: ${quotesError.message}`)

      const payload: MarketTickPayload = {
        marketData,
        intradayByAsset,
        rawNews,
        persistedNewsByExternalId: Object.fromEntries(persistedByExternalId),
      }

      const { error: readyError } = await supabase
        .from('market_ticks')
        .update({ payload, captured_at: new Date().toISOString(), status: 'ready' })
        .eq('id', marketTickId)
      if (readyError) throw new Error(`could not mark market_ticks row ready: ${readyError.message}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await supabase.from('market_ticks').update({ status: 'failed' }).eq('id', marketTickId)
      return { status: 'failed', logicalTickAt, marketTickId, dueCount: due.length, dispatched: [], detail: message }
    }
  }

  // Fan out, bounded concurrency. One account's failure is isolated and
  // logged — it never prevents another account's cycle from running.
  const dispatched: DispatchedAccountResult[] = []
  await runWithConcurrencyLimit(due, concurrency, async (account) => {
    try {
      const { data, error } = await supabase.functions.invoke('agent-cycle', {
        body: { trigger: 'scheduled', portfolioId: account.portfolioId, marketTickId },
      })
      if (error) {
        dispatched.push({ portfolioId: account.portfolioId, status: 'failed' })
        console.error(`cycle-dispatcher: agent-cycle invocation failed for portfolio ${account.portfolioId}: ${error.message}`)
      } else {
        dispatched.push({ portfolioId: account.portfolioId, status: (data as { status?: string } | null)?.status ?? 'unknown' })
      }
    } catch (error) {
      dispatched.push({ portfolioId: account.portfolioId, status: 'failed' })
      console.error(`cycle-dispatcher: unexpected error dispatching portfolio ${account.portfolioId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  return { status: 'completed', logicalTickAt, marketTickId, dueCount: due.length, dispatched }
}

Deno.serve(async (_req) => {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const coingeckoApiKey = Deno.env.get('COINGECKO_API_KEY') || undefined
  const summary = await runCycleDispatcher({ supabase, nowIso: new Date().toISOString(), coingeckoApiKey })
  return new Response(JSON.stringify(summary), { headers: { 'content-type': 'application/json' } })
})
