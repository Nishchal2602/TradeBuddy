// DT-1 (2026-10-09) — the third of E2's three dependence estimators, and
// E1's own single interval method (plan §6.4g, A7): the stationary block
// bootstrap, with the Politis-White (2004) automatic mean-block-length
// selection algorithm (Stage A sign-off: "the algorithm is frozen now;
// its numeric output computed later, from the real assembled series").
//
// This follows the WIDELY-REPLICATED algorithmic STRUCTURE of Politis &
// White (2004), "Automatic Block-Length Selection for the Dependent
// Bootstrap," Econometric Reviews (with the Patton, Politis & White
// (2009) correction note) -- the same structure implemented in
// reference code used across the empirical-finance literature. It is a
// faithful reproduction of that STRUCTURE (the flat-top lag window, the
// significance-based lag cutoff, the g/D structure constants), not a
// byte-for-byte port of any specific reference implementation -- stated
// plainly per this project's own "stated scope simplification" norm
// (e.g. backtest-engine.ts's own header comment), and verified here
// against the qualitative properties the algorithm MUST have (near-1 for
// white noise, materially larger for a strongly autocorrelated series)
// rather than against a specific reference implementation's output.

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

// Sample autocorrelation at lag k (population-style, dividing by n for
// both numerator and denominator -- the conventional choice for this
// algorithm, consistent with the Newey-West module's own gamma(0)
// convention).
function sampleAutocorrelation(series: readonly number[], lag: number): number {
  const n = series.length
  const xbar = mean(series)
  const dev = series.map((v) => v - xbar)
  let gamma0 = 0
  for (const d of dev) gamma0 += d * d
  gamma0 /= n
  if (gamma0 === 0) return 0
  let gammaK = 0
  for (let i = lag; i < n; i++) gammaK += dev[i]! * dev[i - lag]!
  gammaK /= n
  return gammaK / gamma0
}

// Politis-Romano (1995) trapezoidal "flat-top" lag window.
function flatTopLambda(x: number): number {
  const ax = Math.abs(x)
  if (ax <= 0.5) return 1
  if (ax <= 1) return 2 * (1 - ax)
  return 0
}

export interface PolitisWhiteOptions {
  // The significance multiplier in the lag-cutoff threshold
  // c*sqrt(log10(n)/n) -- 2 is the value used in the original paper and
  // its reference implementations.
  cConstant?: number
}

// The automatic mean block length for the STATIONARY bootstrap
// specifically (the structure constant D differs between the circular
// and stationary bootstrap variants — this function targets the
// stationary one only, matching stationaryBootstrapResample below).
export function politisWhiteBlockLength(series: readonly number[], opts: PolitisWhiteOptions = {}): number {
  const n = series.length
  // Too short for a meaningful automatic selection -- fall back to the
  // most conservative choice (i.i.d. resampling) rather than extrapolate
  // from a handful of points.
  if (n < 10) return 1

  const c = opts.cConstant ?? 2
  const kn = Math.max(5, Math.ceil(Math.sqrt(Math.log10(n))))
  const mMax = Math.ceil(Math.sqrt(n)) + kn
  const bMax = Math.ceil(Math.min(3 * Math.sqrt(n), n / 3))

  const rho: number[] = [1] // rho[0] = 1 by definition; rho[k] for k=1..
  for (let k = 1; k <= mMax + kn; k++) rho.push(sampleAutocorrelation(series, k))

  const threshold = c * Math.sqrt(Math.log10(n) / n)
  let mHat = mMax
  for (let m = 1; m <= mMax; m++) {
    let allInsignificant = true
    for (let j = 0; j < kn; j++) {
      if (Math.abs(rho[m + j] ?? 0) >= threshold) {
        allInsignificant = false
        break
      }
    }
    if (allInsignificant) {
      mHat = m
      break
    }
  }

  const m = Math.min(2 * mHat, mMax)

  let gHat = 0
  let sumLambdaRho = 0
  for (let k = -m; k <= m; k++) {
    const absK = Math.abs(k)
    const r = absK === 0 ? 1 : rho[absK] ?? 0
    const lam = flatTopLambda(k / m)
    gHat += lam * absK * r
    sumLambdaRho += lam * r
  }
  // The stationary bootstrap's own structure constant D_SB (distinct
  // from the circular bootstrap's D).
  const dHatSb = 2 * sumLambdaRho * sumLambdaRho

  if (!(dHatSb > 0) || !Number.isFinite(dHatSb) || !Number.isFinite(gHat)) {
    // Degenerate structure constant (near-white-noise series, or a
    // pathological input) -- fall back to the conventional n^(1/3)
    // default rather than propagate a NaN/Infinity block length.
    return Math.max(1, Math.round(Math.cbrt(n)))
  }

  const bOpt = Math.cbrt((2 * gHat * gHat) / dHatSb) * Math.cbrt(n)
  return Math.max(1, Math.round(Math.min(bOpt, bMax)))
}

// Politis & Romano (1994) stationary bootstrap resampling: starting at a
// uniformly random index, each subsequent point either continues the
// current block (probability 1-p) or restarts at a new uniformly random
// index (probability p), with circular (wraparound) indexing. p =
// 1/meanBlockLength is the geometric-distribution parameter.
export function stationaryBootstrapResample(series: readonly number[], meanBlockLength: number, rng: () => number = Math.random): number[] {
  const n = series.length
  if (n === 0) return []
  const p = 1 / Math.max(meanBlockLength, 1)
  const resampled: number[] = new Array(n)
  let idx = Math.floor(rng() * n)
  for (let i = 0; i < n; i++) {
    resampled[i] = series[idx]!
    idx = rng() < p ? Math.floor(rng() * n) : (idx + 1) % n
  }
  return resampled
}

export interface BootstrapCIResult {
  pointEstimate: number
  ciLower: number
  ciUpper: number
  meanBlockLength: number
  numResamples: number
}

export interface BootstrapOptions {
  numResamples?: number
  alpha?: number
  meanBlockLength?: number // pre-computed, to avoid re-deriving it per call when reused
  rng?: () => number
}

// The stationary-bootstrap percentile CI (plan: "10,000 resamples, 90%
// CI"). Shared by E2's third estimator (statistic = pooled mean R) and
// E1's own single interval method (statistic = annualized Sharpe on the
// daily portfolio-return series) -- the resampling/CI machinery is
// identical; only the statistic function and the input series differ.
export function stationaryBootstrapCI(
  series: readonly number[],
  statistic: (resample: readonly number[]) => number,
  opts: BootstrapOptions = {},
): BootstrapCIResult {
  const numResamples = opts.numResamples ?? 10_000
  const alpha = opts.alpha ?? 0.10
  const meanBlockLength = opts.meanBlockLength ?? politisWhiteBlockLength(series)
  const rng = opts.rng ?? Math.random

  const pointEstimate = statistic(series)
  const resampleStats: number[] = new Array(numResamples)
  for (let i = 0; i < numResamples; i++) {
    resampleStats[i] = statistic(stationaryBootstrapResample(series, meanBlockLength, rng))
  }
  resampleStats.sort((a, b) => a - b)

  const lowerIdx = Math.max(0, Math.floor((alpha / 2) * numResamples))
  const upperIdx = Math.min(numResamples - 1, Math.ceil((1 - alpha / 2) * numResamples) - 1)

  return {
    pointEstimate,
    ciLower: resampleStats[lowerIdx]!,
    ciUpper: resampleStats[upperIdx]!,
    meanBlockLength,
    numResamples,
  }
}
