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
    realizedPnl: null, // nothing realized on an OPEN
  }

  return { position, trade, cashAfter }
}

// --- Add (Phase 2, 2026-09-22) -------------------------------------------
//
// Increases an existing position's quantity via a true weighted-average
// entry — never a second position row (positions_one_open_per_asset_idx
// stays satisfied: this mutates the one open row, it doesn't insert a
// new one). SL/TP are NEVER touched here — an ADD's interaction with
// existing protection is a re-validation the risk gate performs BEFORE
// this function is ever called (src/shared/risk/gate.ts's evaluateAdd);
// this function only executes an already-approved amount.

export interface AddToPositionInput {
  position: Position
  referencePrice: number
  addNotionalUsd: number
  feeBps: number
  slippageBps: number
  decisionId: string
  startingCash: number
  nowIso: string
}

export interface AddToPositionResult {
  updatedPosition: Position
  trade: Trade
  cashAfter: number
}

export function addToPosition(input: AddToPositionInput): AddToPositionResult {
  const { position } = input
  const side = sideFor(position.direction, true)
  const fillPrice = applySlippage(input.referencePrice, side, input.slippageBps)

  // Same reference-price sizing convention as openPosition: quantity is
  // sized from the requested notional at the REFERENCE price, then the
  // actual transacted value (grossValue) is that quantity at the real
  // fill price.
  const addQuantity = input.addNotionalUsd / input.referencePrice
  const grossValue = addQuantity * fillPrice
  const fee = grossValue * (input.feeBps / 10_000)
  const slippageCost = Math.abs(fillPrice - input.referencePrice) * addQuantity

  const netCashDelta = -(grossValue + fee) // identical shape to an OPEN's cash effect
  const cashAfter = input.startingCash + netCashDelta

  const newQuantity = position.quantity + addQuantity
  const newCostBasis = position.costBasis + grossValue
  // True weighted-average entry — holds by construction because
  // costBasis === quantity * fillPrice at every prior open/add
  // (broker/accounting.ts's own invariant), so newCostBasis/newQuantity
  // is exactly the blended entry, not an approximation.
  const newEntryPrice = newCostBasis / newQuantity

  const updatedPosition: Position = {
    ...position,
    quantity: newQuantity,
    entryPrice: newEntryPrice,
    costBasis: newCostBasis,
    // stopLossPrice/takeProfitPrice deliberately UNCHANGED — the gate
    // already proved they remain valid under this new entry before
    // approving the ADD; this function has no authority to touch them.
  }

  const trade: Trade = {
    id: crypto.randomUUID(),
    portfolioId: position.portfolioId,
    positionId: position.id,
    asset: position.asset,
    side,
    quantity: addQuantity,
    referencePrice: input.referencePrice,
    fillPrice,
    fee,
    slippageCost,
    grossValue,
    netCashDelta,
    cashAfter,
    executedAt: input.nowIso,
    intent: position.direction === 'long' ? 'ADD_LONG' : 'ADD_SHORT',
    decisionId: input.decisionId,
    triggerReason: null,
    realizedPnl: null, // nothing realized on an ADD
  }

  return { updatedPosition, trade, cashAfter }
}

// --- Reduce (Phase 2, 2026-09-22) -----------------------------------------
//
// Partially exits a position — never touches entry_price (a partial exit
// never moves the average entry, only a full close/re-open does) and
// never inserts a second trades row of the closing kind:
// trades_one_close_per_position_idx only matches CLOSE_LONG/CLOSE_SHORT,
// so a REDUCE_* trade is structurally exempt from it, which is exactly
// what makes more than one partial exit on the same position legal.
//
// A 100%-of-quantity REDUCE is arithmetically IDENTICAL to closePosition
// (costBasisReleased == costBasis, newQuantity == 0) — proven directly in
// accounting.test.ts, not just asserted here. Callers should still
// normalize a >=100% magnitude to an actual CLOSE upstream (cycle/apply-
// management.ts) for correct provenance (a full exit should read CLOSE in
// the decision feed, not "REDUCE that happened to be 100%") — this
// function itself has no opinion on that and will happily execute a
// 100% reduce if asked to.

export interface ReducePositionInput {
  position: Position
  attemptedFillPrice: number
  reduceQuantity: number
  feeBps: number
  slippageBps: number
  decisionId: string
  startingCash: number
  nowIso: string
}

export interface ReducePositionResult {
  updatedPosition: Position
  trade: Trade
  cashAfter: number
  // GROSS (price-based only) — UNCHANGED meaning, still what
  // trades.realized_pnl / positions.realized_pnl / nav_snapshots.
  // realized_pnl_cum accumulate, matching this broker's existing,
  // consistent convention of reporting P&L and fees as separate line
  // items everywhere else. Do not net fee into this — see
  // partialRealizedPnlDelta below for the one place that must be net.
  realizedPnl: number
  // Aggressive V3.1 (2026-09-23) — realizedPnl NET of the fee actually
  // paid on THIS reduce (slippage is already embedded in realizedPnl via
  // fillPrice, so only fee needs subtracting here). This is the one
  // figure that must be economically net, not gross: it accumulates into
  // positions.partial_realized_pnl_usd, which feeds positionPnlR — the
  // metric the giveback ratchet protects. A sunk, already-paid fee must
  // reduce that protected figure; the codebase's gross-realizedPnl
  // convention above is fine for trade-history reporting but would
  // silently overstate protected profit here, compounding with every
  // REDUCE on a position's life.
  partialRealizedPnlDelta: number
}

export function reducePosition(input: ReducePositionInput): ReducePositionResult {
  const { position } = input
  const side = sideFor(position.direction, false)

  // Same exhaustion clamp closePosition applies to a short — a partial
  // exit is still subject to the same collateral ceiling a full one is.
  let fillPrice = applySlippage(input.attemptedFillPrice, side, input.slippageBps)
  if (position.direction === 'short') {
    const exhaustion = exhaustionPrice(position.entryPrice)
    if (fillPrice >= exhaustion) fillPrice = exhaustion
  }

  const grossValue = input.reduceQuantity * fillPrice
  const fee = grossValue * (input.feeBps / 10_000)
  const slippageCost = Math.abs(fillPrice - input.attemptedFillPrice) * input.reduceQuantity

  const realizedPnl = position.direction === 'long'
    ? (fillPrice - position.entryPrice) * input.reduceQuantity
    : (position.entryPrice - fillPrice) * input.reduceQuantity

  // Cost basis released is PROPORTIONAL to the fraction of quantity being
  // reduced — the remaining position's cost basis (and therefore its
  // entryPrice, since entryPrice === costBasis/quantity is this broker's
  // own invariant) is otherwise untouched. At reduceQuantity ===
  // position.quantity, costBasisReleased === position.costBasis exactly
  // (the 100%-reduce-equals-close identity accounting.test.ts proves).
  const costBasisReleased = position.costBasis * (input.reduceQuantity / position.quantity)

  const netCashDelta = position.direction === 'long'
    ? grossValue - fee
    : costBasisReleased + realizedPnl - fee
  const cashAfter = input.startingCash + netCashDelta

  const newQuantity = position.quantity - input.reduceQuantity
  const newCostBasis = position.costBasis - costBasisReleased

  // NET of the fee this reduce actually paid — see
  // ReducePositionResult.partialRealizedPnlDelta's own comment.
  const partialRealizedPnlDelta = realizedPnl - fee

  const updatedPosition: Position = {
    ...position,
    quantity: newQuantity,
    costBasis: newCostBasis,
    // entryPrice UNCHANGED — a partial exit never moves the average
    // entry (only ADD does, and only via a genuine weighted average).
    // Aggressive V3.1 (2026-09-23) — ACCUMULATED, never replaced: this is
    // what keeps positionPnlR continuous across more than one REDUCE over
    // a position's life (`position.partialRealizedPnlUsd` may be
    // undefined on an older in-memory object — same `?? 0` convention
    // row-mappers.ts uses at the DB boundary).
    partialRealizedPnlUsd: (position.partialRealizedPnlUsd ?? 0) + partialRealizedPnlDelta,
  }

  const intent = position.direction === 'long' ? 'REDUCE_LONG' as const : 'REDUCE_SHORT' as const
  const trade: Trade = {
    id: crypto.randomUUID(),
    portfolioId: position.portfolioId,
    positionId: position.id,
    asset: position.asset,
    side,
    quantity: input.reduceQuantity,
    referencePrice: input.attemptedFillPrice,
    fillPrice,
    fee,
    slippageCost,
    grossValue,
    netCashDelta,
    cashAfter,
    executedAt: input.nowIso,
    intent,
    decisionId: input.decisionId,
    triggerReason: null,
    realizedPnl, // populated — this is a realizing fill, unlike OPEN/ADD
  }

  return { updatedPosition, trade, cashAfter, realizedPnl, partialRealizedPnlDelta }
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
  // Phase 2 (2026-09-22): realizedPnl now populated on EVERY close trade,
  // agent- or monitor-initiated — required for sum(trades.realized_pnl)
  // to be a trustworthy lifetime-P&L source across a position's whole
  // open->add->reduce->close lifecycle (a full close that left this null
  // would silently under-report the total). positions.realized_pnl keeps
  // its own, unchanged meaning (the final close) — this doesn't redefine
  // that column, it populates a second, additive one.
  const trade: Trade = input.decisionId
    ? { ...tradeCore, decisionId: input.decisionId, triggerReason: 'agent_close', realizedPnl }
    : {
      ...tradeCore,
      decisionId: null,
      triggerReason: positionCloseReason as 'stop_loss' | 'take_profit' | 'collateral_exhausted' | 'profit_giveback',
      realizedPnl,
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
