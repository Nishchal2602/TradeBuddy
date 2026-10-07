-- ============================================================================
-- EXP-1 Stage E2 (2026-10-07) — experiments as a first-class, reusable
-- concept. Governing distinction (the plan's own, after user review):
--
--   A VARIANT defines the TREATMENT — what is being tested.
--   A PORTFOLIO is an INSTANCE running that treatment.
--
-- Anything that is part of the hypothesis lives on experiment_variants.
-- Anything that merely parameterises one running copy (starting capital,
-- above all) lives on portfolios. This is why starting_capital is NOT a
-- variant column: "₹10k vs ₹50k" is not a different strategy, it is a
-- different account running the SAME strategy — conflating the two would
-- turn a clean 5-config x 4-cadence x 5-capital grid into 100
-- semantically-identical-looking variants.
--
-- Named experiment_variants, deliberately NOT experiment_arms: "arm"
-- already means something specific and load-bearing in this codebase —
-- the six detector arms (ArmId, armFamilyOf, agent_decisions.arm_id/
-- arm_family, eligible_arms). Reusing it here would collide with the
-- exact vocabulary CFG-1 Stage 0 went out of its way to decompose.
-- ============================================================================

create table public.experiments (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null unique,
  hypothesis         text not null,   -- pre-registration, not decoration — §6B's own discipline
  status             text not null check (status in ('draft','running','completed','abandoned')),
  pre_registered_at  timestamptz,
  started_at         timestamptz,
  ended_at           timestamptz,
  notes              text,
  created_at         timestamptz not null default now()
);

comment on table public.experiments is 'EXP-1 (2026-10-07) — the top-level container for one pre-registered question. hypothesis is required at creation, not filled in after the fact, per this project''s own selection-inflation discipline (CFG-1 §6B).';

alter table public.experiments enable row level security;
create policy "anon read experiments" on public.experiments for select to anon using (true);

-- THE TREATMENT. Every column here is part of the hypothesis being tested.
create table public.experiment_variants (
  id                          uuid primary key default gen_random_uuid(),
  experiment_id                uuid not null references public.experiments(id) on delete cascade,
  name                         text not null,
  strategy_config_id           uuid not null references public.strategy_configs(id),
  decision_interval_minutes     int not null check (decision_interval_minutes % 15 = 0 and decision_interval_minutes between 15 and 1440),
  assets                       text[] not null check (array_length(assets, 1) between 1 and 4),
  news_veto_enabled             boolean not null default true,
  management_enabled           boolean not null default true,
  -- Immutability: null while being designed; set once, never cleared,
  -- the moment the parent experiment starts (trigger below). A running
  -- experiment's variant must never change meaning mid-flight — the
  -- same discipline strategy_configs already enforces for configs
  -- themselves (a change is a new row, never a silent edit).
  frozen_at                    timestamptz,
  created_at                   timestamptz not null default now(),
  unique (experiment_id, name)
);

comment on table public.experiment_variants is 'EXP-1 (2026-10-07) — THE TREATMENT: config x cadence x asset-subset x Jev policy. Starting capital is deliberately NOT here — it is an account-instance property (portfolios.starting_capital), not part of what is being tested. Frozen (immutable) once the parent experiment''s status moves to running — see enforce_variant_freeze below.';

alter table public.experiment_variants enable row level security;
create policy "anon read experiment_variants" on public.experiment_variants for select to anon using (true);

-- Freeze enforcement: once frozen_at is set, none of the treatment
-- columns may change. Designing is free; running is immutable. Changing
-- your mind means a NEW variant, exactly as changing a config means a
-- new strategy_configs row.
create or replace function public.enforce_variant_freeze() returns trigger as $$
begin
  if old.frozen_at is not null then
    if new.strategy_config_id        is distinct from old.strategy_config_id
    or new.decision_interval_minutes is distinct from old.decision_interval_minutes
    or new.assets                    is distinct from old.assets
    or new.news_veto_enabled         is distinct from old.news_veto_enabled
    or new.management_enabled       is distinct from old.management_enabled
    then
      raise exception 'experiment_variants: cannot modify a frozen variant''s treatment columns (variant %, frozen at %) — create a new variant instead', old.id, old.frozen_at;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger experiment_variants_enforce_freeze
  before update on public.experiment_variants
  for each row execute function public.enforce_variant_freeze();

-- experiments.status -> 'running' freezes every variant under it that
-- isn't already frozen. One-directional (never un-freezes on a status
-- change away from 'running') — a completed/abandoned experiment's
-- variants stay exactly as immutable as a running one's.
create or replace function public.freeze_variants_on_experiment_start() returns trigger as $$
begin
  if new.status = 'running' and old.status is distinct from 'running' then
    update public.experiment_variants
      set frozen_at = now()
      where experiment_id = new.id and frozen_at is null;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger experiments_freeze_variants_on_start
  after update on public.experiments
  for each row execute function public.freeze_variants_on_experiment_start();

-- The logical clock of the whole experiment. Exactly one row per
-- 15-minute wall-clock slot, enforced by the DB (logical_tick_at
-- unique) — this is what closes the DISPATCHER-level race a per-account
-- idempotency key alone cannot: two dispatcher invocations for the same
-- slot (a cron retry, an overlap, a manual trigger) both attempt the
-- insert; exactly one wins, the loser reuses the winner's id rather
-- than re-fetching or fanning out a second time.
create table public.market_ticks (
  id               uuid primary key default gen_random_uuid(),
  logical_tick_at  timestamptz not null unique,
  captured_at      timestamptz,
  assets           text[] not null,
  payload          jsonb,
  status           text not null default 'fetching' check (status in ('fetching','ready','failed')),
  created_at       timestamptz not null default now(),
  -- A 'ready' tick must actually have a payload and a capture time — the
  -- claim-then-fetch flow inserts 'fetching' with both null, then a
  -- single follow-up update sets payload/captured_at and flips status to
  -- 'ready' together. Never ready-with-no-payload.
  constraint market_ticks_ready_has_payload check (
    status <> 'ready' or (payload is not null and captured_at is not null)
  )
);

comment on table public.market_ticks is 'EXP-1 (2026-10-07) — the experiment''s logical decision clock. logical_tick_at is THE experiment timestamp every account at this tick reasons from (never agent_decisions.decided_at, which is real per-account processing time and legitimately differs across accounts in the same tick — see the plan''s own "three clocks" section). payload is the verbatim fetched market+news data, never reconstructed from market_bars (Stage 2''s own live-input inventory proved market_bars cannot reproduce the hourly closeSeries/volumeSeries or the spot price).';
comment on column public.market_ticks.status is 'fetching: claimed, fetch in progress. ready: payload is complete and safe to fan out from. failed: the fetch errored — never fan out from a failed or still-fetching tick.';

alter table public.market_ticks enable row level security;
create policy "anon read market_ticks" on public.market_ticks for select to anon using (true);

-- THE INSTANCE. starting_capital already exists (portfolios.cash /
-- starting_capital, from the original schema) — only the experiment
-- linkage is new here.
alter table public.portfolios
  add column experiment_variant_id uuid references public.experiment_variants(id);

comment on column public.portfolios.experiment_variant_id is 'EXP-1 (2026-10-07) — which treatment this account is running. NULL for the live champion. starting_capital (pre-existing column) is this account''s own instance property, deliberately not duplicated onto the variant.';

-- Snapshot the FULLY RESOLVED treatment onto every run, so a run is
-- reproducible without ever consulting mutable configuration — the same
-- discipline agent_decisions.strategy_config_hash already established
-- ("a result is only ever claimed for one config hash"), extended to
-- the four additional variables EXP-1 introduces (cadence, assets, both
-- Jev flags) that strategy_config_hash alone does not cover. All
-- nullable: every pre-EXP-1 row and the live champion's own runs keep
-- null, meaning "no experiment, resolved from global agent_settings" —
-- exactly today's behavior.
alter table public.agent_runs
  add column experiment_id          uuid references public.experiments(id),
  add column experiment_variant_id  uuid references public.experiment_variants(id),
  add column strategy_config_hash   text,
  add column cadence_minutes        int,
  add column assets                 text[],
  add column news_veto_enabled      boolean,
  add column management_enabled    boolean,
  add column market_tick_id         uuid references public.market_ticks(id);

comment on column public.agent_runs.market_tick_id is 'EXP-1 (2026-10-07) — the market_ticks row this run''s decision was made under. The synchronization invariant is "same cadence -> same market_tick_id", proven on THIS column, never on agent_decisions.decided_at (which is real per-account processing time, not the experiment''s logical clock).';
