import type { SupabaseClient } from '@supabase/supabase-js'
import { toIsoZ } from './row-mappers.ts'
import type { PersistedNewsItem } from '../cycle/build-context.ts'
import type { NormalizedNewsItem } from '../../../../src/shared/news/types.ts'

// EXP-1 Stage E3 (2026-10-07) — extracted from agent-cycle/index.ts
// (where it originated, 2026-09-xx news pipeline) into its own module so
// cycle-dispatcher can call the IDENTICAL persistence path when it does
// this once per tick, shared by every due account, rather than
// duplicating it a second time. Behavior unchanged from where it lived;
// same "extract once a second real caller exists" discipline as
// row-mappers.ts/market-bars.ts before it.
//
// Upserts on external_id (dedupes a story re-seen inside the overlapping
// lookback window) and returns every row — new or pre-existing — with its
// real news_items.id, since reasons[].newsId (src/shared/decisions/
// types.ts) is validated as a UUID the model cites back: only a
// persisted item has one. Only the columns this upsert actually sets are
// touched on a pre-existing row (PostgREST's merge-duplicates resolution
// updates exactly the provided columns) — ingested_at's own DEFAULT
// now() is never re-applied to an already-ingested story.
export async function persistNews(supabase: SupabaseClient, items: NormalizedNewsItem[]): Promise<Map<string, PersistedNewsItem>> {
  if (items.length === 0) return new Map()
  const { data, error } = await supabase
    .from('news_items')
    .upsert(
      items.map((i) => ({
        external_id: i.externalId,
        source: i.source,
        headline: i.headline,
        summary: i.summary,
        url: i.url,
        assets: i.assets,
        published_at: i.publishedAt,
        raw: i.raw,
      })),
      { onConflict: 'external_id' },
    )
    .select('id, external_id, source, headline, summary, published_at')
  if (error) throw new Error(`could not persist news_items: ${error.message}`)

  const byExternalId = new Map<string, PersistedNewsItem>()
  for (const row of data ?? []) {
    byExternalId.set(row.external_id, {
      id: row.id,
      source: row.source,
      headline: row.headline,
      summary: row.summary,
      publishedAt: toIsoZ(row.published_at),
    })
  }
  return byExternalId
}
