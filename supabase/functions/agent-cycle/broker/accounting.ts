import { exhaustionPrice } from '../../../../src/shared/risk/sl-tp.ts'
import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { CloseReason, Direction, Position } from '../../../../src/shared/positions/types.ts'
import type { Trade, TradeSide } from '../../../../src/shared/trades/types.ts'

// The paper broker — deterministic code shared by the agent cycle and the
// position monitor (invariant 12: one owner, never two implementations).
// Formulas match trading-domain-contract.md §2 exactly; every non-trivial
// number here is proven against ACCOUNTING_SCENARIOS
// (contract.fixtures.ts) in accounting.test.ts, not just asserted.

// OPEN_LONG=BUY, CLOSE_LONG=SELL, OPEN_SHORT=SELL, CLOSE_SHORT=BUY — the
// mechanical fill direction, independent of the model's action vocabulary
// (src/shared/trades/types.ts's own comment explains why they're
// distinct types).
function sideFor(direction: Direction, isOpen: boolean): TradeSide {
  if (direction === 'long') return isOpen ? 'BUY' : 'SELL'
  return isOpen ? 'SELL' : 'BUY'
}

// Adverse slippage, always: a BUY fills higher than reference, a SELL
// fills lower. Direction (long/short) never enters this function directly
// — only `side` does, which already encodes the correct sign per the
// mapping above.
export function applySlippage(referencePrice: number, side: TradeSide, slippageBps: number): number {
  const factor = slippageBps / 10_000
  return side === 'BUY' ? referencePrice * (1 + factor) : referencePrice * (1 - factor)
}

// --- Open ------------------------------------------------------------

export interface OpenPositionInput {
  asset: AssetSymbol
  direction: Direction
  referencePrice: number
  notionalUsd: number
  stopLossPrice: number
  takeProfitPrice: number
  feeBps: number
  slippageBps: number
  portfolioId: string
  decisionId: string
  startingCash: number
  nowIso: string
}

export interface OpenPositionResult {
  position: Position
  trade: Trade
  cashAfter: number
}

export function openPosition(input: OpenPositionInput): OpenPositionResult {
  const side = sideFor(input.direction, true)
  const fillPrice = applySlippage(input.referencePrice, side, input.slippageBps)

  // Quantity is sized from the requested notional at the reference price,
  // then the ACTUAL notional transacted (grossValue) is whatever that
  // quantity costs at the real fill price — slippage moves grossValue
  // slightly away from the originally requested notionalUsd, same as a
  // real exchange fill would.
  const quantity = input.notionalUsd / input.referencePrice
  const grossValue = quantity * fillPrice
  const fee = grossValue * (input.feeBps / 10_000)
  const slippageCost = Math.abs(fillPrice - input.referencePrice) * quantity

  // cash -= N + fee (trading-domain-contract.md §2), N = grossValue here.
  const netCashDelta = -(grossValue + fee)
  const cashAfter = input.startingCash + netCashDelta

  const positionId = crypto.randomUUID()

  const position: Position = {
    id: positionId,
    portfolioId: input.portfolioId,
    asset: input.asset,
    direction: input.direction,
    quantity,
    entryPrice: fillPrice,
    costBasis: grossValue,
    stopLossPrice: input.stopLossPrice,
    takeProfitPrice: input.takeProfitPrice,
    status: 'open',
    openedAt: input.nowIso,
    closedAt: null,
    realizedPnl: null,
    closeReason: null,
    openedByDecisionId: input.decisionId,
    closedByDecisionId: null,
  }

  const trade: Trade = {
    id: crypto.randomUUID(),
    portfolioId: input.portfolioId,
    positionId,
    asset: input.asset,
    side,
    quantity,
    referencePrice: input.referencePrice,
    fillPrice,
    fee,
    slippageCost,
    grossValue,
    netCashDelta,
    cashAfter,
    executedAt: input.nowIso,
    intent: input.direction === 'long' ? 'OPEN_LONG' : 'OPEN_SHORT',
    decisionId: input.decisionId,
    triggerReason: null,
  }

  return { position, trade, cashAfter }
}

// --- Close -------------------------------------------------------------

export interface ClosePositionInput {
  position: Position
  // Pre-slippage reference price for the close. For an agent-initiated
  // close this is simply the current market price. For an automatic
  // exit, the position monitor (Step 5) has already resolved this from
  // its own SL/TP fill-price policy (trading-domain-contract.md §5 — the
  // less favorable of the trigger level and the observed price) before
  // calling the broker; this function's own job is only the exhaustion
  // clamp below, which is a distinct, unconditional accounting guarantee,
  // not a restatement of the monitor's trigger-resolution policy.
  attemptedFillPrice: number
  feeBps: number
  slippageBps: number
  // The caller's intended reason. May be overridden on positionCloseReason
  // (not necessarily on the trade's triggerReason — see below) if the
  // exhaustion clamp fires.
  closeReason: CloseReason
  // Set for an agent-initiated close, null for an automatic exit — this
  // is what actually determines trades.trigger_reason, per
  // trades_provenance_valid (Step 1 migration): a trade with decisionId
  // set MUST carry triggerReason = 'agent_close', full stop, with no
  // exception for the exhaustion case.
  decisionId: string | null
  startingCash: number
  nowIso: string
}

export interface ClosePositionResult {
  closedPosition: Position
  trade: Trade
  cashAfter: number
  realizedPnl: number
}

export function closePosition(input: ClosePositionInput): ClosePositionResult {
  const { position } = input
  const side = sideFor(position.direction, false)

  let fillPrice = applySlippage(input.attemptedFillPrice, side, input.slippageBps)

  // positions.close_reason reflects accounting TRUTH — why the position
  // actually ended, price-wise — and this clamp fires unconditionally,
  // even on an agent-initiated close, if price has already gapped past
  // exhaustion by the time that decision executes (rare in practice given
  // the monitor's 10-minute cadence vs. the 3-hour decision cycle, but
  // handled correctly rather than assumed impossible).
  let positionCloseReason: CloseReason = input.closeReason
  if (position.direction === 'short') {
    const exhaustion = exhaustionPrice(position.entryPrice)
    if (fillPrice >= exhaustion) {
      // trading-domain-contract.md §2 gap-through-exhaustion case: clamp
      // to the exhaustion price itself, not the observed/attempted price
      // — filling at the observed price would realize a loss beyond what
      // the collateral actually covers.
      fillPrice = exhaustion
      positionCloseReason = 'collateral_exhausted'
    }
  }

  const grossValue = position.quantity * fillPrice
  const fee = grossValue * (input.feeBps / 10_000)
  const slippageCost = Math.abs(fillPrice - input.attemptedFillPrice) * position.quantity

  const realizedPnl = position.direction === 'long'
    ? (fillPrice - position.entryPrice) * position.quantity
    : (position.entryPrice - fillPrice) * position.quantity

  // Close cash (trading-domain-contract.md §2):
  //   long:  cash += Q*X - fee                    == grossValue - fee
  //   short: cash += N + (E-X)*Q - fee             == costBasis + realizedPnl - fee
  const netCashDelta = position.direction === 'long'
    ? grossValue - fee
    : position.costBasis + realizedPnl - fee
  const cashAfter = input.startingCash + netCashDelta

  const closedPosition: Position = {
    ...position,
    status: 'closed',
    closedAt: input.nowIso,
    realizedPnl,
    closeReason: positionCloseReason,
    closedByDecisionId: input.decisionId,
  }

  // `as const` preserves the narrow literal type through the tradeCore
  // object literal below — without it, TS widens to `string`, and the
  // discriminated Trade union can no longer match any branch.
  const intent = position.direction === 'long' ? 'CLOSE_LONG' as const : 'CLOSE_SHORT' as const
  const tradeCore = {
    id: crypto.randomUUID(),
    portfolioId: position.portfolioId,
    positionId: position.id,
    asset: position.asset,
    side,
    quantity: position.quantity,
    referencePrice: input.attemptedFillPrice,
    fillPrice,
    fee,
    slippageCost,
    grossValue,
    netCashDelta,
    cashAfter,
    executedAt: input.nowIso,
    intent,
  }

  // See ClosePositionInput.decisionId's comment: the trade's
  // triggerReason is provenance (was this trade agent- or
  // monitor-initiated), which can legitimately diverge from
  // positionCloseReason (accounting truth) in the rare gap-during-
  // agent-close edge case above.
  const trade: Trade = input.decisionId
    ? { ...tradeCore, decisionId: input.decisionId, triggerReason: 'agent_close' }
    : {
      ...tradeCore,
      decisionId: null,
      triggerReason: positionCloseReason as 'stop_loss' | 'take_profit' | 'collateral_exhausted',
    }

  return { closedPosition, trade, cashAfter, realizedPnl }
}

// --- Portfolio valuation --------------------------------------------------
//
// trading-domain-contract.md §2: NAV = cash + Σ long(Q×current) +
// Σ short(collateral + (E−current)×Q, floored at 0). Lives here rather
// than in whichever step first needs it — both the position monitor
// (Step 5) and agent-cycle wiring (Step 7) persist nav_snapshots, so this
// avoids either one inventing its own copy under time pressure.

export interface PositionValuationInput {
  direction: Direction
  quantity: number
  entryPrice: number
  costBasis: number
  currentPrice: number
}

// A short's value is floored at 0, not just its unrealized P&L — this
// protects a NAV computed at an arbitrary snapshot moment (e.g. a read
// that lands between a price gap and the monitor's next tick processing
// the resulting exhaustion close) from going negative on a single
// position, mirroring the same "collateral is the entire downside" limit
// closePosition's exhaustion clamp enforces at close time.
export function computePositionValue(input: PositionValuationInput): number {
  if (input.direction === 'long') return input.quantity * input.currentPrice
  return Math.max(0, input.costBasis + (input.entryPrice - input.currentPrice) * input.quantity)
}

export function computeNav(cash: number, openPositions: PositionValuationInput[]): number {
  return cash + openPositions.reduce((sum, p) => sum + computePositionValue(p), 0)
}
