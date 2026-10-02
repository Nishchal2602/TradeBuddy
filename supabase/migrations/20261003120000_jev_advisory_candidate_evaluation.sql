-- ============================================================================
-- Strategy V4 (intraday_ls) — §5.1 advisory candidate evaluation
-- (2026-10-03, plan revision after review: "advisory entry" widened from
-- one question into three orthogonal Jev evaluations).
--
-- §5.1a (direction-aware news veto) shipped 2026-10-01 — unchanged here,
-- except promoting its raw probability out of output_payload JSON into
-- its own column (jev_news_veto_probability) so the provisional-threshold
-- revisit (model/jev/question.ts's own comment) is a plain SQL query.
--
-- §5.1b (entry_quality + expected_move) and §5.1c (failure_risk +
-- failure_mode, new) are BOTH advisory for intraday_ls — persisted on
-- every row, never consumed to alter a candidate. entry_gate_mode
-- distinguishes this from Aggressive's existing BLOCKING use of the same
-- entry_quality/expected_move question pair, so the two regimes are never
-- pooled by accident.
--
-- Review item ("persist the full Jev distributions structurally"): the
-- *_distribution columns store each Choice/Score answer's full
-- probability map verbatim, not just the winning value — §6 needs to test
-- whether a SPECIFIC option (e.g. failure_mode = MOMENTUM_EXHAUSTION)
-- predicts realized R, which the winning value alone cannot answer, and
-- which output_payload's free-form JSON shape should not be relied on to
-- answer either (that column's shape is not a stable contract — nothing
-- in src/ reads it, per the audit done before this migration).
--
-- Three separate prompt-version columns (not one composite string) — a
-- single batched call can answer veto + entry + adversarial questions
-- together, and index.ts's existing promptVersionForRow can only ever
-- hold ONE string per row. A null column means "this layer did not run
-- for this row," never "ran under an earlier version."
--
-- decision_type is added now as a plain, single-row discriminator
-- ('candidate' when the asset was FLAT this cycle, 'management' when an
-- existing position was what the decision concerned) — derived from
-- state already known at insert time, zero behavior change. It does NOT
-- yet support two rows for the same (run_id, asset): widening
-- agent_decisions_run_asset_unique is deliberately deferred to the
-- follow-up pass that un-gates V4 detection from `openPosition === null`
-- and emits a genuine second 'candidate' row for an occupied asset (plan
-- 5-IMPL's "Candidate vs management" section) — a larger, separately-
-- tested structural change, not bundled into this migration.
-- ============================================================================

alter table public.agent_decisions
  add column decision_type text check (decision_type is null or decision_type in ('candidate', 'management')),
  add column jev_news_veto_probability numeric(5, 4) check (jev_news_veto_probability is null or (jev_news_veto_probability >= 0 and jev_news_veto_probability <= 1)),
  add column entry_quality text check (entry_quality is null or entry_quality in ('ENTER', 'SKIP')),
  add column entry_quality_confidence numeric(5, 4) check (entry_quality_confidence is null or (entry_quality_confidence >= 0 and entry_quality_confidence <= 1)),
  add column entry_quality_distribution jsonb check (entry_quality_distribution is null or jsonb_typeof(entry_quality_distribution) = 'object'),
  add column entry_gate_mode text check (entry_gate_mode is null or entry_gate_mode in ('advisory', 'blocking')),
  add column expected_move_confidence numeric(5, 4) check (expected_move_confidence is null or (expected_move_confidence >= 0 and expected_move_confidence <= 1)),
  add column expected_move_distribution jsonb check (expected_move_distribution is null or jsonb_typeof(expected_move_distribution) = 'object'),
  add column expected_move_horizon_minutes int check (expected_move_horizon_minutes is null or expected_move_horizon_minutes > 0),
  add column failure_risk text check (failure_risk is null or failure_risk in ('LOW', 'MEDIUM', 'HIGH')),
  add column failure_risk_confidence numeric(5, 4) check (failure_risk_confidence is null or (failure_risk_confidence >= 0 and failure_risk_confidence <= 1)),
  add column failure_risk_distribution jsonb check (failure_risk_distribution is null or jsonb_typeof(failure_risk_distribution) = 'object'),
  add column failure_mode text check (failure_mode is null or failure_mode in
    ('MOMENTUM_EXHAUSTION', 'COUNTER_TREND_PRESSURE', 'WEAK_VOLUME_CONFIRMATION', 'RANGE_COMPRESSION', 'STRUCTURE_BREAK', 'NONE')),
  add column failure_mode_confidence numeric(5, 4) check (failure_mode_confidence is null or (failure_mode_confidence >= 0 and failure_mode_confidence <= 1)),
  add column failure_mode_distribution jsonb check (failure_mode_distribution is null or jsonb_typeof(failure_mode_distribution) = 'object'),
  add column veto_prompt_version text,
  add column entry_prompt_version text,
  add column adversarial_prompt_version text;

comment on column public.agent_decisions.decision_type is 'Single-row discriminator: ''candidate'' when the asset was FLAT this cycle (an entry evaluation), ''management'' when an existing position was what the decision concerned. NULL on every pre-2026-10-03 row (never backfilled — ambiguous without replaying each row''s own openPosition state). Does not yet disambiguate two rows for one (run_id, asset); see this migration''s own header note.';
comment on column public.agent_decisions.jev_news_veto_probability is 'The raw noul probability from the direction-aware veto question (model/jev/question.ts), promoted out of output_payload JSON so the provisional JEV_VETO_THRESHOLD can be revisited via plain SQL. Null whenever no veto call completed for this asset this cycle.';
comment on column public.agent_decisions.entry_quality is 'Jev''s ENTER/SKIP verdict on a detected opportunity (model/jev/entry-question.ts). Advisory (never blocks) for intraday_ls; BLOCKING for aggressive — see entry_gate_mode on the same row.';
comment on column public.agent_decisions.entry_quality_confidence is 'Raw confidence on the entry_quality Choice answer.';
comment on column public.agent_decisions.entry_quality_distribution is 'Full probability distribution over {ENTER, SKIP} — not just the winning choice, so a later analysis can test e.g. "does P(ENTER) > 0.8 specifically predict realized R" independent of the thresholded entry_quality value.';
comment on column public.agent_decisions.entry_gate_mode is '''advisory'' (intraday_ls — SKIP is recorded, never acted on) or ''blocking'' (aggressive — SKIP suppresses the trade). Exists so the two regimes'' entry_quality rows are never pooled as if they meant the same thing.';
comment on column public.agent_decisions.expected_move_confidence is 'Raw confidence on the expected_move Score answer.';
comment on column public.agent_decisions.expected_move_distribution is 'Full probability distribution over the Score''s level indices (stringified, e.g. {"0":.., "1":..}) — entry_prompt_version on the same row pins which EXPECTED_MOVE_PCT_BY_SCORE_LEVEL table those indices meant at the time.';
comment on column public.agent_decisions.expected_move_horizon_minutes is 'The pre-registered horizon the expected_move question was asked against (plan §6.3) — 60 for every row that sets this today. decision_outcomes.mfe_r_60m (§6, not yet built) is what expected_move_pct is evaluated against, never lifetime MFE.';
comment on column public.agent_decisions.failure_risk is 'Strategy V4 (intraday_ls) only, plan §5.1c — Jev''s adversarial LOW/MEDIUM/HIGH judgment of how vulnerable the candidate looks, asked under an explicit "assume this is going to fail" premise. Advisory — never blocks. Null for every other profile and for any intraday_ls row with no detected opportunity.';
comment on column public.agent_decisions.failure_risk_confidence is 'Raw confidence on the failure_risk Choice answer.';
comment on column public.agent_decisions.failure_risk_distribution is 'Full probability distribution over {LOW, MEDIUM, HIGH}.';
comment on column public.agent_decisions.failure_mode is 'Strategy V4 (intraday_ls) only, plan §5.1c — which of a fixed taxonomy of weaknesses Jev cited as the strongest evidence this candidate is vulnerable. NONE means ONLY "no material, specific vulnerability is visible in the supplied context" — it does NOT mean "unsure" and does NOT mean "none of the other categories quite fit" (model/jev/adversarial-question.ts''s own criteria text states this explicitly, since it is the easiest option to misread).';
comment on column public.agent_decisions.failure_mode_confidence is 'Raw confidence on the failure_mode Choice answer.';
comment on column public.agent_decisions.failure_mode_distribution is 'Full probability distribution over all six failure modes — the whole point of persisting this structurally rather than relying on output_payload: a later analysis needs each mode''s own probability against realized R, not just the winning label.';
comment on column public.agent_decisions.veto_prompt_version is 'Which JEV_QUESTION_VERSION applied to this row''s veto question, independent of entry_prompt_version/adversarial_prompt_version — null means no veto question was part of this row''s evaluation.';
comment on column public.agent_decisions.entry_prompt_version is 'Which ENTRY_QUESTION_VERSION applied to this row''s entry_quality/expected_move questions. Null means neither question was asked for this row.';
comment on column public.agent_decisions.adversarial_prompt_version is 'Which ADVERSARIAL_QUESTION_VERSION applied to this row''s failure_risk/failure_mode questions. Null means neither question was asked for this row.';
