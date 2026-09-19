import type { Direction } from '../../../src/shared/positions/types.ts'

// Pure trigger-detection logic — no I/O, no Supabase, no CoinGecko. This
// is deliberately separable from price-feed.ts (fetching) and index.ts
// (persistence/wiring) so it can be tested the same way every prior
// step's domain logic was: fixture-driven, no network.

export interface PricePoint {
  timestamp: string // ISO
  price: number
}

// A discriminated union on `triggered`, not a flat object with nullable
// fields — same reasoning as ModelDecisionProposal
// (src/shared/decisions/types.ts): a caller that has checked
// `triggered === true` gets triggerPrice/observedPrice/triggeredAt as
// plain non-null values, not values it still has to guard against being
// null.
export type TriggerResult =
  | { triggered: true; reason: 'stop_loss' | 'take_profit'; triggerPrice: number; observedPrice: number; triggeredAt: string }
  | { triggered: false }

const NOT_TRIGGERED: TriggerResult = { triggered: false }

// Checks a single point. SL is checked before TP — not an arbitrary
// ordering choice, it's what "SL wins" (trading-domain-contract.md §5)
// actually resolves to. Note a single point can never breach BOTH: valid
// SL/TP ordering (long: SL < entry < TP; short: TP < entry < SL,
// enforced unconditionally by Step 3's validateStopLossTakeProfit) makes
// the two breach conditions mathematically disjoint — verified directly
// before relying on it, not assumed. Checking SL first here is a harmless
// defensive ordering for the one scenario it could matter (a data
// artifact producing SL === TP), not a tie-break this function will ever
// actually need to exercise in practice.
function checkPoint(direction: Direction, stopLossPrice: number, takeProfitPrice: number, point: PricePoint): TriggerResult {
  const slBreached = direction === 'long' ? point.price <= stopLossPrice : point.price >= stopLossPrice
  if (slBreached) {
    return { triggered: true, reason: 'stop_loss', triggerPrice: stopLossPrice, observedPrice: point.price, triggeredAt: point.timestamp }
  }

  const tpBreached = direction === 'long' ? point.price >= takeProfitPrice : point.price <= takeProfitPrice
  if (tpBreached) {
    return { triggered: true, reason: 'take_profit', triggerPrice: takeProfitPrice, observedPrice: point.price, triggeredAt: point.timestamp }
  }

  return NOT_TRIGGERED
}

// Walks the replayed points in CHRONOLOGICAL order and returns the FIRST
// trigger encountered — not whatever the latest point alone shows. This
// is what "SL wins" actually resolves to across a replay window
// containing several points (trading-domain-contract.md §5): since a
// single point can't breach both (see checkPoint's comment), "SL wins"
// describes the case where SL breaches at an earlier point in the window
// than TP does — a real system would already have closed the position at
// that earlier point, so evaluating only the latest point could miss it
// and produce a more favorable (wrong) outcome than actually occurred.
//
// No separate exhaustion check exists here, deliberately: a valid short's
// stopLossPrice is always strictly below its exhaustion price (Step 3's
// validateStopLossTakeProfit enforces this unconditionally), so any point
// at or beyond exhaustion has necessarily already breached SL first.
// Detecting exhaustion again here would be redundant — the broker's own
// closePosition (Step 4) re-labels the close to 'collateral_exhausted'
// downstream regardless of the 'stop_loss' reason reported here.
export function findFirstTrigger(
  direction: Direction,
  stopLossPrice: number,
  takeProfitPrice: number,
  points: PricePoint[],
): TriggerResult {
  const chronological = [...points].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  for (const point of chronological) {
    const result = checkPoint(direction, stopLossPrice, takeProfitPrice, point)
    if (result.triggered) return result
  }
  return NOT_TRIGGERED
}

// Fill-price resolution — the LESS FAVORABLE of the trigger level and the
// observed price (trading-domain-contract.md §5's table): SL fills at the
// OBSERVED price (models gap risk — a real stop doesn't get a better fill
// than what the market actually did), TP fills at the TRIGGER LEVEL
// itself (no windfall just because the poll happened to land favorably).
// Takes an already-triggered result (the `triggered: true` branch), not
// the full union — the caller has necessarily already checked
// `.triggered` to get here, so there is no non-triggered case for this
// function to reject or guard against.
export function resolveFillPrice(trigger: Extract<TriggerResult, { triggered: true }>): number {
  return trigger.reason === 'stop_loss' ? trigger.observedPrice : trigger.triggerPrice
}
