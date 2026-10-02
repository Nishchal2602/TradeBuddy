// Strategy V4 (intraday_ls, 2026-10-01) — the consumed-opportunity
// lifecycle (plan §3.4), required because window-scanned detection
// (detectors.ts's scanForEdge) removes the accidental one-shot property
// last-bar-only detection used to have. Without this, a single edge
// found by the scan would be re-emitted every cycle it remains within
// the scan window, or — for fade, whose underlying condition can persist
// for hours — every cycle the condition stays true, turning one market
// event into several candidate rows and corrupting every per-arm
// statistic downstream.
//
// "Consumed" means PROCESSED, not executed: a news-vetoed, risk-rejected,
// daily-limit-blocked, asset-occupied, or arm-disabled candidate all
// consume the opportunity exactly as much as one that actually executes
// (plan §3.4's own table) — because in every one of those cases a
// decision row was persisted recording what happened, and persisting
// that row IS the act of consuming. The caller (agent-cycle/index.ts)
// derives lastConsumedOpportunityBarTs as
// max(agent_decisions.opportunity_bar_ts) for the asset; this module only
// implements the comparison itself, pure and independently testable.

export function isOpportunityConsumed(detectedAtBarTs: string, lastConsumedOpportunityBarTs: string | null): boolean {
  if (lastConsumedOpportunityBarTs === null) return false
  return new Date(detectedAtBarTs).getTime() <= new Date(lastConsumedOpportunityBarTs).getTime()
}

export function shouldEmitOpportunity(detectedAtBarTs: string, lastConsumedOpportunityBarTs: string | null): boolean {
  return !isOpportunityConsumed(detectedAtBarTs, lastConsumedOpportunityBarTs)
}
