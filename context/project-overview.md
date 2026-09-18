# Autonomous Crypto Paper-Trading Agent

## Overview

A Chrome extension that gives a single user a live window into an autonomous AI crypto paper-trading agent. The agent runs server-side on a fixed 3-hour cadence, monitors BTC and ETH using recent market data, technical indicators, and relevant recent news, then makes a structured BUY/SELL/HOLD decision. A deterministic risk gate validates the model proposal before a paper broker executes the simulated trade with fees and slippage. Supabase stores the complete history so every decision can be inspected, including the exact inputs, reasons, and invalidation conditions that produced it. V0 is explicitly a paper-trading experiment; it must not use real funds or exchange credentials.

## Goals

1. Get one reliable autonomous trading loop running end-to-end without requiring Chrome to remain open.
2. Combine fresh crypto market data, deterministic technical indicators, recent news, and portfolio state into one structured AI decision.
3. Make every decision inspectable and reproducible by storing its inputs, outputs, prompt version, timestamps, and resulting portfolio changes.
4. Simulate realistic paper execution using configurable fees and slippage rather than frictionless fills.
5. Give the user a focused Chrome extension UI for decisions, portfolio state, positions, and agent controls.

## Core User Flow

1. User opens the Chrome extension.
2. Extension displays the current agent status, portfolio/NAV, positions, recent decisions, and next scheduled run.
3. On each scheduled 3-hour cycle, the server-side agent fetches current BTC/ETH market data and recent relevant news.
4. Deterministic code calculates the configured technical indicators.
5. The decision agent receives market, technical, news, portfolio, constraints, and recent-decision context.
6. The model returns a validated BUY/SELL/HOLD proposal for BTC and/or ETH.
7. The deterministic risk gate validates and constrains the proposal.
8. Approved proposals are passed to the paper broker, which simulates fills with fees and slippage.
9. Supabase stores the decision, input payload, execution result, positions, and NAV snapshot.
10. The extension reads the latest state from Supabase and presents the decision and its reasoning to the user.
11. User can pause/resume the agent or manually trigger a run through the server-side control endpoint.

## Features

### Autonomous Agent

- Fixed 3-hour scheduled decision cycle.
- Server-side execution independent of whether Chrome is open.
- BTC and ETH support in V0.
- One LLM decision call covering both assets and the portfolio.
- Structured BUY/SELL/HOLD output.
- HOLD is the default posture; the model should trade only when evidence supports a change.
- Prompt version recorded with every decision.
- Exact serialized model input stored with every decision.
- All cycles, including HOLD and skipped cycles, are logged.

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

- action
- asset
- confidence
- primary driver: NEWS / TECHNICAL / BOTH / NONE
- proposed size percentage
- reasons with NEWS or TECHNICAL type and references
- invalidation conditions
- decision horizon
- model/prompt version
- exact input payload
- timestamps and freshness metadata

### Risk and Paper Execution

- Deterministic risk gate.
- Maximum position size of 25% of portfolio value per asset in V0.
- Long-or-flat only.
- Exposure limits, minimum confidence, cooldown, and cash-floor checks.
- Risk gate may reject a proposal; it must not silently transform a proposal without recording what happened.
- Paper fills at the latest valid market price.
- Simulated taker fee: approximately 0.1% per side.
- Simulated slippage: approximately 0.05% per side.
- Position, cash, realized/unrealized P&L, and NAV are updated after fills.

### Chrome Extension

- Decision feed as the primary screen.
- Portfolio/NAV header.
- Positions view.
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
- Deterministic risk gate.
- Paper broker.
- Portfolio/P&L tracking.
- Decision history and inspection.
- Server-side control actions.
- Basic RLS and secure secret handling.

### Out of Scope

- Real-money trading.
- Exchange API credentials or exchange execution.
- Testnet execution.
- Autonomous financial transactions.
- Shorts.
- Leverage.
- Futures/options/derivatives.
- Stop-loss or take-profit orders.
- Limit orders.
- Event-driven/news-triggered execution.
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
