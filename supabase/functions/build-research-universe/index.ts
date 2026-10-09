import { createClient } from '@supabase/supabase-js'

// DT-1 (2026-10-09, Order-of-Work step 4) — triggers
// dt1_build_and_write_universe_membership (migration 20261009130000),
// which both computes the PIT universe ranking AND writes it to
// research_universe_membership in one self-contained SQL function call,
// returning only a row count. A deployed wrapper for the usual reason:
// no local SUPABASE_SERVICE_ROLE_KEY.
//
// This file went through four designs before landing here -- see the
// three ranking-function migrations' own comments for the full history
// (150s Edge Function idle timeout -> Postgres statement timeout on a
// deep OFFSET -> WORKER_RESOURCE_LIMIT holding 803K raw bars in memory ->
// PostgREST's max_rows silently truncating a row-returning RPC's result).
// The lesson that stuck: do the heavy lifting in Postgres, move only the
// final small answer (or, as here, nothing at all) over the wire.

interface RequestBody {
  universeVersion: string
  mappingVersion: string
  fromIso?: string
  toIso?: string
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
  if (!body.universeVersion || !body.mappingVersion) {
    return new Response(JSON.stringify({ error: 'universeVersion and mappingVersion are both required' }), { status: 400, headers: { 'content-type': 'application/json' } })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const fromDate = (body.fromIso ?? '2017-06-01T00:00:00.000Z').slice(0, 10)
    const toDate = (body.toIso ?? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()).slice(0, 10)

    const t0 = Date.now()
    const { data, error } = await supabase.rpc('dt1_build_and_write_universe_membership', {
      p_universe_version: body.universeVersion,
      p_mapping_version: body.mappingVersion,
      p_from: fromDate,
      p_to: toDate,
    })
    if (error) throw new Error(`dt1_build_and_write_universe_membership: ${JSON.stringify(error)}`)
    const elapsedMs = Date.now() - t0

    return new Response(
      JSON.stringify({ universeVersion: body.universeVersion, fromDate, toDate, rowsWritten: data, elapsedMs }),
      { status: 200, headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' } },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`build-research-universe: ${message}`)
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
})
