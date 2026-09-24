import type { Position } from '../../../src/shared/positions/types.ts'
import { computeCostR, computePositionPnlR, nextGivebackFloor, shouldExecuteGivebackExit } from '../agent-cycle/strategy/aggressive/protection.ts'
import type { PricePoint } from './triggers.ts'

// Aggressive V3.1 profit recycling (2026-09-23) — the pure decision core
// for the position-monitor's giveback ratchet, mirroring triggers.ts's
// own role for SL/TP exactly: no I/O, no Supabase client, walks a
// chronological window of replayed price points and returns what
// happened, for index.ts to persist. Direct fix for the diagnosis
// finding that R was previously sampled only at manual decision cycles
// (agent-cycle) and so missed intraday peaks entirely — this runs on the
// monitor's automatic 10-minute tick instead.
//
// Eligibility (whether to call this function AT ALL for a given position)
// is the CALLER's job, not this file's: position.highWaterTrackedFrom
// must be non-null (migration plan §5.5 — a legacy position the guarded
// backfill excluded stays permanently outside this mechanism, continuing
// under its existing SL/TP only). Profile-gating the EXIT (Aggressive
// only samples AND exits; Balanced only samples — plan §3.7) is also the
// caller's job: this function always computes both, and the caller
// decides whether to actually execute a reported `exit`.

export interface GivebackTrackingInput {
  // Must carry a populated ruler (initialEntryPrice/initialStopLossPrice/
  // initialRiskUsd) — the caller's eligibility check already guarantees
  // this for any position it's worth calling this function on, but a
  // missing ruler is handled defensively below (returns the position's
  // existing state unchanged) rather than throwing.
  position: Position
  feeBps: number
  slippageBps: number
  // Already fetched and already filtered to "since the last run" — same
  // convention as triggers.ts's findFirstTrigger and plan.ts's own
  // OpenPositionWithPoints.points.
  points: PricePoint[]
}

export interface GivebackExitTrigger {
  positionPnlR: number
  observedPrice: number
  triggeredAt: string
}

export interface GivebackTrackingResult {
  sampledMfeR: number
  sampledMaeR: number
  givebackFloorR: number | null
  peakTotalPnlUsd: number | null
  peakPnlAt: string | null
  // The FIRST point (chronologically) where positionPnlR retraced to or
  // below the (already-armed-by-then) floor — walking stops there, same
  // "first trigger wins, nothing after matters" philosophy findFirstTrigger
  // already uses for SL/TP. Null when no exit condition was ever met in
  // this window.
  exit: GivebackExitTrigger | null
}

function unchangedResult(position: Position): GivebackTrackingResult {
  return {
    sampledMfeR: position.sampledMfeR ?? 0,
    sampledMaeR: position.sampledMaeR ?? 0,
    givebackFloorR: position.givebackFloorR ?? null,
    peakTotalPnlUsd: position.peakTotalPnlUsd ?? null,
    peakPnlAt: position.peakPnlAt ?? null,
    exit: null,
  }
}

export function trackGivebackForPosition(input: GivebackTrackingInput): GivebackTrackingResult {
  const { position, feeBps, slippageBps } = input

  const initialEntryPrice = position.initialEntryPrice
  const initialStopLossPrice = position.initialStopLossPrice
  const initialRiskUsd = position.initialRiskUsd
  // Defensive no-op, not a throw — mirrors managementAtrPctFor's own
  // "never silently fall back" discipline for the case that IS an error
  // (missing intraday data), but this case is a legitimate, expected
  // state (a position the guarded backfill correctly left untouched)
  // reached only if a caller ever calls this without checking eligibility
  // first.
  if (initialEntryPrice == null || initialStopLossPrice == null || initialRiskUsd == null || initialRiskUsd <= 0) {
    return unchangedResult(position)
  }
  if (input.points.length === 0) return unchangedResult(position)

  const chronological = [...input.points].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  const partialRealizedPnlUsd = position.partialRealizedPnlUsd ?? 0

  let mfeR: number | null = position.sampledMfeR ?? null
  let maeR: number | null = position.sampledMaeR ?? null
  let floorR: number | null = position.givebackFloorR ?? null
  let peakTotalPnlUsd: number | null = position.peakTotalPnlUsd ?? null
  let peakPnlAt: string | null = position.peakPnlAt ?? null
  let exit: GivebackExitTrigger | null = null

  for (const point of chronological) {
    const unrealizedPnlUsd = position.direction === 'long'
      ? (point.price - position.entryPrice) * position.quantity
      : (position.entryPrice - point.price) * position.quantity
    const totalPnlUsd = unrealizedPnlUsd + partialRealizedPnlUsd
    const positionPnlR = computePositionPnlR(unrealizedPnlUsd, partialRealizedPnlUsd, initialRiskUsd)

    mfeR = mfeR === null ? positionPnlR : Math.max(mfeR, positionPnlR)
    maeR = maeR === null ? positionPnlR : Math.min(maeR, positionPnlR)

    if (peakTotalPnlUsd === null || totalPnlUsd > peakTotalPnlUsd) {
      peakTotalPnlUsd = totalPnlUsd
      peakPnlAt = point.timestamp
    }

    // Cost is recomputed at THIS point's price (current quantity, both
    // sides) — the numerator tracks the position as it actually is at
    // each observation; the immutable initialRiskUsd denominator never
    // moves.
    const currentRoundTripCostUsd = ((2 * (feeBps + slippageBps)) / 10_000) * position.quantity * point.price
    const costR = computeCostR(currentRoundTripCostUsd, initialRiskUsd)
    floorR = nextGivebackFloor(mfeR, costR, floorR)

    if (shouldExecuteGivebackExit(positionPnlR, floorR)) {
      exit = { positionPnlR, observedPrice: point.price, triggeredAt: point.timestamp }
      break
    }
  }

  return { sampledMfeR: mfeR!, sampledMaeR: maeR!, givebackFloorR: floorR, peakTotalPnlUsd, peakPnlAt, exit }
}
