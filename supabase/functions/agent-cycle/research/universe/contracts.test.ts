import { assertEquals } from 'jsr:@std/assert@1'
import { buildResearchContracts, classifyUsdtSymbol, isLeveragedToken, KNOWN_EXCHANGE_TOKENS, KNOWN_RENAMES, KNOWN_STABLECOINS } from './contracts.ts'
import type { ExchangeInfoSymbol } from '../../providers/binance.ts'

function sym(symbol: string, quoteAsset = 'USDT', status = 'TRADING'): ExchangeInfoSymbol {
  return { symbol, status, baseAsset: symbol.replace(quoteAsset, ''), quoteAsset }
}

// --- isLeveragedToken ------------------------------------------------------

Deno.test('isLeveragedToken: matches every P1c-census-confirmed leveraged token', () => {
  for (const s of ['BTCUPUSDT', 'BTCDOWNUSDT', 'ETHBULLUSDT', 'ETHBEARUSDT', 'EOSBULLUSDT', 'EOSBEARUSDT', 'LINKDOWNUSDT', 'XRPUPUSDT', 'XRPDOWNUSDT', 'BULLUSDT', 'BEARUSDT']) {
    assertEquals(isLeveragedToken(s), true, `expected ${s} to classify as a leveraged token`)
  }
})

Deno.test('isLeveragedToken: generalizes to a base coin never previously seen (mechanical, not a hardcoded list)', () => {
  assertEquals(isLeveragedToken('ADAUPUSDT'), true)
  assertEquals(isLeveragedToken('ADADOWNUSDT'), true)
})

Deno.test('isLeveragedToken: an ordinary coin is never misclassified', () => {
  for (const s of ['BTCUSDT', 'ETHUSDT', 'SUIUSDT', 'AVAXUSDT', 'DOGEUSDT']) {
    assertEquals(isLeveragedToken(s), false)
  }
})

// --- classifyUsdtSymbol -----------------------------------------------------

Deno.test('classifyUsdtSymbol: every known rename resolves to its underlying id, never excluded', () => {
  for (const [binanceSymbol, underlyingId] of Object.entries(KNOWN_RENAMES)) {
    const result = classifyUsdtSymbol(binanceSymbol)
    assertEquals(result.underlyingId, underlyingId)
    assertEquals(result.assetClass, 'ordinary')
    assertEquals(result.excluded, false)
  }
})

Deno.test('classifyUsdtSymbol: every known stablecoin is excluded with a reason', () => {
  for (const symbol of KNOWN_STABLECOINS) {
    const result = classifyUsdtSymbol(symbol)
    assertEquals(result.assetClass, 'stablecoin')
    assertEquals(result.excluded, true)
    assertEquals(typeof result.exclusionReason, 'string')
  }
})

Deno.test('classifyUsdtSymbol: every known exchange token is excluded with a reason', () => {
  for (const symbol of KNOWN_EXCHANGE_TOKENS) {
    const result = classifyUsdtSymbol(symbol)
    assertEquals(result.assetClass, 'exchange_token')
    assertEquals(result.excluded, true)
  }
})

Deno.test('classifyUsdtSymbol: a leveraged token strips to its own ticker (no rename), excluded', () => {
  const result = classifyUsdtSymbol('BTCUPUSDT')
  assertEquals(result.underlyingId, 'BTCUP')
  assertEquals(result.assetClass, 'leveraged_index')
  assertEquals(result.excluded, true)
})

Deno.test('classifyUsdtSymbol: an ordinary, unrecognized symbol is NEVER excluded by default', () => {
  const result = classifyUsdtSymbol('DOGEUSDT')
  assertEquals(result, { underlyingId: 'DOGE', assetClass: 'ordinary', excluded: false, exclusionReason: null })
})

Deno.test('classifyUsdtSymbol: BTC/ETH/SUI/AVAX -- the four live assets -- classify as ordinary, unexcluded', () => {
  for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SUIUSDT', 'AVAXUSDT']) {
    const result = classifyUsdtSymbol(symbol)
    assertEquals(result.assetClass, 'ordinary')
    assertEquals(result.excluded, false)
  }
})

// --- buildResearchContracts --------------------------------------------

Deno.test('buildResearchContracts: filters to USDT-quoted symbols only, non-USDT pairs are silently dropped (not excluded)', () => {
  const symbols = [sym('BTCUSDT'), sym('ETHBTC', 'BTC'), sym('AXSBIDR', 'BIDR')]
  const rows = buildResearchContracts(symbols, 'dt1-v1')
  assertEquals(rows.length, 1)
  assertEquals(rows[0]!.binanceSymbol, 'BTCUSDT')
})

Deno.test('buildResearchContracts: TRADING and BREAK status symbols are both included (status never gates classification)', () => {
  const symbols = [sym('BTCUSDT', 'USDT', 'TRADING'), sym('BCCUSDT', 'USDT', 'BREAK')]
  const rows = buildResearchContracts(symbols, 'dt1-v1')
  assertEquals(rows.length, 2)
  assertEquals(rows.find((r) => r.binanceSymbol === 'BCCUSDT')?.underlyingId, 'BCH')
})

Deno.test('buildResearchContracts: every row carries the supplied mappingVersion verbatim', () => {
  const rows = buildResearchContracts([sym('BTCUSDT')], 'dt1-v7')
  assertEquals(rows[0]!.mappingVersion, 'dt1-v7')
})

Deno.test('buildResearchContracts: an empty input produces an empty output, never throws', () => {
  assertEquals(buildResearchContracts([], 'dt1-v1'), [])
})
