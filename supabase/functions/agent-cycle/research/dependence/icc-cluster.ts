// DT-1 (2026-10-09) — the overlap-clustered ICC dependence estimator,
// the first of E2's three (plan §6.4a-c, e): the observation is one
// closed trade's net R; correlation is CONTEMPORANEOUS EXPOSURE, not
// entry-month (two trades held open across the same calendar window are
// correlated even if they were entered in different months — a single
// market-wide move affects both); clusters are formed by interval
// overlap of [openedAt, closedAt), with an unequal-cluster-size design
// effect (never the plain mean cluster size) and a hard max(rhoIntra, 0)
// floor so n_eff can never exceed the raw trade count N.

export interface TradeObservation {
  openedAt: string
  closedAt: string
  r: number
}

export interface OverlapCluster {
  trades: TradeObservation[]
}

// Classic "merge overlapping intervals" sweep: sort by openedAt, extend
// the current cluster's running max closedAt while the next trade's
// openedAt falls at-or-before it, else start a new cluster. This
// correctly captures TRANSITIVE overlap (A-B overlap, B-C overlap, A-C
// don't directly overlap -> all three in one cluster) without needing
// pairwise comparison, because the running max always reflects the
// furthest-reaching trade seen so far in the current chain.
export function buildOverlapClusters(trades: readonly TradeObservation[]): OverlapCluster[] {
  if (trades.length === 0) return []
  const sorted = [...trades].sort((a, b) => (a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : 0))

  const clusters: OverlapCluster[] = []
  let current: TradeObservation[] = [sorted[0]!]
  let runningMaxClosedAt = sorted[0]!.closedAt

  for (let i = 1; i < sorted.length; i++) {
    const trade = sorted[i]!
    if (trade.openedAt <= runningMaxClosedAt) {
      current.push(trade)
      if (trade.closedAt > runningMaxClosedAt) runningMaxClosedAt = trade.closedAt
    } else {
      clusters.push({ trades: current })
      current = [trade]
      runningMaxClosedAt = trade.closedAt
    }
  }
  clusters.push({ trades: current })
  return clusters
}

export interface IccResult {
  n: number
  k: number
  mA: number // unequal-cluster-size average, sum(m_i^2)/n -- the plan's own DEFF input
  rhoIntraRaw: number // the ANOVA (Fisher) one-way random-effects ICC estimate, may be negative
  rhoIntra: number // max(rhoIntraRaw, 0) -- the floor that keeps n_eff <= N always
  deff: number
  nEff: number
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

// The standard ANOVA (Fisher) one-way random-effects ICC estimator for
// UNBALANCED designs (unequal cluster sizes) -- e.g. Searle, Casella &
// McCulloch, "Variance Components" (1992); Fleiss (1986). Given k
// clusters of size m_i (i=1..k), n = sum(m_i):
//   MSB = between-cluster mean square = SSB / (k-1)
//   MSW = within-cluster mean square  = SSW / (n-k)
//   m0  = (1/(k-1)) * (n - sum(m_i^2)/n)      [the unbalanced-design
//                                               "average cluster size"
//                                               correction]
//   ICC = (MSB - MSW) / (MSB + (m0-1)*MSW)
export function computeIccNEff(trades: readonly TradeObservation[]): IccResult {
  const n = trades.length
  const clusters = buildOverlapClusters(trades)
  const k = clusters.length

  const clusterSizes = clusters.map((c) => c.trades.length)
  const sumM2 = clusterSizes.reduce((a, m) => a + m * m, 0)
  const mA = n > 0 ? sumM2 / n : 0

  // Degenerate cases: a single trade, or every trade its own cluster
  // (k===n), or a single cluster (k===1) -- none of these can support a
  // between/within decomposition. Treated as "no evidence of intra-
  // cluster correlation" (rhoIntra=0, n_eff=n), the same conservative
  // default the plan's own max(rhoIntra,0) floor already implies when
  // the estimate itself is unreliable rather than genuinely negative.
  if (n === 0 || k === n || k <= 1) {
    return { n, k, mA, rhoIntraRaw: 0, rhoIntra: 0, deff: 1, nEff: n }
  }

  const grandMean = mean(trades.map((t) => t.r))
  let ssb = 0
  let ssw = 0
  for (const cluster of clusters) {
    const clusterMean = mean(cluster.trades.map((t) => t.r))
    ssb += cluster.trades.length * (clusterMean - grandMean) ** 2
    for (const t of cluster.trades) ssw += (t.r - clusterMean) ** 2
  }

  const msb = ssb / (k - 1)
  const msw = ssw / (n - k)
  const m0 = (1 / (k - 1)) * (n - sumM2 / n)

  // msw===0 (every within-cluster observation identical) would divide by
  // zero in the ICC formula; treated as maximal dependence (rhoIntra->1
  // in the limit) rather than NaN -- correctly conservative, since
  // identical within-cluster values is literally the definition of
  // perfect intra-cluster correlation.
  const rhoIntraRaw = msw === 0 ? (msb > 0 ? 1 : 0) : (msb - msw) / (msb + (m0 - 1) * msw)
  const rhoIntra = Math.max(rhoIntraRaw, 0)
  const deff = 1 + (mA - 1) * rhoIntra
  const nEff = n / deff

  return { n, k, mA, rhoIntraRaw, rhoIntra, deff, nEff }
}

export interface IccInterval {
  pointEstimate: number
  ciLower: number
  ciUpper: number
}

// The 90% CI this estimator contributes to E2's three-way comparison:
// normal-theory, using n_eff in place of the raw N (plan §6.4g's own
// "withPowerCheck-style" construction) -- z=1.6449 is the two-sided 90%
// standard-normal critical value (alpha=0.10, this project's convention
// throughout, e.g. CPCV/MDE in stats.ts).
const Z_90_TWO_SIDED = 1.6449
export function iccInterval(trades: readonly TradeObservation[]): IccInterval {
  const rs = trades.map((t) => t.r)
  const pointEstimate = mean(rs)
  const variance = rs.reduce((a, r) => a + (r - pointEstimate) ** 2, 0) / Math.max(rs.length - 1, 1)
  const sd = Math.sqrt(variance)
  const { nEff } = computeIccNEff(trades)
  const halfWidth = Z_90_TWO_SIDED * (sd / Math.sqrt(Math.max(nEff, 1)))
  return { pointEstimate, ciLower: pointEstimate - halfWidth, ciUpper: pointEstimate + halfWidth }
}
