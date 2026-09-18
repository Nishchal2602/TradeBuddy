import { z } from 'zod'
import { AssetSymbol } from '../market-data/types.ts'

// What a NewsProvider returns for one story. Field names mirror the
// `news_items` columns (supabase/migrations/..._initial_schema.sql) —
// same reasoning as market-data/types.ts.
//
// invariant 9 (architecture.md): news is untrusted data. Nothing on this
// type is ever concatenated into a system/instruction prompt — headline,
// summary, and source are rendered strictly as delimited data. That rule
// lives with the prompt-construction code (Next Up #5), not here, but the
// type itself carries no field that could be mistaken for one ("action",
// "instruction", etc. are deliberately not shapes this type has).
export const NormalizedNewsItem = z.object({
  // Stable provider-side id, namespaced by provider so ids from different
  // providers can never collide in the DB's `external_id unique` constraint
  // (e.g. "cryptopanic:1234567") — maps to news_items.external_id, which
  // the schema comment already documents as the cross-lookback-window
  // dedupe key.
  externalId: z.string().min(1),

  source: z.string().min(1),
  headline: z.string().min(1),
  summary: z.string().nullable(),
  url: z.string().nullable(),

  // Which of the V0 assets this story was matched to. Empty array is valid
  // (a provider-side query already scoped to BTC/ETH may still return a
  // story tagged more broadly) — the agent cycle, not this type, decides
  // whether an unmatched story is usable.
  assets: z.array(AssetSymbol),

  publishedAt: z.string().datetime(),

  // The untouched provider payload for this story — maps to news_items.raw
  // (jsonb, nullable). Exists so a decision can be replayed later against
  // exactly what the provider actually said, per code-standards.md "persist
  // enough raw/structured input to make a decision replayable." Not
  // validated beyond "is JSON-serializable" — it's a record, not an input
  // to any calculation.
  raw: z.unknown().nullable(),
})
export type NormalizedNewsItem = z.infer<typeof NormalizedNewsItem>
