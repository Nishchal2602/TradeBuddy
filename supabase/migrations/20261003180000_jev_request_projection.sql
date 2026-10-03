-- ============================================================================
-- Strategy V4 (intraday_ls) — stable per-row Jev-request record
-- (2026-10-03, plan §6B "Jev continuous-evaluation architecture", P0
-- item 2, following P0 item 1's prompt-artifact hashing earlier today).
--
-- Closes a gap named in §6B §5: the full Jev request (model + state +
-- verbatim question text) IS already persisted, inside
-- agent_decisions.output_payload.request — but that column is explicitly
-- declared NOT a stable contract (this table's own 2026-10-03 advisory-
-- evaluation migration header: "nothing in src/ reads it... should not
-- be relied on"), is null for an entire class of rows (no-call, call-
-- failed, every occupied-asset shadow row), and is BATCH-WIDE rather
-- than per-asset — every row from one cycle carries every asset's own
-- news/position/opportunity and every question id the whole cycle
-- asked, not just that row's own slice. A future reader (the case-
-- capture work, plan §6B P0 item 3) needs the per-asset projection, not
-- the batch, or it has to reconstruct that slicing itself every time.
--
-- jev_request_projection is that projection, computed by
-- model/jev/request-projection.ts's projectJevRequestForAsset and
-- validated against a Zod envelope schema before insert (the FIRST
-- Zod-validated persisted jsonb shape originating in this backend —
-- output_payload/input_payload are both deliberately z.unknown() in
-- src/shared/decisions/types.ts, by explicit prior design; this is a
-- considered departure from that precedent, not an oversight, because
-- the whole point of this column is to BE the stable contract
-- output_payload explicitly isn't).
--
-- Scope is the REQUEST side only — every Jev OUTPUT already has its own
-- stable, individually-versioned column from the migration above
-- (entry_quality_distribution, failure_risk_distribution, etc.);
-- duplicating those into this record too would risk the exact
-- two-copies-silently-diverge drift P0 item 1 (prompt-hash.ts) exists to
-- eliminate, one column over.
--
-- Null whenever no genuine call happened for this asset this cycle (no
-- candidate, disabled layer, or a failed call) — same sentinel
-- discipline model_version/output_payload already use. Never set on the
-- occupied-asset shadow 'candidate' row (that row never calls Jev at
-- all, by design — see the 20261003150000 migration's own header).
-- ============================================================================

alter table public.agent_decisions
  add column jev_request_projection jsonb check (jev_request_projection is null or jsonb_typeof(jev_request_projection) = 'object');

comment on column public.agent_decisions.jev_request_projection is 'Stable, typed, per-asset projection of the Jev request this row''s evaluation actually used (model/jev/request-projection.ts, schemaVersion-tagged, Zod-validated at write time) — NOT the batch-wide, unstable output_payload.request. Null whenever no genuine Jev call happened for this asset this cycle (no candidate, disabled layer, failed call, or an occupied-asset shadow row, which never calls Jev at all).';
