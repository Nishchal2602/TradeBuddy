import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchFundingRateHistory, fetchKlines } from '../providers/binance.ts'
import type { HistoricalTimeframe } from '../providers/binance.ts'
import type { ResearchSymbol } from './types.ts'
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

// Ingests ONE (binanceSymbol, timeframe) pair to completion (resumable —
// picks up from the stored max open_time, keyed on storageAsset), writing
// under storageAsset rather than binanceSymbol. requestBudget bounds how
// many paginated requests this single call may make, so one Edge Function
// invocation stays safely within its own wall-clock limit; call again
// (same args) to continue from where it left off.
//
// DT-1 (2026-10-09) — binanceSymbol (what to fetch, e.g. 'BCCUSDT') and
// storageAsset (what to store it under, e.g. 'BCH') are DELIBERATELY two
// separate parameters, never one: Binance treats a rename as
// delist-old/list-new, so one underlying asset can have more than one
// binanceSymbol over non-overlapping date ranges (research_contracts is
// where that mapping lives). For the four live assets, binanceSymbol ===
// BINANCE_SPOT_SYMBOL[asset] and storageAsset === asset — identical to the
// pre-2026-10-09 behavior, just resolved one level up by the caller
// instead of inside fetchKlines itself (see binance.ts's own comment).
// endAtMs optionally bounds ingestion to a contract's own delisting/rename
// date, so a later contract's bars are never attributed to an earlier
// one's symbol.
//
// forceFromEarliest (DT-1, 2026-10-09) — when true, ignores the stored
// max and re-fetches from EARLIEST_START_MS regardless. upsertHistoricalBars
// is a full-row upsert (onConflict asset,timeframe,open_time), so this is
// a NON-destructive backfill, never a delete: an already-stored row with
// a pre-quote_volume NULL is simply overwritten with the freshly-fetched
// row, which does carry it. Used once, deliberately, to backfill
// BTC/ETH/SUI/AVAX's 1d rows ingested under RESEARCH-1 (2026-10-08,
// before quote_volume existed as a column) — never on the hot path.
export async function ingestKlinesFor(
  supabase: SupabaseClient,
  binanceSymbol: string,
  storageAsset: ResearchSymbol,
  timeframe: HistoricalTimeframe,
  requestBudget = 300,
  requestDelayMs = 150,
  endAtMs?: number,
  forceFromEarliest = false,
): Promise<IngestResult> {
  const storedMax = forceFromEarliest ? null : await fetchStoredMaxOpenTime(supabase, storageAsset, timeframe)
  let cursor = storedMax ? new Date(storedMax).getTime() + 1 : EARLIEST_START_MS
  let totalIngested = 0
  let requests = 0
  let reachedPresent = false

  if (endAtMs !== undefined && cursor >= endAtMs) {
    return { ingested: 0, totalRequests: 0, reachedPresent: true }
  }

  while (requests < requestBudget) {
    const klines = await fetchKlines(binanceSymbol, timeframe, cursor, endAtMs)
    requests++
    if (klines.length === 0) {
      reachedPresent = true
      break
    }

    const ceilingMs = endAtMs ?? Date.now()
    const closed = klines.filter((k) => new Date(k.closeTime).getTime() < ceilingMs)
    if (closed.length === 0) {
      reachedPresent = true
      break
    }

    await upsertHistoricalBars(
      supabase,
      closed.map((k) => historicalBarRowFromKline(storageAsset, timeframe, k)),
    )
    totalIngested += closed.length
    cursor = new Date(closed[closed.length - 1]!.closeTime).getTime() + 1

    if (klines.length < 1000 || (endAtMs !== undefined && cursor >= endAtMs)) {
      reachedPresent = true
      break
    }
    await delay(requestDelayMs)
  }

  return { ingested: totalIngested, totalRequests: requests, reachedPresent }
}

export async function ingestFundingFor(
  supabase: SupabaseClient,
  binanceSymbol: string,
  storageAsset: ResearchSymbol,
  requestBudget = 50,
  requestDelayMs = 150,
): Promise<IngestResult> {
  const storedMax = await fetchStoredMaxFundingTime(supabase, storageAsset)
  let cursor = storedMax ? new Date(storedMax).getTime() + 1 : EARLIEST_START_MS
  let totalIngested = 0
  let requests = 0
  let reachedPresent = false

  while (requests < requestBudget) {
    const rates = await fetchFundingRateHistory(binanceSymbol, cursor)
    requests++
    if (rates.length === 0) {
      reachedPresent = true
      break
    }

    await upsertHistoricalFundingRates(
      supabase,
      rates.map((r) => ({ asset: storageAsset, ...r })),
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
