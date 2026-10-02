import type { Position } from '../../../src/shared/positions/types.ts'
import { computePositionPnlR } from '../agent-cycle/strategy/aggressive/protection.ts'
import type { PricePoint } from './triggers.ts'

// Strategy V4 (intraday_ls, 2026-10-01) — the two new, intraday_ls-only
// monitor exits (plan §4.2). Both close with close_reason='time_stop';
// kept as two SEPARATE functions rather than one, because they sit at
// DIFFERENT points in the per-tick precedence chain: SL/TP -> HARD MAX ->
// giveback -> SOFT time stop. Hard max is absolute (fires regardless of
// anything else once minutesHeld crosses the ceiling, so plan.ts checks
// it BEFORE giveback); soft is conditional on positionPnlR, and
// giveback's own reason is preferred when both could fire at the same
// tick, so plan.ts checks soft AFTER giveback.
//
// Both walk the SAME chronological points the other exits (triggers.ts,
// giveback.ts) already walk, returning the FIRST point (earliest in
// time) where the condition holds — "a real system would already have
// closed there," the same reasoning findFirstTrigger's own comment
// states for SL/TP.
//
// Eligibility — gating to intraday_ls-ORIGINATED positions specifically
// (position.openedUnderStrategyProfile), never the currently-active
// global profile, and explicitly NOT gated on highWaterTrackedFrom
// (plan §4.2: "time stops apply to every intraday_ls position regardless
// of high_water_tracked_from") — is the CALLER's job, matching
// giveback.ts's own "the caller decides whether this function should
// even be invoked" split.

export interface TimeExitTrigger {
  observedPrice: number
  triggeredAt: string
  minutesHeld: number
}

function sortedChronological(points: readonly PricePoint[]): PricePoint[] {
  return [...points].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
}

function minutesHeldAt(position: Position, pointTimestamp: string): number {
  return (new Date(pointTimestamp).getTime() - new Date(position.openedAt).getTime()) / 60_000
}

// Unconditional — fires purely on elapsed time, regardless of P&L. Needs
// no ruler (initialRiskUsd), unlike the soft variant below, since it
// never reads positionPnlR at all.
export function findHardMaxHoldExit(position: Position, points: readonly PricePoint[], maxHoldMinutes: number): TimeExitTrigger | null {
  for (const point of sortedChronological(points)) {
    const minutesHeld = minutesHeldAt(position, point.timestamp)
    if (minutesHeld >= maxHoldMinutes) {
      return { observedPrice: point.price, triggeredAt: point.timestamp, minutesHeld }
    }
  }
  return null
}

// Conditional on positionPnlR < 0.5 — a position that has already proven
// itself (>= 0.5R) is deliberately exempt, even past timeStopMinutes.
// Silently never fires if the position has no populated ruler — the same
// defensive-no-op discipline giveback.ts's own missing-ruler case uses,
// never a throw (this should be unreachable in practice: every
// intraday_ls position gets its ruler set atomically at origination,
// same as every other post-V3.1 position).
export function findSoftTimeStopExit(position: Position, points: readonly PricePoint[], timeStopMinutes: number): TimeExitTrigger | null {
  const initialRiskUsd = position.initialRiskUsd
  if (initialRiskUsd == null || initialRiskUsd <= 0) return null
  const partialRealizedPnlUsd = position.partialRealizedPnlUsd ?? 0

  for (const point of sortedChronological(points)) {
    const minutesHeld = minutesHeldAt(position, point.timestamp)
    if (minutesHeld < timeStopMinutes) continue
    const unrealizedPnlUsd = position.direction === 'long'
      ? (point.price - position.entryPrice) * position.quantity
      : (position.entryPrice - point.price) * position.quantity
    const positionPnlR = computePositionPnlR(unrealizedPnlUsd, partialRealizedPnlUsd, initialRiskUsd)
    if (positionPnlR < 0.5) {
      return { observedPrice: point.price, triggeredAt: point.timestamp, minutesHeld }
    }
  }
  return null
}
