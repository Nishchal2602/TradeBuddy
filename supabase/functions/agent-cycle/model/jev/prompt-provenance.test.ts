import { assertEquals } from 'jsr:@std/assert@1'
import { jevQuestionPromptFingerprint, JEV_QUESTION_VERSION } from './question.ts'
import { managementQuestionPromptFingerprint, MANAGEMENT_QUESTION_VERSION } from './management-question.ts'
import { entryQuestionPromptFingerprint, ENTRY_QUESTION_VERSION } from './entry-question.ts'
import { adversarialQuestionPromptFingerprint, ADVERSARIAL_QUESTION_VERSION } from './adversarial-question.ts'

// Tier 0 provenance (2026-10-03, plan §6B P0 item 1) — binds every
// hand-maintained *_QUESTION_VERSION string to a content hash of the
// prompt text it actually describes. This is the test that makes drift
// impossible to ship silently: it has already happened twice —
// MANAGEMENT_QUESTION_VERSION was not bumped when ADD was disabled for
// intraday_ls (caught a day later, by chance); strategy_version drifted
// to a 'v3.1' value that was never shipped.
//
// KNOWN_GOOD is keyed by the CURRENT version string, not recomputed —
// this is deliberate. It means two different ways to drift both fail
// loudly, by construction:
//
//   1. Wording changes, version string is NOT bumped: the lookup key is
//      unchanged, but the freshly-computed fingerprint no longer matches
//      the pinned value under that key. FAILS.
//   2. Wording changes, version string IS bumped: the lookup key changes
//      to a version with no entry in KNOWN_GOOD at all. FAILS, forcing a
//      human to deliberately add the new pinned hash rather than having
//      it silently accepted — exactly the kind of conscious, reviewed
//      step JEV_MODEL_ID's own comment already asks for on a model bump.
//
// To intentionally update a pinned hash after a deliberate wording
// change: run the corresponding *PromptFingerprint() function, read the
// printed value, and paste it in below next to the NEW version string.
// Never update a hash to make this test pass without reading the actual
// wording diff first — that is precisely the failure mode this test
// exists to catch.
const KNOWN_GOOD: Record<string, string> = {
  [JEV_QUESTION_VERSION]: 'a7f9522b370692bf580d0b713ac383c31f3a03b4877afd6a4b30e71e2c8d8448',
  [MANAGEMENT_QUESTION_VERSION]: 'c9ceae348e5b91743cc9f98ecd0640180a74b6cb6e0d1265d12d9a7de1195ec5',
  [ENTRY_QUESTION_VERSION]: '4689c9e95ed89d5dc631b58612dbee18dfb63a127a4a087cc6a000829a1984ce',
  [ADVERSARIAL_QUESTION_VERSION]: '8db082c30fe5cebb2c7f3ebd470ee0be44c7927e3b073e595124f98c2f0126ae',
}

Deno.test('provenance: JEV_QUESTION_VERSION is pinned to a content hash of its actual rendered prompt text', async () => {
  const fingerprint = await jevQuestionPromptFingerprint()
  assertEquals(fingerprint, KNOWN_GOOD[JEV_QUESTION_VERSION], 'veto prompt text changed without a corresponding, deliberate pinned-hash update — see this file\'s own header comment')
})

Deno.test('provenance: MANAGEMENT_QUESTION_VERSION is pinned to a content hash of its actual rendered prompt text', async () => {
  const fingerprint = await managementQuestionPromptFingerprint()
  assertEquals(fingerprint, KNOWN_GOOD[MANAGEMENT_QUESTION_VERSION], 'management prompt text changed without a corresponding, deliberate pinned-hash update — see this file\'s own header comment')
})

Deno.test('provenance: ENTRY_QUESTION_VERSION is pinned to a content hash of its actual rendered prompt text', async () => {
  const fingerprint = await entryQuestionPromptFingerprint()
  assertEquals(fingerprint, KNOWN_GOOD[ENTRY_QUESTION_VERSION], 'entry prompt text changed without a corresponding, deliberate pinned-hash update — see this file\'s own header comment')
})

Deno.test('provenance: ADVERSARIAL_QUESTION_VERSION is pinned to a content hash of its actual rendered prompt text', async () => {
  const fingerprint = await adversarialQuestionPromptFingerprint()
  assertEquals(fingerprint, KNOWN_GOOD[ADVERSARIAL_QUESTION_VERSION], 'adversarial prompt text changed without a corresponding, deliberate pinned-hash update — see this file\'s own header comment')
})

Deno.test('provenance: all four version strings are distinct keys in KNOWN_GOOD — a version collision would silently compare the wrong module against the wrong hash', () => {
  const keys = [JEV_QUESTION_VERSION, MANAGEMENT_QUESTION_VERSION, ENTRY_QUESTION_VERSION, ADVERSARIAL_QUESTION_VERSION]
  assertEquals(new Set(keys).size, keys.length)
})
