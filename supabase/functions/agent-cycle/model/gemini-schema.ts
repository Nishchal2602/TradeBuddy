import { z } from 'zod'
import { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import { Action, ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'

// Gemini's responseSchema dialect: an OpenAPI 3.0 Schema subset with
// UPPERCASE type names — confirmed live against the real API (2026-09-19),
// not assumed from docs, including that `nullable: true` is honored for an
// optional field inside a required object.
//
// This describes ONE FLAT shape (every field always present; SL/TP
// nullable) rather than attempting to express "OPEN requires SL/TP,
// HOLD/CLOSE must not have them" as a conditional/oneOf schema — kept
// deliberately simple rather than betting correctness on how well a
// schema-constrained generation feature supports conditional shapes.
// GEMINI_RESPONSE_SCHEMA gets the model to emit consistently-shaped JSON;
// mapRawDecisionToProposal below is what actually enforces the
// discriminated-union guarantee (ModelDecisionProposal's own .strict()
// branches), the same "loose wire shape -> strict domain parse" split
// used for every external boundary in this codebase.
export const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    decisions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          asset: { type: 'STRING', enum: ['BTC', 'ETH'] },
          action: { type: 'STRING', enum: ['OPEN_LONG', 'OPEN_SHORT', 'HOLD', 'CLOSE'] },
          confidence: { type: 'NUMBER' },
          stopLossPct: { type: 'NUMBER', nullable: true },
          takeProfitPct: { type: 'NUMBER', nullable: true },
          horizonHours: { type: 'INTEGER', nullable: true },
          reasons: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                type: { type: 'STRING', enum: ['NEWS', 'TECHNICAL'] },
                text: { type: 'STRING' },
                newsId: { type: 'STRING', nullable: true },
              },
              required: ['type', 'text'],
            },
          },
          invalidation: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { text: { type: 'STRING' } },
              required: ['text'],
            },
          },
        },
        required: ['asset', 'action', 'confidence', 'reasons', 'invalidation'],
      },
    },
  },
  required: ['decisions'],
} as const

// The loose Zod counterpart to the schema above — validates that Gemini's
// JSON actually came back shaped the way the responseSchema asked (a
// schema-constrained model can still fail to honor its own schema; this
// is not assumed, it's checked), before the stricter per-action mapping
// below. Not .strict(): reasons[].newsId being present-but-null on a
// TECHNICAL reason, or SL/TP present-but-null on a HOLD, are both
// expected shapes here — rejecting extra/inconsistent combinations is
// ModelDecisionProposal's job, not this one's.
const RawReason = z.object({
  type: z.enum(['NEWS', 'TECHNICAL']),
  text: z.string(),
  newsId: z.string().nullable().optional(),
})

const RawInvalidation = z.object({ text: z.string() })

const RawDecision = z.object({
  asset: AssetSymbol,
  action: Action,
  confidence: z.number(),
  stopLossPct: z.number().nullable().optional(),
  takeProfitPct: z.number().nullable().optional(),
  horizonHours: z.number().int().nullable().optional(),
  reasons: z.array(RawReason),
  invalidation: z.array(RawInvalidation),
})

export const RawGeminiResponse = z.object({
  decisions: z.array(RawDecision),
})
export type RawDecision = z.infer<typeof RawDecision>

export class ModelOutputShapeError extends Error {
  readonly asset: string | undefined
  readonly action: string | undefined

  constructor(message: string, asset?: string, action?: string) {
    super(message)
    this.name = 'ModelOutputShapeError'
    this.asset = asset
    this.action = action
  }
}

// Builds the per-branch object ModelDecisionProposal's discriminated union
// actually expects — conditionally including stopLossPct/takeProfitPct
// only for OPEN_LONG/OPEN_SHORT, and never for HOLD/CLOSE, regardless of
// what (possibly null) values the raw decision carried for those fields.
// Passing a key through unconditionally would fail HOLD/CLOSE's .strict()
// branches even when the value is null, since .strict() rejects unknown
// keys outright, not just unexpected non-null values.
function mapRawDecisionToProposal(raw: RawDecision): ModelDecisionProposal {
  const base = {
    asset: raw.asset,
    confidence: raw.confidence,
    horizonHours: raw.horizonHours ?? null,
    reasons: raw.reasons.map((r) =>
      r.type === 'NEWS'
        ? { type: 'NEWS' as const, text: r.text, newsId: requireNewsId(r, raw) }
        : { type: 'TECHNICAL' as const, text: r.text }
    ),
    invalidation: raw.invalidation,
  }

  if (raw.action === 'OPEN_LONG' || raw.action === 'OPEN_SHORT') {
    if (raw.stopLossPct == null || raw.takeProfitPct == null) {
      throw new ModelOutputShapeError(
        `${raw.action} for ${raw.asset} is missing stopLossPct/takeProfitPct — mandatory on every open`,
        raw.asset,
        raw.action,
      )
    }
    const result = ModelDecisionProposal.safeParse({
      ...base,
      action: raw.action,
      stopLossPct: raw.stopLossPct,
      takeProfitPct: raw.takeProfitPct,
    })
    if (!result.success) {
      throw new ModelOutputShapeError(
        `${raw.action} for ${raw.asset} failed validation: ${result.error.message}`,
        raw.asset,
        raw.action,
      )
    }
    return result.data
  }

  // HOLD / CLOSE — stopLossPct/takeProfitPct must be null/absent here. A
  // real value would mean the model is contradicting its own action (it
  // thinks it's proposing a stop for a decision that structurally can't
  // carry one) — that's flagged as a shape error, not silently dropped.
  // Silently omitting the key here would quietly defeat the exact
  // .strict() guarantee ModelDecisionProposal exists to enforce (same
  // failure mode its own module comment warns about for strip-mode
  // parsing), just one layer earlier.
  if (raw.stopLossPct != null || raw.takeProfitPct != null) {
    throw new ModelOutputShapeError(
      `${raw.action} for ${raw.asset} carries a stopLossPct/takeProfitPct value — only valid on an OPEN`,
      raw.asset,
      raw.action,
    )
  }

  const result = ModelDecisionProposal.safeParse({ ...base, action: raw.action })
  if (!result.success) {
    throw new ModelOutputShapeError(`${raw.action} for ${raw.asset} failed validation: ${result.error.message}`, raw.asset, raw.action)
  }
  return result.data
}

function requireNewsId(reason: z.infer<typeof RawReason>, raw: RawDecision): string {
  if (!reason.newsId) {
    throw new ModelOutputShapeError(
      `a NEWS-tagged reason for ${raw.asset} is missing newsId`,
      raw.asset,
      raw.action,
    )
  }
  return reason.newsId
}

// Entry point: raw Gemini JSON (already JSON.parse'd) -> validated
// ModelDecisionProposal[], asserting exactly one decision per requested
// asset — a response covering only one of BTC/ETH, or repeating one
// asset twice, is a shape failure, not something to silently tolerate.
export function parseModelOutput(rawJson: unknown, expectedAssets: readonly string[]): ModelDecisionProposal[] {
  const parsed = RawGeminiResponse.safeParse(rawJson)
  if (!parsed.success) {
    throw new ModelOutputShapeError(`response did not match the expected schema: ${parsed.error.message}`)
  }

  const proposals = parsed.data.decisions.map(mapRawDecisionToProposal)

  const gotAssets = proposals.map((p) => p.asset).sort()
  const wantAssets = [...expectedAssets].sort()
  if (JSON.stringify(gotAssets) !== JSON.stringify(wantAssets)) {
    throw new ModelOutputShapeError(`expected exactly one decision per asset ${JSON.stringify(wantAssets)}, got ${JSON.stringify(gotAssets)}`)
  }

  return proposals
}
