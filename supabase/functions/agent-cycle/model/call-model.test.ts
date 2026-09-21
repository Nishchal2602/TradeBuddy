import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { callModel, ModelCallError } from './call-model.ts'
import { ModelOutputShapeError } from './gemini-schema.ts'
import type { VetoCallPayload } from './payload.ts'

const PAYLOAD: VetoCallPayload = {
  candidates: [
    {
      asset: 'BTC',
      regime: { dailyClose: 82_000, dailyMa: 78_000 },
      stopLossPct: 0.025,
      takeProfitPct: 0.15,
      news: [],
    },
  ],
}

function stopResponse(text: string, modelVersion = 'gemini-3.6-flash') {
  return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }], modelVersion }), { status: 200 })
}

const VALID_VERDICT_JSON = JSON.stringify({
  verdicts: [{ asset: 'BTC', veto: false, rationale: 'no news provided' }],
})

Deno.test('callModel: succeeds on the first key, records keyIndexUsed = 0', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(stopResponse(VALID_VERDICT_JSON))
  }) as unknown as typeof fetch

  const result = await callModel(PAYLOAD, ['key1'], fetchImpl)
  assertEquals(calls, 1)
  assertEquals(result.keyIndexUsed, 0)
  assertEquals(result.verdicts[0]!.asset, 'BTC')
  assertEquals(result.verdicts[0]!.veto, false)
  assertEquals(result.modelVersion, 'gemini-3.6-flash')
})

Deno.test('callModel: first key gets HTTP 429, rotates to and succeeds on the second', async () => {
  const seenKeys: string[] = []
  const fetchImpl = ((url: string) => {
    const key = new URL(url).searchParams.get('key')!
    seenKeys.push(key)
    if (key === 'key1') return Promise.resolve(new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 }))
    return Promise.resolve(stopResponse(VALID_VERDICT_JSON))
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
    return Promise.resolve(stopResponse(VALID_VERDICT_JSON))
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
    return Promise.resolve(stopResponse(VALID_VERDICT_JSON))
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
    verdicts: [{ asset: 'ETH', veto: false, rationale: 'no news provided' }],
  })
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(stopResponse(wrongAssetJson))
  }) as unknown as typeof fetch

  await assertRejects(() => callModel(PAYLOAD, ['key1', 'key2'], fetchImpl), ModelOutputShapeError)
  assertEquals(calls, 1)
})

Deno.test('callModel: a batched call with multiple candidates sends exactly one request, not one per candidate', async () => {
  let calls = 0
  const twoCandidatePayload: VetoCallPayload = {
    candidates: [
      { asset: 'BTC', regime: { dailyClose: 82_000, dailyMa: 78_000 }, stopLossPct: 0.025, takeProfitPct: 0.15, news: [] },
      { asset: 'ETH', regime: { dailyClose: 2_500, dailyMa: 2_400 }, stopLossPct: 0.03, takeProfitPct: 0.18, news: [] },
    ],
  }
  const bothVerdicts = JSON.stringify({
    verdicts: [
      { asset: 'BTC', veto: false, rationale: 'no news provided' },
      { asset: 'ETH', veto: true, rationale: 'exchange hack reported' },
    ],
  })
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(stopResponse(bothVerdicts))
  }) as unknown as typeof fetch

  const result = await callModel(twoCandidatePayload, ['key1'], fetchImpl)
  assertEquals(calls, 1)
  assertEquals(result.verdicts.length, 2)
})
