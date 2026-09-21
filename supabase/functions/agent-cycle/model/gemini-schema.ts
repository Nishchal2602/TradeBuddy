import { z } from 'zod'
import { AssetSymbol } from '../../../../src/shared/market-data/types.ts'

// Gemini's responseSchema dialect: an OpenAPI 3.0 Schema subset with
// UPPERCASE type names — confirmed live against the real API (2026-09-19),
// not assumed from docs.
//
// Trading Strategy V1 (2026-09-21) replaces the old decision-originating
// schema entirely — Gemini no longer proposes action/confidence/SL/TP/
// invalidation (agent-cycle/strategy/rules.ts synthesizes those
// deterministically now). This is a genuine replacement, not an addition:
// nothing in the rewired agent-cycle/index.ts calls the old schema or
// GEMINI_RESPONSE_SCHEMA anymore, so keeping them around would be dead
// code pretending to be live.
export const GEMINI_VETO_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdicts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          asset: { type: 'STRING', enum: ['BTC', 'ETH'] },
          veto: { type: 'BOOLEAN' },
          rationale: { type: 'STRING' },
        },
        required: ['asset', 'veto', 'rationale'],
      },
    },
  },
  required: ['verdicts'],
} as const

const RawVetoVerdict = z.object({
  asset: AssetSymbol,
  veto: z.boolean(),
  rationale: z.string(),
})

const RawVetoResponse = z.object({
  verdicts: z.array(RawVetoVerdict),
})

export interface VetoVerdict {
  asset: z.infer<typeof AssetSymbol>
  veto: boolean
  rationale: string
}

export class ModelOutputShapeError extends Error {
  readonly asset: string | undefined

  constructor(message: string, asset?: string) {
    super(message)
    this.name = 'ModelOutputShapeError'
    this.asset = asset
  }
}

// Entry point: raw Gemini JSON (already JSON.parse'd) -> validated
// VetoVerdict[], asserting exactly one verdict per candidate asset — a
// response covering only one of several candidates, or repeating one
// asset twice, is a shape failure, not something to silently tolerate.
// Same "loose wire shape -> strict domain parse, exact cardinality
// checked" discipline as the decision-schema parser this replaces.
export function parseVetoOutput(rawJson: unknown, expectedAssets: readonly string[]): VetoVerdict[] {
  const parsed = RawVetoResponse.safeParse(rawJson)
  if (!parsed.success) {
    throw new ModelOutputShapeError(`veto response did not match the expected schema: ${parsed.error.message}`)
  }

  const verdicts = parsed.data.verdicts

  const gotAssets = verdicts.map((v) => v.asset).sort()
  const wantAssets = [...expectedAssets].sort()
  if (JSON.stringify(gotAssets) !== JSON.stringify(wantAssets)) {
    throw new ModelOutputShapeError(`expected exactly one veto verdict per candidate asset ${JSON.stringify(wantAssets)}, got ${JSON.stringify(gotAssets)}`)
  }

  return verdicts
}
