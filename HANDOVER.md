# Handover — 2026-10-10

**Read this first, then only pull in the specific files it points to.** This doc is deliberately short and will go stale — if something here conflicts with a dated file it points to, trust the dated file. See "How to use this doc and keep it useful" at the bottom for the convention going forward.

## What this project is

TradeBuddy/AI Trader: an autonomous crypto **paper**-trading system (Chrome extension + Supabase Edge Functions), plus — as of the last two weeks — a substantial research program testing whether a discovered strategy (daily-trend-following, found on BTC/ETH) generalizes to a wider asset universe. `context/project-overview.md` is the canonical product doc; `CLAUDE.md` is the root instruction file every session reads first.

## Current live state (verify before trusting — things move)

- **V4 (the six-arm intraday strategy) is rejected and its crons are stopped.** `agent-cycle-15min`, `cycle-dispatcher-15min`, and `position-monitor-10min` are all unscheduled (migration `20261008170000`). This was a deliberate decision after `R4` (a historical backtest, see below) found V4 statistically indistinguishable from random entry. Do not re-schedule these without the user explicitly asking — it would resume live paper trading on a rejected strategy.
- **Exactly one cron is active**: `dt1-forward-runner-10min` — a standalone, isolated 5-day forward paper-trading experiment (below). Verify with `select jobname, active from cron.job;` via `supabase db query --linked` if you need current ground truth.
- **`supabase/functions/agent-cycle/index.ts` is clean** — a peer-session fix to it (`fc762ee`) is committed. The long-running "don't touch/commit this file, a peer session owns it" caveat from earlier sessions no longer applies as of this handover; re-check `git status` yourself before assuming that's still true.
- **Four dormant EXP-1 test accounts exist** (`exp1-e4-dry-run` × 4, portfolios table) — inert since `cycle-dispatcher-15min` is stopped. They were never formally closed with a write-up (see "Open threads" below).
- **Supabase project**: linked as "TradePartner", ref `ymmegosnnywpnyafgnrk`. No local `SUPABASE_SERVICE_ROLE_KEY` is available or should be fetched (see `MEMORY.md`'s own note on this — `supabase projects api-keys` is specifically avoided). Use `npx supabase db query --linked "<sql>"` for ad hoc reads/writes against the live DB (this already worked throughout the last session), or the public anon key (`src/supabase.ts`) to invoke Edge Functions directly via `curl`.

## The headline finding: DT-1 — does the daily-trend strategy generalize?

**No — it inverts.** Full result: `context/diagnostics/dt1-results-2026-10-09.md`. The one-paragraph version:

R4 (a historical backtest of 13 strategy variants on BTC/ETH, `context/diagnostics/p5-historical-backtest-results-2026-10-08.md`) found the six-arm intraday strategy (V4) indistinguishable from random entry, and found exactly one surviving candidate: a simple daily-trend + inverse-vol-sizing baseline, with a weak positive signal on BTC (Sharpe-equivalent point estimate +0.31R) and near-neutral on ETH (+0.01R) — but underpowered to confirm at that sample size. DT-1 tested whether that signal generalizes to a wider universe (159 other liquid Binance USDT assets, 2018–2026, same frozen strategy config, same risk envelope, same costs — one variable changed: the asset). Result: **annualized Sharpe on the external universe = −0.737, 90% CI [−1.27, −0.17]** — confidently negative, not merely inconclusive — while a continuity re-run on BTC/ETH alone reproduced the original weak positive signal (+0.31 / +0.14). The strategy's apparent edge on its discovery assets does not transfer; on a broader universe it reverses sign. Confirmed independently by three dependence-corrected pooled-expectancy estimators, a 9-year per-year breakdown (only 2021 was positive), and leave-one-year-out (negative even excluding any single year).

This was explicitly run **underpowered by the user's own decision** (DT-1's own pre-registered power simulation showed only 3–4% power to confirm the specific positive hurdle required for a "Supported" verdict) — the negative result is resolvable anyway because a large deviation from the hurdle is easier to detect than a marginal one at the same sample size; see the results doc's §2 for why this isn't a contradiction.

**The full DT-1 research trail, in order, if you need to audit or extend it** (each is a real, dated, frozen document — do not edit retroactively, only append dated amendments):
1. `context/diagnostics/dt1-phase1-feasibility-2026-10-08.md`, `dt1-phase1c-pit-census-2026-10-08.md` — can a point-in-time universe even be built? (yes)
2. `context/diagnostics/dt1-pre-registration-stage-a-2026-10-08.md` — Stage A freeze (universe rules, exclusions, A1–A10 sign-offs)
3. `context/diagnostics/dt1-universe-measurements-2026-10-09.md` — real ρ̄/N/T measured from the built universe
4. `context/diagnostics/dt1-power-simulation-stage-b-2026-10-09.md` — the power simulation; **S11 gate FAILS** (3–4% power at the required hurdle) — this is what triggered the "run underpowered, explicit user decision" framing
5. `context/diagnostics/dt1-pre-registration-2026-10-09.md` — the full DT-1 pre-registration, committed before the run, stating up front it cannot earn "Supported"
6. **`context/diagnostics/dt1-results-2026-10-09.md`** — the actual result (above)
7. The plan file (`/Users/nishchal/.claude/plans/pricing-and-model-selection-ethereal-fox.md`, `DT-1` section) has the full methodology if you need to understand *why* each design choice was made

## The forward paper experiment (running now, unattended)

A second, independent test of the same strategy: a standalone cron (`dt1-forward-runner-10min`) runs R4's exact frozen config live, forward, on BTC and ETH only, in two new dedicated paper portfolios (`dt1-forward-btc`, `dt1-forward-eth`, $10k each) — deliberately isolated from `agent-cycle`/`position-monitor`, so it is safe regardless of what else is or isn't running. Started **2026-10-09**, 5-day window, no action needed before **2026-10-14** unless a position needs review. Code: `supabase/functions/dt1-forward-runner/index.ts`. Given DT-1's own historical result above, the honest expectation for this forward window is a handful of trades, not a statistically meaningful readout on its own — it exists for continuity with R4/DT-1's own methodology, not to settle anything by itself.

## Open threads / what's next (none of these are urgent)

- **The 4 dormant `exp1-e4-dry-run` accounts were never closed with a write-up.** They tested giveback-ratchet/signal-drift mechanisms that never fired in 35 live positions — low value, but it's a loose end. Grep `progress-tracker.md` for `exp1-e4-dry-run`.
- **A `strategies`/`strategy_status_events` lifecycle table was never built** (DT-1 plan §9.4) — would be where "V4 → REJECTED → RETIRED" and "daily-trend baseline → RESEARCH → failed-to-generalize" get formally recorded instead of living only in prose across diagnostic docs.
- **DSR N=14's exact skew/kurtosis-adjusted value** (for DT-1) — the direction and near-zero magnitude are already certain (see the results doc §5–6); the precise figure needs re-running `run-dt1.ts` (`supabase/functions/agent-cycle/research/run-dt1.ts`, already has the N=14 code path, just needs a clean run saved) — cheap, low-priority.
- **SUI/AVAX as DT-1's own explicitly-deferred follow-up appendix** — same methodology, not yet run.
- Given DT-1's result, anything downstream that assumed the daily-trend baseline might be viable (STRAT-1's P6 "4h-led bias" direction, any thought of a live `daily_trend` StrategyProfile) should probably be re-evaluated before investing further — that's a decision for the user, not something to resume by default.

## Operational gotchas worth knowing before touching anything

- **Never retroactively edit a frozen pre-registration or results document.** This project's entire research discipline (DT-1, R4, the power simulation) depends on amendments being dated and appended, never edited in place. If something in a frozen doc turns out wrong, append a note, don't rewrite history.
- **Never fetch the Supabase service-role key via `supabase projects api-keys`** — use `db query --linked` for reads/writes, or invoke Edge Functions with the public anon key.
- **Before any destructive git operation**, `git status` first — this repo has had long stretches of legitimate uncommitted peer-session work in flight.
- **This project's own context files are the source of truth, not this handover.** If `CLAUDE.md`/`context/project-overview.md`/`context/architecture.md` say something different from what's written here, they win — update this doc, not your mental model of the project.

## How to use this doc and keep it useful (context-management note, added 2026-10-10)

`context/progress-tracker.md` had grown past 770 lines — too large to usefully read end-to-end every session, and too valuable as a historical audit trail to prune. The fix going forward, not a rewrite of what's already there:

- **This file is the fresh-session entry point.** `CLAUDE.md` now says to read it first, before the project-overview, before progress-tracker. Keep it short — a page or two, current-state only, pointing at dated files for depth rather than restating them.
- **`progress-tracker.md` gained a `## Start here` section** at its own top, explaining that it's append-only, that its own `## Current Phase` heading is stale and should be ignored in favor of `## Completed`'s most recent entries, and that grepping for an initiative name beats reading linearly.
- **`context/ai-workflow-rules.md` gained a rule**: a new `progress-tracker.md` entry for a finished unit of work should be a short pointer (2–5 sentences + a path) to its own dated doc under `context/diagnostics/`, not a full reproduction. The tracker indexes; the diagnostic docs hold the depth.
- **Update this file** the next time a large body of work finishes or state changes meaningfully (a new live cron, a new major finding, a resolved caveat) — replace stale sections rather than appending to them, since the entire value of this doc is staying short. If it starts growing past a page or two, that's a sign to prune it back down, not to keep adding.
