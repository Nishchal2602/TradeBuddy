// DT-1 (2026-10-09, Order-of-Work step 4) — pure eligibility checks for
// the PIT universe (plan §5.3): "data presence, never exchangeInfo status
// alone" -- the same discipline P1c's own census already established
// (BREAK does not mean long dead; TRADING does not guarantee recency).
// Takes only already-ingested daily bar close times; never reads
// research_contracts.excluded/listed_at/delisted_at, which are a
// SEPARATE, independent filter applied by the universe builder.

export interface EligibilityResult {
  eligible: boolean
  reason: string | null
  historyDays: number
  mostRecentBarCloseIso: string | null
}

const MS_PER_DAY = 86_400_000

// minHistoryDays/maxStalenessDays are plan-frozen defaults (§5.3's own
// "≥180 days of daily history"); maxStalenessDays is this module's own
// operational threshold for "active at formation" (not separately named
// in the plan's prose, since it only ever says "data presence for the
// relevant window" -- 10 days is generous enough to absorb a provider
// publication lag (P1c's own STGUSDT finding: up to ~2 days) while still
// excluding anything genuinely long-dead.
export function evaluateEligibility(
  dailyBarCloseTimesIso: readonly string[],
  formationDateIso: string,
  opts: { minHistoryDays?: number; maxStalenessDays?: number } = {},
): EligibilityResult {
  const minHistoryDays = opts.minHistoryDays ?? 180
  const maxStalenessDays = opts.maxStalenessDays ?? 10
  const formationMs = new Date(formationDateIso).getTime()

  const priorBarsMs = dailyBarCloseTimesIso
    .map((iso) => new Date(iso).getTime())
    .filter((ms) => ms < formationMs)
    .sort((a, b) => a - b)

  if (priorBarsMs.length === 0) {
    return { eligible: false, reason: 'no daily history before formation', historyDays: 0, mostRecentBarCloseIso: null }
  }

  const earliestMs = priorBarsMs[0]!
  const latestMs = priorBarsMs[priorBarsMs.length - 1]!
  const historyDays = (latestMs - earliestMs) / MS_PER_DAY
  const stalenessDays = (formationMs - latestMs) / MS_PER_DAY
  const mostRecentBarCloseIso = new Date(latestMs).toISOString()

  if (historyDays < minHistoryDays) {
    return { eligible: false, reason: `insufficient history: ${historyDays.toFixed(1)} days of coverage, ${minHistoryDays} required`, historyDays, mostRecentBarCloseIso }
  }
  if (stalenessDays > maxStalenessDays) {
    return { eligible: false, reason: `not active at formation: most recent bar is ${stalenessDays.toFixed(1)} days stale (max ${maxStalenessDays})`, historyDays, mostRecentBarCloseIso }
  }
  return { eligible: true, reason: null, historyDays, mostRecentBarCloseIso }
}
