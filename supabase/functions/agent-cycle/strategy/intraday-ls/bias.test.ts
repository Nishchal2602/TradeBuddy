import { assertEquals } from 'jsr:@std/assert@1'
import { evaluateBias, evaluateH4Trend } from './bias.ts'

const DAY = 86_400_000

function dailySeries(closes: number[], endIso = '2026-09-21T00:00:00.000Z'): { timestamp: string; close: number }[] {
  const end = new Date(endIso).getTime()
  return closes.map((close, i) => ({
    timestamp: new Date(end - (closes.length - 1 - i) * DAY).toISOString(),
    close,
  }))
}

const UP_DAILY = dailySeries(Array.from({ length: 50 }, (_, i) => 80 + i)) // regime UP (mean 104.5, last 129)
const DOWN_DAILY = dailySeries(Array.from({ length: 50 }, (_, i) => 129 - i)) // regime DOWN (mean 104.5, last 80)
const RISING_H4 = Array.from({ length: 50 }, (_, i) => 80 + i) // EMA20 > EMA50 (h4Up)
const FALLING_H4 = Array.from({ length: 50 }, (_, i) => 129 - i) // EMA20 < EMA50 (!h4Up)

Deno.test('evaluateBias: regime UP + h4 up -> LONG', () => {
  assertEquals(evaluateBias(UP_DAILY, RISING_H4), 'LONG')
})

Deno.test('evaluateBias: regime DOWN + h4 down -> SHORT', () => {
  assertEquals(evaluateBias(DOWN_DAILY, FALLING_H4), 'SHORT')
})

Deno.test('evaluateBias: regime UP but h4 down (disagreement) -> NEUTRAL', () => {
  assertEquals(evaluateBias(UP_DAILY, FALLING_H4), 'NEUTRAL')
})

Deno.test('evaluateBias: regime DOWN but h4 up (disagreement) -> NEUTRAL', () => {
  assertEquals(evaluateBias(DOWN_DAILY, RISING_H4), 'NEUTRAL')
})

Deno.test('evaluateBias: fewer than 50 closed daily bars fails closed (null), never guesses', () => {
  const shortDaily = dailySeries(Array.from({ length: 49 }, () => 100))
  assertEquals(evaluateBias(shortDaily, RISING_H4), null)
})

Deno.test('evaluateBias: fewer than 50 closed 4h bars fails closed (null), even with a valid daily regime', () => {
  const shortH4 = RISING_H4.slice(0, 49)
  assertEquals(evaluateBias(UP_DAILY, shortH4), null)
})

Deno.test('evaluateBias: exactly 50 daily and 50 4h closes is valid (boundary inclusive)', () => {
  assertEquals(evaluateBias(UP_DAILY, RISING_H4), 'LONG')
  assertEquals(UP_DAILY.length, 50)
  assertEquals(RISING_H4.length, 50)
})

// --- evaluateH4Trend (CFG-1 Stage 2 P3, 2026-10-08, additive) --------------

Deno.test('evaluateH4Trend: EMA20 > EMA50 -> "Up"', () => {
  assertEquals(evaluateH4Trend(RISING_H4), 'Up')
})

Deno.test('evaluateH4Trend: EMA20 < EMA50 -> "Down"', () => {
  assertEquals(evaluateH4Trend(FALLING_H4), 'Down')
})

Deno.test('evaluateH4Trend: fewer than MIN_H4_CLOSES (50) fails closed (null), same floor as evaluateBias\'s own 4h leg', () => {
  assertEquals(evaluateH4Trend(RISING_H4.slice(0, 49)), null)
})

Deno.test('evaluateH4Trend: agrees with evaluateBias\'s own internal 4h leg on every bias fixture in this file', () => {
  // Cross-check, not a duplicate: evaluateBias is untouched by this
  // addition, so its resolved bias and this function's own leg must
  // never silently diverge.
  assertEquals(evaluateH4Trend(RISING_H4), 'Up')
  assertEquals(evaluateBias(UP_DAILY, RISING_H4), 'LONG') // UP regime + Up 4h -> LONG, confirming the Up leg
  assertEquals(evaluateH4Trend(FALLING_H4), 'Down')
  assertEquals(evaluateBias(DOWN_DAILY, FALLING_H4), 'SHORT') // DOWN regime + Down 4h -> SHORT, confirming the Down leg
})
