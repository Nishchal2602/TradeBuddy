import { assertAlmostEquals } from 'jsr:@std/assert@1'
import { studentTCdf, studentTCriticalValue } from './student-t.ts'

// Known two-sided 90% critical values (alpha=0.10), from standard
// statistics tables -- this is the exact use case the Newey-West E2
// estimator needs (plan §6.4h's own alpha=0.10 convention).
const KNOWN_90_PCT_TWO_SIDED: [number, number][] = [
  [1, 6.314],
  [5, 2.015],
  [10, 1.812],
  [20, 1.725],
  [30, 1.697],
  [60, 1.671],
  [100, 1.660],
  [120, 1.658],
]

for (const [df, expected] of KNOWN_90_PCT_TWO_SIDED) {
  Deno.test(`studentTCriticalValue: df=${df}, alpha=0.10 matches the textbook table value`, () => {
    const actual = studentTCriticalValue(0.10, df)
    assertAlmostEquals(actual, expected, 0.01)
  })
}

Deno.test('studentTCriticalValue: converges toward the normal z-value (1.6449) as df grows large', () => {
  const actual = studentTCriticalValue(0.10, 10_000)
  assertAlmostEquals(actual, 1.6449, 0.005)
})

Deno.test('studentTCriticalValue: a smaller alpha (wider interval) always produces a larger critical value at fixed df', () => {
  const wide = studentTCriticalValue(0.01, 30)
  const narrow = studentTCriticalValue(0.10, 30)
  if (!(wide > narrow)) throw new Error(`expected wide (${wide}) > narrow (${narrow})`)
})

Deno.test('studentTCdf: symmetric around zero', () => {
  assertAlmostEquals(studentTCdf(1.5, 20), 1 - studentTCdf(-1.5, 20), 1e-9)
})

Deno.test('studentTCdf: at t=0, CDF is exactly 0.5 for any df', () => {
  for (const df of [1, 5, 30, 500]) {
    assertAlmostEquals(studentTCdf(0, df), 0.5, 1e-9)
  }
})

Deno.test('studentTCdf: approaches 1 for large positive t, 0 for large negative t', () => {
  assertAlmostEquals(studentTCdf(50, 10), 1, 1e-6)
  assertAlmostEquals(studentTCdf(-50, 10), 0, 1e-6)
})
