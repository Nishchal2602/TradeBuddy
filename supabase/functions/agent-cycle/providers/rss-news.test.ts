import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { RssNewsProvider } from './rss-news.ts'
import { ProviderFetchError } from '../../../../src/shared/providers/errors.ts'

// Real wall-clock time, not a fixed historical anchor — rss-news.ts's own
// lookback filter compares against real Date.now() (it has no injectable
// clock), so a hardcoded NOW here silently rots as real time moves past it
// and every hoursAgo() fixture falls outside the lookback window it's
// meant to test. Found exactly that way (2026-09-19, unrelated to any
// change that day) when a previously-hardcoded 2026-09-18 anchor finally
// drifted far enough to fail 11 of 14 tests.
const NOW = new Date()
function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000).toUTCString()
}

// Mirrors the real structure captured live from Cointelegraph/Decrypt/etc.
// on 2026-09-18: CDATA-wrapped <link>, <guid isPermaLink="true">, RFC 2822
// <pubDate>, CDATA <description> containing raw HTML.
function rssXml(items: { title: string; link: string; guid?: string; pubDate: string; description?: string }[]): string {
  const itemsXml = items.map((it) => `
    <item>
      <title>${it.title}</title>
      <pubDate>${it.pubDate}</pubDate>
      ${it.guid ? `<guid isPermaLink="true">${it.guid}</guid>` : ''}
      <link><![CDATA[${it.link}]]></link>
      <description><![CDATA[${it.description ?? ''}]]></description>
    </item>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Test Feed</title>${itemsXml}</channel></rss>`
}

function textResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, { status: 200, ...init })
}

const FEED_A = { slug: 'feed-a', name: 'Feed A', url: 'https://feed-a.example/rss' }
const FEED_B = { slug: 'feed-b', name: 'Feed B', url: 'https://feed-b.example/rss' }

function mockFetch(routes: Record<string, () => Response>) {
  return (url: string | URL): Promise<Response> => {
    const href = url.toString()
    const handler = routes[href]
    if (!handler) throw new Error(`mockFetch: no route for ${href}`)
    return Promise.resolve(handler())
  }
}

Deno.test('getRecentNews: normalizes and filters by requested asset relevance', async () => {
  const xml = rssXml([
    { title: 'Bitcoin breaks $80k resistance', link: 'https://a.example/1', guid: 'a1', pubDate: hoursAgo(1), description: '<p>BTC rallies hard.</p>' },
    { title: 'Local weather forecast for the weekend', link: 'https://a.example/2', guid: 'a2', pubDate: hoursAgo(1) },
    { title: 'Ethereum upgrade ships on schedule', link: 'https://a.example/3', guid: 'a3', pubDate: hoursAgo(1) },
  ])
  const provider = new RssNewsProvider(
    mockFetch({ [FEED_A.url]: () => textResponse(xml) }) as unknown as typeof fetch,
    [FEED_A],
  )
  const result = await provider.getRecentNews(['BTC', 'ETH'], 180)

  assertEquals(result.length, 2)
  const btc = result.find((r) => r.headline.includes('Bitcoin'))!
  assertEquals(btc.assets, ['BTC'])
  assertEquals(btc.summary, 'BTC rallies hard.')
  assertEquals(btc.source, 'Feed A')
  assertEquals(btc.externalId, 'rss:feed-a:a1')
  assertEquals(btc.url, 'https://a.example/1')
})

Deno.test('getRecentNews: an item mentioning both assets is tagged with only the requested ones', async () => {
  const xml = rssXml([
    { title: 'Bitcoin and Ethereum both rally on ETF news', link: 'https://a.example/1', guid: 'a1', pubDate: hoursAgo(1) },
  ])
  const provider = new RssNewsProvider(
    mockFetch({ [FEED_A.url]: () => textResponse(xml) }) as unknown as typeof fetch,
    [FEED_A],
  )
  const both = await provider.getRecentNews(['BTC', 'ETH'], 180)
  assertEquals(both[0]!.assets.sort(), ['BTC', 'ETH'])

  const btcOnly = await provider.getRecentNews(['BTC'], 180)
  assertEquals(btcOnly[0]!.assets, ['BTC'])
})

Deno.test('getRecentNews: excludes items published outside the lookback window', async () => {
  const xml = rssXml([
    { title: 'Bitcoin fresh news', link: 'https://a.example/1', guid: 'a1', pubDate: hoursAgo(1) },
    { title: 'Bitcoin stale news', link: 'https://a.example/2', guid: 'a2', pubDate: hoursAgo(10) },
  ])
  const provider = new RssNewsProvider(
    mockFetch({ [FEED_A.url]: () => textResponse(xml) }) as unknown as typeof fetch,
    [FEED_A],
  )
  const result = await provider.getRecentNews(['BTC'], 180) // 3h window
  assertEquals(result.length, 1)
  assertEquals(result[0]!.headline, 'Bitcoin fresh news')
})

Deno.test('getRecentNews: dedupes the same story across two feeds by normalized title', async () => {
  const headline = 'Bitcoin ETF sees record inflows'
  const xmlA = rssXml([{ title: headline, link: 'https://a.example/1', guid: 'a1', pubDate: hoursAgo(1) }])
  const xmlB = rssXml([{ title: headline + '!', link: 'https://b.example/1', guid: 'b1', pubDate: hoursAgo(1) }])
  const provider = new RssNewsProvider(
    mockFetch({ [FEED_A.url]: () => textResponse(xmlA), [FEED_B.url]: () => textResponse(xmlB) }) as unknown as typeof fetch,
    [FEED_A, FEED_B],
  )
  const result = await provider.getRecentNews(['BTC'], 180)
  assertEquals(result.length, 1)
})

Deno.test('getRecentNews: single-item feed (fast-xml-parser object-not-array gotcha)', async () => {
  const xml = rssXml([{ title: 'Bitcoin solo item', link: 'https://a.example/1', guid: 'a1', pubDate: hoursAgo(1) }])
  const provider = new RssNewsProvider(
    mockFetch({ [FEED_A.url]: () => textResponse(xml) }) as unknown as typeof fetch,
    [FEED_A],
  )
  const result = await provider.getRecentNews(['BTC'], 180)
  assertEquals(result.length, 1)
})

Deno.test('getRecentNews: one feed failing does not block the other (partial success)', async () => {
  const xml = rssXml([{ title: 'Bitcoin still works', link: 'https://a.example/1', guid: 'a1', pubDate: hoursAgo(1) }])
  const provider = new RssNewsProvider(
    mockFetch({
      [FEED_A.url]: () => textResponse(xml),
      [FEED_B.url]: () => new Response('Internal Server Error', { status: 500 }),
    }) as unknown as typeof fetch,
    [FEED_A, FEED_B],
  )
  const result = await provider.getRecentNews(['BTC'], 180)
  assertEquals(result.length, 1)
})

// fast-xml-parser is lenient by design (confirmed live, 2026-09-18):
// mismatched tags, binary garbage, and truncated-but-well-formed-enough
// input all parse "successfully" into some best-effort shape rather than
// throwing. These three tests separate the distinct failure paths that
// actually exist, rather than one test guessing at "malformed XML" and
// happening to pass through whichever path first.

Deno.test('getRecentNews: an item missing required fields (title/pubDate) is dropped, not a parse error', async () => {
  // Well-formed XML, but the title is empty — parser succeeds, per-item
  // validation in toNormalizedItem() is what actually rejects this one.
  const brokenItemXml = '<?xml version="1.0"?><rss><channel><item><title></title></item></channel></rss>'
  const goodXml = rssXml([{ title: 'Bitcoin still works', link: 'https://a.example/1', guid: 'a1', pubDate: hoursAgo(1) }])
  const provider = new RssNewsProvider(
    mockFetch({
      [FEED_A.url]: () => textResponse(goodXml),
      [FEED_B.url]: () => textResponse(brokenItemXml),
    }) as unknown as typeof fetch,
    [FEED_A, FEED_B],
  )
  const result = await provider.getRecentNews(['BTC'], 180)
  assertEquals(result.length, 1)
})

Deno.test('getRecentNews: XML with no channel/item structure returns zero items, not a thrown error', async () => {
  // Valid, parseable XML — just not RSS shaped (e.g. an outlet's WAF
  // returning an HTML error page with a 200 status). parseFeedXml's
  // channel?.item optional-chaining guard is what handles this, not a
  // try/catch.
  const goodXml = rssXml([{ title: 'Bitcoin still works', link: 'https://a.example/1', guid: 'a1', pubDate: hoursAgo(1) }])
  const provider = new RssNewsProvider(
    mockFetch({
      [FEED_A.url]: () => textResponse(goodXml),
      [FEED_B.url]: () => textResponse('<html><body>404 not found</body></html>'),
    }) as unknown as typeof fetch,
    [FEED_A, FEED_B],
  )
  const result = await provider.getRecentNews(['BTC'], 180)
  assertEquals(result.length, 1)
})

Deno.test('getRecentNews: a genuine parser exception (unclosed CDATA) on one feed does not crash the batch', async () => {
  // The one input actually confirmed to make fast-xml-parser throw
  // (2026-09-18) — a truncated response cut off mid-CDATA is a realistic
  // way this happens for real. This is the only test that exercises the
  // try/catch around parseFeedXml() rather than a downstream guard.
  const goodXml = rssXml([{ title: 'Bitcoin still works', link: 'https://a.example/1', guid: 'a1', pubDate: hoursAgo(1) }])
  const provider = new RssNewsProvider(
    mockFetch({
      [FEED_A.url]: () => textResponse(goodXml),
      [FEED_B.url]: () => textResponse('<rss><channel><item><title><![CDATA[unterminated'),
    }) as unknown as typeof fetch,
    [FEED_A, FEED_B],
  )
  const result = await provider.getRecentNews(['BTC'], 180)
  assertEquals(result.length, 1)
})

Deno.test('getRecentNews: every feed failing throws ProviderFetchError (fail closed)', async () => {
  const provider = new RssNewsProvider(
    mockFetch({
      [FEED_A.url]: () => new Response('error', { status: 500 }),
      [FEED_B.url]: () => new Response('error', { status: 503 }),
    }) as unknown as typeof fetch,
    [FEED_A, FEED_B],
  )
  await assertRejects(() => provider.getRecentNews(['BTC'], 180), ProviderFetchError)
})

Deno.test('getRecentNews: empty asset list makes zero requests and returns []', async () => {
  const calls: string[] = []
  const provider = new RssNewsProvider(((url: string) => {
    calls.push(url)
    throw new Error('should never be called')
  }) as unknown as typeof fetch)
  const result = await provider.getRecentNews([], 180)
  assertEquals(result, [])
  assertEquals(calls.length, 0)
})

Deno.test('getRecentNews: items irrelevant to any requested asset are dropped entirely', async () => {
  const xml = rssXml([{ title: 'Stock market closes higher today', link: 'https://a.example/1', guid: 'a1', pubDate: hoursAgo(1) }])
  const provider = new RssNewsProvider(
    mockFetch({ [FEED_A.url]: () => textResponse(xml) }) as unknown as typeof fetch,
    [FEED_A],
  )
  const result = await provider.getRecentNews(['BTC', 'ETH'], 180)
  assertEquals(result, [])
})

Deno.test('getRecentNews: HTML description is stripped to plain text', async () => {
  const xml = rssXml([{
    title: 'Bitcoin news with rich description',
    link: 'https://a.example/1',
    guid: 'a1',
    pubDate: hoursAgo(1),
    description: '<p style="color:red">Price &amp; volume both up &#39;a lot&#39;.</p>',
  }])
  const provider = new RssNewsProvider(
    mockFetch({ [FEED_A.url]: () => textResponse(xml) }) as unknown as typeof fetch,
    [FEED_A],
  )
  const result = await provider.getRecentNews(['BTC'], 180)
  assertEquals(result[0]!.summary, "Price & volume both up 'a lot'.")
})

Deno.test('getRecentNews: item missing a guid falls back to link as the dedupe key', async () => {
  const xml = rssXml([{ title: 'Bitcoin no guid here', link: 'https://a.example/no-guid', pubDate: hoursAgo(1) }])
  const provider = new RssNewsProvider(
    mockFetch({ [FEED_A.url]: () => textResponse(xml) }) as unknown as typeof fetch,
    [FEED_A],
  )
  const result = await provider.getRecentNews(['BTC'], 180)
  assertEquals(result[0]!.externalId, 'rss:feed-a:https://a.example/no-guid')
})
