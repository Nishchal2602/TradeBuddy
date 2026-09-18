import type { AssetSymbol } from '../market-data/types.ts'
import type { NormalizedNewsItem } from './types.ts'

export interface NewsProvider {
  // Recent stories relevant to the given assets, published within the last
  // `lookbackMinutes`. The caller (agent cycle) is responsible for sizing
  // lookbackMinutes from agent_settings.decision_interval_minutes +
  // news_lookback_overlap_minutes (progress-tracker.md Architecture
  // Decisions) — this interface just takes a plain duration so it has no
  // opinion on cadence.
  //
  // Must distinguish "queried and found nothing" (empty array) from
  // "couldn't reach the provider" (throw) — code-standards.md "distinguish
  // empty result from provider failure." A provider implementation must
  // never collapse those two into the same empty-array return.
  getRecentNews(assets: AssetSymbol[], lookbackMinutes: number): Promise<NormalizedNewsItem[]>
}
