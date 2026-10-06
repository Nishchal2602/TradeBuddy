import { closePosition } from '../agent-cycle/broker/accounting.ts'
import type { ClosePositionResult } from '../agent-cycle/broker/accounting.ts'
import type { AssetSymbol } from '../../../src/shared/market-data/types.ts'
import type { Position } from '../../../src/shared/positions/types.ts'
import type { StrategyProfile } from '../../../src/shared/strategy/profiles.ts'
import { findFirstTrigger, resolveFillPrice } from './triggers.ts'
import type { PricePoint } from './triggers.ts'
import { trackGivebackForPosition } from './giveback.ts'
import { findHardMaxHoldExit, findSoftTimeStopExit } from './time-exits.ts'

// Pure decision core for one monitor tick — no I/O, no Supabase client, no
// fetch. index.ts's job is reduced to: read this input from the database,
// call this function, persist its output. Same split as every prior step
// (triggers.ts, accounting.ts, gate.ts): the actual decisions are a plain
// function over plain data, testable with fixtures alone.

export interface OpenPositionWithPoints {
  position: Position
  // Already fetched and already filtered to "since the last run"
  // (architecture.md's Position Monitor Cycle, step 2) — this function
  // does not know what "last run" means, it only walks whatever points
  // it's given.
  points: PricePoint[]
}

export interface MonitorPlanInput {
  openPositions: OpenPositionWithPoints[]
  // A position is stale (architecture.md step 3) when its most recent
  // available point is older than this many minutes before nowIso. Reused
  // from agent_settings.max_data_staleness_minutes — the same freshness
  // budget the decision cycle already applies to market data, not a
  // second, independently-invented threshold.
  maxDataStalenessMinutes: number
  nowIso: string
  feeBps: number
  slippageBps: number
  // Portfolio cash at plan time. Only used to populate the transient
  // ClosePositionResult.cashAfter/trade.cashAfter fields for logging — the
  // values actually persisted come from close_position_atomic's own
  // fresh read-modify-write (accounting.ts's module comment / the RPC
  // migration explain why), so staleness here cannot corrupt persisted
  // state. Updated sequentially across multiple closes within one plan
  // call purely so logged figures stay internally consistent.
  startingCash: number
  // Aggressive V3.1 profit recycling (2026-09-23) — the CURRENTLY active
  // strategy profile, read fresh by index.ts from agent_settings every
  // tick. Gates ONLY the giveback EXIT (whether a triggered ratchet
  // actually closes a position); high-water SAMPLING runs regardless of
  // the active profile for any eligible position (migration plan §3.7),
  // so switching back to Aggressive later resumes with intact history
  // rather than a reset ratchet.
  strategyProfile: StrategyProfile
  // CFG-1 Stage 1B (2026-10-06) — the active intraday_ls config's own
  // givebackEnabledForIntradayLs flag (false in both shipped presets
  // today; plan.ts's own giveback block is below). Read by index.ts via
  // agent-cycle/db/strategy-config.ts's loadActiveIntradayLsConfig — the
  // identical config row agent-cycle itself reads, so the two functions
  // can never silently disagree on whether the ratchet is live for this
  // profile. Meaningless (left false) whenever strategyProfile is not
  // 'intraday_ls' — Aggressive's own giveback exit is unconditional and
  // unaffected by this field.
  givebackEnabledForIntradayLs: boolean
  // Strategy V4 (2026-10-01) — threaded into every closePosition call
  // (perpetual funding accrual, broker/accounting.ts's own module
  // comment) and the two new intraday_ls-only exits' own thresholds.
  shortFundingBpsPerDay: number
  timeStopMinutes: number
  maxHoldMinutes: number
}

// One eligible, still-open position's high-water state as of this tick —
// index.ts persists this with exactly ONE atomic .update() per position
// (migration plan §3.6), however many price points were replayed to
// produce it.
export interface HighWaterUpdate {
  positionId: string
  sampledMfeR: number
  sampledMaeR: number
  givebackFloorR: number | null
  peakTotalPnlUsd: number | null
  peakPnlAt: string | null
}

export interface StaleAsset {
  asset: AssetSymbol
  positionId: string
  latestPointAgeMinutes: number | null // null when there were zero points at all
}

export interface MonitorPlanResult {
  closes: ClosePositionResult[]
  staleAssets: StaleAsset[]
  // Every open position this plan did NOT close — held (no trigger) or
  // skipped for staleness. index.ts still needs these for the NAV mark.
  remainingOpenPositions: Position[]
  // Aggressive V3.1 profit recycling (2026-09-23) — positions closed by
  // the giveback ratchet this tick. Kept SEPARATE from `closes` (SL/TP)
  // even though both ultimately call the same closePosition accounting
  // function, so index.ts's own logging can distinguish the two triggers
  // cleanly — the same reasoning staleAssets already gets its own bucket
  // rather than being folded into `closes`.
  givebackCloses: ClosePositionResult[]
  // Sampled high-water state for every eligible, still-open position —
  // see HighWaterUpdate's own comment.
  highWaterUpdates: HighWaterUpdate[]
  // Strategy V4 (2026-10-01) — positions closed by the hard max hold or
  // the soft time stop this tick (plan §4.2). Kept SEPARATE from `closes`
  // and `givebackCloses`, same reasoning as those two already being
  // distinct buckets — index.ts's own logging can tell the three triggers
  // apart. Both new exits share this one bucket (both persist
  // close_reason='time_stop'; nothing downstream needs to know which of
  // the two actually fired).
  timeStopCloses: ClosePositionResult[]
}

function latestPointAgeMinutes(points: PricePoint[], nowIso: string): number | null {
  if (points.length === 0) return null
  const latestMs = Math.max(...points.map((p) => new Date(p.timestamp).getTime()))
  return (new Date(nowIso).getTime() - latestMs) / 60_000
}

export function planMonitorActions(input: MonitorPlanInput): MonitorPlanResult {
  const closes: ClosePositionResult[] = []
  const givebackCloses: ClosePositionResult[] = []
  const timeStopCloses: ClosePositionResult[] = []
  const highWaterUpdates: HighWaterUpdate[] = []
  const staleAssets: StaleAsset[] = []
  const remainingOpenPositions: Position[] = []
  let cash = input.startingCash

  for (const { position, points } of input.openPositions) {
    const ageMinutes = latestPointAgeMinutes(points, input.nowIso)
    const isStale = ageMinutes === null || ageMinutes > input.maxDataStalenessMinutes
    if (isStale) {
      staleAssets.push({ asset: position.asset, positionId: position.id, latestPointAgeMinutes: ageMinutes })
      remainingOpenPositions.push(position)
      continue
    }

    // Precedence (plan §4.2, pre-registered): SL/TP -> hard max hold ->
    // giveback -> soft time stop. SL/TP wins first because it's a price
    // event at a specific replayed point a real system would already
    // have acted on; hard max is absolute and checked next; giveback
    // outranks the soft time stop (both can fire at the same tick —
    // MFE>=1.0 then retraced below 0.5 after 8h — and profit_giveback is
    // the more informative reason); soft time stop is the fallback.
    const trigger = findFirstTrigger(position.direction, position.stopLossPrice, position.takeProfitPrice, points)
    if (trigger.triggered) {
      const result = closePosition({
        position,
        attemptedFillPrice: resolveFillPrice(trigger),
        feeBps: input.feeBps,
        slippageBps: input.slippageBps,
        closeReason: trigger.reason,
        decisionId: null, // automatic exit — trades_provenance_valid requires this
        startingCash: cash,
        nowIso: input.nowIso,
        shortFundingBpsPerDay: input.shortFundingBpsPerDay,
      })
      closes.push(result)
      cash = result.cashAfter
      // Closed, not held — deliberately excluded from remainingOpenPositions
      // and never reaches anything below (SL/TP always wins the race,
      // unchanged — every other exit is only ever evaluated for a
      // position that did NOT breach its static bracket this tick).
      continue
    }

    // Strategy V4 (2026-10-01) — hard max hold. Gated on the position's
    // OWN originating profile (openedUnderStrategyProfile), never the
    // currently-active global one — unlike the giveback EXIT below,
    // which deliberately DOES key on the active profile (see that
    // block's own comment for why that precedent does not generalize
    // here). Explicitly NOT gated on highWaterTrackedFrom either (plan
    // §4.2: "time stops apply to every intraday_ls position regardless
    // of high_water_tracked_from").
    if (position.openedUnderStrategyProfile === 'intraday_ls') {
      const hardMax = findHardMaxHoldExit(position, points, input.maxHoldMinutes)
      if (hardMax) {
        const result = closePosition({
          position,
          attemptedFillPrice: hardMax.observedPrice,
          feeBps: input.feeBps,
          slippageBps: input.slippageBps,
          closeReason: 'time_stop',
          decisionId: null,
          startingCash: cash,
          nowIso: input.nowIso,
          shortFundingBpsPerDay: input.shortFundingBpsPerDay,
        })
        timeStopCloses.push(result)
        cash = result.cashAfter
        continue
      }
    }

    // Aggressive V3.1 profit recycling (2026-09-23) — only for a position
    // that was actually tracked from origination (migration plan §5.5); a
    // legacy position the guarded backfill excluded has
    // highWaterTrackedFrom === null and passes straight through,
    // continuing under its existing SL/TP only, exactly as before this
    // revision.
    if (position.highWaterTrackedFrom != null) {
      const tracking = trackGivebackForPosition({ position, feeBps: input.feeBps, slippageBps: input.slippageBps, points })

      // CFG-1 Stage 1B (2026-10-06) — intraday_ls now reaches this EXIT
      // too when its own config says so (both shipped presets ship this
      // false, matching the plan.ts §4.2 vs. code contradiction this
      // fixes: the plan always listed giveback as an active V4 exit, the
      // code could never reach it under this profile). Aggressive's own
      // exit is unconditional, unchanged.
      const givebackExitEnabled = input.strategyProfile === 'aggressive' ||
        (input.strategyProfile === 'intraday_ls' && input.givebackEnabledForIntradayLs)
      if (tracking.exit !== null && givebackExitEnabled) {
        const result = closePosition({
          position,
          // Same "no windfall" fill-price policy as a stop-loss — the
          // OBSERVED price at the point the ratchet actually triggered,
          // not a clean target level (there is no discrete price level
          // for an R-based trigger to fill at).
          attemptedFillPrice: tracking.exit.observedPrice,
          feeBps: input.feeBps,
          slippageBps: input.slippageBps,
          closeReason: 'profit_giveback',
          decisionId: null,
          startingCash: cash,
          nowIso: input.nowIso,
          shortFundingBpsPerDay: input.shortFundingBpsPerDay,
        })
        givebackCloses.push(result)
        cash = result.cashAfter
        continue // closed — excluded from remainingOpenPositions, no separate highWaterUpdates entry needed
      }

      // Either no exit condition was met, or one was but the active
      // profile/config doesn't enable this exit (Balanced; or intraday_ls
      // with givebackEnabledForIntradayLs false) — sampling continues
      // regardless, only the exit is gated — persist the advanced
      // high-water state and keep the position open.
      highWaterUpdates.push({
        positionId: position.id,
        sampledMfeR: tracking.sampledMfeR,
        sampledMaeR: tracking.sampledMaeR,
        givebackFloorR: tracking.givebackFloorR,
        peakTotalPnlUsd: tracking.peakTotalPnlUsd,
        peakPnlAt: tracking.peakPnlAt,
      })
    }

    // Strategy V4 (2026-10-01) — soft time stop. Same eligibility gate as
    // hard max above; checked LAST, after giveback, per the precedence
    // comment at the top of this loop.
    if (position.openedUnderStrategyProfile === 'intraday_ls') {
      const softStop = findSoftTimeStopExit(position, points, input.timeStopMinutes)
      if (softStop) {
        const result = closePosition({
          position,
          attemptedFillPrice: softStop.observedPrice,
          feeBps: input.feeBps,
          slippageBps: input.slippageBps,
          closeReason: 'time_stop',
          decisionId: null,
          startingCash: cash,
          nowIso: input.nowIso,
          shortFundingBpsPerDay: input.shortFundingBpsPerDay,
        })
        timeStopCloses.push(result)
        cash = result.cashAfter
        continue
      }
    }

    remainingOpenPositions.push(position)
  }

  return { closes, givebackCloses, timeStopCloses, highWaterUpdates, staleAssets, remainingOpenPositions }
}
