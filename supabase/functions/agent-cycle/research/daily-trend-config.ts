import { computeCanonicalHash } from '../db/strategy-config.ts'
import type { DailyTrendConfig } from '../../../../src/shared/strategy/daily-trend-config-schema.ts'
import { dailyTrendConfigHashInput } from '../../../../src/shared/strategy/daily-trend-config-schema.ts'

// DT-1 plan, Phase P0 (2026-10-08) — reuses the SAME canonical-hash
// primitive IntradayLsConfig already uses (db/strategy-config.ts's
// computeCanonicalHash, extracted for exactly this reuse), never a second
// hashing scheme. DailyTrendConfig is research-only today — there is no
// strategy_configs row, no DB loader, no is_active concept, because DT-1
// is offline research and never reads a config from the DB (plan
// section 3, "Deliberately NOT reused"). This function exists solely so
// R4_DAILY_TREND_CONFIG can be cited by a committed, reproducible hash in
// the pre-registration and results documents.
export async function computeDailyTrendConfigHash(config: DailyTrendConfig): Promise<string> {
  return computeCanonicalHash(dailyTrendConfigHashInput(config))
}
