// trading-strategy-v1.md §7 — the daily-trend regime. Dual-runtime (the
// extension will eventually want to display regime state, same reasoning
// as src/shared/positions/types.ts's PositionState), so this lives here
// rather than under agent-cycle/ alongside the computation itself —
// mirrors src/shared/indicators/types.ts's own type-vs-computation split.

// §7's rule is exactly one comparison, with no third state: "daily_close >
// SMA50 -> UP; daily_close <= SMA50 -> DOWN" (equal counts as DOWN,
// deliberately — see regime.ts). There is no NEUTRAL/UNKNOWN member here;
// insufficient history is a thrown InsufficientDataError (fail closed,
// same pattern as indicators/calculate.ts), not a third regime value.
export type TrendRegime = 'UP' | 'DOWN'

// §7 §Part-4: "chosen ex ante, never selected on results" — the midpoint
// of Detzel et al.'s empirically-significant 20/50/100-day band, not
// tuned. 20 and 100 are robustness-report-only; changing this value is a
// strategy decision, not a code change, and must go through the spec.
export const TREND_MA_LOOKBACK_DAYS = 50

export interface RegimeResult {
  regime: TrendRegime
  dailyClose: number
  dailyMa: number
  // How many closed daily bars the MA was actually computed from — always
  // TREND_MA_LOOKBACK_DAYS by construction (evaluateTrendRegime throws
  // below that), carried here so it's visible in the persisted audit
  // trail without re-deriving it from the raw series.
  barsUsed: number
}
