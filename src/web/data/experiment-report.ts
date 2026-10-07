import type { ExperimentDetailData } from './experiment-detail'
import type { AccountNavSeries } from './experiment-performance'
import type { AccountDecisionStats, ExperimentRunStatsResult } from './experiment-analysis'

// WEB-2 (2026-10-08) — "generated experiment reports," in-app only (per
// explicit decision). Pure composition, ZERO new queries — reshapes data
// already fetched by the other three data files. No composite score, no
// rank, no winner field anywhere: `sections` is explicitly NOT sorted by
// any derived performance metric, specifically so array order can never
// function as an implicit ranking.
export interface ExperimentReportSection {
  variantId: string
  variantName: string
  accounts: { portfolioId: string; name: string }[]
  performance: { latestNav: number | null; latestCumulativePnl: number | null; n: number }
  decisions: { totalDecisions: number; realizedTradeCount: number; closedPositionCount: number; winCount: number; lossCount: number }
  reliability: { totalRuns: number; failedRuns: number; realJevCallRate: number | null }
}

export interface ExperimentReport {
  experimentName: string
  hypothesis: string
  status: string
  sections: ExperimentReportSection[]
}

export function composeExperimentReport(
  detail: ExperimentDetailData,
  performance: AccountNavSeries[],
  decisionStats: AccountDecisionStats[],
  runStats: ExperimentRunStatsResult,
): ExperimentReport {
  const performanceByPortfolio = new Map(performance.map((p) => [p.portfolioId, p]))
  const decisionsByPortfolio = new Map(decisionStats.map((d) => [d.portfolioId, d]))
  const runsByPortfolio = new Map(runStats.perAccount.map((r) => [r.portfolioId, r]))

  // Natural order = variant name (already sorted that way by
  // loadExperimentDetail's own query) — never sorted by any performance
  // number.
  const sections: ExperimentReportSection[] = detail.variants.map((variant) => {
    const accounts = detail.accounts.filter((a) => a.variantId === variant.id)

    let latestNav: number | null = null
    let latestCumulativePnl: number | null = null
    let n = 0
    let totalDecisions = 0
    let realizedTradeCount = 0
    let closedPositionCount = 0
    let winCount = 0
    let lossCount = 0
    let totalRuns = 0
    let failedRuns = 0
    let realCalls = 0
    let callableCycles = 0

    for (const account of accounts) {
      const perf = performanceByPortfolio.get(account.portfolioId)
      if (perf) {
        latestNav = (latestNav ?? 0) + (perf.latestNav ?? 0)
        latestCumulativePnl = (latestCumulativePnl ?? 0) + (perf.latestCumulativePnl ?? 0)
        n += perf.snapshotCount
      }
      const stats = decisionsByPortfolio.get(account.portfolioId)
      if (stats) {
        totalDecisions += stats.totalDecisions
        realizedTradeCount += stats.realizedTradeCount
        closedPositionCount += stats.closedPositionCount
        winCount += stats.winCount
        lossCount += stats.lossCount
        realCalls += stats.modelCallBuckets.realCall
        callableCycles += stats.modelCallBuckets.realCall + stats.modelCallBuckets.callFailed
      }
      const runs = runsByPortfolio.get(account.portfolioId)
      if (runs) {
        totalRuns += runs.totalRuns
        failedRuns += runs.byStatusAndKind['decision:failed'] ?? 0
        failedRuns += runs.byStatusAndKind['monitor:failed'] ?? 0
      }
    }

    return {
      variantId: variant.id,
      variantName: variant.name,
      accounts: accounts.map((a) => ({ portfolioId: a.portfolioId, name: a.name })),
      performance: { latestNav, latestCumulativePnl, n },
      decisions: { totalDecisions, realizedTradeCount, closedPositionCount, winCount, lossCount },
      reliability: { totalRuns, failedRuns, realJevCallRate: callableCycles > 0 ? realCalls / callableCycles : null },
    }
  })

  return {
    experimentName: detail.header.name,
    hypothesis: detail.header.hypothesis,
    status: detail.header.status,
    sections,
  }
}
