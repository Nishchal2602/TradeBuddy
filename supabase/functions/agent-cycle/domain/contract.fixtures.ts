// Golden vectors for the trading domain contract
// (context/specs/trading-domain-contract.md). These are the acceptance
// criteria for Steps 1-5 of the position-model plan, expressed as plain
// data rather than prose, so later steps have fixed targets instead of
// re-deriving semantics as they go.
//
// contract.test.ts checks the INTERNAL CONSISTENCY of these fixtures —
// there is no production code yet. Steps 3-5 re-run these same vectors
// against real implementations.

// --- Core vocabulary ---------------------------------------------------

export type PositionState = 'FLAT' | 'LONG' | 'SHORT'
export type Action = 'OPEN_LONG' | 'OPEN_SHORT' | 'HOLD' | 'CLOSE'
export type Direction = 'long' | 'short'
export type TradeIntent = 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE_LONG' | 'CLOSE_SHORT'
export type AutomaticTriggerReason = 'stop_loss' | 'take_profit' | 'collateral_exhausted'

// --- 1. State-machine totality ------------------------------------------
//
// Every (state, action) pair must appear exactly once below, with exactly
// one outcome. 3 states x 4 actions = 12 cases.

export interface StateTransitionCase {
  state: PositionState
  action: Action
  outcome: 'valid' | 'rejected'
  rejectionReason?: string
}

export const STATE_TRANSITIONS: StateTransitionCase[] = [
  // FLAT
  { state: 'FLAT', action: 'OPEN_LONG', outcome: 'valid' },
  { state: 'FLAT', action: 'OPEN_SHORT', outcome: 'valid' },
  { state: 'FLAT', action: 'HOLD', outcome: 'valid' },
  { state: 'FLAT', action: 'CLOSE', outcome: 'rejected', rejectionReason: 'no open position to close' },

  // LONG
  { state: 'LONG', action: 'OPEN_LONG', outcome: 'rejected', rejectionReason: 'position already open; CLOSE first' },
  { state: 'LONG', action: 'OPEN_SHORT', outcome: 'rejected', rejectionReason: 'position already open; CLOSE first' },
  { state: 'LONG', action: 'HOLD', outcome: 'valid' },
  { state: 'LONG', action: 'CLOSE', outcome: 'valid' },

  // SHORT
  { state: 'SHORT', action: 'OPEN_LONG', outcome: 'rejected', rejectionReason: 'position already open; CLOSE first' },
  { state: 'SHORT', action: 'OPEN_SHORT', outcome: 'rejected', rejectionReason: 'position already open; CLOSE first' },
  { state: 'SHORT', action: 'HOLD', outcome: 'valid' },
  { state: 'SHORT', action: 'CLOSE', outcome: 'valid' },
]

// --- 2. Accounting identities --------------------------------------------
//
// Every scenario must satisfy, exactly (to floating-point tolerance):
//   cashAfterClose - startingCash == realizedPnl - totalFees - totalSlippage
//
// realizedPnl is the CLEAN price-based P&L — it excludes fees. Fees are a
// separate, already-visible cost (trades.fee), not folded into
// positions.realized_pnl. All numbers below were computed independently in
// Python before being transcribed here (see progress-tracker.md) — this is
// the same discipline that caught the epoch-timestamp bug in Unit 3 and
// the fractional-date bug in Unit 5; arithmetic this load-bearing does not
// get hand-verified only once, in the language it will also be asserted in.

export interface AccountingScenario {
  name: string
  direction: Direction
  startingCash: number
  entryPrice: number
  notional: number
  feeRate: number // decimal, e.g. 0.001 = 10 bps
  /** The price the close actually fills at (post-clamp, if applicable). */
  fillPrice: number
  /**
   * Present only when the observed/trigger price differs from fillPrice —
   * i.e. a gap that jumped past the collateral-exhaustion price. When
   * absent, fillPrice IS the observed price.
   */
  observedPrice?: number
  expected: {
    quantity: number
    feeOpen: number
    cashAfterOpen: number
    costBasis: number
    feeClose: number
    cashAfterClose: number
    realizedPnl: number
  }
}

export const ACCOUNTING_SCENARIOS: AccountingScenario[] = [
  {
    name: 'long, profit',
    direction: 'long',
    startingCash: 10000,
    entryPrice: 100,
    notional: 2000,
    feeRate: 0.001,
    fillPrice: 120,
    expected: {
      quantity: 20,
      feeOpen: 2,
      cashAfterOpen: 7998,
      costBasis: 2000,
      feeClose: 2.4,
      cashAfterClose: 10395.6,
      realizedPnl: 400,
    },
  },
  {
    name: 'long, loss',
    direction: 'long',
    startingCash: 10000,
    entryPrice: 100,
    notional: 2000,
    feeRate: 0.001,
    fillPrice: 85,
    expected: {
      quantity: 20,
      feeOpen: 2,
      cashAfterOpen: 7998,
      costBasis: 2000,
      feeClose: 1.7,
      cashAfterClose: 9696.3,
      realizedPnl: -300,
    },
  },
  {
    name: 'short, profit',
    direction: 'short',
    startingCash: 10000,
    entryPrice: 100,
    notional: 2000,
    feeRate: 0.001,
    fillPrice: 80,
    expected: {
      quantity: 20,
      feeOpen: 2,
      cashAfterOpen: 7998,
      costBasis: 2000,
      feeClose: 1.6,
      cashAfterClose: 10396.4,
      realizedPnl: 400,
    },
  },
  {
    name: 'short, loss (not yet exhausted)',
    direction: 'short',
    startingCash: 10000,
    entryPrice: 100,
    notional: 2000,
    feeRate: 0.001,
    fillPrice: 150,
    expected: {
      quantity: 20,
      feeOpen: 2,
      cashAfterOpen: 7998,
      costBasis: 2000,
      feeClose: 3,
      cashAfterClose: 8995,
      realizedPnl: -1000,
    },
  },
  {
    name: 'short, exact collateral exhaustion (observed price lands exactly on 2x entry)',
    direction: 'short',
    startingCash: 10000,
    entryPrice: 100,
    notional: 2000,
    feeRate: 0.001,
    fillPrice: 200, // == exhaustion price, observedPrice omitted since they coincide
    expected: {
      quantity: 20,
      feeOpen: 2,
      cashAfterOpen: 7998,
      costBasis: 2000,
      feeClose: 4,
      cashAfterClose: 7994,
      realizedPnl: -2000, // == -notional, exactly
    },
  },
  {
    name: 'short, GAP THROUGH exhaustion (observed 250, must fill+realize as if at 200, not 250)',
    direction: 'short',
    startingCash: 10000,
    entryPrice: 100,
    notional: 2000,
    feeRate: 0.001,
    fillPrice: 200, // clamped to the exhaustion price
    observedPrice: 250, // what the price feed actually reported
    expected: {
      quantity: 20,
      feeOpen: 2,
      cashAfterOpen: 7998,
      costBasis: 2000,
      feeClose: 4, // computed on the CLAMPED fill price (200), not observed (250)
      cashAfterClose: 7994,
      realizedPnl: -2000, // NOT -3000 — this is the whole point of the case
    },
  },
]

/**
 * A short's collateral-exhaustion price. Pure function of entry only —
 * exists here so contract.test.ts and every later implementation compute
 * it identically rather than each hand-deriving "2x entry".
 */
export function exhaustionPrice(entryPrice: number): number {
  return entryPrice * 2
}

// --- 3. SL/TP ordering ----------------------------------------------------
//
// LONG:  stopLoss < entry < takeProfit
// SHORT: takeProfit < entry < stopLoss
// Entry is always 100 across these cases; only the SL/TP placement varies.

export interface SlTpCase {
  direction: Direction
  entry: number
  stopLoss: number
  takeProfit: number
  outcome: 'valid' | 'rejected'
  note: string
}

export const SL_TP_ORDERING_CASES: SlTpCase[] = [
  { direction: 'long', entry: 100, stopLoss: 95, takeProfit: 110, outcome: 'valid', note: 'correctly ordered' },
  { direction: 'long', entry: 100, stopLoss: 110, takeProfit: 95, outcome: 'rejected', note: 'fully inverted' },
  { direction: 'long', entry: 100, stopLoss: 105, takeProfit: 110, outcome: 'rejected', note: 'SL above entry' },
  { direction: 'long', entry: 100, stopLoss: 95, takeProfit: 90, outcome: 'rejected', note: 'TP below entry' },
  { direction: 'long', entry: 100, stopLoss: 100, takeProfit: 110, outcome: 'rejected', note: 'SL equal to entry (must be strict)' },
  { direction: 'long', entry: 100, stopLoss: 95, takeProfit: 100, outcome: 'rejected', note: 'TP equal to entry (must be strict)' },

  { direction: 'short', entry: 100, stopLoss: 105, takeProfit: 90, outcome: 'valid', note: 'correctly ordered' },
  { direction: 'short', entry: 100, stopLoss: 90, takeProfit: 105, outcome: 'rejected', note: 'fully inverted' },
  { direction: 'short', entry: 100, stopLoss: 95, takeProfit: 90, outcome: 'rejected', note: 'SL below entry' },
  { direction: 'short', entry: 100, stopLoss: 105, takeProfit: 110, outcome: 'rejected', note: 'TP above entry' },
  { direction: 'short', entry: 100, stopLoss: 100, takeProfit: 90, outcome: 'rejected', note: 'SL equal to entry (must be strict)' },
  { direction: 'short', entry: 100, stopLoss: 105, takeProfit: 100, outcome: 'rejected', note: 'TP equal to entry (must be strict)' },

  // The structural ceiling: a short's SL at exactly the exhaustion price
  // (100% distance, i.e. stop_loss_pct = 1.0) is unreachable — exhaustion
  // fires at or before that price is reached. Distance must be < 100%,
  // strictly, not <= 100%.
  { direction: 'short', entry: 100, stopLoss: 200, takeProfit: 90, outcome: 'rejected', note: 'SL at exactly the exhaustion price (2x entry) — unreachable' },
]

// --- 4. Provenance combinations --------------------------------------------
//
// Exactly 3 legal (intent, decisionId, triggerReason) combinations. Every
// other combination — including ones that look "close enough" — is invalid.
// Mirrors the trades_provenance_valid CHECK constraint from the plan.

export interface ProvenanceCase {
  intent: TradeIntent
  hasDecisionId: boolean
  triggerReason: AutomaticTriggerReason | 'agent_close' | null
  outcome: 'valid' | 'rejected'
  note: string
}

export const PROVENANCE_CASES: ProvenanceCase[] = [
  // The 3 legal combinations
  { intent: 'OPEN_LONG', hasDecisionId: true, triggerReason: null, outcome: 'valid', note: 'agent open' },
  { intent: 'OPEN_SHORT', hasDecisionId: true, triggerReason: null, outcome: 'valid', note: 'agent open' },
  { intent: 'CLOSE_LONG', hasDecisionId: true, triggerReason: 'agent_close', outcome: 'valid', note: 'agent-initiated close' },
  { intent: 'CLOSE_SHORT', hasDecisionId: true, triggerReason: 'agent_close', outcome: 'valid', note: 'agent-initiated close' },
  { intent: 'CLOSE_LONG', hasDecisionId: false, triggerReason: 'stop_loss', outcome: 'valid', note: 'automatic exit' },
  { intent: 'CLOSE_SHORT', hasDecisionId: false, triggerReason: 'take_profit', outcome: 'valid', note: 'automatic exit' },
  { intent: 'CLOSE_LONG', hasDecisionId: false, triggerReason: 'collateral_exhausted', outcome: 'valid', note: 'automatic exit' },

  // Illegal — an open carrying a trigger_reason
  { intent: 'OPEN_LONG', hasDecisionId: true, triggerReason: 'stop_loss', outcome: 'rejected', note: 'opens never carry a trigger_reason' },

  // Illegal — an open with no decision_id (nothing else could have opened it)
  { intent: 'OPEN_SHORT', hasDecisionId: false, triggerReason: null, outcome: 'rejected', note: 'opens are always agent-initiated' },

  // Illegal — an agent close missing the agent_close marker
  { intent: 'CLOSE_LONG', hasDecisionId: true, triggerReason: null, outcome: 'rejected', note: 'agent close must carry trigger_reason = agent_close' },
  { intent: 'CLOSE_SHORT', hasDecisionId: true, triggerReason: 'stop_loss', outcome: 'rejected', note: 'a decision_id present means agent-initiated — cannot also claim an automatic trigger' },

  // Illegal — an automatic exit carrying a decision_id
  { intent: 'CLOSE_LONG', hasDecisionId: true, triggerReason: 'take_profit', outcome: 'rejected', note: 'automatic exits have no decision_id' },

  // Illegal — a close with neither provenance marker
  { intent: 'CLOSE_SHORT', hasDecisionId: false, triggerReason: null, outcome: 'rejected', note: 'every close must be attributable to something' },
]

// --- 5. Concurrent-close race --------------------------------------------
//
// The agent cycle and the position monitor can both target the same open
// position. Both interleavings must resolve to exactly one close, one
// trade, one realized P&L — encoded here as ordered event sequences so
// Step 5 inherits this as a real concurrency test, not a re-derived one.

export interface RaceEvent {
  actor: 'agent' | 'monitor'
  event: string
}

export interface RaceScenario {
  name: string
  sequence: RaceEvent[]
  expected: {
    positionCloses: 1
    closeTrades: 1
    realizedPnlEntries: 1
    agentDecisionOutcome: 'approved' | 'rejected_already_closed'
    monitorOutcome: 'closed_position' | 'noop_already_closed'
  }
}

export const CONCURRENT_CLOSE_RACE: RaceScenario[] = [
  {
    name: 'monitor wins the race (stop-loss fires before the agent cycle commits its CLOSE)',
    sequence: [
      { actor: 'agent', event: 'reads position state: LONG' },
      { actor: 'agent', event: 'decides CLOSE' },
      { actor: 'monitor', event: 'observes price has crossed stop-loss' },
      { actor: 'monitor', event: 'executes conditional UPDATE ... WHERE status=open -> 1 row affected -> closes position, writes trade (trigger_reason=stop_loss)' },
      { actor: 'agent', event: 'attempts to execute its own CLOSE -> conditional UPDATE ... WHERE status=open -> 0 rows affected' },
      { actor: 'agent', event: 'persists its decision as rejected, reason: position already closed' },
    ],
    expected: {
      positionCloses: 1,
      closeTrades: 1,
      realizedPnlEntries: 1,
      agentDecisionOutcome: 'rejected_already_closed',
      monitorOutcome: 'closed_position',
    },
  },
  {
    name: 'agent wins the race (agent commits its CLOSE before the next monitor tick)',
    sequence: [
      { actor: 'agent', event: 'reads position state: LONG' },
      { actor: 'agent', event: 'decides CLOSE' },
      { actor: 'agent', event: 'executes conditional UPDATE ... WHERE status=open -> 1 row affected -> closes position, writes trade (trigger_reason=agent_close)' },
      { actor: 'agent', event: 'persists its decision as approved' },
      { actor: 'monitor', event: 'next tick: observes price has crossed stop-loss for the same asset' },
      { actor: 'monitor', event: 'attempts conditional UPDATE ... WHERE status=open -> 0 rows affected (no open position found)' },
      { actor: 'monitor', event: 'logs a no-op in its run record; creates no trade' },
    ],
    expected: {
      positionCloses: 1,
      closeTrades: 1,
      realizedPnlEntries: 1,
      agentDecisionOutcome: 'approved',
      monitorOutcome: 'noop_already_closed',
    },
  },
]
