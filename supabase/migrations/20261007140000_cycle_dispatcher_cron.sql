-- ============================================================================
-- EXP-1 Stage E4 (2026-10-07) — cycle-dispatcher's own standing pg_cron
-- schedule. This is the dispatcher's first CONTINUOUS live operation —
-- E3 only ever proved the mechanism via manual invocation against
-- throwaway test accounts, created and deleted within the same session.
--
-- Same 15-minute grid as agent-cycle-15min (the finest cadence any
-- experiment_variant may declare — decision_interval_minutes % 15 = 0),
-- and the identical net.http_post + Vault-secret-by-name shape every
-- prior cron job in this project uses (position-monitor-10min,
-- agent-cycle-15min). The URL secret ('cycle_dispatcher_url') was
-- created via a one-time manual `vault.create_secret(...)` call against
-- the live project, NOT in this migration — consistent with how every
-- other function URL secret in this project is handled (the service-
-- role key the SAME WAY — real secret values never enter a tracked
-- migration file).
--
-- The live CHAMPION account is completely unaffected by this job: the
-- dispatcher only ever resolves is_test=true portfolios (see cycle-
-- dispatcher/index.ts's own module comment) — agent-cycle-15min keeps
-- calling agent-cycle directly for the champion, exactly as before.
--
-- Cost: with zero due test accounts, each tick is a single cheap SELECT
-- (no CoinGecko/news calls, no market_ticks row written) — see
-- runCycleDispatcher's own no_due_accounts early-return, live-verified
-- during E3. Once EXP-1 Stage E4's dry-run accounts are seeded, real
-- CoinGecko/news/Jev cost begins accruing for those accounts' own
-- cadences — expected and accepted for the dry run's duration.
-- ============================================================================

select cron.schedule(
  'cycle-dispatcher-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'cycle_dispatcher_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body    := '{}'::jsonb
  );
  $$
);
