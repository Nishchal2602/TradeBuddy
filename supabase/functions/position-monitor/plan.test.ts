import { assertEquals } from 'jsr:@std/assert@1'
import { planMonitorActions } from './plan.ts'
import type { Position } from '../../../src/shared/positions/types.ts'

const NOW = '2026-09-18T12:00:00.000Z'

function longPosition(overrides: Partial<Position> = {}): Position {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    portfolioId: '22222222-2222-2222-2222-222222222222',
    asset: 'BTC',
    direction: 'long',
    quantity: 1,
    entryPrice: 100,
    costBasis: 100,
    stopLossPrice: 95,
    takeProfitPrice: 110,
    status: 'open',
    openedAt: '2026-09-18T00:00:00.000Z',
    closedAt: null,
    realizedPnl: null,
    closeReason: null,
    openedByDecisionId: '33333333-3333-3333-3333-333333333333',
    closedByDecisionId: null,
    ...overrides,
  }
}

function point(minutesAgo: number, price: number) {
  return { timestamp: new Date(new Date(NOW).getTime() - minutesAgo * 60_000).toISOString(), price }
}

const BASE_INPUT = {
  maxDataStalenessMinutes: 20, nowIso: NOW, feeBps: 0, slippageBps: 0, startingCash: 1000, strategyProfile: 'balanced' as const,
  shortFundingBpsPerDay: 0, timeStopMinutes: 480, maxHoldMinutes: 1440, givebackEnabledForIntradayLs: false,
}

Deno.test('planMonitorActions: no open positions -> everything empty', () => {
  const result = planMonitorActions({ ...BASE_INPUT, openPositions: [] })
  assertEquals(result, { closes: [], givebackCloses: [], timeStopCloses: [], highWaterUpdates: [], staleAssets: [], remainingOpenPositions: [] })
})

Deno.test('planMonitorActions: fresh data, no trigger -> held, not closed', () => {
  const position = longPosition()
  const result = planMonitorActions({
    ...BASE_INPUT,
    openPositions: [{ position, points: [point(5, 102), point(0, 103)] }],
  })
  assertEquals(result.closes.length, 0)
  assertEquals(result.staleAssets.length, 0)
  assertEquals(result.remainingOpenPositions, [position])
})

Deno.test('planMonitorActions: fresh data, take-profit breach -> closed, removed from remaining', () => {
  const position = longPosition()
  const result = planMonitorActions({
    ...BASE_INPUT,
    openPositions: [{ position, points: [point(0, 112)] }],
  })
  assertEquals(result.closes.length, 1)
  assertEquals(result.closes[0]!.trade.triggerReason, 'take_profit')
  assertEquals(result.closes[0]!.trade.fillPrice, 110) // TP fills at trigger level, not the observed 112
  assertEquals(result.remainingOpenPositions, [])
})

Deno.test('planMonitorActions: stale data (latest point older than threshold) -> not evaluated, stays open', () => {
  const position = longPosition()
  // 112 would breach TP if evaluated — proving staleness is checked BEFORE
  // trigger evaluation, not that this price happens not to trigger.
  const result = planMonitorActions({
    ...BASE_INPUT,
    openPositions: [{ position, points: [point(25, 112)] }], // 25 min > 20 min threshold
  })
  assertEquals(result.closes.length, 0)
  assertEquals(result.staleAssets.length, 1)
  assertEquals(result.staleAssets[0]!.asset, 'BTC')
  assertEquals(result.staleAssets[0]!.latestPointAgeMinutes, 25)
  assertEquals(result.remainingOpenPositions, [position])
})

Deno.test('planMonitorActions: zero points at all -> stale with null age, stays open', () => {
  const position = longPosition()
  const result = planMonitorActions({ ...BASE_INPUT, openPositions: [{ position, points: [] }] })
  assertEquals(result.staleAssets, [{ asset: 'BTC', positionId: position.id, latestPointAgeMinutes: null }])
  assertEquals(result.remainingOpenPositions, [position])
})

Deno.test('planMonitorActions: latest point exactly AT the staleness threshold counts as fresh (boundary inclusive)', () => {
  const position = longPosition()
  const result = planMonitorActions({
    ...BASE_INPUT,
    openPositions: [{ position, points: [point(20, 103)] }], // exactly 20 min, threshold is 20
  })
  assertEquals(result.staleAssets.length, 0)
  assertEquals(result.remainingOpenPositions, [position])
})

Deno.test('planMonitorActions: two positions in one tick thread cash sequentially, not independently from startingCash', () => {
  const btc = longPosition({
    id: '11111111-1111-1111-1111-111111111111',
    asset: 'BTC',
    entryPrice: 100,
    costBasis: 100,
    stopLossPrice: 95,
    takeProfitPrice: 110,
  })
  const eth = longPosition({
    id: '44444444-4444-4444-4444-444444444444',
    asset: 'ETH',
    entryPrice: 50,
    costBasis: 50,
    stopLossPrice: 45,
    takeProfitPrice: 60,
  })
  const result = planMonitorActions({
    ...BASE_INPUT,
    startingCash: 1000,
    openPositions: [
      { position: btc, points: [point(0, 110)] }, // TP -> fillPrice 110, netCashDelta +110
      { position: eth, points: [point(0, 60)] }, // TP -> fillPrice 60, netCashDelta +60
    ],
  })
  assertEquals(result.closes.length, 2)
  assertEquals(result.closes[0]!.cashAfter, 1110) // 1000 + 110
  assertEquals(result.closes[1]!.cashAfter, 1170) // 1110 + 60, NOT 1000 + 60
})

Deno.test('planMonitorActions: mixed tick -> one closed, one held, one stale, all correctly bucketed', () => {
  const closes = longPosition({ id: '11111111-1111-1111-1111-111111111111', asset: 'BTC' })
  const holds = longPosition({ id: '44444444-4444-4444-4444-444444444444', asset: 'ETH', entryPrice: 50, stopLossPrice: 45, takeProfitPrice: 60, costBasis: 50 })
  const stale = longPosition({ id: '55555555-5555-5555-5555-555555555555', asset: 'BTC', entryPrice: 200, stopLossPrice: 190, takeProfitPrice: 220, costBasis: 200 })

  const result = planMonitorActions({
    ...BASE_INPUT,
    openPositions: [
      { position: closes, points: [point(0, 112)] }, // TP breach
      { position: holds, points: [point(0, 55)] }, // within band
      { position: stale, points: [point(30, 500)] }, // stale, would've been a huge TP breach if evaluated
    ],
  })

  assertEquals(result.closes.length, 1)
  assertEquals(result.closes[0]!.closedPosition.id, closes.id)
  assertEquals(result.remainingOpenPositions.map((p) => p.id).sort(), [holds.id, stale.id].sort())
  assertEquals(result.staleAssets.map((s) => s.positionId), [stale.id])
})

// --- Aggressive V3.1 profit recycling: the giveback ratchet, wired into
// the monitor's per-position loop (migration plan §3.5/§3.7/§5.1) --------

// entry 100, initialStop 92 -> riskPerUnit0 = 8, qty 10 -> initialRiskUsd 80.
// stopLossPrice/takeProfitPrice set far away so SL/TP never breaches in
// these fixtures — isolating the giveback ratchet from the static bracket
// it must never interfere with.
function trackedLongPosition(overrides: Partial<Position> = {}): Position {
  return longPosition({
    quantity: 10,
    stopLossPrice: 10, takeProfitPrice: 1000,
    initialEntryPrice: 100, initialStopLossPrice: 92, initialRiskUsd: 80,
    partialRealizedPnlUsd: 0, sampledMfeR: null, sampledMaeR: null,
    peakTotalPnlUsd: null, peakPnlAt: null, givebackFloorR: null,
    highWaterTrackedFrom: '2026-09-18T00:00:00.000Z',
    ...overrides,
  })
}

Deno.test('planMonitorActions: SL/TP always wins the race — a position that breaches its static bracket never reaches giveback tracking', () => {
  const position = trackedLongPosition({ takeProfitPrice: 108, sampledMfeR: 4.0, givebackFloorR: 1.5 }) // armed and, on positionPnlR alone, would exit — but TP breaches FIRST
  const result = planMonitorActions({ ...BASE_INPUT, strategyProfile: 'aggressive', openPositions: [{ position, points: [point(0, 108)] }] })
  assertEquals(result.closes.length, 1)
  assertEquals(result.closes[0]!.closedPosition.closeReason, 'take_profit')
  assertEquals(result.givebackCloses.length, 0)
})

Deno.test('planMonitorActions: a legacy position (highWaterTrackedFrom null) is never sampled and never exits on giveback, regardless of profile', () => {
  const legacy = trackedLongPosition({ highWaterTrackedFrom: null })
  const result = planMonitorActions({ ...BASE_INPUT, strategyProfile: 'aggressive', openPositions: [{ position: legacy, points: [point(0, 132), point(0, 100)] }] })
  assertEquals(result.givebackCloses.length, 0)
  assertEquals(result.highWaterUpdates.length, 0)
  assertEquals(result.remainingOpenPositions.map((p) => p.id), [legacy.id])
})

Deno.test('planMonitorActions: an eligible position under Balanced is SAMPLED but never EXITED — profile gates only the exit (plan §3.7)', () => {
  const position = trackedLongPosition()
  // 100 -> 132 (+4R, arms 1.5R floor) -> 108 (+1R, would cross the floor)
  const result = planMonitorActions({ ...BASE_INPUT, strategyProfile: 'balanced', openPositions: [{ position, points: [point(5, 132), point(0, 108)] }] })
  assertEquals(result.givebackCloses.length, 0, 'Balanced never executes a giveback exit')
  assertEquals(result.closes.length, 0)
  assertEquals(result.remainingOpenPositions.map((p) => p.id), [position.id])
  assertEquals(result.highWaterUpdates.length, 1, 'but high-water state IS still sampled under Balanced')
  assertEquals(result.highWaterUpdates[0]!.sampledMfeR, 4.0)
})

Deno.test('planMonitorActions: an eligible position under Aggressive DOES exit via profit_giveback when the ratchet fires', () => {
  const position = trackedLongPosition()
  const result = planMonitorActions({ ...BASE_INPUT, strategyProfile: 'aggressive', openPositions: [{ position, points: [point(5, 132), point(0, 108)] }] })
  assertEquals(result.givebackCloses.length, 1)
  assertEquals(result.givebackCloses[0]!.closedPosition.closeReason, 'profit_giveback')
  assertEquals(result.remainingOpenPositions.length, 0)
  assertEquals(result.highWaterUpdates.length, 0, 'a closed position gets no separate high-water update — its final state travels on the close itself')
})

Deno.test('planMonitorActions: no premature exit under Aggressive — a small pullback below +1R stays open with no giveback close', () => {
  const position = trackedLongPosition()
  const result = planMonitorActions({ ...BASE_INPUT, strategyProfile: 'aggressive', openPositions: [{ position, points: [point(0, 104)] }] }) // +0.5R, unarmed
  assertEquals(result.givebackCloses.length, 0)
  assertEquals(result.remainingOpenPositions.map((p) => p.id), [position.id])
})

// CFG-1 Stage 1B (2026-10-06) — the giveback EXIT's intraday_ls gap: both
// shipped presets today ship givebackEnabledForIntradayLs=false, which is
// exactly the OLD unconditional behavior below; a config flipping it on is
// what newly reaches the exit, mirroring the Balanced/Aggressive pair above.

Deno.test('planMonitorActions: an eligible position under intraday_ls is SAMPLED but never EXITED when givebackEnabledForIntradayLs is false (the shipped default)', () => {
  const position = trackedLongPosition()
  const result = planMonitorActions({
    ...BASE_INPUT, strategyProfile: 'intraday_ls', givebackEnabledForIntradayLs: false,
    openPositions: [{ position, points: [point(5, 132), point(0, 108)] }],
  })
  assertEquals(result.givebackCloses.length, 0)
  assertEquals(result.closes.length, 0)
  assertEquals(result.remainingOpenPositions.map((p) => p.id), [position.id])
  assertEquals(result.highWaterUpdates.length, 1, 'high-water state is still sampled regardless of the flag')
  assertEquals(result.highWaterUpdates[0]!.sampledMfeR, 4.0)
})

Deno.test('planMonitorActions: an eligible position under intraday_ls DOES exit via profit_giveback once givebackEnabledForIntradayLs is true', () => {
  const position = trackedLongPosition()
  const result = planMonitorActions({
    ...BASE_INPUT, strategyProfile: 'intraday_ls', givebackEnabledForIntradayLs: true,
    openPositions: [{ position, points: [point(5, 132), point(0, 108)] }],
  })
  assertEquals(result.givebackCloses.length, 1)
  assertEquals(result.givebackCloses[0]!.closedPosition.closeReason, 'profit_giveback')
  assertEquals(result.remainingOpenPositions.length, 0)
})

// =========================================================================
// Strategy V4 (2026-10-01) — the two new intraday_ls-only exits (hard max
// hold, soft time stop) and the FULL precedence chain: SL/TP -> hard max
// -> giveback -> soft time stop.
// =========================================================================

function minutesBeforeNow(minutes: number): string {
  return new Date(new Date(NOW).getTime() - minutes * 60_000).toISOString()
}

function intradayLsPosition(overrides: Partial<Position> = {}): Position {
  return trackedLongPosition({ openedUnderStrategyProfile: 'intraday_ls', ...overrides })
}

Deno.test('planMonitorActions: intraday_ls position past maxHoldMinutes closes via time_stop, regardless of strongly POSITIVE P&L', () => {
  const position = intradayLsPosition({ openedAt: minutesBeforeNow(1440) })
  const result = planMonitorActions({ ...BASE_INPUT, openPositions: [{ position, points: [point(0, 150)] }] }) // +6.25R, strongly profitable
  assertEquals(result.timeStopCloses.length, 1)
  assertEquals(result.timeStopCloses[0]!.closedPosition.closeReason, 'time_stop')
  assertEquals(result.remainingOpenPositions.length, 0)
})

Deno.test('planMonitorActions: intraday_ls position past timeStopMinutes with weak P&L closes via the soft time stop', () => {
  const position = intradayLsPosition({ openedAt: minutesBeforeNow(500) })
  const result = planMonitorActions({ ...BASE_INPUT, openPositions: [{ position, points: [point(0, 100)] }] }) // flat, 0R
  assertEquals(result.timeStopCloses.length, 1)
  assertEquals(result.timeStopCloses[0]!.closedPosition.closeReason, 'time_stop')
})

Deno.test('planMonitorActions: intraday_ls position well before either threshold stays open', () => {
  const position = intradayLsPosition({ openedAt: minutesBeforeNow(100) })
  const result = planMonitorActions({ ...BASE_INPUT, openPositions: [{ position, points: [point(0, 100)] }] })
  assertEquals(result.timeStopCloses.length, 0)
  assertEquals(result.remainingOpenPositions.map((p) => p.id), [position.id])
})

Deno.test('planMonitorActions: a position NOT opened under intraday_ls is never time-stopped, even well past maxHoldMinutes', () => {
  const position = trackedLongPosition({ openedUnderStrategyProfile: 'aggressive', openedAt: minutesBeforeNow(1440) })
  const result = planMonitorActions({ ...BASE_INPUT, openPositions: [{ position, points: [point(0, 100)] }] })
  assertEquals(result.timeStopCloses.length, 0)
  assertEquals(result.remainingOpenPositions.map((p) => p.id), [position.id])
})

Deno.test('planMonitorActions: time stops are NOT gated on highWaterTrackedFrom — a never-tracked intraday_ls position still gets hard-max-closed', () => {
  const position = longPosition({
    openedUnderStrategyProfile: 'intraday_ls',
    highWaterTrackedFrom: null, // never tracked -- would be permanently giveback-ineligible
    initialRiskUsd: null, // no ruler at all -- hard max must not need one
    openedAt: minutesBeforeNow(1440),
  })
  const result = planMonitorActions({ ...BASE_INPUT, openPositions: [{ position, points: [point(0, 100)] }] })
  assertEquals(result.timeStopCloses.length, 1)
})

Deno.test('planMonitorActions: precedence — SL/TP still wins over hard max for an intraday_ls position breaching both at the same tick', () => {
  const position = intradayLsPosition({ stopLossPrice: 95, openedAt: minutesBeforeNow(1440) })
  const result = planMonitorActions({ ...BASE_INPUT, openPositions: [{ position, points: [point(0, 94)] }] }) // breaches SL AND is past maxHoldMinutes
  assertEquals(result.closes.length, 1)
  assertEquals(result.closes[0]!.closedPosition.closeReason, 'stop_loss')
  assertEquals(result.timeStopCloses.length, 0)
})

Deno.test('planMonitorActions: precedence — hard max wins over giveback when both conditions are met at the same tick', () => {
  // Same giveback setup as the existing Aggressive giveback test (100 ->
  // 132 arms the 1.5R floor -> 108 would cross it), but ALSO past
  // maxHoldMinutes at the final point.
  const position = intradayLsPosition({ openedAt: minutesBeforeNow(1440) })
  const result = planMonitorActions({
    ...BASE_INPUT, strategyProfile: 'aggressive',
    openPositions: [{ position, points: [point(5, 132), point(0, 108)] }],
  })
  assertEquals(result.timeStopCloses.length, 1, 'hard max intercepts before giveback tracking ever runs')
  assertEquals(result.timeStopCloses[0]!.closedPosition.closeReason, 'time_stop')
  assertEquals(result.givebackCloses.length, 0)
})

Deno.test('planMonitorActions: precedence — giveback wins over the soft time stop when both conditions are met at the same tick', () => {
  // Past timeStopMinutes (500 > 480) but NOT maxHoldMinutes (500 < 1440),
  // so hard max does not intercept — falls through to giveback, which
  // must win over the soft time stop per the precedence chain.
  const position = intradayLsPosition({ openedAt: minutesBeforeNow(500) })
  const result = planMonitorActions({
    ...BASE_INPUT, strategyProfile: 'aggressive',
    openPositions: [{ position, points: [point(5, 132), point(0, 108)] }],
  })
  assertEquals(result.givebackCloses.length, 1)
  assertEquals(result.givebackCloses[0]!.closedPosition.closeReason, 'profit_giveback')
  assertEquals(result.timeStopCloses.length, 0, 'the soft time stop is never reached once giveback has already closed the position')
})
