import { closePosition } from '../agent-cycle/broker/accounting.ts'
import type { ClosePositionResult } from '../agent-cycle/broker/accounting.ts'
import type { AssetSymbol } from '../../../src/shared/market-data/types.ts'
import type { Position } from '../../../src/shared/positions/types.ts'
import { findFirstTrigger, resolveFillPrice } from './triggers.ts'
import type { PricePoint } from './triggers.ts'

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
}

function latestPointAgeMinutes(points: PricePoint[], nowIso: string): number | null {
  if (points.length === 0) return null
  const latestMs = Math.max(...points.map((p) => new Date(p.timestamp).getTime()))
  return (new Date(nowIso).getTime() - latestMs) / 60_000
}

export function planMonitorActions(input: MonitorPlanInput): MonitorPlanResult {
  const closes: ClosePositionResult[] = []
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

    const trigger = findFirstTrigger(position.direction, position.stopLossPrice, position.takeProfitPrice, points)
    if (!trigger.triggered) {
      remainingOpenPositions.push(position)
      continue
    }

    const result = closePosition({
      position,
      attemptedFillPrice: resolveFillPrice(trigger),
      feeBps: input.feeBps,
      slippageBps: input.slippageBps,
      closeReason: trigger.reason,
      decisionId: null, // automatic exit — trades_provenance_valid requires this
      startingCash: cash,
      nowIso: input.nowIso,
    })
    closes.push(result)
    cash = result.cashAfter
    // Closed, not held — deliberately excluded from remainingOpenPositions.
  }

  return { closes, staleAssets, remainingOpenPositions }
}
