import { assertEquals } from 'jsr:@std/assert@1'
import { validateIntradayLsConfig } from '../../../../src/shared/strategy/config-validate.ts'
import { V4_COMPAT_CONFIG } from '../../../../src/shared/strategy/config-presets.ts'

// EXP-1 Stage E2 (2026-10-07) — this is the gate's own "variant
// validation rejects a saturating config" scenario. No new production
// wrapper exists for "validate an experiment variant" — nothing creates
// variants programmatically yet (that's a future seeding/admin step),
// so this exercises validateIntradayLsConfig directly with a variant's
// own asset count, exactly as a future variant-creation call site would.
// V4_COMPAT_CONFIG already validates clean at every count 1-4
// (strategy-config-presets.test.ts) — this file is specifically about
// the REJECTION path, which has no dedicated coverage yet.
//
// Co-located here, not under src/shared/strategy/, for the SAME reason
// strategy-config-presets.test.ts already lives here (its own module
// comment): a Deno-only test file (jsr: imports, Deno.test) under
// src/shared/ breaks the root tsc -b project, which has no Deno types
// and no jsr: resolution.

Deno.test('validateIntradayLsConfig: a 2-asset-sized maxSingleTradePct (0.30) assigned to a 4-asset variant is rejected — the exact ASSET-4 saturation class', () => {
  const twoAssetSizedConfig = { ...V4_COMPAT_CONFIG, maxSingleTradePct: 0.30 } // V4_COMPAT_CONFIG itself ships 0.15 (sized for 4 assets)
  const errors = validateIntradayLsConfig(twoAssetSizedConfig, 4)
  assertEquals(errors.length > 0, true, 'a config sized for 2 assets must be rejected when a variant wants to run it across 4')
  assertEquals(errors.some((e) => e.field === 'maxSingleTradePct'), true)
})

Deno.test('validateIntradayLsConfig: the SAME config is accepted for a 2-asset variant — it is a variant/config MISMATCH being rejected, not the config itself', () => {
  const twoAssetSizedConfig = { ...V4_COMPAT_CONFIG, maxSingleTradePct: 0.30 }
  const errors = validateIntradayLsConfig(twoAssetSizedConfig, 2)
  assertEquals(errors.length, 0, '0.30 x 2 assets = 0.60, exactly at the 0.60 notional ceiling — valid')
})
