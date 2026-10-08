import type { CloseReason, Direction } from '../../../../src/shared/positions/types.ts'
import type { ArmId } from '../strategy/intraday-ls/detectors.ts'

// RESEARCH-1 (2026-10-08, STRAT-1 P5, stage R3) — the statistics module
// `trading-strategy-v1.md` §22/§23 require: the full performance panel,
// Deflated Sharpe (never raw Sharpe alone), and a purged/embargoed CPCV
// splitter. Pure, no I/O — consumes a backtest's own output shape
// (research/backtest-engine.ts / research/baseline-daily-trend.ts), never
// re-derives trading logic.
//
// Mechanical "every statistic carries its own n and MDE" discipline (§23's
// own binding rule, demonstrated by hand in the P4 report) — withPower
// below is what makes this automatic rather than left to a future report
// author's own memory.

// --- Shared input shape --------------------------------------------------
//
// Deliberately decoupled from backtest-engine.ts's own ClosedBacktestTrade/
// BacktestResult types (a structural subset, not an import) so this module
// stays reusable for either engine's output, or for real (non-backtest)
// trade history, without caring which concrete type produced it.

export interface StatsTrade {
  asset: string
  direction: Direction
  armId: ArmId | 'daily_trend' | string
  openedAt: string
  closedAt: string
  realizedPnl: number
  fee: number
  slippageCost: number
  fundingCost: number
  initialRiskUsd: number
  closeReason: CloseReason
}

export interface StatsNavPoint {
  timestamp: string
  nav: number
}

export interface BacktestStatsInput {
  trades: readonly StatsTrade[]
  navSeries: readonly StatsNavPoint[]
  rejectionsByReason?: Readonly<Record<string, number>>
}

// --- Rejection-reason classification -------------------------------------
//
// A short, stable bucket for a risk-gate rejection's own free-text reason
// (src/shared/risk/gate.ts's `rejected(reason)` calls) — classified by
// known prefixes/substrings rather than re-deriving the gate's own logic.
// Both backtest engines (research/backtest-engine.ts, research/baseline-
// daily-trend.ts) call this to build their own `rejectionsByReason` maps,
// so the panel's "risk rejections by reason" row is real counted data,
// never fabricated or omitted.
export function classifyRejectionReason(reason: string): string {
  if (reason.startsWith('position already open')) return 'position_already_open'
  if (reason.includes('below effective minimum')) return 'confidence_below_minimum'
  if (reason.includes('stop-loss') || reason.includes('take-profit')) return 'invalid_sl_tp'
  if (reason.startsWith('stop-out re-entry block')) return 'stop_out_reentry_block'
  if (reason.startsWith('drawdown breaker')) return 'drawdown_breaker'
  if (reason.startsWith('no room to open')) return 'no_room_sizing_clamped_to_zero'
  return 'other'
}

// --- n/MDE "not actionable" discipline (invariant I5) --------------------

export interface PowerCheckOptions {
  // Two-sided alpha and power, matching the exact convention this
  // project's own P4 report used by hand (alpha=.10, power=80%) —
  // overridable, never silently assumed to be some other field's
  // convention.
  alpha?: number
  power?: number
}

// Rough-and-ready inverse normal CDF via Acklam's algorithm, used only for
// the z-values this module needs (never exposed as a general statistics
// API) — see normalCdf's own comment for the matching forward direction,
// used by deflatedSharpeRatio below.
function inverseNormalCdf(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  // Acklam's rational approximation coefficients.
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
  const pLow = 0.02425
  const pHigh = 1 - pLow
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  if (p <= pHigh) {
    const q = p - 0.5
    const r = q * q
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  }
  const q = Math.sqrt(-2 * Math.log(1 - p))
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
}

// Standard normal CDF via the erf approximation (Abramowitz & Stegun
// 7.1.26) — accurate to ~1.5e-7, more than sufficient for reporting
// purposes (never used for a trading decision).
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const t = 1 / (1 + p * ax)
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax)
  return sign * y
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.sqrt(2)))
}

export interface PowerCheckedStat {
  value: number
  n: number
  mde: number
  actionable: boolean
  label: string
}

// MDE = (z_{alpha/2} + z_{power}) * sd / sqrt(n) -- the exact formula this
// project's own P4 report (context/diagnostics/p4-deterministic-exit-
// counterfactual-2026-10-08.md) computed by hand. "Actionable" means the
// statistic's own absolute value exceeds its MDE -- a statistic that
// doesn't clear this bar prints NOT ACTIONABLE in formatPowerChecked
// below, mechanically, rather than relying on a future report author to
// remember I5.
export function withPowerCheck(value: number, n: number, sd: number, label: string, options: PowerCheckOptions = {}): PowerCheckedStat {
  const alpha = options.alpha ?? 0.10
  const power = options.power ?? 0.80
  const zAlpha = inverseNormalCdf(1 - alpha / 2)
  const zPower = inverseNormalCdf(power)
  const mde = n > 0 ? (zAlpha + zPower) * sd / Math.sqrt(n) : Infinity
  return { value, n, mde, actionable: Math.abs(value) > mde, label }
}

export function formatPowerChecked(stat: PowerCheckedStat): string {
  if (!stat.actionable) {
    return `${stat.label}: ${stat.value.toFixed(3)}, n=${stat.n}. MDE at this n is ${stat.mde.toFixed(3)}. NOT ACTIONABLE.`
  }
  return `${stat.label}: ${stat.value.toFixed(3)}, n=${stat.n}, MDE=${stat.mde.toFixed(3)}.`
}

// --- Basic distribution helpers -------------------------------------------

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length
}

function sampleStdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)
  return Math.sqrt(variance)
}

function sampleSkewness(xs: readonly number[]): number {
  const n = xs.length
  if (n < 3) return 0
  const m = mean(xs)
  const sd = sampleStdev(xs)
  if (sd === 0) return 0
  const m3 = xs.reduce((s, x) => s + (x - m) ** 3, 0) / n
  return m3 / sd ** 3
}

// Excess kurtosis (normal distribution -> 0), matching the (gamma4 - 1)
// convention the Deflated Sharpe formula itself uses.
function sampleExcessKurtosis(xs: readonly number[]): number {
  const n = xs.length
  if (n < 4) return 0
  const m = mean(xs)
  const sd = sampleStdev(xs)
  if (sd === 0) return 0
  const m4 = xs.reduce((s, x) => s + (x - m) ** 4, 0) / n
  return m4 / sd ** 4 - 3
}

// --- Performance panel (trading-strategy-v1.md §22) -----------------------

export interface PerformancePanel {
  tradeCount: number
  winRate: number
  avgWinR: number
  avgLossR: number
  expectancyR: PowerCheckedStat
  profitFactor: number
  totalFees: number
  totalSlippage: number
  totalFunding: number
  exitsByType: Record<string, number>
  riskRejectionsByReason: Record<string, number>
  cagr: number
  maxDrawdownPct: number
  longestDrawdownDays: number
  calmarRatio: number
  sharpe: number
  sortino: number
  downsideDeviation: number
  timeInMarketPct: number
  takeProfitTouchRatePct: number
  bySameDirection: Record<Direction, { tradeCount: number; expectancyR: number }>
  byAsset: Record<string, { tradeCount: number; expectancyR: number }>
}

function tradeR(t: StatsTrade): number {
  if (t.initialRiskUsd <= 0) return 0
  return (t.realizedPnl - t.fee - t.slippageCost - t.fundingCost) / t.initialRiskUsd
}

function periodicReturns(navSeries: readonly StatsNavPoint[]): number[] {
  const returns: number[] = []
  for (let i = 1; i < navSeries.length; i++) {
    const prev = navSeries[i - 1]!.nav
    if (prev <= 0) continue
    returns.push(navSeries[i]!.nav / prev - 1)
  }
  return returns
}

function maxDrawdown(navSeries: readonly StatsNavPoint[]): { pct: number; longestDays: number } {
  let peak = navSeries[0]?.nav ?? 0
  let peakTime = navSeries[0]?.timestamp ?? null
  let worstPct = 0
  let longestMs = 0
  for (const point of navSeries) {
    if (point.nav > peak) {
      peak = point.nav
      peakTime = point.timestamp
    } else if (peak > 0) {
      const ddPct = (peak - point.nav) / peak
      if (ddPct > worstPct) worstPct = ddPct
      if (peakTime) {
        const durationMs = new Date(point.timestamp).getTime() - new Date(peakTime).getTime()
        if (durationMs > longestMs) longestMs = durationMs
      }
    }
  }
  return { pct: worstPct, longestDays: longestMs / 86_400_000 }
}

// Annualization factor inferred from the navSeries' own median tick
// spacing -- never assumed to be daily/30-minute/etc, since this module
// serves both the 30-minute V4 engine and the daily baseline.
function annualizationFactor(navSeries: readonly StatsNavPoint[]): number {
  if (navSeries.length < 2) return 1
  const gaps: number[] = []
  for (let i = 1; i < navSeries.length; i++) {
    gaps.push(new Date(navSeries[i]!.timestamp).getTime() - new Date(navSeries[i - 1]!.timestamp).getTime())
  }
  gaps.sort((a, b) => a - b)
  const medianGapMs = gaps[Math.floor(gaps.length / 2)]!
  if (medianGapMs <= 0) return 1
  return (365 * 86_400_000) / medianGapMs
}

export function computePerformancePanel(input: BacktestStatsInput, powerOptions: PowerCheckOptions = {}): PerformancePanel {
  const { trades, navSeries } = input
  const wins = trades.filter((t) => t.realizedPnl > 0)
  const losses = trades.filter((t) => t.realizedPnl <= 0)
  const rs = trades.map(tradeR)

  const exitsByType: Record<string, number> = {}
  for (const t of trades) exitsByType[t.closeReason] = (exitsByType[t.closeReason] ?? 0) + 1

  const grossWin = wins.reduce((s, t) => s + t.realizedPnl, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.realizedPnl, 0))

  const returns = periodicReturns(navSeries)
  const annFactor = annualizationFactor(navSeries)
  const meanReturn = mean(returns)
  const sdReturn = sampleStdev(returns)
  const downsideReturns = returns.filter((r) => r < 0)
  const downsideDeviation = sampleStdev(downsideReturns) * Math.sqrt(annFactor)
  const sharpe = sdReturn > 0 ? (meanReturn / sdReturn) * Math.sqrt(annFactor) : 0
  const sortino = downsideDeviation > 0 ? (meanReturn * annFactor) / downsideDeviation : 0

  const dd = maxDrawdown(navSeries)
  const first = navSeries[0]
  const last = navSeries[navSeries.length - 1]
  const years = first && last ? Math.max((new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()) / (365 * 86_400_000), 1e-9) : 1
  const cagr = first && last && first.nav > 0 ? (last.nav / first.nav) ** (1 / years) - 1 : 0

  // Time in market: fraction of nav ticks that fall within ANY trade's own
  // [openedAt, closedAt] window. A linear merge-sweep, not the O(ticks x
  // trades) nested check a naive implementation would use -- found live
  // during R4's own full-history run (a high-turnover variant's trade
  // count made the nested version prohibitively slow against a
  // multi-year, 30-minute-tick nav series). Valid because one asset can
  // hold at most one position at a time, so trade windows never overlap
  // in time -- sorting once and sweeping both series together in lockstep
  // is sufficient; a true interval tree would be overkill here.
  const sortedTradeWindows = trades
    .map((t) => ({ start: new Date(t.openedAt).getTime(), end: new Date(t.closedAt).getTime() }))
    .sort((a, b) => a.start - b.start)
  let tradeWindowIdx = 0
  let inMarketCount = 0
  for (const point of navSeries) {
    const t = new Date(point.timestamp).getTime()
    while (tradeWindowIdx < sortedTradeWindows.length && sortedTradeWindows[tradeWindowIdx]!.end < t) tradeWindowIdx++
    const current = sortedTradeWindows[tradeWindowIdx]
    if (current && t >= current.start && t <= current.end) inMarketCount++
  }

  const bySameDirection: Record<Direction, { tradeCount: number; expectancyR: number }> = {
    long: { tradeCount: 0, expectancyR: 0 },
    short: { tradeCount: 0, expectancyR: 0 },
  }
  for (const direction of ['long', 'short'] as const) {
    const subset = trades.filter((t) => t.direction === direction)
    bySameDirection[direction] = { tradeCount: subset.length, expectancyR: mean(subset.map(tradeR)) }
  }

  const byAsset: Record<string, { tradeCount: number; expectancyR: number }> = {}
  for (const t of trades) {
    if (!byAsset[t.asset]) byAsset[t.asset] = { tradeCount: 0, expectancyR: 0 }
  }
  for (const asset of Object.keys(byAsset)) {
    const subset = trades.filter((t) => t.asset === asset)
    byAsset[asset] = { tradeCount: subset.length, expectancyR: mean(subset.map(tradeR)) }
  }

  return {
    tradeCount: trades.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    avgWinR: wins.length > 0 ? mean(wins.map(tradeR)) : 0,
    avgLossR: losses.length > 0 ? mean(losses.map(tradeR)) : 0,
    expectancyR: withPowerCheck(mean(rs), rs.length, sampleStdev(rs), 'expectancy (R)', powerOptions),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    totalFees: trades.reduce((s, t) => s + t.fee, 0),
    totalSlippage: trades.reduce((s, t) => s + t.slippageCost, 0),
    totalFunding: trades.reduce((s, t) => s + t.fundingCost, 0),
    exitsByType,
    riskRejectionsByReason: { ...(input.rejectionsByReason ?? {}) },
    cagr,
    maxDrawdownPct: dd.pct,
    longestDrawdownDays: dd.longestDays,
    calmarRatio: dd.pct > 0 ? cagr / dd.pct : cagr > 0 ? Infinity : 0,
    sharpe,
    sortino,
    downsideDeviation,
    timeInMarketPct: navSeries.length > 0 ? inMarketCount / navSeries.length : 0,
    takeProfitTouchRatePct: trades.length > 0 ? (exitsByType.take_profit ?? 0) / trades.length : 0,
    bySameDirection,
    byAsset,
  }
}

// --- Deflated Sharpe Ratio (Bailey & Lopez de Prado, 2014) ----------------
//
// "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest
// Overfitting, and Non-Normality." Implements:
//   SR0 = E[max_k SR_k], the expected maximum Sharpe ratio achievable by
//         N independent zero-skill trials with Sharpe-ratio variance V:
//         SR0 = sqrt(V) * ((1-gamma)*Phi^-1(1-1/N) + gamma*Phi^-1(1-1/(N*e)))
//         (gamma = Euler-Mascheroni constant)
//   DSR  = Phi( (SR_hat - SR0) * sqrt(n-1) / sqrt(1 - skew*SR_hat + ((kurt-1)/4)*SR_hat^2) )
// `returns` is the PERIODIC (non-annualized) return series the observed
// Sharpe was computed from -- skewness/kurtosis are estimated from it
// directly, never assumed normal.
const EULER_MASCHERONI = 0.5772156649015329

export interface DeflatedSharpeInput {
  observedSharpe: number // the per-period (non-annualized) Sharpe ratio actually achieved
  returns: readonly number[] // the periodic return series the Sharpe was computed from
  numTrials: number // N -- the number of independent trials PRE-REGISTERED and actually run (never undercounted)
  sharpeVarianceAcrossTrials: number // V -- variance of the Sharpe ratios across those N trials
}

export interface DeflatedSharpeResult {
  observedSharpe: number
  expectedMaxSharpeUnderNull: number
  deflatedSharpeRatio: number // a p-value-like quantity in [0,1]: P(true Sharpe > 0 | the data), after deflation
  numTrials: number
}

export function deflatedSharpeRatio(input: DeflatedSharpeInput): DeflatedSharpeResult {
  const { observedSharpe, returns, numTrials, sharpeVarianceAcrossTrials } = input
  const n = returns.length
  const skew = sampleSkewness(returns)
  const kurtExcess = sampleExcessKurtosis(returns) // gamma4 - 3; the formula below uses (gamma4 - 1), i.e. (kurtExcess + 2)

  const sr0 = numTrials > 1
    ? Math.sqrt(Math.max(sharpeVarianceAcrossTrials, 0)) *
      ((1 - EULER_MASCHERONI) * inverseNormalCdf(1 - 1 / numTrials) + EULER_MASCHERONI * inverseNormalCdf(1 - 1 / (numTrials * Math.E)))
    : 0

  if (n < 2) {
    return { observedSharpe, expectedMaxSharpeUnderNull: sr0, deflatedSharpeRatio: 0, numTrials }
  }

  const denominator = Math.sqrt(Math.max(1 - skew * observedSharpe + ((kurtExcess + 2) / 4) * observedSharpe ** 2, 1e-9))
  const z = ((observedSharpe - sr0) * Math.sqrt(n - 1)) / denominator
  return { observedSharpe, expectedMaxSharpeUnderNull: sr0, deflatedSharpeRatio: normalCdf(z), numTrials }
}

// --- Purged, embargoed CPCV (Combinatorial Purged Cross-Validation) -------
//
// de Prado, "Advances in Financial Machine Learning," ch. 12. General-
// purpose over any set of [start,end] intervals (a backtest's own closed
// trades, keyed by their own holding period) -- never specific to one
// strategy's trade shape. The timeline is split into `numGroups` roughly
// equal, CONTIGUOUS time blocks; every C(numGroups, testGroupsPerSplit)
// combination of blocks is tried as the test set, with:
//   PURGE:   any train interval overlapping ANY test interval is removed
//   EMBARGO: any train interval starting within `embargoMs` after a test
//            block's own end boundary is also removed
// Fold count, testGroupsPerSplit, and embargoMs are caller-supplied
// (pre-registered in R4, never tuned post-hoc by this module itself).

export interface TimedInterval {
  start: number // epoch ms
  end: number // epoch ms
}

export interface CpcvSplit {
  trainIndices: number[]
  testIndices: number[]
  testGroupIndices: number[]
}

function combinations(n: number, k: number): number[][] {
  const result: number[][] = []
  const combo: number[] = []
  function recurse(start: number) {
    if (combo.length === k) {
      result.push([...combo])
      return
    }
    for (let i = start; i < n; i++) {
      combo.push(i)
      recurse(i + 1)
      combo.pop()
    }
  }
  recurse(0)
  return result
}

export function buildCpcvSplits(intervals: readonly TimedInterval[], numGroups: number, testGroupsPerSplit: number, embargoMs: number): CpcvSplit[] {
  if (intervals.length === 0 || numGroups < 2 || testGroupsPerSplit < 1 || testGroupsPerSplit >= numGroups) return []

  const order = intervals.map((_, i) => i).sort((a, b) => intervals[a]!.start - intervals[b]!.start)
  const groupSize = Math.ceil(order.length / numGroups)
  const groups: number[][] = Array.from({ length: numGroups }, (_, g) => order.slice(g * groupSize, (g + 1) * groupSize)).filter((g) => g.length > 0)
  const actualGroupCount = groups.length
  if (testGroupsPerSplit >= actualGroupCount) return []

  // A manual loop, not Math.min(...array)/Math.max(...array) — found live
  // during R4's own full-history run: a high-turnover variant's group
  // sizes can exceed the engine's own spread/apply argument limit,
  // throwing "Maximum call stack size exceeded." `start` is just the
  // group's first element (groups are built from `order`, already sorted
  // by start), but `end` genuinely needs a max over the whole group — a
  // later-starting interval can still close earlier than one before it
  // — so that one still needs a real scan, just via a loop, not a spread.
  const groupBounds = groups.map((g) => {
    let maxEnd = -Infinity
    for (const i of g) if (intervals[i]!.end > maxEnd) maxEnd = intervals[i]!.end
    return { start: intervals[g[0]!]!.start, end: maxEnd }
  })

  const splits: CpcvSplit[] = []
  for (const testGroupIdxCombo of combinations(actualGroupCount, testGroupsPerSplit)) {
    const testGroupIdxSet = new Set(testGroupIdxCombo)
    const testIndices = testGroupIdxCombo.flatMap((g) => groups[g]!)
    const testBounds = testGroupIdxCombo.map((g) => groupBounds[g]!)

    const trainCandidateGroupIdx = groups.map((_, g) => g).filter((g) => !testGroupIdxSet.has(g))
    const trainIndices: number[] = []
    for (const g of trainCandidateGroupIdx) {
      for (const idx of groups[g]!) {
        const interval = intervals[idx]!
        // PURGE: conservative, against each TEST GROUP's own overall
        // boundary (de Prado's own method) rather than every individual
        // test interval -- O(testGroupsPerSplit) per train interval
        // instead of O(testSize), and strictly the safer direction (a
        // group-boundary overlap check can only purge MORE than an
        // exact per-interval check would, never less).
        const overlapsTest = testBounds.some((t) => interval.start <= t.end && interval.end >= t.start)
        if (overlapsTest) continue
        const embargoed = testBounds.some((bound) => interval.start > bound.end && interval.start <= bound.end + embargoMs)
        if (embargoed) continue
        trainIndices.push(idx)
      }
    }

    splits.push({ trainIndices, testIndices, testGroupIndices: testGroupIdxCombo })
  }
  return splits
}
