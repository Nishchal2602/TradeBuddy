import type { Action, RiskStatus } from '@/shared/decisions/types.ts'
import type { CloseReason } from '@/shared/positions/types.ts'
import type { BadgeProps } from '@/components/ui/badge'

/** Shared Action -> badge/label mapping. Lives outside src/features/home/
 * deliberately: the Home, Positions, Activity, and Decision-detail screens
 * all render the same action vocabulary and must render it identically
 * (ui-context.md § Decision Card Language) — one mapping, not one per
 * screen. ADD/REDUCE/MODIFY_PROTECTION added by Phase 2 (2026-09-22/23,
 * "Jev as a portfolio-management decision layer") — label/badge entries
 * only, forced by Record<Action, ...> now including them; no other UI
 * change accompanies this (explicit scope boundary for this migration). */
export const ACTION_LABEL: Record<Action, string> = {
  OPEN_LONG: 'OPEN LONG',
  OPEN_SHORT: 'OPEN SHORT',
  HOLD: 'HOLD',
  CLOSE: 'CLOSE',
  ADD: 'ADD',
  REDUCE: 'REDUCE',
  MODIFY_PROTECTION: 'MODIFY PROTECTION',
}

export const ACTION_BADGE_VARIANT: Record<Action, NonNullable<BadgeProps['variant']>> = {
  OPEN_LONG: 'long',
  OPEN_SHORT: 'short',
  HOLD: 'hold',
  CLOSE: 'neutral',
  ADD: 'long',
  REDUCE: 'neutral',
  MODIFY_PROTECTION: 'accent',
}

export const RISK_STATUS_LABEL: Record<RiskStatus, string> = {
  approved: 'Approved',
  clamped: 'Clamped',
  rejected: 'Rejected',
  not_applicable: 'Not applicable',
}

export const RISK_STATUS_BADGE_VARIANT: Record<RiskStatus, NonNullable<BadgeProps['variant']>> = {
  approved: 'success',
  clamped: 'warning',
  rejected: 'error',
  not_applicable: 'neutral',
}

/** Positions and Activity both render a position's close_reason /
 * a trade's trigger_reason — same four-value vocabulary
 * (trading-domain-contract.md §4), one mapping. */
export const CLOSE_REASON_LABEL: Record<CloseReason, string> = {
  agent_close: 'Agent close',
  stop_loss: 'Stop loss',
  take_profit: 'Take profit',
  collateral_exhausted: 'Collateral exhausted',
}

export const CLOSE_REASON_BADGE_VARIANT: Record<CloseReason, NonNullable<BadgeProps['variant']>> = {
  agent_close: 'neutral',
  stop_loss: 'error',
  take_profit: 'success',
  collateral_exhausted: 'warning',
}
