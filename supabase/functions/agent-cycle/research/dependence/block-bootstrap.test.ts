import { assertEquals } from 'jsr:@std/assert@1'
import { politisWhiteBlockLength, stationaryBootstrapCI, stationaryBootstrapResample } from './block-bootstrap.ts'

// A tiny deterministic PRNG (mulberry32) so every test here is
// reproducible -- Math.random() is the production default but would
// make these tests flaky/non-reproducible.
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function whiteNoise(n: number, seed: number): number[] {
  const rng = mulberry32(seed)
  return Array.from({ length: n }, () => rng() * 2 - 1)
}

// A persistent AR(1) series: x_t = phi*x_{t-1} + noise, phi close to 1 ->
// strong positive autocorrelation.
function ar1(n: number, phi: number, seed: number): number[] {
  const rng = mulberry32(seed)
  const x: number[] = [0]
  for (let i = 1; i < n; i++) x.push(phi * x[i - 1]! + (rng() * 2 - 1))
  return x
}

// --- politisWhiteBlockLength ---------------------------------------------

Deno.test('politisWhiteBlockLength: a series shorter than 10 points falls back to 1 (iid resampling)', () => {
  assertEquals(politisWhiteBlockLength([1, 2, 3]), 1)
})

Deno.test('politisWhiteBlockLength: white noise produces a small block length', () => {
  const b = politisWhiteBlockLength(whiteNoise(300, 1))
  if (!(b <= 5)) throw new Error(`expected a small block length for white noise, got ${b}`)
})

Deno.test('politisWhiteBlockLength: a strongly persistent AR(1) series (phi=0.9) produces a materially larger block length than white noise', () => {
  const bWhite = politisWhiteBlockLength(whiteNoise(300, 1))
  const bPersistent = politisWhiteBlockLength(ar1(300, 0.9, 1))
  if (!(bPersistent > bWhite)) throw new Error(`expected persistent (${bPersistent}) > white noise (${bWhite})`)
})

Deno.test('politisWhiteBlockLength: block length increases with the AR(1) coefficient (more persistence -> longer blocks)', () => {
  const bLow = politisWhiteBlockLength(ar1(400, 0.3, 2))
  const bHigh = politisWhiteBlockLength(ar1(400, 0.9, 2))
  if (!(bHigh >= bLow)) throw new Error(`expected higher-phi block length (${bHigh}) >= lower-phi (${bLow})`)
})

Deno.test('politisWhiteBlockLength: never returns less than 1, never NaN/Infinity, for a constant (zero-variance) series', () => {
  const b = politisWhiteBlockLength(new Array(50).fill(5))
  assertEquals(Number.isFinite(b), true)
  if (!(b >= 1)) throw new Error(`expected b >= 1, got ${b}`)
})

// --- stationaryBootstrapResample ------------------------------------------

Deno.test('stationaryBootstrapResample: output length always equals input length', () => {
  const series = [1, 2, 3, 4, 5, 6, 7]
  const result = stationaryBootstrapResample(series, 3, mulberry32(42))
  assertEquals(result.length, series.length)
})

Deno.test('stationaryBootstrapResample: empty input produces empty output', () => {
  assertEquals(stationaryBootstrapResample([], 3), [])
})

Deno.test('stationaryBootstrapResample: a fake rng that never restarts a block reproduces a circular shift of the original series', () => {
  const series = [10, 20, 30, 40, 50]
  // First call (start index) returns 0.41 -> floor(0.41*5)=2. Every
  // subsequent call returns 0.99, which is always >= p (p=1/anything<=1
  // for a sane block length), so the block never restarts.
  let first = true
  const fakeRng = () => {
    if (first) {
      first = false
      return 0.41
    }
    return 0.99
  }
  const result = stationaryBootstrapResample(series, 10, fakeRng)
  // Starting at index 2, circularly: [30, 40, 50, 10, 20]
  assertEquals(result, [30, 40, 50, 10, 20])
})

Deno.test('stationaryBootstrapResample: every resampled value comes from the original series (no fabricated values)', () => {
  const series = [1, 2, 3, 4, 5]
  const result = stationaryBootstrapResample(series, 2, mulberry32(7))
  for (const v of result) {
    if (!series.includes(v)) throw new Error(`resampled value ${v} not in original series`)
  }
})

// --- stationaryBootstrapCI -----------------------------------------------

Deno.test('stationaryBootstrapCI: a constant series produces a degenerate CI exactly at that constant (every resample is identical)', () => {
  const series = new Array(50).fill(7)
  const result = stationaryBootstrapCI(series, (xs) => xs.reduce((a, b) => a + b, 0) / xs.length, {
    numResamples: 200,
    rng: mulberry32(1),
  })
  assertEquals(result.pointEstimate, 7)
  assertEquals(result.ciLower, 7)
  assertEquals(result.ciUpper, 7)
})

Deno.test('stationaryBootstrapCI: CI is well-ordered (lower <= point <= upper) on a generic series with real variance', () => {
  const series = whiteNoise(100, 3)
  const result = stationaryBootstrapCI(series, (xs) => xs.reduce((a, b) => a + b, 0) / xs.length, {
    numResamples: 500,
    rng: mulberry32(9),
  })
  if (!(result.ciLower <= result.pointEstimate && result.pointEstimate <= result.ciUpper)) {
    throw new Error(`expected ciLower <= point <= ciUpper, got [${result.ciLower}, ${result.pointEstimate}, ${result.ciUpper}]`)
  }
})

Deno.test('stationaryBootstrapCI: echoes back the supplied meanBlockLength and numResamples', () => {
  const series = whiteNoise(50, 5)
  const result = stationaryBootstrapCI(series, (xs) => xs[0]!, { numResamples: 123, meanBlockLength: 4, rng: mulberry32(2) })
  assertEquals(result.meanBlockLength, 4)
  assertEquals(result.numResamples, 123)
})

Deno.test('stationaryBootstrapCI: a larger sample size produces a tighter CI around the true mean, for the same underlying variance', () => {
  const small = whiteNoise(30, 11)
  const large = whiteNoise(3000, 11)
  const smallResult = stationaryBootstrapCI(small, (xs) => xs.reduce((a, b) => a + b, 0) / xs.length, { numResamples: 500, rng: mulberry32(20) })
  const largeResult = stationaryBootstrapCI(large, (xs) => xs.reduce((a, b) => a + b, 0) / xs.length, { numResamples: 500, rng: mulberry32(20) })
  const smallWidth = smallResult.ciUpper - smallResult.ciLower
  const largeWidth = largeResult.ciUpper - largeResult.ciLower
  if (!(largeWidth < smallWidth)) throw new Error(`expected large-n CI (${largeWidth}) narrower than small-n CI (${smallWidth})`)
})
