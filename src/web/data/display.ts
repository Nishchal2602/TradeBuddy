import type { Action, RiskStatus } from '@/shared/decisions/types.ts'
import type { CloseReason } from '@/shared/positions/types.ts'
import type { ExperimentStatus } from '@/shared/experiments/types.ts'
import { ACTION_LABEL, RISK_STATUS_LABEL, CLOSE_REASON_LABEL } from '@/features/decisions/display'
import type { BadgeVariant } from '../ui/badge'

// Reuses the extension's LABEL maps verbatim (same vocabulary must read
// identically everywhere, ui-context.md § Decision Card Language) but
// defines its OWN variant mapping — this app's Badge has a different,
// smaller variant set (pos/neg/accent/neutral/muted) than the extension's
// (long/short/hold/success/error/warning/...), so the extension's
// *_BADGE_VARIANT maps don't type-check against it directly.
export { ACTION_LABEL, RISK_STATUS_LABEL, CLOSE_REASON_LABEL }

export const ACTION_VARIANT: Record<Action, BadgeVariant> = {
  OPEN_LONG: 'pos',
  OPEN_SHORT: 'neg',
  HOLD: 'muted',
  CLOSE: 'neutral',
  ADD: 'pos',
  REDUCE: 'neutral',
  MODIFY_PROTECTION: 'accent',
}

export const RISK_STATUS_VARIANT: Record<RiskStatus, BadgeVariant> = {
  approved: 'pos',
  clamped: 'accent',
  rejected: 'neg',
  not_applicable: 'muted',
}

export const CLOSE_REASON_VARIANT: Record<CloseReason, BadgeVariant> = {
  agent_close: 'neutral',
  stop_loss: 'neg',
  take_profit: 'pos',
  collateral_exhausted: 'neg',
  profit_giveback: 'accent',
  time_stop: 'muted',
}

// A "shadow candidate" is specifically the occupied-asset counterfactual
// row (2026-10-03) — NOT every decision_type='candidate' row. A FLAT
// asset with no detected opportunity ALSO gets decision_type='candidate'
// with action=HOLD and risk_status='not_applicable', which is the
// ordinary path, not a shadow. The shadow is deterministically
// gate-rejected ('position already open; CLOSE first'), so
// risk_status='rejected' is the second half of the real signal — found
// live while verifying this page: AVAX/SUI (both flat) were initially
// mislabeled "Shadow candidate" here when they were just routine HOLDs.
export function isShadowCandidate(decisionType: 'candidate' | 'management' | null, riskStatus: string): boolean {
  return decisionType === 'candidate' && riskStatus === 'rejected'
}

// model_version disambiguation (CLAUDE.md named invariant) — a dashboard
// that renders a 'call-failed' or 'not-called' row as a plain action label
// silently attributes an outage or a disabled layer to model judgment.
export function modelCallLabel(modelVersion: string): { label: string; variant: BadgeVariant } {
  if (modelVersion === 'not-called') return { label: 'No model call', variant: 'muted' }
  if (modelVersion === 'call-failed') return { label: 'Call failed', variant: 'neg' }
  return { label: modelVersion, variant: 'neutral' }
}

// WEB-2 (2026-10-08) — Experiments section additions.
export const EXPERIMENT_STATUS_VARIANT: Record<ExperimentStatus, BadgeVariant> = {
  draft: 'muted',
  running: 'accent',
  completed: 'pos',
  abandoned: 'neg',
}

export const EXPERIMENT_STATUS_LABEL: Record<ExperimentStatus, string> = {
  draft: 'Draft',
  running: 'Running',
  completed: 'Completed',
  abandoned: 'Abandoned',
}

// All 8 values confirmed verbatim from the real CHECK constraint
// (agent_decisions_no_candidate_reason_valid, migrations
// 20261006140000/20261006150000) — not guessed.
export const NO_CANDIDATE_REASON_LABEL: Record<string, string> = {
  data_insufficient: 'Insufficient data',
  regime_null: 'Regime undetermined',
  no_arm_triggered: 'No arm triggered',
  cost_gate: 'Cost gate',
  opportunity_consumed: 'Opportunity already consumed',
  arm_disabled: 'Arm disabled',
  direction_disabled: 'Direction disabled',
  signal_stale: 'Signal drift (stale)',
}
