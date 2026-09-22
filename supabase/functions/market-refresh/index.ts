import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchLatestQuotes } from '../agent-cycle/providers/coingecko.ts'
import { toQuoteRow, toRefreshErrorRows } from '../agent-cycle/db/quote-rows.ts'
import type { AssetSymbol } from '../../../src/shared/market-data/types.ts'

// A third, deliberately trade-incapable Edge Function ("market_quotes
// plan", 2026-09-21) — its only job is keeping market_quotes fresh
// between manual agent runs. It imports nothing from the strategy, risk
// gate, broker, or either atomic RPC, and touches no table but
// market_quotes — there is no code path here that can produce a
// decision, trade, or position. Runs on its own 5-minute pg_cron
// schedule (supabase/migrations/20260921095012_market_quotes.sql),
// entirely independent of agent-cycle's manual-only decision cadence and
// position-monitor's 10-minute exit cadence.
//
// No agent_runs row, and no idempotency key — unlike a decision or a
// monitor tick, a duplicate or retried refresh is harmless: it just
// upserts the same 2 rows an extra time. Invariant 10 ("idempotent, no
// duplicate trades") protects against duplicate TRADES; there is nothing
// here to duplicate. Deliberately simpler than agent-cycle/
// position-monitor for exactly this reason, not an oversight.

const ASSETS: AssetSymbol[] = ['BTC', 'ETH']

export interface RefreshSummary {
  status: 'refreshed' | 'failed'
  assets: AssetSymbol[]
  detail?: string
}

export interface RefreshDeps {
  supabase: SupabaseClient
  // deno-lint-ignore no-explicit-any
  fetchImpl?: any
  nowIso: string
}

export async function refreshMarketQuotes(deps: RefreshDeps): Promise<RefreshSummary> {
  const { supabase, nowIso } = deps
  const fetchImpl = deps.fetchImpl ?? fetch

  try {
    const quotes = await fetchLatestQuotes(ASSETS, fetchImpl)
    const { error } = await supabase.from('market_quotes').upsert(quotes.map(toQuoteRow), { onConflict: 'asset' })
    if (error) throw new Error(`could not upsert market_quotes: ${error.message}`)
    return { status: 'refreshed', assets: ASSETS }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Error rows touch ONLY the two error columns (quote-rows.ts) — this
    // assumes a row already exists for every asset in ASSETS, which the
    // market_quotes migration guarantees by seeding both before this
    // function's cron job ever exists to fire. Not defended against a
    // hypothetically wiped table: an insert-path upsert with only 3 of
    // the table's 8 not-null columns would fail its own not-null
    // constraints, but that's not a state this function has any way to
    // reach in practice.
    const { error: errorWriteError } = await supabase
      .from('market_quotes')
      .upsert(toRefreshErrorRows(ASSETS, message, nowIso), { onConflict: 'asset' })
    if (errorWriteError) {
      // Best-effort — a cron no-op must never look like an unhandled
      // function crash to the scheduler, so this never throws past here
      // even if recording the failure itself also failed.
      console.error(`market-refresh: could not even record the refresh failure: ${errorWriteError.message}`)
    }
    return { status: 'failed', assets: ASSETS, detail: message }
  }
}

Deno.serve(async (_req) => {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const summary = await refreshMarketQuotes({ supabase, nowIso: new Date().toISOString() })
  return new Response(JSON.stringify(summary), { headers: { 'content-type': 'application/json' } })
})
