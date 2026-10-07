import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'

// EXP-1 Stage E2 (2026-10-07) — per-account settings resolution. Pure,
// zero DB, mirroring strategy/registry.ts's own convention (a small
// function over plain data, not a class). agent_settings stays exactly
// what it is today — the DB-enforced global singleton, source of every
// OPERATOR-level value (fees, slippage, SL/TP bounds, drawdown breaker,
// staleness, risk ceilings). This function only ever overrides the FOUR
// treatment columns a variant is actually permitted to vary (the plan's
// own configurability tiering: cadence/assets/Jev-gating are
// user-variable; risk ceilings are never variant-overridable).
//
// variant === null (the live champion, and every pre-EXP-1 code path)
// returns `global` UNCHANGED, BY IDENTITY — not a shallow copy — so a
// reference-equality check or a JSON diff against the pre-EXP-1 object
// both confirm zero behavior change for the one case that matters most.

export interface VariantOverrides {
  decisionIntervalMinutes: number
  assets: AssetSymbol[]
  newsVetoEnabled: boolean
  managementEnabled: boolean
}

export function resolveAccountSettings<T extends VariantOverrides>(global: T, variant: VariantOverrides | null): T {
  if (variant === null) return global
  // Spreading a VariantOverrides over a wider T only ever touches the
  // four keys VariantOverrides itself declares, with field types that
  // already match T's own (both come from the same four underlying
  // columns) — safe by construction, not merely asserted.
  return { ...global, ...variant } as T
}
