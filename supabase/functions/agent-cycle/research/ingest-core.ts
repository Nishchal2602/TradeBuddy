import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import { fetchFundingRateHistory, fetchKlines } from '../providers/binance.ts'
import type { HistoricalTimeframe } from '../providers/binance.ts'
import { fetchStoredMaxOpenTime, historicalBarRowFromKline, upsertHistoricalBars } from './db/historical-bars.ts'
import { fetchStoredMaxFundingTime, upsertHistoricalFundingRates } from './db/historical-funding.ts'

// RESEARCH-1 (2026-10-08, STRAT-1 P5, stage R1) — the pure(ish) ingestion
// loops, extracted so both the local script (research/ingest-historical-
// bars.ts) and the deployed one-off Edge Function
// (functions/ingest-historical-bars/index.ts) call the SAME logic rather
// than maintaining two copies. The deployed function exists because this
// session has no local SUPABASE_SERVICE_ROLE_KEY available (and, per this
// project's own standing secret-handling discipline, does not fetch one
// via `supabase projects api-keys`) — every other deployed Edge Function
// already receives its service-role key automatically from the platform,
// so wrapping ingestion as a function sidesteps ever needing that value
// locally, invoked instead with the already-public anon key as bearer
// token (the established, safe pattern this project's own market-refresh
// verification already used).

const EARLIEST_START_MS = Date.parse('2017-01-01T00:00:00.000Z')
export const HISTORICAL_TIMEFRAMES: HistoricalTimeframe[] = ['1d', '4h', '1h', '30m']

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface IngestResult {
  ingested: number
  totalRequests: number
  reachedPresent: boolean
}

// Ingests ONE (asset, timeframe) pair to completion (resumable — picks up
// from the stored max open_time). requestBudget bounds how many paginated
// requests this single call may make, so one Edge Function invocation
// stays safely within its own wall-clock limit; call again (same args) to
// continue from where it left off.
export async function ingestKlinesFor(
  supabase: SupabaseClient,
  asset: AssetSymbol,
  timeframe: HistoricalTimeframe,
  requestBudget = 300,
  requestDelayMs = 150,
): Promise<IngestResult> {
  const storedMax = await fetchStoredMaxOpenTime(supabase, asset, timeframe)
  let cursor = storedMax ? new Date(storedMax).getTime() + 1 : EARLIEST_START_MS
  let totalIngested = 0
  let requests = 0
  let reachedPresent = false

  while (requests < requestBudget) {
    const klines = await fetchKlines(asset, timeframe, cursor)
    requests++
    if (klines.length === 0) {
      reachedPresent = true
      break
    }

    const nowMs = Date.now()
    const closed = klines.filter((k) => new Date(k.closeTime).getTime() < nowMs)
    if (closed.length === 0) {
      reachedPresent = true
      break
    }

    await upsertHistoricalBars(
      supabase,
      closed.map((k) => historicalBarRowFromKline(asset, timeframe, k)),
    )
    totalIngested += closed.length
    cursor = new Date(closed[closed.length - 1]!.closeTime).getTime() + 1

    if (klines.length < 1000) {
      reachedPresent = true
      break
    }
    await delay(requestDelayMs)
  }

  return { ingested: totalIngested, totalRequests: requests, reachedPresent }
}

export async function ingestFundingFor(
  supabase: SupabaseClient,
  asset: AssetSymbol,
  requestBudget = 50,
  requestDelayMs = 150,
): Promise<IngestResult> {
  const storedMax = await fetchStoredMaxFundingTime(supabase, asset)
  let cursor = storedMax ? new Date(storedMax).getTime() + 1 : EARLIEST_START_MS
  let totalIngested = 0
  let requests = 0
  let reachedPresent = false

  while (requests < requestBudget) {
    const rates = await fetchFundingRateHistory(asset, cursor)
    requests++
    if (rates.length === 0) {
      reachedPresent = true
      break
    }

    await upsertHistoricalFundingRates(
      supabase,
      rates.map((r) => ({ asset, ...r })),
    )
    totalIngested += rates.length
    cursor = new Date(rates[rates.length - 1]!.fundingTime).getTime() + 1

    if (rates.length < 1000) {
      reachedPresent = true
      break
    }
    await delay(requestDelayMs)
  }

  return { ingested: totalIngested, totalRequests: requests, reachedPresent }
}
