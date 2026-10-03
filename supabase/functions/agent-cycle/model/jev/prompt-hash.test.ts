import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1'
import { hashPromptContent } from './prompt-hash.ts'

Deno.test('hashPromptContent: deterministic — identical input produces identical output', async () => {
  const a = await hashPromptContent(['Does the news contain a material event?', 'hack, exploit, ban'])
  const b = await hashPromptContent(['Does the news contain a material event?', 'hack, exploit, ban'])
  assertEquals(a, b)
})

Deno.test('hashPromptContent: a one-character wording change produces a different hash — the drift-detection property itself', async () => {
  const original = await hashPromptContent(['Does the news contain a material event?'])
  const oneCharChanged = await hashPromptContent(['Does the news contain a material event? '])
  assertNotEquals(original, oneCharChanged)
})

Deno.test('hashPromptContent: sensitive to ORDER, not just content — two parts swapped must hash differently', async () => {
  const a = await hashPromptContent(['long criteria text', 'short criteria text'])
  const b = await hashPromptContent(['short criteria text', 'long criteria text'])
  assertNotEquals(a, b)
})

Deno.test('hashPromptContent: a 64-char lowercase hex digest (SHA-256), matching the format evaluation_id will later compose with', async () => {
  const hash = await hashPromptContent(['anything'])
  assertEquals(hash.length, 64)
  assertEquals(/^[0-9a-f]{64}$/.test(hash), true)
})

Deno.test('hashPromptContent: empty input is well-defined, not a throw — a module with no branches still has a fingerprint', async () => {
  const hash = await hashPromptContent([])
  assertEquals(typeof hash, 'string')
  assertEquals(hash.length, 64)
})
