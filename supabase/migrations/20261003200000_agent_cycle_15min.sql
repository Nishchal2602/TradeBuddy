-- ============================================================================
-- agent-cycle cadence change: 60 minutes -> 15 minutes (2026-10-03),
-- explicit user instruction: "Change it to trade every 15 mins, precisely
-- I need more data to test my strategy. 15m V4 cadence + keep 30m bars +
-- keep 4-bar window scan + keep 10m monitor."
--
-- Scoped exactly as instructed. UNCHANGED by this migration: the 30-minute
-- signal timeframe, WINDOW_SCAN_BARS=4 (strategy/intraday-ls/detectors.ts),
-- and position-monitor's own independent 10-minute cycle. The
-- consumed-opportunity lifecycle (opportunity_bar_ts, strategy/intraday-ls/
-- lifecycle.ts) is bar-timestamp-based, not cycle-count-based, so a real
-- signal still only ever emits once per genuine 30-minute bar close
-- regardless of how many 15-minute cycles observe it — no code change
-- needed there for this to remain correct.
--
-- CoinGecko quota: user was shown the exact number before confirming
-- (same discipline as every prior cadence change in this project's
-- history) — at 11 requests/cycle (the "1+5N" shape for N=2 assets,
-- confirmed in providers/coingecko.ts's own comment), 15-minute cadence
-- is ~2,922 cycles/month x 11 = ~32,145 requests/month, 3.2x the free
-- Demo tier's 10,000/month cap. User explicitly accepted this. If the
-- monthly cap is exceeded, fetches may start failing/rate-limiting for
-- the remainder of that month — this fails cycles CLOSED (skipped, not
-- wrong data), per this project's own "stale or failed critical inputs
-- fail closed" architecture rule; it does not corrupt anything.
--
-- decision_interval_minutes (agent_settings) is updated in lockstep for
-- UI-display accuracy ONLY (Settings/Home screens read this column
-- directly, src/features/home/queries.ts + settings/queries.ts) — it is
-- NOT the value agent-cycle's own idempotency-key bucketing reads
-- anymore (that was already fixed in the 2026-10-01 Phase 0 wiring pass
-- to read strategy.decisionIntervalMinutes, the per-profile resolved
-- value, instead — see index.ts's own comment at that call site). The
-- per-profile value for intraday_ls is changed in the SAME commit as
-- this migration (src/shared/strategy/profiles.ts), in lockstep, which
-- is what actually matters for correctness this time.
-- ============================================================================

update agent_settings set decision_interval_minutes = 15;

-- Rename agent-cycle-60min -> agent-cycle-15min so the job name matches
-- its actual schedule (same convention as market-refresh-5min/
-- position-monitor-10min, and the exact pattern the 2026-09-27 60-minute
-- migration itself used). pg_cron has no in-place rename; unschedule the
-- old job and schedule a new one with the identical net.http_post body.
select cron.unschedule('agent-cycle-60min');

select cron.schedule(
  'agent-cycle-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'agent_cycle_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body    := '{}'::jsonb
  );
  $$
);
