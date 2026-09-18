import { XMLParser } from 'fast-xml-parser'
import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { NormalizedNewsItem } from '../../../../src/shared/news/types.ts'
import { NormalizedNewsItem as NormalizedNewsItemSchema } from '../../../../src/shared/news/types.ts'
import type { NewsProvider } from '../../../../src/shared/news/provider.ts'
import { ProviderFetchError } from '../../../../src/shared/providers/errors.ts'

// A small curated set of reputable, publicly-syndicated RSS feeds — no
// paid API, no scraping (user direction, 2026-09-18: avoid CryptoPanic given
// its free-tier uncertainty; RSS keeps V0 at $0 with no account/token
// needed at all). Every URL here was checked live before being added
// (HTTP 200, genuine RSS 2.0 XML, real recent items) — not assumed from
// memory; outlets migrate these paths often enough that guessing is how
// this silently breaks. `slug` is the externalId namespace and is
// deliberately independent of `name` — renaming the display name must
// never change the dedupe identity of stories already persisted.
const FEEDS: { slug: string; name: string; url: string }[] = [
  { slug: 'cointelegraph', name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { slug: 'decrypt', name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { slug: 'bitcoinmagazine', name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/feed' },
  { slug: 'cryptoslate', name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/' },
  { slug: 'theblock', name: 'The Block', url: 'https://www.theblock.co/rss.xml' },
  { slug: 'bitcoincom', name: 'Bitcoin.com News', url: 'https://news.bitcoin.com/feed/' },
  // These 308/301-redirect to their canonical feed URL — fetch() follows
  // redirects by default, confirmed live (2026-09-18), so the original
  // URLs are kept rather than hardcoding a redirect target that could
  // itself move again.
  { slug: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { slug: 'thedefiant', name: 'The Defiant', url: 'https://thedefiant.io/feed' },
]

// Word-boundary, case-insensitive — verified against common false-positive
// words (method, weather, together, aesthetic, ethics, ethereal, ...) and
// real-world phrasing ($ETH rallies, ETH/USD, Ether surged) before use.
// "eth"/"ether" without \b would false-positive inside dozens of ordinary
// English words.
const ASSET_PATTERNS: Record<AssetSymbol, RegExp> = {
  BTC: /\b(bitcoin|btc)\b/i,
  ETH: /\b(ethereum|eth|ether)\b/i,
}

function guessRelevantAssets(text: string): AssetSymbol[] {
  return (Object.keys(ASSET_PATTERNS) as AssetSymbol[]).filter((asset) => ASSET_PATTERNS[asset].test(text))
}

// fast-xml-parser represents the same logical text field differently
// depending on whether the source XML wrapped it in CDATA and/or gave it
// attributes — plain string, { __cdata: string }, or { '#text': string,
// '@_...': ... }. Real captured feeds (2026-09-18) exercised all three
// shapes across different fields on the same item.
function extractText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.__cdata === 'string') return obj.__cdata
    if (typeof obj['#text'] === 'string') return obj['#text']
  }
  return ''
}

// Descriptions arrive as raw HTML (image tags, inline styles, etc.) —
// strip tags and decode the handful of entities actually seen in practice.
// Not a general HTML-to-text library on purpose: normalized summaries are
// data shown in the UI and fed to the model as delimited text, not
// rendered HTML, so "readable plain text" is the actual bar, not fidelity.
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeTitleForDedup(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

interface RawFeedItem {
  title?: unknown
  link?: unknown
  guid?: unknown
  pubDate?: unknown
  description?: unknown
  [key: string]: unknown
}

function parseFeedXml(xml: string): RawFeedItem[] {
  const parser = new XMLParser({ ignoreAttributes: false, cdataPropName: '__cdata' })
  const parsed: unknown = parser.parse(xml)

  const channel = (parsed as { rss?: { channel?: unknown } })?.rss?.channel as
    | { item?: unknown }
    | undefined
  const rawItems = channel?.item
  if (!rawItems) return []

  // fast-xml-parser returns a bare object (not a one-element array) when a
  // group has exactly one member — a well-known gotcha, unlikely in
  // practice for these feeds (every one observed live carries dozens of
  // items) but cheap to guard against a crash on `.map`.
  return Array.isArray(rawItems) ? (rawItems as RawFeedItem[]) : [rawItems as RawFeedItem]
}

function toNormalizedItem(
  raw: RawFeedItem,
  feed: { slug: string; name: string },
): NormalizedNewsItem | null {
  const title = extractText(raw.title).trim()
  const link = extractText(raw.link).trim()
  const guidText = extractText(raw.guid).trim()
  const pubDateText = extractText(raw.pubDate).trim()
  if (!title || !pubDateText) return null

  const publishedAt = new Date(pubDateText)
  if (Number.isNaN(publishedAt.getTime())) return null

  const externalId = `rss:${feed.slug}:${guidText || link || title}`
  const summary = stripHtml(extractText(raw.description)) || null

  return NormalizedNewsItemSchema.parse({
    externalId,
    source: feed.name,
    headline: title,
    summary,
    url: link || null,
    assets: [], // filled in by the caller once it knows which assets were requested
    publishedAt: publishedAt.toISOString(),
    raw,
  })
}

export class RssNewsProvider implements NewsProvider {
  private readonly fetchImpl: typeof fetch
  private readonly feeds: { slug: string; name: string; url: string }[]

  // Explicit fields + manual assignment, not constructor parameter-property
  // shorthand — see src/shared/providers/errors.ts for why
  // (erasableSyntaxOnly).
  constructor(fetchImpl: typeof fetch = fetch, feeds: { slug: string; name: string; url: string }[] = FEEDS) {
    this.fetchImpl = fetchImpl
    this.feeds = feeds
  }

  async getRecentNews(assets: AssetSymbol[], lookbackMinutes: number): Promise<NormalizedNewsItem[]> {
    if (assets.length === 0) return []

    const now = Date.now()
    const cutoff = now - lookbackMinutes * 60 * 1000

    const results = await Promise.allSettled(
      this.feeds.map((feed) => this.fetchOneFeed(feed)),
    )

    const failures: string[] = []
    const allItems: NormalizedNewsItem[] = []

    results.forEach((result, i) => {
      const feed = this.feeds[i]!
      if (result.status === 'rejected') {
        failures.push(`${feed.name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
        return
      }
      allItems.push(...result.value)
    })

    // Fail closed only when EVERY feed failed — a genuine outage, not a
    // single dead source among a redundant set (code-standards.md "fail
    // closed for trading decisions" / this provider's whole point is that
    // one feed being down shouldn't blind the cycle).
    if (failures.length === this.feeds.length) {
      throw new ProviderFetchError(
        `rss-news: all ${this.feeds.length} feeds failed: ${failures.join('; ')}`,
        'rss-news',
      )
    }

    const relevant = allItems
      .filter((item) => new Date(item.publishedAt).getTime() >= cutoff)
      .map((item) => ({ ...item, assets: guessRelevantAssets(`${item.headline} ${item.summary ?? ''}`) }))
      .filter((item) => item.assets.some((a) => assets.includes(a)))
      .map((item) => ({ ...item, assets: item.assets.filter((a) => assets.includes(a)) }))

    const seenExternalIds = new Set<string>()
    const seenTitles = new Set<string>()
    const deduped: NormalizedNewsItem[] = []
    for (const item of relevant) {
      const titleKey = normalizeTitleForDedup(item.headline)
      if (seenExternalIds.has(item.externalId) || seenTitles.has(titleKey)) continue
      seenExternalIds.add(item.externalId)
      seenTitles.add(titleKey)
      deduped.push(item)
    }

    deduped.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    return deduped
  }

  private async fetchOneFeed(feed: { slug: string; name: string; url: string }): Promise<NormalizedNewsItem[]> {
    let response: Response
    try {
      response = await this.fetchImpl(feed.url)
    } catch (cause) {
      throw new ProviderFetchError(`${feed.name}: network error`, 'rss-news', cause)
    }

    if (!response.ok) {
      throw new ProviderFetchError(`${feed.name}: HTTP ${response.status}`, 'rss-news')
    }

    let xml: string
    try {
      xml = await response.text()
    } catch (cause) {
      throw new ProviderFetchError(`${feed.name}: could not read response body`, 'rss-news', cause)
    }

    let rawItems: RawFeedItem[]
    try {
      rawItems = parseFeedXml(xml)
    } catch (cause) {
      throw new ProviderFetchError(`${feed.name}: malformed XML`, 'rss-news', cause)
    }

    const normalized: NormalizedNewsItem[] = []
    for (const raw of rawItems) {
      const item = toNormalizedItem(raw, feed)
      if (item) normalized.push(item)
    }
    return normalized
  }
}
