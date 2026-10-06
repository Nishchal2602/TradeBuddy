-- ============================================================================
-- strategy_configs + agent_decisions observability (CFG-1 Stage 1A,
-- 2026-10-06) — the config-as-data layer and the fields that make it
-- attributable. No seed data here deliberately: ensureConfigSeeded()
-- (agent-cycle/db/strategy-config.ts) inserts the two presets on first
-- use, computing each row's own content hash at insert time — this
-- avoids any risk of a migration-time hash computed by a different code
-- path than the runtime verifier ever disagreeing with it.
--
-- The three new agent_decisions columns are the direct answer to this
-- plan's own motivating question ("why does it never short, is it a
-- bug"): regime_state and eligible_arms are persisted on EVERY row,
-- not just when an arm fires (arm_id already only does that) — so F1
-- ("bias has read LONG on literally every decision") and F3/F4
-- ("NEUTRAL is common but the arms it enables never fire") become a
-- GROUP BY against this table instead of market_bars archaeology.
-- ============================================================================

create table public.strategy_configs (
  id          uuid primary key default gen_random_uuid(),
  profile     text not null check (profile in ('balanced', 'aggressive', 'intraday_ls')),
  preset_name text not null,
  config      jsonb not null,
  config_hash text not null,
  is_active   boolean not null default false,
  created_at  timestamptz not null default now()
);

-- At most one active config per profile — mirrors agent_settings'
-- singleton pattern (a partial unique index, not a CHECK, since the
-- uniqueness spans rows).
create unique index strategy_configs_one_active_per_profile
  on public.strategy_configs (profile) where is_active;

-- A config_hash is looked up far more often than it's listed by
-- preset_name, but both patterns matter for a future replay harness
-- ("find the config this historical decision ran under").
create index strategy_configs_hash_idx on public.strategy_configs (config_hash);
create unique index strategy_configs_profile_preset_name_idx on public.strategy_configs (profile, preset_name);

comment on table public.strategy_configs is 'Content-hashed, versioned strategy configuration (CFG-1). A config change is an explicit new row with a new hash, never a silent edit to an existing one — pre-registration now means "a result is only ever claimed for one config hash," not "the number never changes."';
comment on column public.strategy_configs.config_hash is 'SHA-256 of the config''s canonical JSON (src/shared/strategy/config-schema.ts''s configHashInput, excluding presetName) via the same hashPromptContent primitive P0 item 1 built for prompt-artifact hashing. Recomputed and verified on every read (agent-cycle/db/strategy-config.ts) — a mismatch means the row was edited outside computeConfigHash.';

alter table public.strategy_configs enable row level security;
create policy "anon read strategy_configs" on public.strategy_configs for select to anon using (true);

alter table public.agent_decisions
  add column strategy_config_hash text,
  add column regime_state         text check (regime_state is null or regime_state in ('LONG', 'SHORT', 'NEUTRAL')),
  add column eligible_arms        text[],
  add column no_candidate_reason  text check (
    no_candidate_reason is null or no_candidate_reason in (
      'data_insufficient', 'regime_null', 'no_arm_triggered', 'cost_gate',
      'opportunity_consumed', 'arm_disabled', 'direction_disabled'
    )
  );

comment on column public.agent_decisions.strategy_config_hash is 'CFG-1 — the exact strategy_configs.config_hash this decision ran under. NULL for every pre-2026-10-06 row and for any non-intraday_ls profile (config-as-data is scoped to intraday_ls in this pass).';
comment on column public.agent_decisions.regime_state is 'CFG-1 — bias.ts''s evaluateBias() result (LONG/SHORT/NEUTRAL), persisted on EVERY intraday_ls row, not only when an arm fires (unlike the pre-existing bias column, which — despite the identical name/values — was only ever written alongside arm_id). NULL means either evaluateBias returned null (insufficient daily/4h history) or this is not an intraday_ls row; no_candidate_reason disambiguates the former.';
comment on column public.agent_decisions.eligible_arms is 'CFG-1 — directionPolicy[regime_state] at decision time: which arm ids were ELIGIBLE to be attempted this cycle, regardless of whether one actually fired. NULL when regime_state is null.';
comment on column public.agent_decisions.no_candidate_reason is 'CFG-1 — WHY no candidate was built this cycle, for an intraday_ls row with no arm_id. Makes F1/F3/F4-style findings (this plan''s own motivating investigation) a live GROUP BY instead of archaeology. NULL exactly when arm_id is populated (a candidate WAS built) or this is not an intraday_ls candidate-eligible row.';
