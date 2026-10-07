import { assertEquals, assertStrictEquals } from 'jsr:@std/assert@1'
import { resolveAccountSettings } from './resolve-account-settings.ts'
import type { VariantOverrides } from './resolve-account-settings.ts'

interface FixtureSettings extends VariantOverrides {
  feeBps: number // a field a variant never touches, to prove it survives untouched
}

function globalSettings(overrides: Partial<FixtureSettings> = {}): FixtureSettings {
  return {
    decisionIntervalMinutes: 15,
    assets: ['BTC', 'ETH', 'SUI', 'AVAX'],
    newsVetoEnabled: true,
    managementEnabled: true,
    feeBps: 10,
    ...overrides,
  }
}

Deno.test('resolveAccountSettings: variant=null returns global UNCHANGED, by identity — the behavior-neutrality guarantee', () => {
  const global = globalSettings()
  const result = resolveAccountSettings(global, null)
  assertStrictEquals(result, global, 'must be the SAME object reference, not merely an equal one — every pre-EXP-1 call site depends on zero behavior change for the champion')
})

Deno.test('resolveAccountSettings: a variant overrides exactly its four treatment fields', () => {
  const global = globalSettings()
  const variant: VariantOverrides = {
    decisionIntervalMinutes: 60,
    assets: ['BTC', 'ETH'],
    newsVetoEnabled: false,
    managementEnabled: false,
  }
  const result = resolveAccountSettings(global, variant)
  assertEquals(result.decisionIntervalMinutes, 60)
  assertEquals(result.assets, ['BTC', 'ETH'])
  assertEquals(result.newsVetoEnabled, false)
  assertEquals(result.managementEnabled, false)
})

Deno.test('resolveAccountSettings: every OTHER field is inherited from global, untouched', () => {
  const global = globalSettings({ feeBps: 42 })
  const variant: VariantOverrides = { decisionIntervalMinutes: 30, assets: ['SUI'], newsVetoEnabled: true, managementEnabled: true }
  const result = resolveAccountSettings(global, variant)
  assertEquals(result.feeBps, 42, 'operator-only fields (fees, risk ceilings, etc.) are never variant-overridable')
})
