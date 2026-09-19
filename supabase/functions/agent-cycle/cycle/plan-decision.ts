import { openPosition, closePosition } from '../broker/accounting.ts'
import type { OpenPositionResult, ClosePositionResult } from '../broker/accounting.ts'
import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { Position } from '../../../../src/shared/positions/types.ts'
import type { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'
import type { RiskGateResult } from '../../../../src/shared/risk/gate.ts'

// Pure: given a proposal and its already-computed risk-gate result, decide
// whether anything should execute and, if so, compute the full
// accounting via Step 4's pure openPosition/closePosition. Does NOT touch
// the database — index.ts calls the atomic RPCs (open_position_atomic /
// close_position_atomic) with whatever this returns, and is the only
// place that finds out whether a close actually won its race (that's a
// runtime fact from the RPC call, not something this function can know).

export interface DecisionPlanInput {
  asset: AssetSymbol
  portfolioId: string
  proposal: ModelDecisionProposal
  gateResult: RiskGateResult
  openPosition: Position | null
  nav: number
  referencePrice: number
  feeBps: number
  slippageBps: number
  startingCash: number
  decisionId: string
  nowIso: string
}

export type DecisionPlan =
  | { kind: 'none' }
  | { kind: 'open'; openResult: OpenPositionResult }
  | { kind: 'close'; closeResult: ClosePositionResult }

export function planDecisionExecution(input: DecisionPlanInput): DecisionPlan {
  const { proposal, gateResult } = input

  if (proposal.action === 'HOLD') return { kind: 'none' }

  if (proposal.action === 'CLOSE') {
    if (gateResult.riskStatus !== 'approved') return { kind: 'none' }
    if (!input.openPosition) {
      // Unreachable by construction: gate.ts only approves a CLOSE when
      // currentState !== 'FLAT', and currentState is derived from this
      // same openPosition — a caller passing mismatched state between the
      // gate context and this input would be a real bug worth failing
      // loudly on, not silently producing a nonsensical plan.
      throw new Error(`planDecisionExecution: CLOSE approved for ${input.asset} but no open position was provided`)
    }
    const closeResult = closePosition({
      position: input.openPosition,
      attemptedFillPrice: input.referencePrice,
      feeBps: input.feeBps,
      slippageBps: input.slippageBps,
      closeReason: 'agent_close',
      decisionId: input.decisionId,
      startingCash: input.startingCash,
      nowIso: input.nowIso,
    })
    return { kind: 'close', closeResult }
  }

  // OPEN_LONG / OPEN_SHORT
  if (gateResult.riskStatus !== 'approved' && gateResult.riskStatus !== 'clamped') return { kind: 'none' }
  if (gateResult.approvedSizePct == null || gateResult.computedStopLossPrice == null || gateResult.computedTakeProfitPrice == null) {
    throw new Error(`planDecisionExecution: ${proposal.action} for ${input.asset} was ${gateResult.riskStatus} but is missing computed sizing/SL/TP — should be unreachable`)
  }

  const direction = proposal.action === 'OPEN_LONG' ? 'long' : 'short'
  const openResult = openPosition({
    asset: input.asset,
    direction,
    referencePrice: input.referencePrice,
    notionalUsd: gateResult.approvedSizePct * input.nav,
    stopLossPrice: gateResult.computedStopLossPrice,
    takeProfitPrice: gateResult.computedTakeProfitPrice,
    feeBps: input.feeBps,
    slippageBps: input.slippageBps,
    portfolioId: input.portfolioId,
    decisionId: input.decisionId,
    startingCash: input.startingCash,
    nowIso: input.nowIso,
  })
  return { kind: 'open', openResult }
}
