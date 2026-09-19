import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { callModel, ModelCallError } from './call-model.ts'
import { ModelOutputShapeError } from './gemini-schema.ts'
import type { ModelCallPayload } from './payload.ts'

const PAYLOAD: ModelCallPayload = {
  portfolio: { cash: 10_000, nav: 10_000, constraints: { minConfidence: 0.65, minStopLossPct: 0.005, maxStopLossPct: 0.15, minTakeProfitPct: 0.005, maxTakeProfitPct: 0.5 } },
  assets: [
    {
      asset: 'BTC',
      state: 'FLAT',
      market: { price: 80_000, change1hPct: 0, change24hPct: 1, change7dPct: -2, indicators: { rsi14: 50, ema20: 80_000, ema50: 79_000, macdHistogram: 0, atrPct: 2, volumeRatio: 1, distanceFromSevenDayHighPct: -1, distanceFromSevenDayLowPct: 3 }, recentCloses: [] },
      news: [],
      position: null,
      recentDecisions: [],
      blockedDirections: [],
    },
  ],
}

function stopResponse(text: string, modelVersion = 'gemini-2.5-flash') {
  return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }], modelVersion }), { status: 200 })
}

const VALID_HOLD_JSON = JSON.stringify({
  decisions: [{ asset: 'BTC', action: 'HOLD', confidence: 0.4, stopLossPct: null, takeProfitPct: null, horizonHours: null, reasons: [{ type: 'TECHNICAL', text: 'RSI neutral', newsId: null }], invalidation: [] }],
})

Deno.test('callModel: succeeds on the first key, records keyIndexUsed = 0', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(stopResponse(VALID_HOLD_JSON))
  }) as unknown as typeof fetch

  const result = await callModel(PAYLOAD, ['key1'], fetchImpl)
  assertEquals(calls, 1)
  assertEquals(result.keyIndexUsed, 0)
  assertEquals(result.decisions[0]!.action, 'HOLD')
  assertEquals(result.modelVersion, 'gemini-2.5-flash')
})

Deno.test('callModel: first key gets HTTP 429, rotates to and succeeds on the second', async () => {
  const seenKeys: string[] = []
  const fetchImpl = ((url: string) => {
    const key = new URL(url).searchParams.get('key')!
    seenKeys.push(key)
    if (key === 'key1') return Promise.resolve(new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 }))
    return Promise.resolve(stopResponse(VALID_HOLD_JSON))
  }) as unknown as typeof fetch

  const result = await callModel(PAYLOAD, ['key1', 'key2'], fetchImpl)
  assertEquals(seenKeys, ['key1', 'key2'])
  assertEquals(result.keyIndexUsed, 1)
})

Deno.test('callModel: first key throws a network error, rotates to the third (skipping none)', async () => {
  const seenKeys: string[] = []
  const fetchImpl = ((url: string) => {
    const key = new URL(url).searchParams.get('key')!
    seenKeys.push(key)
    if (key === 'key1') return Promise.reject(new TypeError('fetch failed'))
    if (key === 'key2') return Promise.resolve(new Response('server error', { status: 500 }))
    return Promise.resolve(stopResponse(VALID_HOLD_JSON))
  }) as unknown as typeof fetch

  const result = await callModel(PAYLOAD, ['key1', 'key2', 'key3'], fetchImpl)
  assertEquals(seenKeys, ['key1', 'key2', 'key3'])
  assertEquals(result.keyIndexUsed, 2)
})

Deno.test('callModel: all keys fail -> ModelCallError naming every key\'s own failure reason', async () => {
  const fetchImpl = ((url: string) => {
    const key = new URL(url).searchParams.get('key')!
    return Promise.resolve(new Response(JSON.stringify({ error: { message: `bad key ${key}` } }), { status: 403 }))
  }) as unknown as typeof fetch

  const err = await assertRejects(() => callModel(PAYLOAD, ['key1', 'key2'], fetchImpl), ModelCallError)
  assertEquals((err as ModelCallError).message.includes('key 1'), true)
  assertEquals((err as ModelCallError).message.includes('key 2'), true)
  assertEquals((err as ModelCallError).message.includes('bad key key1'), true)
})

Deno.test('callModel: zero keys throws immediately without calling fetch', async () => {
  let called = false
  const fetchImpl = (() => {
    called = true
    return Promise.resolve(stopResponse(VALID_HOLD_JSON))
  }) as unknown as typeof fetch
  await assertRejects(() => callModel(PAYLOAD, [], fetchImpl), ModelCallError)
  assertEquals(called, false)
})

Deno.test('callModel: a non-STOP finishReason fails immediately, does NOT try the next key', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(new Response(JSON.stringify({ candidates: [{ finishReason: 'SAFETY', content: {} }] }), { status: 200 }))
  }) as unknown as typeof fetch

  await assertRejects(() => callModel(PAYLOAD, ['key1', 'key2'], fetchImpl), ModelCallError)
  assertEquals(calls, 1, 'a content-level failure must not burn a second key')
})

Deno.test('callModel: non-JSON text in an otherwise-STOP response fails immediately, no rotation', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(stopResponse('not valid json{{{'))
  }) as unknown as typeof fetch

  await assertRejects(() => callModel(PAYLOAD, ['key1', 'key2'], fetchImpl), ModelCallError)
  assertEquals(calls, 1)
})

Deno.test('callModel: a schema-shape failure (ModelOutputShapeError) propagates untouched and does not rotate', async () => {
  let calls = 0
  const wrongAssetJson = JSON.stringify({
    decisions: [{ asset: 'ETH', action: 'HOLD', confidence: 0.4, stopLossPct: null, takeProfitPct: null, horizonHours: null, reasons: [], invalidation: [] }],
  })
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(stopResponse(wrongAssetJson))
  }) as unknown as typeof fetch

  await assertRejects(() => callModel(PAYLOAD, ['key1', 'key2'], fetchImpl), ModelOutputShapeError)
  assertEquals(calls, 1)
})
