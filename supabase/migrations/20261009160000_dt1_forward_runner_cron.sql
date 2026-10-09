-- DT-1 forward paper experiment (2026-10-09) — dt1-forward-runner's own
-- standing pg_cron schedule. Same 10-minute cadence and identical
-- net.http_post + Vault-secret-by-name shape every prior cron job in this
-- project uses (position-monitor-10min, agent-cycle-15min,
-- cycle-dispatcher-15min). The URL secret ('dt1_forward_runner_url') was
-- created via a one-time manual `vault.create_secret(...)` call against
-- the live project, NOT in this migration — consistent with how every
-- other function URL secret in this project is handled.
--
-- This cron is completely independent of agent-cycle-15min,
-- cycle-dispatcher-15min, and position-monitor-10min (all three currently
-- unscheduled per 20261008170000_disable_v4_trading_crons.sql, following
-- R4's rejection of V4) — it calls none of them and is called by none of
-- them. The champion account and every EXP-1 test account are completely
-- unaffected: dt1-forward-runner only ever touches the two portfolios
-- labelled 'dt1-forward-btc'/'dt1-forward-eth', seeded in
-- 20261009150000_dt1_forward_experiment.sql.

select cron.schedule(
  'dt1-forward-runner-10min',
  '*/10 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'dt1_forward_runner_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body    := '{}'::jsonb
  );
  $$
);
