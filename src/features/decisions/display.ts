import type { Action, RiskStatus } from '@/shared/decisions/types.ts'
import type { BadgeProps } from '@/components/ui/badge'

/** Shared Action -> badge/label mapping. Lives outside src/features/home/
 * deliberately: the Home, Positions, Activity, and Decision-detail screens
 * all render the same four-action vocabulary and must render it
 * identically (ui-context.md § Decision Card Language) — one mapping, not
 * one per screen. */
export const ACTION_LABEL: Record<Action, string> = {
  OPEN_LONG: 'OPEN LONG',
  OPEN_SHORT: 'OPEN SHORT',
  HOLD: 'HOLD',
  CLOSE: 'CLOSE',
}

export const ACTION_BADGE_VARIANT: Record<Action, NonNullable<BadgeProps['variant']>> = {
  OPEN_LONG: 'long',
  OPEN_SHORT: 'short',
  HOLD: 'hold',
  CLOSE: 'neutral',
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
