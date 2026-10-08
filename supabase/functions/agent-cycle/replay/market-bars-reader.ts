import type { AssetSymbol, NormalizedMarketData } from '../../../../src/shared/market-data/types.ts'
import type { IntradayMarketData } from '../strategy/aggressive/types.ts'
import type { MarketBarRow } from '../db/market-bars.ts'

// CFG-1 Stage 2 (2026-10-06) — pure assembly of market_bars rows into the
// exact NormalizedMarketData/IntradayMarketData shapes detectCandidate
// consumes, scoped to what one real agent-cycle run actually knew at its
// own decision timestamp. Named assembleAsOfCycle, never assembleAsOf —
// the guarantee is scoped to real cycle timestamps only (see the Stage 2
// plan's "ingested_at — exact semantics" section). No DB access here;
// the one impure fetch lives in replay/db/fetch-market-bars.ts.
//
// Deliberately NEVER throws for insufficient data — that would duplicate
// detectCandidate's own checkStrategyDataSufficiency rather than reuse
// it (the plan's own non-negotiable: "not a second implementation of
// trading logic"). This function hands back whatever was actually
// visible, however thin, and lets the existing sufficiency gate classify
// it exactly as it would live.
//
// --- The per-bar ingestedAt rule was WRONG — corrected 2026-10-06, found
// by actually running this against live data before claiming the gate
// passed. -----------------------------------------------------------------
//
// The first version of this function excluded any bar whose OWN
// ingestedAt was null or after the cutoff. Live-checked against real
// data this makes daily/4h replay nearly impossible FOREVER: a daily bar
// only gets a NEW row once every 24h (4h: every 4h), and upsertMarketBars'
// own dedup (`filterNewBars`, db/market-bars.ts) means an ALREADY-STORED
// bar is simply never re-written — so a pre-Stage-0 daily bar's
// ingestedAt stays permanently null even though every cycle since
// Stage 0 has CONTINUED to re-fetch and re-confirm the exact same value
// (coingecko.ts always re-requests the FULL lookback window — 120 days
// daily, 30 days for /ohlc — never an incremental diff; that comment is
// literally why filterNewBars exists at all). Treating "never re-stamped
// due to a storage dedup optimization" as "never confirmed since
// Stage 0" would make the daily series require ~50 DAYS of real time to
// reach replayability and the 4h series ~8 days — not a fidelity
// nuance, a practical dead end, confirmed live: zero of BTC's 125 daily
// bars and only 2 of 212 4h bars carry a real ingestedAt as of this
// writing.
//
// The corrected rule reasons PER TIMEFRAME, not per bar: if ANY bar in
// an (asset, timeframe) series has ingestedAt <= the cutoff, that
// confirming write's own fetch necessarily re-requested and re-verified
// the ENTIRE historical window up through whatever it most recently
// found closed — because this provider is always refetched in full,
// never incrementally. So every bar in that series with closeTime <=
// the confirming write's own ingestedAt is safely "known as of the
// cutoff," regardless of whether THAT bar's own row happened to be the
// one freshly written or one already sitting in the table untouched.
// This still only ever promises correctness at real cycle timestamps
// (ingestedAt values are always a real cycle's nowIso) and still
// permanently excludes a timeframe with ZERO qualifying writes at or
// before the cutoff — it only changes what counts as "confirmed" once
// at least one qualifying write exists.
//
// This rests on one assumption, stated so it is a decision rather than
// a silent premise: CoinGecko's historical OHLC/close values for a
// bar that has already closed do not change between fetches. The rest
// of this codebase already trusts an adjacent form of this (closed
// bars, once closed, are final) — this is the same trust extended one
// step further, to "a value already seen is seen the same way again."
//
// Two permanent, documented gaps (Stage 2 plan's live-input inventory,
// 2B.0) deliberately NOT worked around here:
// - price is NOT part of this function's output. It is not reconstructible
//   from market_bars at all (a live spot quote, not a bar series) — the
//   caller must source it from the decision's own audit trail
//   (agent_decisions.input_payload / market_snapshots) and assign it
//   itself, never from this reader.
// - closeSeries/volumeSeries (the hourly series the fade arm alone
//   reads) are always empty here — no market_bars timeframe stores them.
//   Inert for every LONG/SHORT-biased replay (fade is never reached);
//   the golden-replay driver must exclude any real NEUTRAL-bias row from
//   its pass/fail comparison set rather than let this gap masquerade as
//   a harness bug.

export interface AssembledCycleMarketData {
  // price deliberately absent — see this module's own comment above.
  dailyCloseSeries: NormalizedMarketData['dailyCloseSeries']
  candles: NormalizedMarketData['candles']
  closeSeries: NormalizedMarketData['closeSeries']
  volumeSeries: NormalizedMarketData['volumeSeries']
  ohlc30m: IntradayMarketData['ohlc30m']
  spot5m: IntradayMarketData['spot5m']
}

function byCloseTimeAscending(a: MarketBarRow, b: MarketBarRow): number {
  return new Date(a.closeTime).getTime() - new Date(b.closeTime).getTime()
}

// The one confirming-write computation, per (asset, timeframe) series:
// the LATEST ingestedAt that is still <= the cutoff. Null when this
// series has never once been written at or before the cutoff — the
// series is then entirely unknown, not approximated.
function latestConfirmedIngestedAtMs(series: readonly MarketBarRow[], cutoffMs: number): number | null {
  let latest: number | null = null
  for (const b of series) {
    if (b.ingestedAt === null) continue
    const t = new Date(b.ingestedAt).getTime()
    if (t > cutoffMs) continue
    if (latest === null || t > latest) latest = t
  }
  return latest
}

// Every bar in `series` with closeTime <= the series' own confirming
// write (which is itself always <= cutoffMs, so this can never leak a
// bar from strictly after the cutoff), sorted oldest -> newest.
function visibleSeries(series: readonly MarketBarRow[], cutoffMs: number): MarketBarRow[] {
  const confirmedThroughMs = latestConfirmedIngestedAtMs(series, cutoffMs)
  if (confirmedThroughMs === null) return []
  return series.filter((b) => new Date(b.closeTime).getTime() <= confirmedThroughMs).sort(byCloseTimeAscending)
}

export function assembleAsOfCycle(asset: AssetSymbol, bars: readonly MarketBarRow[], asOfCycleIso: string): AssembledCycleMarketData {
  const cutoffMs = new Date(asOfCycleIso).getTime()
  const forAsset = bars.filter((b) => b.asset === asset)

  // Plan STRAT-1 P2 (2026-10-08) — '1d' rows flagged isOffGrid are a
  // confirmed look-ahead defect (the live spot price, mislabeled as a
  // closed daily close — see market-bars.ts's own comment on the field)
  // and must never enter a replayed dailyCloseSeries. Excluded before
  // visibleSeries runs, not after: visibleSeries' own closeTime <=
  // confirmedThroughMs logic has no way to know these specific rows are
  // untrustworthy, and letting one through would silently reproduce the
  // exact defect this fix exists to close.
  const daily = visibleSeries(forAsset.filter((b) => b.timeframe === '1d' && !b.isOffGrid), cutoffMs)
  const fourH = visibleSeries(forAsset.filter((b) => b.timeframe === '4h'), cutoffMs)
  const thirtyM = visibleSeries(forAsset.filter((b) => b.timeframe === '30m'), cutoffMs)
  const fiveM = visibleSeries(forAsset.filter((b) => b.timeframe === '5m'), cutoffMs)

  return {
    dailyCloseSeries: daily.map((b) => ({ timestamp: b.closeTime, close: b.close })),
    candles: fourH.map((b) => ({ timestamp: b.closeTime, open: b.open ?? b.close, high: b.high ?? b.close, low: b.low ?? b.close, close: b.close })),
    // Permanently empty — see this module's own comment above. Never
    // populated from a substitute series; detectFadeOpportunity's own
    // `closes.length < MIN_CLOSES_FOR_FADE` guard degrades this cleanly.
    closeSeries: [],
    volumeSeries: [],
    ohlc30m: thirtyM.map((b) => ({ timestamp: b.closeTime, open: b.open ?? b.close, high: b.high ?? b.close, low: b.low ?? b.close, close: b.close })),
    spot5m: fiveM.map((b) => ({ timestamp: b.closeTime, price: b.close, volume: b.volume ?? 0 })),
  }
}
