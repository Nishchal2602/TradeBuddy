import type { Direction } from '../positions/types.ts'

export interface SlTpBounds {
  minStopLossPct: number
  maxStopLossPct: number
  minTakeProfitPct: number
  maxTakeProfitPct: number
}

export interface SlTpPrices {
  stopLossPrice: number
  takeProfitPrice: number
}

// entryPrice here is the reference market price at gate-evaluation time,
// not necessarily the eventual fill price — trades.reference_price vs
// trades.fill_price are already distinct columns; the broker (Step 4)
// applies slippage on top of this.
export function computeStopLossTakeProfitPrices(
  direction: Direction,
  entryPrice: number,
  stopLossPct: number,
  takeProfitPct: number,
): SlTpPrices {
  if (direction === 'long') {
    return {
      stopLossPrice: entryPrice * (1 - stopLossPct),
      takeProfitPrice: entryPrice * (1 + takeProfitPct),
    }
  }
  return {
    stopLossPrice: entryPrice * (1 + stopLossPct),
    takeProfitPrice: entryPrice * (1 - takeProfitPct),
  }
}

// A short's collateral-exhaustion price — trading-domain-contract.md §2.
// The one bound that is NOT a free tuning choice: a short's stop-loss
// distance must stay below 100% regardless of whatever
// agent_settings.max_stop_loss_pct is configured to, because exhaustion
// fires at or before that price is reached, making the stop unreachable.
export function exhaustionPrice(entryPrice: number): number {
  return entryPrice * 2
}

export interface SlTpValidationResult {
  valid: boolean
  reason?: string
}

// Two independent layers, not one — deliberately kept separate rather than
// collapsed, because they fail differently:
//   - The pct-bounds check is a soft, tunable config guard
//     (agent_settings.min/max_stop_loss_pct etc. — currently provisional
//     placeholders, position-model plan §3).
//   - The ordering + exhaustion-ceiling check is a hard structural
//     invariant that must hold even if the configured bounds are ever
//     misconfigured too wide (e.g. max_stop_loss_pct mistakenly set to
//     1.5) — it is the actual backstop, not the bounds check.
// For a long, the ordering half is only at risk of failing if
// stopLossPct >= 1 (a non-positive resulting price) — given
// ModelDecisionProposal already enforces stopLossPct > 0
// (src/shared/decisions/types.ts) and bounds are checked first here, this
// mostly can't fail in practice for longs. It's still evaluated
// unconditionally rather than skipped, on the same "verify derived values
// even when upstream constraints should already prevent it" reasoning
// applied throughout this codebase (e.g. Position's own schema).
export function validateStopLossTakeProfit(
  direction: Direction,
  entryPrice: number,
  stopLossPct: number,
  takeProfitPct: number,
  bounds: SlTpBounds,
): SlTpValidationResult {
  if (stopLossPct < bounds.minStopLossPct || stopLossPct > bounds.maxStopLossPct) {
    return {
      valid: false,
      reason: `stop-loss distance ${stopLossPct} outside configured bounds [${bounds.minStopLossPct}, ${bounds.maxStopLossPct}]`,
    }
  }
  if (takeProfitPct < bounds.minTakeProfitPct || takeProfitPct > bounds.maxTakeProfitPct) {
    return {
      valid: false,
      reason: `take-profit distance ${takeProfitPct} outside configured bounds [${bounds.minTakeProfitPct}, ${bounds.maxTakeProfitPct}]`,
    }
  }

  const { stopLossPrice, takeProfitPrice } = computeStopLossTakeProfitPrices(direction, entryPrice, stopLossPct, takeProfitPct)

  if (direction === 'long') {
    if (!(stopLossPrice < entryPrice && entryPrice < takeProfitPrice)) {
      return { valid: false, reason: 'long SL/TP ordering invalid: requires stopLoss < entry < takeProfit' }
    }
    return { valid: true }
  }

  if (!(takeProfitPrice < entryPrice && entryPrice < stopLossPrice)) {
    return { valid: false, reason: 'short SL/TP ordering invalid: requires takeProfit < entry < stopLoss' }
  }
  if (!(stopLossPrice < exhaustionPrice(entryPrice))) {
    return { valid: false, reason: 'short stop-loss at or beyond the collateral-exhaustion price (2x entry) — unreachable' }
  }
  return { valid: true }
}
