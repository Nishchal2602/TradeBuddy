import type { ModelDecisionProposal, PrimaryDriver } from '../../../../src/shared/decisions/types.ts'

// Small pure helpers for shaping what gets persisted to agent_decisions —
// separated from index.ts so the orchestration file stays focused on I/O
// sequencing, not field-derivation logic.

// Derived from reasons[]'s type distribution, never asked of the model
// directly (src/shared/decisions/types.ts's own module comment) — one
// less place for the model to contradict its own stated reasoning.
export function derivePrimaryDriver(reasons: ModelDecisionProposal['reasons']): PrimaryDriver {
  const hasNews = reasons.some((r) => r.type === 'NEWS')
  const hasTechnical = reasons.some((r) => r.type === 'TECHNICAL')
  if (hasNews && hasTechnical) return 'BOTH'
  if (hasNews) return 'NEWS'
  if (hasTechnical) return 'TECHNICAL'
  return 'NONE'
}

// flatMap with a conditional single-item/empty array, not
// filter().map(): filter() alone doesn't narrow the array's element type
// to the NEWS branch, so a later .newsId access wouldn't type-check
// without an explicit type predicate — this reads cleaner and narrows
// naturally within each ternary branch.
export function citedNewsIds(reasons: ModelDecisionProposal['reasons']): string[] {
  return reasons.flatMap((r) => (r.type === 'NEWS' ? [r.newsId] : []))
}
