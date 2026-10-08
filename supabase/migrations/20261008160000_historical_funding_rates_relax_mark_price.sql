-- ============================================================================
-- RESEARCH-1 (2026-10-08) — found live, not assumed: real Binance funding-
-- rate history includes entries with mark_price = 0 (pre-tracking/
-- placeholder rows from early in a symbol's own funding history), which
-- the original `mark_price > 0` check rejected outright, silently
-- blocking ingestion for every asset at the very first funding row. A
-- mark price of 0 is a real, if degenerate, value from the provider --
-- recorded as-is, never discarded, matching this project's own "never
-- guess, never silently drop provider data" discipline.
-- ============================================================================

alter table public.historical_funding_rates
  drop constraint historical_funding_rates_mark_price_check;

alter table public.historical_funding_rates
  add constraint historical_funding_rates_mark_price_check check (mark_price >= 0);
