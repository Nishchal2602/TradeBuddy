import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1'
import {
  buildDecisionIdempotencyKey,
  classifyRunInsertConflict,
  floorToIntervalIso,
  parseTrigger,
  staleRunCutoffIso,
} from './idempotency.ts'

// --- floorToIntervalIso -----------------------------------------------------

Deno.test('floorToIntervalIso: two instants in the same 180-minute bucket floor to the same value', () => {
  const a = floorToIntervalIso('2026-09-22T06:00:00.000Z', 180)
  const b = floorToIntervalIso('2026-09-22T08:59:59.999Z', 180)
  assertEquals(a, b)
  assertEquals(a, '2026-09-22T06:00:00.000Z')
})

Deno.test('floorToIntervalIso: exactly at a bucket boundary floors forward, not back', () => {
  assertEquals(floorToIntervalIso('2026-09-22T09:00:00.000Z', 180), '2026-09-22T09:00:00.000Z')
})

Deno.test('floorToIntervalIso: one millisecond before a boundary stays in the prior bucket', () => {
  assertEquals(floorToIntervalIso('2026-09-22T08:59:59.999Z', 180), '2026-09-22T06:00:00.000Z')
})

// --- buildDecisionIdempotencyKey --------------------------------------------

Deno.test('buildDecisionIdempotencyKey: scheduled — two instants in the same bucket produce the identical key', () => {
  const a = buildDecisionIdempotencyKey('scheduled', '2026-09-22T06:05:00.000Z', 180)
  const b = buildDecisionIdempotencyKey('scheduled', '2026-09-22T08:55:00.000Z', 180)
  assertEquals(a, b)
})

Deno.test('buildDecisionIdempotencyKey: scheduled — adjacent buckets produce different keys', () => {
  const a = buildDecisionIdempotencyKey('scheduled', '2026-09-22T08:59:00.000Z', 180)
  const b = buildDecisionIdempotencyKey('scheduled', '2026-09-22T09:01:00.000Z', 180)
  assertNotEquals(a, b)
})

Deno.test('buildDecisionIdempotencyKey: scheduled — exact literal format, unchanged from the pre-split behavior (regression guard)', () => {
  assertEquals(
    buildDecisionIdempotencyKey('scheduled', '2026-09-22T07:12:34.000Z', 180),
    'decision-2026-09-22T06:00:00.000Z',
  )
})

Deno.test('buildDecisionIdempotencyKey: manual — different milliseconds produce different keys (the actual bug fix)', () => {
  const a = buildDecisionIdempotencyKey('manual', '2026-09-22T07:00:00.000Z', 180)
  const b = buildDecisionIdempotencyKey('manual', '2026-09-22T07:00:00.001Z', 180)
  assertNotEquals(a, b)
})

Deno.test('buildDecisionIdempotencyKey: manual — two clicks inside the SAME 180-minute bucket both get distinct keys', () => {
  const a = buildDecisionIdempotencyKey('manual', '2026-09-22T06:05:00.000Z', 180)
  const b = buildDecisionIdempotencyKey('manual', '2026-09-22T08:55:00.000Z', 180)
  assertNotEquals(a, b)
})

Deno.test('buildDecisionIdempotencyKey: manual — the identical instant produces the identical key (same-instant dedup still works)', () => {
  const a = buildDecisionIdempotencyKey('manual', '2026-09-22T07:00:00.000Z', 180)
  const b = buildDecisionIdempotencyKey('manual', '2026-09-22T07:00:00.000Z', 180)
  assertEquals(a, b)
})

Deno.test('buildDecisionIdempotencyKey: manual and scheduled keys for the same instant are never equal (disjoint namespaces)', () => {
  const nowIso = '2026-09-22T07:12:34.000Z'
  assertNotEquals(
    buildDecisionIdempotencyKey('manual', nowIso, 180),
    buildDecisionIdempotencyKey('scheduled', nowIso, 180),
  )
})

// --- parseTrigger ------------------------------------------------------------

Deno.test('parseTrigger: {trigger: "manual"} -> manual', () => {
  assertEquals(parseTrigger({ trigger: 'manual' }), 'manual')
})

Deno.test('parseTrigger: {trigger: "scheduled"} -> scheduled', () => {
  assertEquals(parseTrigger({ trigger: 'scheduled' }), 'scheduled')
})

Deno.test('parseTrigger: an empty object, null, undefined, and an unrecognized value all default to scheduled — the fail-safe default', () => {
  assertEquals(parseTrigger({}), 'scheduled')
  assertEquals(parseTrigger(null), 'scheduled')
  assertEquals(parseTrigger(undefined), 'scheduled')
  assertEquals(parseTrigger({ trigger: 'something-else' }), 'scheduled')
  assertEquals(parseTrigger('manual'), 'scheduled') // a bare string, not the expected object shape
})

// --- staleRunCutoffIso -------------------------------------------------------

Deno.test('staleRunCutoffIso: exactly 10 minutes before nowIso', () => {
  assertEquals(staleRunCutoffIso('2026-09-22T07:10:00.000Z'), '2026-09-22T07:00:00.000Z')
})

// --- classifyRunInsertConflict -----------------------------------------------

Deno.test('classifyRunInsertConflict: an error naming the mutex index -> already_running, regardless of trigger', () => {
  const msg = 'duplicate key value violates unique constraint "agent_runs_one_running_decision_idx"'
  assertEquals(classifyRunInsertConflict(msg, 'manual'), 'already_running')
  assertEquals(classifyRunInsertConflict(msg, 'scheduled'), 'already_running')
})

Deno.test('classifyRunInsertConflict: an error naming the idempotency-key constraint -> duplicate_tick, regardless of trigger', () => {
  const msg = 'duplicate key value violates unique constraint "agent_runs_idempotency_key_unique"'
  assertEquals(classifyRunInsertConflict(msg, 'manual'), 'duplicate_tick')
  assertEquals(classifyRunInsertConflict(msg, 'scheduled'), 'duplicate_tick')
})

Deno.test('classifyRunInsertConflict: an unrecognized error message falls back to trigger-based inference', () => {
  assertEquals(classifyRunInsertConflict('some other 23505 text', 'manual'), 'already_running')
  assertEquals(classifyRunInsertConflict('some other 23505 text', 'scheduled'), 'duplicate_tick')
})
