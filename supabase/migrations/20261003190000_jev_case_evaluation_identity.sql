-- ============================================================================
-- Strategy V4 (intraday_ls) — case_id / evaluation_id
-- (2026-10-03, plan §6B "Jev continuous-evaluation architecture", P0
-- item 3, the last of the three P0 units — prompt-artifact hashing,
-- the stable per-row request projection, and this).
--
-- The review correction this encodes, verbatim from the plan file: "A
-- case is the input. An evaluation is one model's answer to it." An
-- earlier draft folded model+prompt into the CASE's own identity, which
-- would have given a champion and a challenger evaluating the IDENTICAL
-- market situation two DIFFERENT case ids — destroying the pairing
-- §6B §9's whole champion/challenger comparison design depends on.
--
--   case_id        = hash(input_state_projection)
--   evaluation_id  = hash(case_id, model_id, prompt_hashes, inference_config)
--
-- jev_case_id depends ONLY on the market situation (asset, evaluatedAt,
-- news, position, opportunity, portfolio exposure) — model/jev/
-- case-identity.ts's caseInputFromRequestProjection is request-
-- projection.ts's own JevRequestProjection with everything
-- evaluation-specific (schemaVersion, modelRequested/modelResolved,
-- questions) deliberately stripped. jev_evaluation_id additionally
-- folds in the resolved model id and, for each question family this row
-- actually asked, that family's CURRENT module-level prompt fingerprint
-- (P0 item 1's prompt-hash.ts primitive, reused rather than a second
-- per-row hashing scheme) plus an inference-config placeholder (empty
-- today — this system has no caller-supplied sampling/determinism
-- parameter yet).
--
-- Both null under the exact same conditions jev_request_projection is:
-- no genuine call this cycle, a failed call, or the occupied-asset
-- shadow row (which never calls Jev at all). Neither is backfilled for
-- any pre-2026-10-03 row — doing so would require reconstructing a
-- request projection this migration's own prerequisite (P0 item 2)
-- never existed for at the time.
--
-- jev_case_id gets a plain (non-unique) index: the whole point of
-- separating the two identifiers is that MULTIPLE evaluation rows
-- legitimately share one case_id (champion + challenger, or a retry) —
-- this is exactly the lookup pattern ("every evaluation of this case")
-- a future case-capture/comparison query needs. jev_evaluation_id gets
-- no uniqueness constraint: a true duplicate (the identical case
-- re-evaluated under the identical model/prompt/config) is not an error
-- this schema needs to forbid, and a live trading cycle must never fail
-- an insert over a telemetry coincidence.
-- ============================================================================

alter table public.agent_decisions
  add column jev_case_id text,
  add column jev_evaluation_id text;

comment on column public.agent_decisions.jev_case_id is 'hash(market-situation input) — model/jev/case-identity.ts''s computeCaseId, derived from jev_request_projection with model/prompt/questions stripped. Identical across a champion/challenger pair evaluating the same market situation; null under the same conditions as jev_request_projection.';
comment on column public.agent_decisions.jev_evaluation_id is 'hash(case_id, resolved model id, per-family prompt fingerprints, inference config) — model/jev/case-identity.ts''s computeEvaluationId. Differs between a champion and challenger sharing the same jev_case_id. Null under the same conditions as jev_request_projection.';

create index agent_decisions_jev_case_id_idx
  on public.agent_decisions (jev_case_id)
  where jev_case_id is not null;
