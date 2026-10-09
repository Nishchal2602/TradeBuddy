// DT-1 (2026-10-09, Order-of-Work step 5) — the power simulation's data-
// generating process (plan §6.7b): "Simulate at the trade level... with a
// known true annualized Sharpe, at the realistic length and dependence
// structure the real universe will actually have."
//
// STATED SIMPLIFICATION, documented plainly (the same discipline this
// project applies everywhere a research engine's fidelity is bounded,
// e.g. backtest-engine.ts's own header comment): E1's daily portfolio-
// return series and E2's trade population are generated as TWO
// separately-parameterized but IDENTICALLY-CALIBRATED processes (both
// targeting the same true annualized Sharpe and rho-bar), rather than one
// bottom-up multi-sleeve price-path simulator that trades are carved out
// of. A fully coherent single price-path simulator would mean
// re-implementing R4's own signal-generation engine inside the power
// simulation -- a materially larger, riskier undertaking than what a
// power simulation is actually for (characterizing the STATISTICAL
// ESTIMATORS' behavior under known ground truth, not re-deriving the
// strategy's own mechanics). Cross-sleeve/cross-trade correlation is
// still genuinely modeled in both tracks (an equicorrelation factor model
// for the daily series; a shared monthly common-factor shock for trades
// closing in the same month), so the dependence structure E2's three
// estimators need to detect is real, not absent.

export interface MeasuredTradeMoments {
  n: number
  mean: number
  sd: number
  skewness: number
  excessKurtosis: number
  standardizedRValues: number[]
  meanHoldingDays: number
  medianHoldingDays: number
  holdingDaysValues: number[]
}

export interface MeasuredInputs {
  tradeMoments: MeasuredTradeMoments
  perSleeveDailyVolatility: { medianLogReturnSd: number; assetsSampled: number }
}

export interface Scenario {
  rhoBar: number
  trueAnnualizedSharpe: number
}

const TRADING_DAYS_PER_YER = 365 // crypto trades every day -- confirmed in dt1-universe-measurements-2026-10-09.md (T measured in calendar days, zero gaps)

function pickOne<T>(xs: readonly T[], rng: () => number): T {
  return xs[Math.floor(rng() * xs.length)]!
}

// A single standardized (mean~0 across the source array by construction)
// draw from a resampled empirical shape -- used for both the daily-return
// shocks and the trade-R shocks, preserving R4's own measured skew/
// kurtosis rather than assuming Gaussian shocks.
export function drawShock(shape: readonly number[], rng: () => number): number {
  if (shape.length === 0) return 0
  return pickOne(shape, rng)
}

// --- E1: the daily equal-weight portfolio return series -------------------
//
// Equicorrelation factor model: sleeve_i,t = mu + sqrt(rhoBar)*sigma*common_t
// + sqrt(1-rhoBar)*sigma*idio_i,t. The equal-weight portfolio return is the
// mean over active sleeves, which (since idiosyncratic shocks are
// independent across sleeves) has variance sigma^2*(rhoBar + (1-rhoBar)/n)
// -- the standard equicorrelation portfolio-variance identity. Computed
// DIRECTLY per day (never materializing n individual sleeve series) for
// speed: a single idiosyncratic draw scaled by sqrt((1-rhoBar)/n) is
// statistically equivalent in variance to averaging n iid idiosyncratic
// draws (a stated approximation -- see this module's own header comment;
// verified empirically in this module's test file by actually generating
// many individual sleeves and checking the realized pairwise correlation
// and realized Sharpe both land close to their targets).
export function simulatePortfolioDailyReturnsOverTrajectory(
  nByDay: readonly number[],
  muDaily: number,
  sigmaDaily: number,
  rhoBar: number,
  shape: readonly number[],
  rng: () => number,
): number[] {
  const series: number[] = new Array(nByDay.length)
  for (let t = 0; t < nByDay.length; t++) {
    const n = Math.max(nByDay[t]!, 1)
    const common = drawShock(shape, rng)
    const idio = drawShock(shape, rng)
    series[t] = muDaily + Math.sqrt(rhoBar) * sigmaDaily * common + Math.sqrt((1 - rhoBar) / n) * sigmaDaily * idio
  }
  return series
}

// Lower-level, TESTABLE sleeve-by-sleeve generator (not used on the
// production grid-sweep path, which uses the aggregate formula above for
// speed) -- exists specifically to empirically verify the equicorrelation
// construction's realized pairwise correlation and realized portfolio
// Sharpe both land close to their intended targets.
export function simulateSleeveDailyReturns(
  n: number,
  days: number,
  muDaily: number,
  sigmaDaily: number,
  rhoBar: number,
  shape: readonly number[],
  rng: () => number,
): number[][] {
  const sleeves: number[][] = Array.from({ length: n }, () => new Array(days))
  for (let t = 0; t < days; t++) {
    const common = drawShock(shape, rng)
    for (let i = 0; i < n; i++) {
      const idio = drawShock(shape, rng)
      sleeves[i]![t] = muDaily + Math.sqrt(rhoBar) * sigmaDaily * common + Math.sqrt(1 - rhoBar) * sigmaDaily * idio
    }
  }
  return sleeves
}

// Solves for the daily per-sleeve mean that makes the EQUAL-WEIGHT
// PORTFOLIO's annualized Sharpe equal the target, at a given (mature,
// steady-state) sleeve count -- the calibration point for E1's series
// construction. Portfolio daily sd = sigmaDaily*sqrt(rhoBar+(1-rhoBar)/n);
// annualizedSharpe = (muDaily/portfolioSd)*sqrt(365) => muDaily =
// annualizedSharpe*portfolioSd/sqrt(365).
export function solveDailyMeanForTargetSharpe(trueAnnualizedSharpe: number, sigmaDaily: number, rhoBar: number, matureN: number): number {
  const portfolioSd = sigmaDaily * Math.sqrt(rhoBar + (1 - rhoBar) / matureN)
  return (trueAnnualizedSharpe * portfolioSd) / Math.sqrt(TRADING_DAYS_PER_YER)
}

// --- E2: the synthetic trade population -------------------------------
//
// AnnualizedSharpe ~= sqrt(tradesPerYear) * (meanR/sdR) -- the standard
// "Sharpe scales with sqrt(frequency)" identity applied at the trade
// level (the same relationship that annualizes a daily Sharpe by
// sqrt(365)), under the simplifying assumption that trades are
// approximately independent units of risk-taking BEFORE the shared
// monthly factor below re-introduces real cross-sleeve dependence.
// Solving for the target per-trade mean given R4's own measured sd:
//   meanR_target = trueAnnualizedSharpe * sdR / sqrt(tradesPerYear)
export function solveTradeMeanRForTargetSharpe(trueAnnualizedSharpe: number, sdR: number, tradesPerYear: number): number {
  if (tradesPerYear <= 0) return 0
  return (trueAnnualizedSharpe * sdR) / Math.sqrt(tradesPerYear)
}

export interface SimulatedTrade {
  openedAt: string
  closedAt: string
  r: number
}

export interface TradePopulationOptions {
  fromMonth: string // YYYY-MM
  nTrajectoryByMonth: ReadonlyMap<string, number> // formation month -> realized N
  tradesPerSleevePerMonth: number // measured from R4 (e.g. 352/(2*103))
  tradeMoments: MeasuredTradeMoments
  rhoBar: number
  trueAnnualizedSharpe: number
  matureN: number // the steady-state N used for calibration, e.g. 20
  rng: () => number
}

// Generates a synthetic trade population month by month, using the REAL
// measured N(t) trajectory: expected trade count each month scales with
// that month's realized N. Each trade's R combines an idiosyncratic shock
// with a SHARED MONTHLY common-factor shock (all trades closing in the
// same month partially share one draw), inducing genuine cross-trade
// dependence at strength rhoBar -- giving the ICC/Newey-West/bootstrap
// estimators real structure to detect, not an artificially independent
// population. Holding periods are resampled directly from R4's own
// empirical distribution (plan: realistic length AND dependence
// structure) rather than assumed parametric.
export function simulateTradePopulation(opts: TradePopulationOptions): SimulatedTrade[] {
  const tradesPerYear = opts.tradesPerSleevePerMonth * 12 * opts.matureN
  const meanRTarget = solveTradeMeanRForTargetSharpe(opts.trueAnnualizedSharpe, opts.tradeMoments.sd, tradesPerYear)
  const sd = opts.tradeMoments.sd

  const trades: SimulatedTrade[] = []
  for (const [month, n] of opts.nTrajectoryByMonth) {
    const expectedTrades = opts.tradesPerSleevePerMonth * n
    // Poisson-like count via rounding a jittered expectation -- simple and
    // adequate for a count whose own realistic variability does not need
    // to be exactly Poisson-distributed to serve this simulation's
    // purpose (characterizing the estimators, not the trade-count
    // process itself).
    const jitter = (opts.rng() - 0.5) * Math.sqrt(Math.max(expectedTrades, 0))
    const tradeCount = Math.max(0, Math.round(expectedTrades + jitter))
    if (tradeCount === 0) continue

    const commonShock = drawShock(opts.tradeMoments.standardizedRValues, opts.rng)
    for (let i = 0; i < tradeCount; i++) {
      const idioShock = drawShock(opts.tradeMoments.standardizedRValues, opts.rng)
      const standardized = Math.sqrt(opts.rhoBar) * commonShock + Math.sqrt(1 - opts.rhoBar) * idioShock
      const r = standardized * sd + meanRTarget

      const holdingDays = Math.max(1, pickOne(opts.tradeMoments.holdingDaysValues, opts.rng))
      // Spread trades through the month (day 1-28, avoiding month-length
      // edge cases) rather than piling every trade onto the 1st.
      const day = 1 + Math.floor(opts.rng() * 27)
      const openedAt = `${month}-${String(day).padStart(2, '0')}T00:00:00.000Z`
      const closedAtMs = new Date(openedAt).getTime() + holdingDays * 86_400_000
      trades.push({ openedAt, closedAt: new Date(closedAtMs).toISOString(), r })
    }
  }
  return trades
}
