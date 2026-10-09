// DT-1 (2026-10-09) — the 13 real R4 variants' own per-period
// ("daily-resampled") Sharpe ratios, pooled across BTC/ETH as the simple
// mean of the two assets' own `trainSharpeDailyResampled` figures (the
// Stage A "13 trials" framing collapses the registry's 26 per-asset rows
// to 13 per-variant values; this file states the exact pooling rule used
// to do that, rather than leaving it implicit). Computed ONCE from
// context/research/trial-registry.json (committed 2026-10-08, DSR unit
// fix) — a fixed external input to the N=14 secondary diagnostic, not
// recomputed per simulation replicate. Used ONLY to build the
// sharpeVarianceAcrossTrials input for deflatedSharpeRatio at N=14 (plan
// Stage A §7: "N=14 reported alongside as the maximally-conservative
// cumulative bound").

export const REGISTRY_VARIANT_SHARPES_DAILY_RESAMPLED: readonly number[] = [
  -0.147346343442553, // v4-compat (control)
  -0.155279189455018, // breakout_long only
  -0.168757290345415, // breakout_short only
  -0.148443138626864, // pullback_long only
  -0.161691931255953, // pullback_short only
  -0.070006533936722, // fade_long only
  -0.091234269575068, // fade_short only
  -0.144498085148812, // random-entry baseline (long)
  -0.138883658953554, // random-entry baseline (short)
  -0.147650863531449, // daily-only bias
  -0.147790508117099, // geometry-alt-1 (wider stop)
  -0.127028042091005, // geometry-alt-2 (higher reward:risk)
  0.010614006621197, // daily-trend + inverse-vol-targeting baseline (R4's own variant 13)
]
