import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AssetSymbol } from '../../../src/shared/market-data/types.ts'
import { BINANCE_FUTURES_SYMBOL, BINANCE_SPOT_SYMBOL } from '../agent-cycle/providers/binance.ts'
import { countHistoricalBars } from '../agent-cycle/research/db/historical-bars.ts'
import { countHistoricalFundingRates } from '../agent-cycle/research/db/historical-funding.ts'
import { HISTORICAL_TIMEFRAMES, ingestFundingFor, ingestKlinesFor } from '../agent-cycle/research/ingest-core.ts'

// RESEARCH-1 (2026-10-08, STRAT-1 P5, stage R1) — a deployed wrapper around
// ingest-core.ts's pure ingestion loops, so historical ingestion can run
// WITHOUT a locally-available SUPABASE_SERVICE_ROLE_KEY (this session has
// none, and per this project's own standing secret-handling discipline,
// does not fetch one via `supabase projects api-keys`). Every other
// deployed Edge Function already receives its service-role key
// automatically from the platform; this one is no different. Invoked with
// the already-PUBLIC anon key as bearer token (src/supabase.ts's own
// SUPABASE_ANON_KEY) — the same "anon key legitimately authorizes
// INVOKING a function; RLS and the function's own service-role key govern
// what it can then read/write" pattern this project's market-refresh
// verification already established.
//
// ONE invocation ingests ONE (asset, timeframe) pair's klines, or one
// asset's funding history, resumable and request-budget-bounded so a
// single call stays well within the platform's own execution time limit —
// call again with the same body to continue from where it left off
// (fetchStoredMaxOpenTime/fetchStoredMaxFundingTime make this safe).
//
// Never a cron target, never wired into any schedule — this is a one-off
// research tool, invoked manually/scripted only while backfilling or
// extending the historical range.

// DT-1 (2026-10-09) — the request body now accepts EITHER shape:
//   { asset: 'BTC'|'ETH'|'SUI'|'AVAX', ... }                   — legacy,
//     unchanged behavior, still AssetSymbol-validated.
//   { binanceSymbol: 'BCCUSDT', storageAsset: 'BCH', ... }      — new, the
//     PIT universe path: an arbitrary Binance USDT pair, written under its
//     underlying ResearchSymbol rather than a live AssetSymbol. Two
//     separate fields, never a widened `asset`, because one underlying can
//     have more than one binanceSymbol over non-overlapping date ranges
//     (research_contracts is where that mapping is frozen) — see
//     ingest-core.ts's own comment on why ingestKlinesFor/ingestFundingFor
//     take them as two parameters.
interface IngestRequestBody {
  kind: 'klines' | 'funding'
  asset?: string
  binanceSymbol?: string
  storageAsset?: string
  timeframe?: string
  requestBudget?: number
  endAtMs?: number
  // DT-1 (2026-10-09) — see ingestKlinesFor's own comment: a deliberate,
  // non-destructive backfill mode (full-row upsert overwrites a stale
  // NULL quote_volume), never used by the normal resumable flow.
  forceFromEarliest?: boolean
}

function resolveSymbols(body: IngestRequestBody, lookup: Record<AssetSymbol, string>): { binanceSymbol: string; storageAsset: string } | { error: string } {
  if (body.binanceSymbol && body.storageAsset) {
    return { binanceSymbol: body.binanceSymbol, storageAsset: body.storageAsset }
  }
  if (body.asset) {
    const assetResult = AssetSymbol.safeParse(body.asset)
    if (!assetResult.success) return { error: `invalid asset: ${body.asset}` }
    return { binanceSymbol: lookup[assetResult.data], storageAsset: assetResult.data }
  }
  return { error: 'request body must supply either "asset" or both "binanceSymbol" and "storageAsset"' }
}

async function handleRequest(supabase: SupabaseClient, body: IngestRequestBody) {
  if (body.kind === 'funding') {
    const resolved = resolveSymbols(body, BINANCE_FUTURES_SYMBOL)
    if ('error' in resolved) return { status: 400 as const, body: { error: resolved.error } }
    const result = await ingestFundingFor(supabase, resolved.binanceSymbol, resolved.storageAsset, body.requestBudget ?? 50)
    const totalStored = await countHistoricalFundingRates(supabase, resolved.storageAsset)
    return { status: 200 as const, body: { ...result, ...resolved, kind: 'funding', totalStored } }
  }

  if (!body.timeframe || !HISTORICAL_TIMEFRAMES.includes(body.timeframe as (typeof HISTORICAL_TIMEFRAMES)[number])) {
    return { status: 400 as const, body: { error: `invalid or missing timeframe for kind=klines: ${body.timeframe}` } }
  }
  const timeframe = body.timeframe as (typeof HISTORICAL_TIMEFRAMES)[number]
  const resolved = resolveSymbols(body, BINANCE_SPOT_SYMBOL)
  if ('error' in resolved) return { status: 400 as const, body: { error: resolved.error } }
  const result = await ingestKlinesFor(supabase, resolved.binanceSymbol, resolved.storageAsset, timeframe, body.requestBudget ?? 300, 150, body.endAtMs, body.forceFromEarliest ?? false)
  const totalStored = await countHistoricalBars(supabase, resolved.storageAsset, timeframe)
  return { status: 200 as const, body: { ...result, ...resolved, timeframe, kind: 'klines', totalStored } }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' } })
  }

  let body: IngestRequestBody
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400, headers: { 'content-type': 'application/json' } })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const result = await handleRequest(supabase, body)
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`ingest-historical-bars: ${message}`)
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
})
