-- ============================================================================
-- Position model rebuild — Step 1 of the position-model plan.
--
-- Replaces the long-or-flat BUY/SELL/HOLD foundation with FLAT/LONG/SHORT,
-- explicit OPEN_LONG/OPEN_SHORT/HOLD/CLOSE, mandatory SL/TP, and
-- risk-derived sizing. Source of truth for every rule enforced here:
-- context/specs/trading-domain-contract.md — this migration encodes that
-- contract as constraints; it does not redefine it.
--
-- 20260917102906_initial_schema.sql and 20260917104757_seed_v0_config.sql
-- are applied and untouched (ai-workflow-rules.md § Protected Files) — this
-- is a new migration, not an edit.
--
-- All tables affected below are empty except agent_settings' single seeded
-- row (agent_runs/agent_decisions/positions/trades have zero rows — no
-- cycle has ever executed), so NOT NULL additions need no data backfill
-- beyond agent_settings, which uses column DEFAULTs for that one row.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- agent_settings
--
-- max_position_pct and cooldown_minutes are superseded, not just renamed:
-- position size is no longer a flat NAV percentage (it's risk-derived, see
-- the contract doc §4), and the blanket cooldown is replaced by an
-- asymmetric stop-out re-entry block that never gates a CLOSE.
-- ---------------------------------------------------------------------------
alter table public.agent_settings
  drop column max_position_pct,
  drop column cooldown_minutes;

alter table public.agent_settings
  add column max_single_trade_pct         numeric(6, 4) not null default 0.2000,
  add column max_asset_exposure_pct       numeric(6, 4) not null default 0.3500,
  add column monitor_interval_minutes     integer       not null default 10,
  add column stop_out_reentry_block_minutes integer     not null default 360;

comment on column public.agent_settings.max_single_trade_pct is
  'Hard cap on any one trade''s notional as % of NAV (0.20 = 20%). Binds before max_asset_exposure_pct in V0 since one net position per asset means per-trade and per-asset exposure are the same number — see trading-domain-contract.md §4 worked example.';
comment on column public.agent_settings.max_asset_exposure_pct is
  'Hard cap on total notional per asset as % of NAV. Structurally inert in V0 (see max_single_trade_pct comment) — implemented now because it becomes load-bearing the moment pyramiding/multi-leg positions exist, not because it does anything yet.';
comment on column public.agent_settings.stop_out_reentry_block_minutes is
  'Blocks re-opening the SAME asset in the SAME direction for this long after a stop-loss exit — a deterministic proxy for "avoid the same failed thesis," not real thesis matching. Never blocks CLOSE, under any condition.';

-- SL/TP distance bounds. Deliberately provisional wide placeholders, NOT
-- final values — the actual numbers are a decision for the NEWS/TECHNICAL
-- methodology review, explicitly deferred (position-model plan). The one
-- bound that is NOT a free tuning choice: a short's stop-loss distance must
-- stay below 100%, enforced separately and unconditionally by
-- positions_sl_tp_ordering_valid below, independent of whatever value
-- max_stop_loss_pct eventually takes.
alter table public.agent_settings
  add column min_stop_loss_pct   numeric(6, 4) not null default 0.0050,
  add column max_stop_loss_pct   numeric(6, 4) not null default 0.1500,
  add column min_take_profit_pct numeric(6, 4) not null default 0.0050,
  add column max_take_profit_pct numeric(6, 4) not null default 0.5000,
  add constraint agent_settings_max_single_trade_pct_range
    check (max_single_trade_pct > 0 and max_single_trade_pct <= 1),
  add constraint agent_settings_max_asset_exposure_pct_range
    check (max_asset_exposure_pct > 0 and max_asset_exposure_pct <= 1),
  add constraint agent_settings_monitor_interval_positive
    check (monitor_interval_minutes > 0),
  add constraint agent_settings_reentry_block_nonneg
    check (stop_out_reentry_block_minutes >= 0),
  add constraint agent_settings_sl_bounds_valid
    check (min_stop_loss_pct > 0 and min_stop_loss_pct < max_stop_loss_pct and max_stop_loss_pct < 1),
  add constraint agent_settings_tp_bounds_valid
    check (min_take_profit_pct > 0 and min_take_profit_pct < max_take_profit_pct);

-- ---------------------------------------------------------------------------
-- positions
--
-- direction/stop_loss_price/take_profit_price/close_reason turn the
-- long-or-flat model into FLAT/LONG/SHORT with mandatory, validated SL/TP.
-- The table has zero rows, so these are added NOT NULL directly except
-- close_reason (nullable until closed, same pattern as closed_at).
-- ---------------------------------------------------------------------------
alter table public.positions
  add column direction         text           not null,
  add column stop_loss_price   numeric(20, 8) not null,
  add column take_profit_price numeric(20, 8) not null,
  add column close_reason      text;

alter table public.positions
  add constraint positions_direction_valid check (direction in ('long', 'short')),
  add constraint positions_close_reason_valid check (
    close_reason is null or close_reason in ('agent_close', 'stop_loss', 'take_profit', 'collateral_exhausted')
  ),
  -- Direction-dependent ordering, combined with the short exhaustion
  -- ceiling as ONE predicate — a validator that checks ordering alone
  -- accepts a short stop at exactly 2x entry, which is structurally
  -- unreachable (collateral exhaustion fires first). This is the exact bug
  -- caught while building the Step 0 fixtures (contract.test.ts) — see
  -- trading-domain-contract.md §3.
  add constraint positions_sl_tp_ordering_valid check (
    (direction = 'long'
      and stop_loss_price < entry_price
      and entry_price < take_profit_price)
    or
    (direction = 'short'
      and take_profit_price < entry_price
      and entry_price < stop_loss_price
      and stop_loss_price < entry_price * 2)
  );

-- Widen the existing open/closed field-presence rule to also require
-- close_reason exactly when closed. Dropping and re-adding rather than
-- editing in place — Postgres has no ALTER CONSTRAINT for a CHECK
-- expression.
alter table public.positions drop constraint positions_closed_fields;
alter table public.positions add constraint positions_closed_fields check (
  (status = 'open'   and closed_at is null     and realized_pnl is null     and close_reason is null) or
  (status = 'closed' and closed_at is not null and realized_pnl is not null and close_reason is not null)
);

comment on column public.positions.stop_loss_price is
  'Absolute price, computed by deterministic code from the model''s proposed percentage distance at open time — never trusted as an absolute value directly from the model.';
comment on column public.positions.close_reason is
  'agent_close = closed by an OPEN_LONG/OPEN_SHORT/CLOSE decision; stop_loss/take_profit/collateral_exhausted = closed automatically by the position monitor. Mirrors trades.trigger_reason for the trade that closed this position.';

-- ---------------------------------------------------------------------------
-- agent_decisions
--
-- Action vocabulary changes from BUY/SELL/HOLD to
-- OPEN_LONG/OPEN_SHORT/HOLD/CLOSE (not BUY/SELL — ambiguous once both
-- directions exist). The model no longer proposes size directly
-- (proposed_size_pct dropped); it proposes SL/TP percentages, and
-- deterministic code derives size from risk-at-stop plus the caps above.
-- ---------------------------------------------------------------------------
alter table public.agent_decisions drop constraint agent_decisions_action_valid;
alter table public.agent_decisions add constraint agent_decisions_action_valid
  check (action in ('OPEN_LONG', 'OPEN_SHORT', 'HOLD', 'CLOSE'));

-- Drops its own range constraint (agent_decisions_proposed_size_range)
-- automatically — that constraint references only this column.
alter table public.agent_decisions drop column proposed_size_pct;

alter table public.agent_decisions
  add column position_id                     uuid references public.positions (id) on delete set null,
  add column proposed_stop_loss_pct          numeric(6, 4),
  add column proposed_take_profit_pct        numeric(6, 4),
  add column computed_stop_loss_price        numeric(20, 8),
  add column computed_take_profit_price      numeric(20, 8),
  add column effective_risk_budget_pct       numeric(6, 4) not null default 0,
  add column effective_single_trade_cap_pct  numeric(6, 4) not null default 0,
  add column effective_asset_exposure_cap_pct numeric(6, 4) not null default 0,
  add column size_cap_applied               text;

-- The DEFAULT 0 above exists only so the ADD COLUMN succeeds against an
-- empty table without a data backfill question; it is not a meaningful
-- value and every real row the application ever inserts must supply an
-- actual effective_* figure. Drop the default now so future inserts fail
-- loudly if the application forgets to stamp one, rather than silently
-- writing 0.
alter table public.agent_decisions
  alter column effective_risk_budget_pct        drop default,
  alter column effective_single_trade_cap_pct   drop default,
  alter column effective_asset_exposure_cap_pct drop default;

alter table public.agent_decisions
  add constraint agent_decisions_proposed_sl_range
    check (proposed_stop_loss_pct is null or (proposed_stop_loss_pct > 0 and proposed_stop_loss_pct < 1)),
  add constraint agent_decisions_proposed_tp_range
    check (proposed_take_profit_pct is null or proposed_take_profit_pct > 0),
  add constraint agent_decisions_effective_risk_budget_range
    check (effective_risk_budget_pct >= 0 and effective_risk_budget_pct <= 1),
  add constraint agent_decisions_effective_single_trade_cap_range
    check (effective_single_trade_cap_pct >= 0 and effective_single_trade_cap_pct <= 1),
  add constraint agent_decisions_effective_asset_exposure_cap_range
    check (effective_asset_exposure_cap_pct >= 0 and effective_asset_exposure_cap_pct <= 1),
  add constraint agent_decisions_size_cap_applied_valid
    check (size_cap_applied is null or size_cap_applied in ('single_trade', 'asset_exposure', 'cash'));

comment on column public.agent_decisions.position_id is
  'The position this decision opened, closed, or (for a HOLD on an open position) is currently tracking. Null for a HOLD while flat.';
comment on column public.agent_decisions.effective_risk_budget_pct is
  'The risk-appetite-derived risk budget in force when this decision was gated (trading-domain-contract.md §4) — denormalised on the decision itself, same reasoning as effective_min_confidence: re-tuning the mapping later must never make historical decisions unreadable.';
comment on column public.agent_decisions.size_cap_applied is
  'Which hard cap, if any, clamped the risk-derived size. Null when the risk-derived size needed no clamping, or the decision was not an open.';

-- ---------------------------------------------------------------------------
-- trades
--
-- decision_id becomes nullable (an automatic SL/TP/exhaustion exit has no
-- agent decision); position_id becomes mandatory (every trade, agent- or
-- monitor-initiated, belongs to exactly one position). intent +
-- trigger_reason + trades_provenance_valid together make a trade's
-- provenance unambiguous from the row alone — see
-- trading-domain-contract.md §4 for the three legal combinations and why
-- an earlier draft's "exactly one of decision_id/trigger_reason" framing
-- was wrong (an agent-initiated close legitimately carries both).
-- ---------------------------------------------------------------------------
alter table public.trades alter column decision_id drop not null;

-- position_id already exists (added in the initial schema, nullable, FK
-- ON DELETE SET NULL). Made mandatory here. Note: ON DELETE SET NULL
-- against a NOT NULL column is a latent inconsistency that would only
-- surface if a position row were ever deleted — nothing in this
-- application ever deletes a position (positions are opened and closed,
-- never removed), so it is inert in practice. Left as-is rather than
-- guessing the auto-generated FK constraint name to change it, since
-- fixing an unreachable edge case isn't worth that risk — revisit if
-- position deletion is ever introduced.
alter table public.trades alter column position_id set not null;

alter table public.trades
  add column intent         text not null default 'OPEN_LONG',
  add column trigger_reason text;

-- Same reasoning as agent_decisions.effective_*: the DEFAULT above only
-- exists to satisfy ADD COLUMN NOT NULL against an empty table. Every real
-- trade the application inserts must supply an actual intent explicitly.
alter table public.trades alter column intent drop default;

alter table public.trades
  add constraint trades_intent_valid
    check (intent in ('OPEN_LONG', 'OPEN_SHORT', 'CLOSE_LONG', 'CLOSE_SHORT')),
  add constraint trades_trigger_reason_valid
    check (trigger_reason is null or trigger_reason in ('agent_close', 'stop_loss', 'take_profit', 'collateral_exhausted')),
  add constraint trades_provenance_valid check (
    (intent in ('OPEN_LONG', 'OPEN_SHORT')
       and decision_id is not null and trigger_reason is null)
    or
    (intent in ('CLOSE_LONG', 'CLOSE_SHORT')
       and decision_id is not null and trigger_reason = 'agent_close')
    or
    (intent in ('CLOSE_LONG', 'CLOSE_SHORT')
       and decision_id is null
       and trigger_reason in ('stop_loss', 'take_profit', 'collateral_exhausted'))
  );

-- Race-safety backstop for the agent-cycle-vs-position-monitor concurrent
-- close (trading-domain-contract.md §6): at most one close-trade per
-- position, regardless of which path wrote it. The primary defense is the
-- conditional UPDATE ... WHERE status = 'open' in the application code;
-- this is the DB-level guarantee if that check is ever bypassed.
create unique index trades_one_close_per_position_idx
  on public.trades (position_id)
  where intent in ('CLOSE_LONG', 'CLOSE_SHORT');

comment on column public.trades.intent is
  'The mechanical action this trade performed. Distinct from agent_decisions.action: intent describes the trade (CLOSE_LONG closes a long via a sell), action describes the model''s decision (CLOSE is direction-agnostic).';

-- ---------------------------------------------------------------------------
-- agent_runs
--
-- kind distinguishes the two independent scheduled cycles that now write
-- to this table — the 3-hour decision cycle and the 10-minute position
-- monitor (trading-domain-contract.md §5) — so idempotency keys and run
-- history for each are queryable separately.
-- ---------------------------------------------------------------------------
alter table public.agent_runs
  add column kind text not null default 'decision';

alter table public.agent_runs
  add constraint agent_runs_kind_valid check (kind in ('decision', 'monitor'));

create index agent_runs_kind_started_idx
  on public.agent_runs (kind, started_at desc);

comment on column public.agent_runs.kind is
  'decision = the 3-hour Gemini decision cycle; monitor = the 10-minute SL/TP/collateral-exhaustion execution cycle. Two independent pg_cron jobs write here.';
