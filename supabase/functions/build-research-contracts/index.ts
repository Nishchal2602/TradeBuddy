import { createClient } from '@supabase/supabase-js'
import { fetchAndBuildResearchContracts } from '../agent-cycle/research/universe/contracts.ts'

// DT-1 (2026-10-09, Order-of-Work step 4) — a deployed wrapper around
// research/universe/contracts.ts's fetchAndBuildResearchContracts, for the
// identical reason ingest-historical-bars/index.ts is deployed rather than
// run as a local script: this session has no local
// SUPABASE_SERVICE_ROLE_KEY (and, per this project's own standing
// secret-handling discipline, does not fetch one via
// `supabase projects api-keys`). Invoked with the already-public anon key
// as bearer token, same established pattern.
//
// One invocation fetches the FULL live exchangeInfo dump (one request) and
// classifies+writes every USDT-quoted symbol under the given
// mappingVersion. Idempotent: re-running with the same mappingVersion is
// a plain upsert, safe to retry.
//
// Never a cron target — a one-off research tool, invoked manually only
// when building or refreshing a frozen mapping_version.

interface RequestBody {
  mappingVersion: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' } })
  }

  let body: RequestBody
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400, headers: { 'content-type': 'application/json' } })
  }

  if (!body.mappingVersion || typeof body.mappingVersion !== 'string') {
    return new Response(JSON.stringify({ error: 'mappingVersion (string) is required' }), { status: 400, headers: { 'content-type': 'application/json' } })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const result = await fetchAndBuildResearchContracts(supabase, body.mappingVersion)
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`build-research-contracts: ${message}`)
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
})
