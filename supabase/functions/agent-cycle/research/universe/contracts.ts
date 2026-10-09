import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchExchangeInfo } from '../../providers/binance.ts'
import type { ExchangeInfoSymbol } from '../../providers/binance.ts'
import type { ResearchSymbol } from '../types.ts'

// DT-1 (2026-10-09, Order-of-Work step 4) — the frozen, auditable
// Binance-symbol -> underlying-asset mapping and exclusion classification
// (plan §5.7, §9.1; research_contracts, migration 20261009100000).
//
// Pre-registered, named classification rules (NOT hand-picked per-asset):
// the point of this file is that every USDT symbol Binance has ever
// listed classifies MECHANICALLY against these rules — exactly the "a
// mechanically-generated, frozen-observation-window fallback... never a
// hand-picked list" discipline the plan applies everywhere else. The
// three named, VERIFIED sources below are the only places a specific
// symbol name appears:
//   1. KNOWN_RENAMES — 7 contract migrations, each live-verified against
//      exchangeInfo during P1c (dt1-phase1c-pit-census-2026-10-08.md).
//   2. KNOWN_STABLECOINS — 4 delisted ones the P1c volume census found
//      (PAX/BUSD/UST/USDSOLD), plus well-known CURRENTLY-TRADING
//      stablecoin tickers (USDC/TUSD/FDUSD/DAI/USDP/GUSD) that would
//      otherwise pollute the universe ranking as if they were ordinary
//      risk assets. Stablecoin status has no safe regex -- a new one
//      discovered later is a dated, visibly-appended addition here, never
//      inferred.
//   3. KNOWN_EXCHANGE_TOKENS — WRXUSDT, per the Stage A sign-off
//      (2026-10-08): "exchange-affiliated token" is a named exclusion
//      category, applied consistently, not asset-by-asset judgment.
// Leveraged/index tokens (BTCUPUSDT, ETHBULLUSDT, ...), by contrast, DO
// have a safe, unambiguous naming convention Binance itself uses --
// isLeveragedToken below is a REGEX, deliberately generalizing beyond the
// 11 symbols the P1c census happened to find, so a leveraged token never
// seen before in this project's research still classifies correctly on
// first encounter.

export type ResearchAssetClass = 'ordinary' | 'stablecoin' | 'leveraged_index' | 'wrapped' | 'lst' | 'exchange_token' | 'fiat_currency'

export interface ResearchContractClassification {
  underlyingId: ResearchSymbol
  assetClass: ResearchAssetClass
  excluded: boolean
  exclusionReason: string | null
}

// Binance symbol -> underlying id, for contracts where Binance delisted
// the old symbol and listed a new one rather than renaming in place (the
// plan's own §5.7: "Binance treats a rename as delist-old/list-new, never
// in-place"). Every entry here is independently live-verified against
// exchangeInfo (P1c), not inferred from ticker similarity -- P1c's own
// writeup documents catching and correcting one wrong initial guess
// (AGIXUSDT assumed -> ASIUSDT, corrected to the real FETUSDT) specifically
// BECAUSE verification, not assumption, is the standard here.
export const KNOWN_RENAMES: Readonly<Record<string, ResearchSymbol>> = {
  BCCUSDT: 'BCH', // Bitcoin Cash's original 2017 Binance ticker
  BCHABCUSDT: 'BCH', // the post-Nov-2018-fork interim ticker, folded back into BCH
  VENUSDT: 'VET', // VeChain's 2018 rebrand
  LENDUSDT: 'AAVE', // Aave's 2020 rebrand from LEND
  ERDUSDT: 'EGLD', // Elrond's rebrand to MultiversX
  RNDRUSDT: 'RENDER', // Render's ticker migration
  AGIXUSDT: 'FET', // SingularityNET's 2024 merger into the ASI alliance -- surviving ticker is Fetch.ai's FET, NOT a separate ASI symbol (P1c's own corrected-guess note)
}

// Stablecoins, USDT-quoted, that must never be ranked as an ordinary risk
// asset. The first 4 are the P1c census's own named delisted findings;
// several more are well-known currently-trading stablecoin tickers added
// so the mechanical classifier does not silently admit them as
// "ordinary" the first time this runs against a live exchangeInfo dump.
//
// IMPORTANT LIMITATION, read before trusting this list alone: unlike
// leveraged tokens, stablecoins have no universal Binance naming
// convention a regex can safely generalize from (a name-based substring
// rule would both miss real cases -- PAX/UST/DAI contain no "USD"
// substring at all -- and risk false positives on an ordinary coin that
// happens to contain "USD" in its name). unused at symbol-classification
// time anyway: this classifier runs on exchangeInfo alone, before any
// price history is ingested, so it CANNOT check price behavior.
//
// The real safety net is therefore a SEPARATE, price-behavior-based
// sweep run AFTER ingestion, over whatever actually lands in a built
// universe -- coefficient of variation of daily close price across an
// asset's full history; genuine crypto assets never sit anywhere near a
// stablecoin's ~0.05% figure. USD1 and RLUSD below were found EXACTLY
// this way (2026-10-09, both appeared in the live-built dt1-v1 universe
// before this fix, at CoV 0.0005 and 0.0005 respectively) -- added here
// as a dated, named correction, not inferred from their tickers alone.
export const KNOWN_STABLECOINS: ReadonlySet<string> = new Set([
  'PAXUSDT', // Paxos Standard
  'BUSDUSDT', // Binance USD
  'USTUSDT', // TerraUSD
  'USDSOLDUSDT', // a deprecated Binance stablecoin ticker
  'USDCUSDT',
  'TUSDUSDT',
  'FDUSDUSDT',
  'DAIUSDT',
  'USDPUSDT',
  'GUSDUSDT',
  'USD1USDT', // World Liberty Financial USD1 -- found via the price-volatility sweep, 2026-10-09
  'RLUSDUSDT', // Ripple USD -- found via the price-volatility sweep, 2026-10-09
  'UUSDT', // found via the price-volatility sweep, 2026-10-09 -- CoV 0.0005, same signature as the two above
])

// A fiat currency pair (Binance lists spot EUR/USDT as an ordinary
// trading pair), not a cryptocurrency at all -- out of scope for a
// strategy-generalization test over a CRYPTO universe regardless of how
// its volatility compares to a stablecoin's. Also found via the
// price-volatility sweep (2026-10-09): CoV 0.05, clearly not pegged like
// a stablecoin, but its multi-year 0.96-1.26 range is ordinary FX
// movement, not crypto risk-asset behavior.
export const KNOWN_FIAT_CURRENCIES: ReadonlySet<string> = new Set(['EURUSDT'])

// Exchange-affiliated tokens -- Stage A sign-off (2026-10-08): a named
// exclusion category (an exchange token's value is tied to a specific
// platform's own fortunes, not an ordinary open-market asset), applied
// consistently rather than per-asset discretion. WRXUSDT (WazirX) is the
// only one verified so far; a future hit is a dated, visibly-appended
// addition, never a silent default-to-ordinary.
export const KNOWN_EXCHANGE_TOKENS: ReadonlySet<string> = new Set(['WRXUSDT'])

// Binance's own leveraged/3x-long-short-index-token naming convention --
// <BASE><UP|DOWN|BULL|BEAR>USDT, base at least 2 characters (excludes a
// coin whose OWN ticker happens to end in one of these words with no
// base prefix at all -- there is no such real coin at the time of
// writing, and requiring 2+ base characters is the conservative choice).
// BULLUSDT/BEARUSDT themselves have no base prefix at all (they are their
// own distinct historical tokens, confirmed in the P1c census) and so sit
// in their own exact-match set rather than the regex.
const LEVERAGED_TOKEN_PATTERN = /^[A-Z0-9]{2,}(?:UP|DOWN|BULL|BEAR)USDT$/
const LEVERAGED_TOKEN_EXACT: ReadonlySet<string> = new Set(['BULLUSDT', 'BEARUSDT'])

export function isLeveragedToken(symbol: string): boolean {
  return LEVERAGED_TOKEN_EXACT.has(symbol) || LEVERAGED_TOKEN_PATTERN.test(symbol)
}

// The one pure classification function every USDT symbol passes through.
// Deliberately total (never throws) -- an unrecognized symbol classifies
// as 'ordinary', not excluded, with its own ticker (USDT suffix stripped)
// as its underlying id. This is the correct default: silence (an
// unclassified symbol) must never mean "excluded" by accident, since that
// would shrink the universe without anyone deciding to.
export function classifyUsdtSymbol(symbol: string): ResearchContractClassification {
  const rename = KNOWN_RENAMES[symbol]
  if (rename) {
    return { underlyingId: rename, assetClass: 'ordinary', excluded: false, exclusionReason: null }
  }
  if (isLeveragedToken(symbol)) {
    return { underlyingId: stripUsdtSuffix(symbol), assetClass: 'leveraged_index', excluded: true, exclusionReason: 'leveraged/3x long-short index token (Binance-native product, excluded by construction)' }
  }
  if (KNOWN_STABLECOINS.has(symbol)) {
    return { underlyingId: stripUsdtSuffix(symbol), assetClass: 'stablecoin', excluded: true, exclusionReason: 'stablecoin, not an ordinary risk asset' }
  }
  if (KNOWN_FIAT_CURRENCIES.has(symbol)) {
    return { underlyingId: stripUsdtSuffix(symbol), assetClass: 'fiat_currency', excluded: true, exclusionReason: 'fiat currency pair, not a cryptocurrency' }
  }
  if (KNOWN_EXCHANGE_TOKENS.has(symbol)) {
    return { underlyingId: stripUsdtSuffix(symbol), assetClass: 'exchange_token', excluded: true, exclusionReason: "exchange-affiliated token -- value tied to a specific platform's own fortunes, not an ordinary open-market asset (Stage A sign-off, 2026-10-08)" }
  }
  return { underlyingId: stripUsdtSuffix(symbol), assetClass: 'ordinary', excluded: false, exclusionReason: null }
}

function stripUsdtSuffix(symbol: string): string {
  return symbol.endsWith('USDT') ? symbol.slice(0, -'USDT'.length) : symbol
}

export interface ResearchContractRow {
  binanceSymbol: string
  underlyingId: ResearchSymbol
  quoteAsset: string
  assetClass: ResearchAssetClass
  excluded: boolean
  exclusionReason: string | null
  mappingVersion: string
}

// Pure: turns a raw exchangeInfo dump into research_contracts rows,
// restricted to USDT-quoted spot symbols only (plan §5.3's venue/quote
// rule) -- the many BNB/BTC/ETH-quoted pairs from Binance's early years
// are out of scope for DT-1's own universe and are not classified at all
// (not "excluded": genuinely a different, irrelevant population).
export function buildResearchContracts(symbols: readonly ExchangeInfoSymbol[], mappingVersion: string): ResearchContractRow[] {
  return symbols
    .filter((s) => s.quoteAsset === 'USDT')
    .map((s) => {
      const classification = classifyUsdtSymbol(s.symbol)
      return {
        binanceSymbol: s.symbol,
        underlyingId: classification.underlyingId,
        quoteAsset: s.quoteAsset,
        assetClass: classification.assetClass,
        excluded: classification.excluded,
        exclusionReason: classification.exclusionReason,
        mappingVersion,
      }
    })
}

function toDbRow(row: ResearchContractRow) {
  return {
    binance_symbol: row.binanceSymbol,
    underlying_id: row.underlyingId,
    quote_asset: row.quoteAsset,
    asset_class: row.assetClass,
    excluded: row.excluded,
    exclusion_reason: row.exclusionReason,
    mapping_version: row.mappingVersion,
  }
}

export async function upsertResearchContracts(supabase: SupabaseClient, rows: readonly ResearchContractRow[]): Promise<void> {
  if (rows.length === 0) return
  const { error } = await supabase.from('research_contracts').upsert(rows.map(toDbRow), { onConflict: 'binance_symbol,mapping_version' })
  if (error) throw new Error(`upsertResearchContracts: ${error.message}`)
}

// The one impure entry point: fetch exchangeInfo live, classify, write.
// Idempotent under the same mappingVersion (upsert on binance_symbol +
// mapping_version) -- re-running it to pick up newly-listed symbols never
// mutates an already-frozen mapping_version's existing rows' classification,
// since the same deterministic input always produces the same output.
export async function fetchAndBuildResearchContracts(
  supabase: SupabaseClient,
  mappingVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ total: number; excluded: number; byClass: Record<ResearchAssetClass, number> }> {
  const symbols = await fetchExchangeInfo(fetchImpl)
  const rows = buildResearchContracts(symbols, mappingVersion)
  await upsertResearchContracts(supabase, rows)

  const byClass: Record<ResearchAssetClass, number> = { ordinary: 0, stablecoin: 0, leveraged_index: 0, wrapped: 0, lst: 0, exchange_token: 0, fiat_currency: 0 }
  let excluded = 0
  for (const row of rows) {
    byClass[row.assetClass]++
    if (row.excluded) excluded++
  }
  return { total: rows.length, excluded, byClass }
}
