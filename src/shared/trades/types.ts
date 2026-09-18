import { z } from 'zod'
import { AssetSymbol } from '../market-data/types.ts'
import { CloseReason } from '../positions/types.ts'

// Mechanical fill direction — distinct from agent_decisions.action, which
// describes the model's decision (CLOSE is direction-agnostic). intent
// below is what actually happened: OPEN_LONG -> BUY, CLOSE_LONG -> SELL,
// OPEN_SHORT -> SELL, CLOSE_SHORT -> BUY. This mapping is also what
// determines which way slippage moves the fill price (adverse to
// whichever side the trader is on) — see the broker's applySlippage.
export const TradeSide = z.enum(['BUY', 'SELL'])
export type TradeSide = z.infer<typeof TradeSide>

export const TradeIntent = z.enum(['OPEN_LONG', 'OPEN_SHORT', 'CLOSE_LONG', 'CLOSE_SHORT'])
export type TradeIntent = z.infer<typeof TradeIntent>

// trades.trigger_reason uses the exact same four values as
// positions.close_reason (agent_close/stop_loss/take_profit/
// collateral_exhausted) — reusing CloseReason rather than redefining an
// identical enum under a second name.
export const TriggerReason = CloseReason

// Exactly the three legal (intent, decisionId, triggerReason) combinations
// from trading-domain-contract.md §4 / the trades_provenance_valid DB
// constraint (Step 1). Modeled as a discriminated union on intent-category
// for the same reason as ModelDecisionProposal (src/shared/decisions/
// types.ts): the type system should make the illegal combinations
// unrepresentable, not just document them in a comment.
const openFields = {
  decisionId: z.string().uuid(),
  triggerReason: z.null(),
}
const agentCloseFields = {
  decisionId: z.string().uuid(),
  triggerReason: z.literal('agent_close'),
}
const automaticCloseFields = {
  decisionId: z.null(),
  triggerReason: z.enum(['stop_loss', 'take_profit', 'collateral_exhausted']),
}

const tradeCoreFields = {
  id: z.string().uuid(),
  portfolioId: z.string().uuid(),
  positionId: z.string().uuid(),
  asset: AssetSymbol,

  side: TradeSide,
  quantity: z.number().positive(),
  referencePrice: z.number().positive(),
  fillPrice: z.number().positive(),
  fee: z.number().nonnegative(),
  slippageCost: z.number().nonnegative(),
  grossValue: z.number().positive(),
  netCashDelta: z.number(),

  cashAfter: z.number().nonnegative(),
  executedAt: z.string().datetime(),
}

const OpenTrade = z.object({ ...tradeCoreFields, intent: z.enum(['OPEN_LONG', 'OPEN_SHORT']), ...openFields }).strict()
const AgentCloseTrade = z.object({ ...tradeCoreFields, intent: z.enum(['CLOSE_LONG', 'CLOSE_SHORT']), ...agentCloseFields }).strict()
const AutomaticCloseTrade = z.object({ ...tradeCoreFields, intent: z.enum(['CLOSE_LONG', 'CLOSE_SHORT']), ...automaticCloseFields }).strict()

// Not a single z.discriminatedUnion here: the discriminant would need to
// be a combination of `intent` category AND provenance, which isn't one
// literal field the way ModelDecisionProposal's `action` is. A plain union
// with .strict() branches still gets the same "illegal combinations don't
// parse" guarantee; it just can't narrow as cleanly at the call site.
export const Trade = z.union([OpenTrade, AgentCloseTrade, AutomaticCloseTrade])
export type Trade = z.infer<typeof Trade>
