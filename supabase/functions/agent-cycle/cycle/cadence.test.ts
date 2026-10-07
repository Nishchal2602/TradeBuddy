import { assertEquals } from 'jsr:@std/assert@1'
import { isCadenceDue } from './cadence.ts'

Deno.test('isCadenceDue: a 60-minute account is due only at the top of the hour', () => {
  assertEquals(isCadenceDue('2026-10-07T15:00:00.000Z', 60), true)
  assertEquals(isCadenceDue('2026-10-07T15:15:00.000Z', 60), false)
  assertEquals(isCadenceDue('2026-10-07T15:30:00.000Z', 60), false)
  assertEquals(isCadenceDue('2026-10-07T15:45:00.000Z', 60), false)
})

Deno.test('isCadenceDue: a 30-minute account is due at :00 and :30', () => {
  assertEquals(isCadenceDue('2026-10-07T15:00:00.000Z', 30), true)
  assertEquals(isCadenceDue('2026-10-07T15:15:00.000Z', 30), false)
  assertEquals(isCadenceDue('2026-10-07T15:30:00.000Z', 30), true)
  assertEquals(isCadenceDue('2026-10-07T15:45:00.000Z', 30), false)
})

Deno.test('isCadenceDue: a 15-minute account is due at every quarter-hour', () => {
  for (const minute of ['00', '15', '30', '45']) {
    assertEquals(isCadenceDue(`2026-10-07T15:${minute}:00.000Z`, 15), true)
  }
})

Deno.test('isCadenceDue: every cadence grid coincides at :00 — the dispatcher\'s own worst-case tick', () => {
  const top = '2026-10-07T16:00:00.000Z'
  assertEquals(isCadenceDue(top, 15), true)
  assertEquals(isCadenceDue(top, 30), true)
  assertEquals(isCadenceDue(top, 60), true)
})

Deno.test('isCadenceDue: the origin is the UTC epoch, not the tick itself — a midnight tick is due for every cadence', () => {
  assertEquals(isCadenceDue('2026-10-08T00:00:00.000Z', 60), true)
})
