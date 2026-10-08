import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AssetSymbol } from '../../../src/shared/market-data/types.ts'
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

interface IngestRequestBody {
  kind: 'klines' | 'funding'
  asset: string
  timeframe?: string
  requestBudget?: number
}

async function handleRequest(supabase: SupabaseClient, body: IngestRequestBody) {
  const assetResult = AssetSymbol.safeParse(body.asset)
  if (!assetResult.success) {
    return { status: 400 as const, body: { error: `invalid asset: ${body.asset}` } }
  }
  const asset = assetResult.data

  if (body.kind === 'funding') {
    const result = await ingestFundingFor(supabase, asset, body.requestBudget ?? 50)
    const totalStored = await countHistoricalFundingRates(supabase, asset)
    return { status: 200 as const, body: { ...result, asset, kind: 'funding', totalStored } }
  }

  if (!body.timeframe || !HISTORICAL_TIMEFRAMES.includes(body.timeframe as (typeof HISTORICAL_TIMEFRAMES)[number])) {
    return { status: 400 as const, body: { error: `invalid or missing timeframe for kind=klines: ${body.timeframe}` } }
  }
  const timeframe = body.timeframe as (typeof HISTORICAL_TIMEFRAMES)[number]
  const result = await ingestKlinesFor(supabase, asset, timeframe, body.requestBudget ?? 300)
  const totalStored = await countHistoricalBars(supabase, asset, timeframe)
  return { status: 200 as const, body: { ...result, asset, timeframe, kind: 'klines', totalStored } }
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
