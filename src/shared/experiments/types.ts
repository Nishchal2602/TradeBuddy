import { z } from 'zod'

// WEB-2 (2026-10-08) — mirrors how every other DB-persisted,
// CHECK-constrained enum in this codebase gets a Zod type under
// src/shared/ (PositionStatus/CloseReason in positions/types.ts), even
// though the only consumer today is the web dashboard. Values match
// experiments.status's own CHECK constraint exactly (migration
// 20261007130000_exp1_experiment_schema.sql).
export const ExperimentStatus = z.enum(['draft', 'running', 'completed', 'abandoned'])
export type ExperimentStatus = z.infer<typeof ExperimentStatus>
