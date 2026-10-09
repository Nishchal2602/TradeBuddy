// DT-1 (2026-10-09) — Student-t distribution numerics, needed for the
// Newey-West E2 estimator's confidence interval (plan §6.4h: "a
// Student-t reference with T-1 degrees of freedom, not a Normal
// approximation"). Self-contained rather than importing stats.ts's own
// private inverseNormalCdf/erf pair — that module's own comment states
// those are "never exposed as a general statistics API," and duplicating
// a few lines of a well-known, standard numerical kernel is preferable
// to coupling two otherwise-unrelated modules for it.
//
// No external numerics library exists in this codebase (matching the
// project's own "pure code only" convention throughout research/) — the
// incomplete beta function (continued-fraction form) is the standard
// textbook algorithm (e.g. Numerical Recipes §6.4's betacf/betai), and
// the t-quantile is obtained by bisecting the (monotonic) CDF rather
// than a closed-form inversion, which is simple and numerically robust
// for any degrees of freedom.

function logGamma(x: number): number {
  // Lanczos approximation, g=7, n=9 — standard, ~15-digit accuracy.
  const g = 7
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (x < 0.5) {
    // Reflection formula.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  }
  const xx = x - 1
  let a = coefficients[0]!
  const t = xx + g + 0.5
  for (let i = 1; i < g + 2; i++) a += coefficients[i]! / (xx + i)
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a)
}

// Regularized incomplete beta function I_x(a, b), via the standard
// continued-fraction evaluation (Numerical Recipes' betacf), valid for
// x in [0, 1].
function betaContinuedFraction(x: number, a: number, b: number): number {
  const MAX_ITER = 200
  const EPS = 3e-10
  const FPMIN = 1e-300

  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d

  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const logBt = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  const bt = Math.exp(logBt)
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaContinuedFraction(x, a, b)) / a
  }
  return 1 - (bt * betaContinuedFraction(1 - x, b, a)) / b
}

// P(T <= t) for a Student-t distribution with `df` degrees of freedom.
export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0
  const x = df / (df + t * t)
  const ib = regularizedIncompleteBeta(x, df / 2, 0.5)
  return t > 0 ? 1 - 0.5 * ib : 0.5 * ib
}

// The two-sided critical value t* such that P(-t* <= T <= t*) = 1 - alpha
// (e.g. alpha=0.10 -> the 90% two-sided critical value), found by
// bisecting the (monotonic, continuous) CDF. Converges in ~60 iterations
// to well beyond the precision this module needs.
export function studentTCriticalValue(alpha: number, df: number): number {
  const targetUpperTail = 1 - alpha / 2
  if (df <= 0) throw new Error(`studentTCriticalValue: df must be positive, got ${df}`)
  let lo = 0
  let hi = 1
  // Expand hi until the CDF at hi exceeds the target (always terminates:
  // the t-CDF -> 1 as t -> infinity).
  while (studentTCdf(hi, df) < targetUpperTail) hi *= 2
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (studentTCdf(mid, df) < targetUpperTail) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}
