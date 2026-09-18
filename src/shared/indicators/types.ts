import { z } from 'zod'

// Matches market_snapshots.indicators exactly (supabase/migrations/
// ..._initial_schema.sql, column comment: "Deterministically computed:
// RSI(14), EMA20, EMA50, MACD histogram, ATR%, volume ratio, distance from
// 7d high/low."). Computed here in code from NormalizedMarketData — the
// model never supplies these values (invariant 4).
export const MarketIndicators = z.object({
  rsi14: z.number(),
  ema20: z.number(),
  ema50: z.number(),
  macdHistogram: z.number(),
  atrPct: z.number(),
  volumeRatio: z.number(),

  // Signed: negative means price is below the 7d high (the normal case,
  // 0 at a new high); positive means price is above the 7d low.
  // Deliberately two fields, not one "distance" scalar — the model gets a
  // cleaner "how close to breaking out / breaking down" read from two
  // signed numbers than from one that conflates direction.
  distanceFromSevenDayHighPct: z.number(),
  distanceFromSevenDayLowPct: z.number(),
})
export type MarketIndicators = z.infer<typeof MarketIndicators>

// Matches market_snapshots.recent_closes — the "~24 recent hourly closes"
// price-shape context (project-overview.md § Market and News Intelligence).
export const RecentClose = z.object({
  timestamp: z.string().datetime(),
  close: z.number().positive(),
})
export type RecentClose = z.infer<typeof RecentClose>
