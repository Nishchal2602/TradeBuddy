-- ============================================================================
-- agent-cycle cadence change: 15 minutes -> 60 minutes (2026-09-27), explicit
-- user instruction: "Change the agent/ trade execution from 15 minutes to
-- 60 minutes."
--
-- This also resolves the CoinGecko quota overage accepted on 2026-09-24
-- (up to ~32,736 requests/month at */15 with Aggressive active, against a
-- 10,000/month Demo-tier cap) -- at */60 the same 11-requests/tick math is
-- at most 744 ticks/month x 11 = ~8,184 requests/month, comfortably under
-- the cap. Not the reason for this change, but a direct consequence of it.
--
-- decision_interval_minutes is updated in lockstep with the cron schedule
-- below, not left at its old value. This column drives two things read in
-- agent-cycle/index.ts: the idempotency-key flooring (buildDecisionIdempotencyKey,
-- cycle/idempotency.ts) and the news-lookback window (index.ts ~431). Leaving
-- it at 15 while the cron runs hourly would silently narrow the news
-- lookback to the last 15 minutes instead of the full hour since the prior
-- decision, missing 45 minutes of news on every tick -- the exact class of
-- bug already found once this session (decision_interval_minutes left at
-- 180 after the 15-min cron was set up). The per-profile wiring of
-- strategy.decisionIntervalMinutes (src/shared/strategy/profiles.ts) into
-- these two read sites remains the parked permanent fix -- unaffected by
-- this migration, still deferred to a future enhancement pass.
--
-- Manual invocation (src/features/home/run-agent.ts) is untouched, as with
-- every prior cadence change -- entirely separate infrastructure from
-- pg_cron/net.http_post.
-- ============================================================================

update agent_settings set decision_interval_minutes = 60;

-- ---------------------------------------------------------------------------
-- Rename agent-cycle-15min -> agent-cycle-60min so the job name matches its
-- actual schedule (same convention as market-refresh-5min/position-monitor-10min).
-- pg_cron has no in-place rename; unschedule the old job and schedule a new
-- one with the identical net.http_post body, now on an hourly cadence
-- (top of every hour).
-- ---------------------------------------------------------------------------

select cron.unschedule('agent-cycle-15min');

select cron.schedule(
  'agent-cycle-60min',
  '0 * * * *',
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
