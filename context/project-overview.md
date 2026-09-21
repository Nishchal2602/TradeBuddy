# Autonomous Crypto Paper-Trading Agent

## Overview

A Chrome extension that gives a single user a live window into an AI crypto paper-trading agent. The agent monitors BTC and ETH using recent market data, technical indicators, and relevant recent news, then makes a structured OPEN_LONG / OPEN_SHORT / HOLD / CLOSE decision, with a mandatory stop-loss and take-profit on every open. A deterministic risk gate validates the model proposal — confidence, SL/TP placement, risk-derived position size, exposure caps — before a paper broker executes the simulated trade with fees and slippage. SL/TP execution itself runs automatically on an independent 10-minute position-monitor cycle. Supabase stores the complete history so every decision can be inspected, including the exact inputs, reasons, and invalidation conditions that produced it. V0 is explicitly a paper-trading experiment; it must not use real funds, real leverage, or exchange credentials — shorts are 1x unleveraged synthetic paper positions only (`context/specs/trading-domain-contract.md`).

**V0 execution mode: manual-only (2026-09-19, explicit user decision — see `context/progress-tracker.md`'s Architecture Decisions).** The decision cycle described below and throughout this document as running on "a fixed 3-hour cadence" is the target autonomous design, not V0's current behavior: it runs exclusively when the user clicks "Run agent" in the extension, never on a schedule. `decision_interval_minutes` stays configured for when autonomous scheduling is deliberately switched on later. The position monitor is a separate, already-automatic process, unaffected by this — it keeps running independently on its own schedule regardless of whether the decision cycle has ever been triggered.

## Goals

1. Get one reliable autonomous trading loop running end-to-end without requiring Chrome to remain open.
2. Combine fresh crypto market data, deterministic technical indicators, recent news, and portfolio state into one structured AI decision.
3. Make every decision inspectable and reproducible by storing its inputs, outputs, prompt version, timestamps, and resulting portfolio changes.
4. Simulate realistic paper execution using configurable fees and slippage rather than frictionless fills.
5. Give the user a focused Chrome extension UI for decisions, portfolio state, positions, and agent controls.

## Core User Flow

1. User opens the Chrome extension.
2. Extension displays the current agent status, portfolio/NAV, positions (with direction, entry, SL/TP), recent decisions, and next scheduled run.
3. On each scheduled 3-hour cycle, the server-side agent fetches current BTC/ETH market data and recent relevant news.
4. Deterministic code calculates the configured technical indicators.
5. The decision agent receives market, technical, news, portfolio, constraints, and recent-decision context.
6. The model returns a validated OPEN_LONG / OPEN_SHORT / HOLD / CLOSE proposal for BTC and/or ETH, with a stop-loss/take-profit percentage on any open.
7. The deterministic risk gate validates and constrains the proposal — confidence, SL/TP placement, risk-derived size, exposure caps.
8. Approved proposals are passed to the paper broker, which simulates fills with fees and slippage.
9. Independently, every 10 minutes, the position monitor polls prices for open positions and executes any SL/TP/collateral-exhaustion trigger through the same paper broker — see `context/specs/trading-domain-contract.md`.
10. Supabase stores the decision, input payload, execution result, positions, and NAV snapshot.
11. The extension reads the latest state from Supabase and presents the decision and its reasoning to the user.
12. User manually triggers a decision cycle by clicking "Run agent" in the extension, which invokes the decision-cycle Edge Function directly (V0 execution mode: manual-only, 2026-09-19 — no separate control endpoint exists or is needed for this specific action).

## Features

### Autonomous Agent

- Fixed 3-hour scheduled decision cycle (currently manual-only in V0 — see Architecture Decisions in `progress-tracker.md`).
- Server-side execution independent of whether Chrome is open.
- BTC and ETH support in V0.
- **Trading Strategy V1 (2026-09-21, implemented):** a deterministic daily-trend regime rule originates every proposal (OPEN_LONG / HOLD / CLOSE — never OPEN_SHORT), with mandatory stop-loss/take-profit on every open. The LLM makes at most one batched call per cycle, only to veto an OPEN_LONG candidate on a known exogenous confound — zero candidates means zero calls. Full detail: `context/specs/trading-strategy-v1.md`.
- HOLD is the default posture: trade only when the deterministic regime rule signals eligibility and the veto (if any) doesn't block it; otherwise HOLD.
- Independent 10-minute position-monitor cycle executes SL/TP/collateral-exhaustion triggers, decoupled from the 3-hour decision cadence — see `context/specs/trading-domain-contract.md`.
- Prompt version recorded with every decision.
- Exact serialized model input stored with every decision.
- All cycles, including HOLD and skipped cycles, are logged — for both the decision cycle and the position-monitor cycle.

### Market and News Intelligence

- Recent spot price and OHLCV data.
- Deterministic technical indicators:
  - RSI(14)
  - EMA20
  - EMA50
  - MACD histogram
  - ATR%
  - Volume ratio
  - Distance from 7-day high/low
- Approximately 24 recent hourly closes supplied as price-shape context.
- Recent relevant news mapped to BTC/ETH.
- News items include stable ID, publish time, age, source, headline, and summary.
- News is treated as untrusted data, never as instructions.
- Failed news retrieval is distinguishable from a legitimately empty news result.
- Stale or incomplete critical market/news inputs cause the cycle to skip rather than trade blind.

### Decision Records

Each decision records:

- action: OPEN_LONG / OPEN_SHORT / HOLD / CLOSE
- asset
- confidence
- primary driver: NEWS / TECHNICAL / BOTH / NONE
- proposed and computed stop-loss / take-profit (percentage and resulting absolute price)
- risk-derived position size and which cap, if any, was applied (position size is not model-proposed — see Risk and Paper Execution below)
- reasons with NEWS or TECHNICAL type and references
- invalidation conditions — the human-readable thesis, kept separate from the executable stop-loss
- decision horizon
- model/prompt version
- exact input payload
- timestamps and freshness metadata

### Risk and Paper Execution

- Deterministic risk gate.
- One net position per asset: FLAT / LONG / SHORT (no lots, no pyramiding, no partial exits).
- Position size is risk-derived (from stop-loss distance and a risk budget), not a raw model-proposed percentage — then capped at a maximum 20% of NAV per trade and 35% of NAV per asset.
- Every open position requires a valid stop-loss and take-profit; the risk gate validates their direction-dependent ordering (and, for shorts, that the stop stays below the collateral-exhaustion price) before accepting the open.
- Minimum confidence gates OPEN_LONG/OPEN_SHORT only — CLOSE is never blocked by confidence, by the stop-out re-entry block, or by any exposure cap. Exits must always be actionable.
- After a stop-loss exit, re-opening the same asset in the same direction is blocked for a configurable window (a deterministic proxy for "avoid the same failed thesis," not real thesis matching) — the opposite direction is unaffected.
- Risk gate may reject or clamp a proposal; it must not silently transform a proposal without recording what happened and which check applied.
- Shorts are 1x unleveraged synthetic paper positions: opening reserves collateral equal to notional. If price reaches the collateral-exhaustion level, the position is closed deterministically — never left open with its loss silently capped. No leverage, margin, funding, or exchange-style liquidation mechanics. Full detail: `context/specs/trading-domain-contract.md`.
- SL/TP execution runs on an independent 10-minute position-monitor cycle against real price data, not the 3-hour decision cadence — explicitly documented as an approximation of a real stop order, not a claim of equivalence.
- Paper fills at the latest valid market price (or, for a triggered SL/TP, the less-favorable of the trigger level and the observed price — models real fill risk rather than assuming a perfect fill).
- Simulated taker fee: approximately 0.1% per side.
- Simulated slippage: approximately 0.05% per side.
- Position, cash, realized/unrealized P&L, and NAV are updated after fills.

### Chrome Extension

- Decision feed as the primary screen.
- Portfolio/NAV header.
- Positions view — asset, direction (long/short), size, entry, current price, stop-loss/take-profit, unrealized P&L, hold duration.
- Agent status and schedule.
- Pause/resume.
- Run-now.
- Risk controls.
- Expandable decision detail.
- No trading calculations or secret keys in the extension.

## Scope

### In Scope

- Single-user V0.
- Chrome Manifest V3 extension.
- React + TypeScript extension UI.
- Server-side agent loop using Supabase Edge Functions.
- Supabase Postgres for application state and history.
- Scheduled execution through Supabase cron.
- BTC and ETH.
- Market data ingestion.
- News ingestion.
- Technical indicator calculation.
- Gemini model integration behind a single model-call abstraction.
- Deterministic risk gate, including SL/TP validation and risk-derived position sizing.
- Paper broker, including 1x unleveraged synthetic short accounting.
- Independent position-monitor cycle for SL/TP/collateral-exhaustion execution.
- Portfolio/P&L tracking.
- Decision history and inspection.
- Server-side control actions.
- Basic RLS and secure secret handling.

### Out of Scope

- Real-money trading.
- Exchange API credentials or exchange execution.
- Testnet execution.
- Autonomous financial transactions.
- Real leverage, margin borrowing, or funding mechanics (shorts are in scope, but strictly as 1x unleveraged synthetic paper positions — `context/specs/trading-domain-contract.md`).
- Exchange-style liquidation.
- Futures/options/derivatives.
- Limit orders.
- Pyramiding, multi-leg positions, partial exits, trailing stops.
- Event-driven/news-triggered execution on the decision cycle (the position monitor is a separate, deterministic exception for SL/TP execution only).
- Streaming/WebSocket market feeds.
- Backtesting infrastructure.
- Multi-agent architecture.
- RAG, embeddings, or vector databases.
- On-chain or social signals.
- Multi-user accounts.
- Billing/subscriptions.
- Mobile apps.
- Notifications.
- Web Store publishing work.
- SOL support until V0.1.
- News/no-news control experiment until V0.1.
- Buy-and-hold benchmark until V0.1.

## Success Criteria

1. A scheduled server-side cycle can complete without Chrome being open.
2. A successful cycle creates a complete decision record in Supabase with the exact model input and output.
3. BTC/ETH market data and technical indicators are timestamped and available to the decision agent.
4. News retrieval failure causes a safe skipped cycle rather than a trade based on stale/missing news.
5. Model output is schema-validated before reaching the risk gate.
6. Oversized or otherwise invalid proposals are rejected by deterministic risk rules.
7. Paper trades correctly update cash, positions, fees, and NAV.
8. Every cycle, including HOLD and skipped cycles, is visible in the history.
9. The Chrome extension can display the latest portfolio and decision state after reopening.
10. The project builds cleanly with no TypeScript errors or unhandled runtime errors.
11. The position monitor correctly executes SL/TP/collateral-exhaustion triggers on its own 10-minute cycle, independent of whether a decision cycle has run, and the agent-vs-monitor concurrent-close race resolves to exactly one close every time (`context/specs/trading-domain-contract.md`).
