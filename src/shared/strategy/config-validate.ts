import type { IntradayLsConfig } from './config-schema.ts'

// CFG-1 — cross-field validation. A config schema's per-field bounds
// (config-schema.ts) cannot catch relationships BETWEEN fields — and
// several of this strategy's constants are arithmetically coupled by
// design (protection.ts's own comment: "the 1.2% floor exists BECAUSE
// 0.30% round-trip = 0.25R at that stop"). A naive tuning UI would
// silently break these. Every rule here is a REJECTION at config-write
// time, never a trade-time surprise.
//
// assetCount is passed in rather than read from agent_settings here,
// because this module must stay a pure function over plain data (no DB
// I/O) — the caller (agent-cycle/db/strategy-config.ts) is responsible
// for supplying the live asset count.

export interface ConfigValidationError {
  field: string
  message: string
}

export function validateIntradayLsConfig(config: IntradayLsConfig, assetCount: number): ConfigValidationError[] {
  const errors: ConfigValidationError[] = []

  if (config.h4EmaFastPeriod >= config.h4EmaSlowPeriod) {
    errors.push({ field: 'h4EmaFastPeriod', message: `h4EmaFastPeriod (${config.h4EmaFastPeriod}) must be strictly less than h4EmaSlowPeriod (${config.h4EmaSlowPeriod}) — otherwise bias.ts's EMA cross can never read the UP/DOWN direction it was designed to detect.` })
  }

  if (config.dailyRegimeLookbackDays < config.h4EmaSlowPeriod) {
    errors.push({ field: 'dailyRegimeLookbackDays', message: `dailyRegimeLookbackDays (${config.dailyRegimeLookbackDays}) should be >= h4EmaSlowPeriod (${config.h4EmaSlowPeriod}) — a shorter daily floor than the 4h floor it's paired with is very likely a mistake, not a deliberate choice.` })
  }

  if (config.minOhlc30mBars < config.breakoutLookbackBars + 1) {
    errors.push({ field: 'minOhlc30mBars', message: `minOhlc30mBars (${config.minOhlc30mBars}) must be >= breakoutLookbackBars + 1 (${config.breakoutLookbackBars + 1}) — scanForEdge's own data-sufficiency floor must cover at least one full lookback window plus the current bar.` })
  }

  if (config.fadeRsiOversold >= config.fadeRsiOverbought) {
    errors.push({ field: 'fadeRsiOversold', message: `fadeRsiOversold (${config.fadeRsiOversold}) must be strictly less than fadeRsiOverbought (${config.fadeRsiOverbought}).` })
  }

  if (config.minClosesForFade < config.rsiPeriod + 1) {
    errors.push({ field: 'minClosesForFade', message: `minClosesForFade (${config.minClosesForFade}) must be >= rsiPeriod + 1 (${config.rsiPeriod + 1}) — RSI(period) needs period+1 closes, and the fade edge-trigger needs one more for its "prior" evaluation.` })
  }

  if (config.minCandlesForFade < config.atrPeriod + 1) {
    errors.push({ field: 'minCandlesForFade', message: `minCandlesForFade (${config.minCandlesForFade}) must be >= atrPeriod + 1 (${config.atrPeriod + 1}) — ATR(period) and the 7-day range both need period+1 candles, plus one more for "prior".` })
  }

  // The ASSET-4 saturation this project already hit live once
  // (verified: NAV $10,006.28, BTC 30.0%, ETH 29.9% against a 60% cap —
  // exactly 2 full-size positions saturated it). A config permitting
  // every asset to size up simultaneously past the notional ceiling is
  // rejected here rather than discovered as a live "no room to open"
  // rejection.
  if (config.maxSingleTradePct * assetCount > config.maxTotalNotionalPct) {
    errors.push({
      field: 'maxSingleTradePct',
      message: `maxSingleTradePct (${config.maxSingleTradePct}) x assetCount (${assetCount}) = ${(config.maxSingleTradePct * assetCount).toFixed(4)}, which exceeds maxTotalNotionalPct (${config.maxTotalNotionalPct}) — not every asset could size up simultaneously without hitting the total-notional cap, same saturation ASSET-4 fixed once already.`,
    })
  }

  // stopFloorPct / costGateMaxRatio are arithmetically coupled
  // (protection.ts's own comment): the floor exists because the cost
  // gate's own ratio is satisfied exactly at that stop distance, for
  // the fee/slippage structure this system actually runs. This cannot
  // be fully validated here without agent_settings.feeBps/slippageBps
  // (a DB value, not a strategy-config one) — flagged as a reminder
  // rather than silently assumed consistent.
  if (config.stopFloorPct <= 0 || config.costGateMaxRatio <= 0) {
    errors.push({ field: 'stopFloorPct', message: 'stopFloorPct and costGateMaxRatio must both be positive — zero or negative makes every candidate either always or never clear the cost gate.' })
  }

  if (config.timeStopMinutes >= config.maxHoldMinutes) {
    errors.push({ field: 'timeStopMinutes', message: `timeStopMinutes (${config.timeStopMinutes}) must be strictly less than maxHoldMinutes (${config.maxHoldMinutes}) — the soft time stop is meant to fire before the hard ceiling, not after or simultaneously with it.` })
  }

  return errors
}
