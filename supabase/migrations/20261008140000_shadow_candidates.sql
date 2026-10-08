-- ============================================================================
-- STRAT-1 P3 (2026-10-08) — event-keyed shadow candidates + a random-entry
-- baseline. The evidence instrument for "does any of the six arms actually
-- have an edge, and over random chance?" — answerable only once enough of
-- these rows exist, which is why this ships now rather than waiting on P5's
-- historical engine (P3 is live-forward data collection, zero trading risk).
--
-- KEYED ON THE MARKET EVENT, NOT THE RUN (plan correction E2, found during
-- the first STRAT-1 draft's review): `unique(run_id, asset, arm_id)` would
-- re-log the identical edge up to 8x (a 4-bar/2h window, scanned every 15
-- minutes) and once per portfolio on top of that. `unique(asset, arm_id,
-- trigger_bar_ts, detector_version)` has neither problem — the SAME bar
-- close detected by the SAME detector version produces exactly one row,
-- system-wide, no matter how many accounts or cycles observe it. run_id/
-- portfolio_id are kept as PROVENANCE only (which cycle first logged this
-- event), never part of the identity.
--
-- shadow_cause has FIVE values beyond the plan's own literal four
-- ('taken'/'bias_blocked'/'arm_disabled'/'direction_disabled'): the fifth,
-- 'lower_priority', covers a real, reachable case the plan's prose didn't
-- enumerate — both trend arms for one direction (e.g. breakout_long AND
-- pullback_long) can independently edge in the same cycle, and
-- detectIntradayLsOpportunity's own breakout-before-pullback priority
-- means only one is ever promoted. The other is fully bias-eligible and
-- arm-enabled; it is simply never reached. Mislabeling it 'bias_blocked'
-- or 'arm_disabled' would be false. 'baseline' is the sixth value, for the
-- random-entry control rows (no detector, no signal).
--
-- Forward outcomes (return/mfe/mae at 1h/4h/8h) are DEFERRED and NULLABLE —
-- they require future price data that does not exist at detection time.
-- A separate labeler job (not built in this migration) fills them in once
-- 8h has elapsed, reading the 30m TRUE-OHLC series (never 5m/1d close-only
-- — invariant I12). Deliberately NOT stored as [pessimistic, optimistic]
-- intervals (invariant I11 is about EXIT ORDER ambiguity within one bar,
-- which only applies to a realized stop/target resolution; MFE/MAE/return
-- are pure, order-independent price-path statistics over a fixed forward
-- window, so a single point value is both correct and simpler — a
-- deliberate, documented reading of I11's own scope, not an oversight).
-- ============================================================================

create table public.shadow_candidates (
  id                   uuid primary key default gen_random_uuid(),

  -- identity (what this row is a shadow OF)
  asset                text not null,
  arm_id               text not null check (arm_id in (
                         'breakout_long', 'breakout_short', 'pullback_long', 'pullback_short',
                         'fade_long', 'fade_short', 'baseline_long', 'baseline_short'
                       )),
  arm_family           text not null check (arm_family in ('breakout', 'pullback', 'fade', 'baseline')),
  direction            text not null check (direction in ('long', 'short')),
  detector_version     text not null,
  trigger_bar_ts       timestamptz not null,

  -- regime, as two SEPARATE sliceable legs (never only the fused bias) --
  regime_daily         text not null check (regime_daily in ('UP', 'DOWN')),
  regime_4h            text not null check (regime_4h in ('Up', 'Down')),
  bias_resolved        text not null check (bias_resolved in ('LONG', 'SHORT', 'NEUTRAL')),

  -- why this event did/didn't become the real candidate --
  shadow_cause         text not null check (shadow_cause in (
                         'taken', 'bias_blocked', 'arm_disabled', 'direction_disabled', 'lower_priority', 'baseline'
                       )),

  -- geometry, model-free — enough for a labeler to compute R without
  -- re-deriving protection.ts's own formula --
  trigger_bar_close    numeric not null check (trigger_bar_close > 0),
  reference_price      numeric not null check (reference_price > 0),
  stop_loss_pct        numeric not null check (stop_loss_pct > 0),
  take_profit_pct      numeric not null check (take_profit_pct > 0),
  stop_loss_price      numeric not null check (stop_loss_price > 0),
  take_profit_price    numeric not null check (take_profit_price > 0),

  -- signal-time features (plan P3's "feature set a meta-labeller would
  -- later train on") — nullable only because a baseline row has no signal
  atr_pct              numeric,
  rsi14                numeric,
  ret_60m_pct          numeric,
  hour_of_day          int check (hour_of_day between 0 and 23),
  day_of_week          int check (day_of_week between 0 and 6),

  -- provenance, never part of identity --
  strategy_config_hash text,
  portfolio_id         uuid references public.portfolios(id),
  run_id               uuid references public.agent_runs(id),
  detected_at          timestamptz not null default now(),

  -- deferred forward outcomes (STRAT-1 P3's own labeler job, not built
  -- here) — computed from the 30m true-OHLC series once 8h has elapsed
  return_1h            numeric,
  return_4h            numeric,
  return_8h            numeric,
  mfe_r_1h             numeric,
  mfe_r_4h             numeric,
  mfe_r_8h             numeric,
  mae_r_1h             numeric,
  mae_r_4h             numeric,
  mae_r_8h             numeric,
  resolved_at          timestamptz,
  labeler_version      text,

  unique (asset, arm_id, trigger_bar_ts, detector_version)
);

comment on table public.shadow_candidates is 'STRAT-1 P3 (2026-10-08) — event-keyed shadow candidates (all six arms, ungated by bias/config/position-state) plus a random-entry baseline. Write-only from agent-cycle, non-fatal on failure (observational telemetry, never a trading action). Forward outcomes are filled in later by a separate labeler job. Portfolio-independent by design: one real market edge produces exactly one row no matter how many accounts or cycles observe it.';
comment on column public.shadow_candidates.shadow_cause is 'taken = this IS the real candidate this cycle; bias_blocked = bias did not permit this arm; arm_disabled = config disabled this arm; direction_disabled = a detected short while shortEnabled=false; lower_priority = bias-eligible and arm-enabled, but a higher-priority arm (breakout before pullback) was already promoted this cycle; baseline = the random-entry control, no detector involved.';
comment on column public.shadow_candidates.regime_4h is 'The raw 4h EMA20-vs-EMA50 cross alone, independent of the daily leg bias.ts fuses it with — see strategy/intraday-ls/bias.ts''s evaluateH4Trend (additive, does not change evaluateBias itself).';

alter table public.shadow_candidates enable row level security;
create policy "anon read shadow_candidates" on public.shadow_candidates for select to anon using (true);
