-- ============================================================================
-- market_bars off-grid quarantine (plan STRAT-1 P2, 2026-10-08) — flags,
-- never deletes, the daily rows a confirmed look-ahead defect produced.
--
-- Root cause (full detail: strategy/closed-bars.ts's own gridAlignedTail
-- comment, and context/diagnostics/long-only-losses-investigation-
-- 2026-10-08.md): CoinGecko's /market_chart?days=120 response
-- intermittently omits today's own 00:00 point entirely, in which case the
-- trailing live point's gap from yesterday's 00:00 looks >= 24h and
-- closedPoints (a gap-based check) does not drop it — so the live spot
-- price gets written as if it were a closed daily bar. Live-measured
-- 2026-10-08: 24 off-grid '1d' rows for one single in-progress day, with
-- NO clean 00:00:00 row for it at all.
--
-- These rows are NOT deleted. Production genuinely computed its regime/
-- bias decisions from these exact values on the cycles where this fired —
-- deleting them would make those decisions unreproducible, and would
-- itself corrupt the one thing a replay harness depends on: that
-- market_bars holds what production actually used. Quarantining (flag +
-- filter at read time) preserves the audit trail while keeping every
-- NEW reader honest about which historical '1d' rows are a genuine closed
-- daily bar and which are a mislabeled live snapshot.
--
-- Going forward, no new off-grid '1d' row should ever be written:
-- providers/coingecko.ts now composes gridAlignedTail(closedPoints(...))
-- for dailyCloseSeries specifically, which trims a non-midnight-aligned
-- trailing point before it ever reaches marketBarsFromNormalizedMarketData
-- (db/market-bars.ts). is_off_grid therefore defaults false and needs no
-- write-path change — it exists purely to mark the historical rows this
-- migration backfills, from before that fix was live.
-- ============================================================================

alter table public.market_bars
  add column is_off_grid boolean not null default false;

comment on column public.market_bars.is_off_grid is 'true only for pre-2026-10-08 ''1d'' rows whose open_time is not UTC-midnight-aligned — a confirmed look-ahead defect (plan STRAT-1 P2): the value is the live spot price at write time, not a genuine closed daily close. Never read as a real daily close; replay/market-bars-reader.ts filters these out. Always false for 5m/30m/4h rows (the concept does not apply to them) and for every ''1d'' row written after the fix landed.';

update public.market_bars
set is_off_grid = true
where timeframe = '1d' and open_time::time <> '00:00:00';
