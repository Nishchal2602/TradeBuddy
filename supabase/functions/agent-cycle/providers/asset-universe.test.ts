import { assertEquals } from 'jsr:@std/assert@1'
import { AssetSymbol, ALL_ASSETS } from '../../../../src/shared/market-data/types.ts'
import { COIN_ID } from './coingecko.ts'
import { ASSET_PATTERNS } from './rss-news.ts'

// Asset-universe completeness (2026-10-03, plan ASSET-4 item 7a) — there
// was previously NO test pinning the asset universe at all, which is
// exactly why market-refresh/index.ts's own hardcoded ['BTC','ETH'] array
// (fixed in the same commit as this test, via the new ALL_ASSETS constant)
// was able to drift silently when the enum widened: a 2-element array
// stays a valid AssetSymbol[] after widening, so the compiler cannot catch
// it, and that function has no test file of its own at all.
//
// This test is the one mechanical guard that closes that gap, by asserting
// every consumer of "the asset universe" agrees with the single source of
// truth (AssetSymbol.options) in one place — so asset #5 fails loudly here
// rather than silently in three different modules.

Deno.test('asset universe: AssetSymbol.options is exactly BTC/ETH/SUI/AVAX (pins the universe itself)', () => {
  assertEquals([...AssetSymbol.options].sort(), ['AVAX', 'BTC', 'ETH', 'SUI'])
})

Deno.test('asset universe: ALL_ASSETS (market-refresh\'s drift-proof source) matches AssetSymbol.options exactly', () => {
  assertEquals([...ALL_ASSETS].sort(), [...AssetSymbol.options].sort())
})

Deno.test('asset universe: COIN_ID (coingecko.ts) has exactly one entry per asset, no more, no fewer', () => {
  assertEquals(Object.keys(COIN_ID).sort(), [...AssetSymbol.options].sort())
})

Deno.test('asset universe: ASSET_PATTERNS (rss-news.ts) has exactly one entry per asset, no more, no fewer', () => {
  assertEquals(Object.keys(ASSET_PATTERNS).sort(), [...AssetSymbol.options].sort())
})

Deno.test('asset universe: an unrecognized symbol is rejected by AssetSymbol, never silently accepted', () => {
  assertEquals(AssetSymbol.safeParse('DOGE').success, false)
  assertEquals(AssetSymbol.safeParse('avalanche').success, false) // the coin-id gotcha, not a valid ticker
  assertEquals(AssetSymbol.safeParse('').success, false)
  assertEquals(AssetSymbol.safeParse(null).success, false)
})
