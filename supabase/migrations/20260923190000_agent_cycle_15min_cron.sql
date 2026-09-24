-- ============================================================================
-- agent-cycle automated cadence (2026-09-23/24) — explicit user instruction:
-- "Setup the cron which runs the agent every 15 minutes starting at 12:30
-- today (IST)... DO NOT remove the manual run flow."
--
-- Cost context (computed live before this migration, not guessed): one
-- agent-cycle invocation makes 7 CoinGecko requests with Balanced active,
-- 11 with Aggressive active (providers/coingecko.ts's own "1+3N"/"1+5N"
-- comments) -- at */15 cadence that is up to 2,976 ticks/month x 11 =
-- ~32,736 requests/month, well above the documented 10,000/month CoinGecko
-- Demo-tier cap, EVEN with market_quotes' own independent 5-minute poller
-- disabled below. The user was shown this math explicitly and confirmed
-- proceeding at 15 minutes regardless, to revisit the interval later --
-- this is a deliberate, informed acceptance of the overage, not an
-- oversight.
--
-- Manual invocation (the extension's "Run agent" button,
-- src/features/home/run-agent.ts, `supabase.functions.invoke('agent-cycle',
-- {body: {trigger: 'manual'}})`) is COMPLETELY UNTOUCHED by this migration
-- -- it is a direct client SDK call, entirely separate infrastructure from
-- pg_cron/net.http_post. agent-cycle's own Deno.serve handler
-- (index.ts:1495-1512) was already built anticipating this exact cron
-- shape: an empty POST body parses via cycle/idempotency.ts's parseTrigger
-- to the fail-safe 'scheduled' default (never 'manual' unless explicitly
-- requested) -- no application code changes were needed for this
-- migration, only infrastructure.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- market-refresh-5min -- DISABLED, not dropped ("might revert later to the
-- original setup", per the user's own instruction). Its whole job is
-- upserting market_quotes for the extension's live-price display;
-- agent-cycle already performs the same upsert on every run of its own
-- (architecture.md's Core Data Model section), so display freshness now
-- tracks agent-cycle's cadence (15 min, once active below) instead of a
-- separate always-on 5-minute poller -- eliminating that poller's entire
-- 8,640 requests/month at no functional loss.
-- position-monitor-10min is DELIBERATELY left untouched: it is the
-- independent SL/TP safety poll, not a "crypto data update," and disabling
-- it was never asked for and would remove real protection between
-- agent-cycle ticks.
-- ---------------------------------------------------------------------------

select cron.alter_job(
  (select jobid from cron.job where jobname = 'market-refresh-5min'),
  active => false
);

-- ---------------------------------------------------------------------------
-- agent-cycle-15min -- created but left INACTIVE here; the one-shot
-- activator below turns it on at exactly 12:30 IST (07:00 UTC) today,
-- 2026-09-24, per the user's explicit "starting at 12:30 today (IST)".
-- */15 already lands on :00/:15/:30/:45 -- 07:00 UTC is one of those marks,
-- so once active this job's first tick is exactly 12:30 IST, and every
-- 15 minutes thereafter. Same net.http_post + Vault-secret-by-name shape
-- as market-refresh-5min/position-monitor-10min above (vault.create_secret
-- for 'agent_cycle_url' was run live, outside this tracked migration, same
-- precedent as the other two url secrets -- see progress-tracker.md).
-- ---------------------------------------------------------------------------

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

select cron.alter_job(
  (select jobid from cron.job where jobname = 'agent-cycle-15min'),
  active => false
);

-- ---------------------------------------------------------------------------
-- One-shot activator -- fires exactly once, at 07:00 UTC / 12:30 IST on
-- 2026-09-24 (this specific day-of-month/month combination will not recur
-- for another year, which is what makes a standard 5-field cron expression
-- behave as a one-shot here). Activates agent-cycle-15min, then removes
-- itself -- DB-native, no dependency on any external process or session
-- staying alive in the meantime.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'agent-cycle-15min-activate-once',
  '0 7 24 9 *',
  $$
  select cron.alter_job(
    (select jobid from cron.job where jobname = 'agent-cycle-15min'),
    active => true
  );
  select cron.unschedule('agent-cycle-15min-activate-once');
  $$
);
