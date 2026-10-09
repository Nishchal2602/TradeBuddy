import { createClient } from '@supabase/supabase-js'
import { ALL_ASSETS } from '../../../../src/shared/market-data/types.ts'
import { BINANCE_FUTURES_SYMBOL, BINANCE_SPOT_SYMBOL } from '../providers/binance.ts'
import { countHistoricalBars } from './db/historical-bars.ts'
import { countHistoricalFundingRates } from './db/historical-funding.ts'
import { HISTORICAL_TIMEFRAMES, ingestFundingFor, ingestKlinesFor } from './ingest-core.ts'

// RESEARCH-1 (2026-10-08, STRAT-1 P5, stage R1) — one-off / resumable
// historical ingestion from Binance's public endpoints, run locally end to
// end. A LOCAL script, deliberately NOT itself a deployed Edge Function
// (same reasoning as replay/run-golden-replay.ts). Run via:
//
//   deno run --allow-net --allow-env --env-file=.env \
//     supabase/functions/agent-cycle/research/ingest-historical-bars.ts
//
// with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the environment. If
// those are not available locally, use the deployed equivalent instead
// (functions/ingest-historical-bars/index.ts, invoked with the public anon
// key) — see ingest-core.ts's own comment for why that alternative exists.
// Both call the identical ingestKlinesFor/ingestFundingFor logic.

async function main() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment. See this file\'s own header comment.')
    Deno.exit(1)
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  console.log('Ingesting Binance spot klines...')
  for (const asset of ALL_ASSETS) {
    const binanceSymbol = BINANCE_SPOT_SYMBOL[asset]
    for (const timeframe of HISTORICAL_TIMEFRAMES) {
      let caughtUp = false
      while (!caughtUp) {
        const result = await ingestKlinesFor(supabase, binanceSymbol, asset, timeframe)
        caughtUp = result.reachedPresent
      }
      const total = await countHistoricalBars(supabase, asset, timeframe)
      console.log(`  ${asset}/${timeframe}: ${total} total stored`)
    }
  }

  console.log('\nIngesting Binance USDS-M funding-rate history...')
  for (const asset of ALL_ASSETS) {
    const binanceSymbol = BINANCE_FUTURES_SYMBOL[asset]
    let caughtUp = false
    while (!caughtUp) {
      const result = await ingestFundingFor(supabase, binanceSymbol, asset)
      caughtUp = result.reachedPresent
    }
    const total = await countHistoricalFundingRates(supabase, asset)
    console.log(`  ${asset}: ${total} total stored`)
  }

  console.log('\nDone.')
}

if (import.meta.main) {
  await main()
}
