# DT-1 Phase 1 — point-in-time universe feasibility probe

**2026-10-08. Scope, per the DT-1 plan's own stop gate: data availability only.** No performance statistic was computed, no asset was hand-selected or excluded outside a mechanical rule, no strategy code was run. Every claim below is a direct, reproducible observation against Binance's live public endpoints — curl output is quoted or summarized, never assumed.

## What was tested

1. Whether `GET /api/v3/exchangeInfo` (authorized by the P0b scope amendment) retains metadata for symbols that are no longer trading, or drops them entirely.
2. Whether `GET /api/v3/klines` serves historical OHLCV for a symbol no longer listed as `TRADING`.
3. Whether `data.binance.vision` (the bulk archive host, also authorized by P0b) can independently corroborate a delisted symbol's trading history.
4. Daily-bar boundary exactness and `quoteAssetVolume` presence, both load-bearing for the universe's liquidity screen and the plan's own no-lookahead design (§7).

## Findings

### 1. `exchangeInfo` retains delisted/renamed symbols — it does not silently drop them

The DT-1 plan's own working assumption (written before this probe) was: *"`exchangeInfo` lists currently-trading and suspended symbols, so fully delisted symbols simply disappear from it."* **This is contradicted by direct observation.**

A full, unfiltered `exchangeInfo` call returns **3,724 total symbols**: 1,375 `TRADING`, **2,349 `BREAK`**. `BREAK` is Binance's status for a symbol that is not currently tradable.

Seven historically delisted or renamed spot pairs — spanning 2017–2019, chosen because they are genuinely obscure or involve a known rename (BCC→BCH, VEN→VET) rather than a pair still colloquially traded — were queried individually. **All seven returned `status: "BREAK"`, none returned "symbol not found":**

| Symbol | Status | Note |
|---|---|---|
| `BCCBTC` | BREAK | Bitcoin's original Binance ticker for Bitcoin Cash (2017), later superseded by `BCHBTC` |
| `VENBTC` | BREAK | VeChain's original ticker, rebranded VET in 2018 |
| `HSRBTC` | BREAK | — |
| `MCOBTC` | BREAK | — |
| `BCPTBTC` | BREAK | — |
| `MODBTC` | BREAK | — |
| `STORMBTC` | BREAK | — |

A genuinely nonexistent symbol (`ZZZQQQXYZUSDT`) returns `{"code":-1121,"msg":"Invalid symbol."}` from **both** `exchangeInfo` and `klines` — a clean, reliable signal distinguishing "known to Binance, currently inactive" from "never existed / fully purged."

**Caveat, stated honestly:** seven confirmations is strong evidence of a standing retention practice, not proof for every symbol that ever listed. No counterexample (a symbol absent entirely) was found in this probe, but the search was not exhaustive — a small number of symbols may still have been fully purged. Treat "exchangeInfo retains delisted symbols" as a well-supported working assumption, verified further at Phase 3 ingestion time (any `Invalid symbol` response for a universe candidate is logged, not silently skipped).

### 2. `klines` serves full historical OHLCV for a delisted symbol

`GET /api/v3/klines?symbol=BCCBTC&interval=1d&limit=3` returned real daily candles from **November 2018** — real open/high/low/close/volume data, years after the pair's own last active trading. This directly answers the plan's own explicitly-flagged uncertainty ("I am not certain [klines] does [serve delisted symbols]"): **yes, it does**, at least for symbols `exchangeInfo` still lists (finding 1).

### 3. `data.binance.vision`'s S3 listing API independently corroborates the same history

The bulk archive host does not serve a browsable directory page (`GET .../BCCBTC/1d/` returns a 404 `NoSuchKey`) — it must be queried as an S3 bucket listing (`?prefix=...&delimiter=/`), which returns a structured XML `ListBucketResult`. Queried this way for `BCCBTC/1d`, it returned monthly archive files starting **`BCCBTC-1d-2017-08.zip`** — consistent with Binance's own 2017 launch and BCC's real listing history, and consistent with the REST klines data in finding 2.

This is independently useful beyond corroboration: the S3 listing API gives a **clean, structured, paginated way to enumerate exactly which monthly archives exist** for a given symbol/timeframe — a more direct way to establish a symbol's full available date range than binary-searching REST klines, and a candidate mechanism for Phase 3's listing/delisting-date inference (see "What remains unresolved" below).

### 4. Daily-bar boundaries and quote volume — both exact and present

`GET /api/v3/klines?symbol=BTCUSDT&interval=1d&limit=2`: both returned bars satisfy `closeTime - openTime === 86399999` exactly, confirming no boundary ambiguity for the daily cadence DT-1's strategy runs on (matching §7's no-lookahead design). `quoteAssetVolume` (tuple index 7) is present and sane (~$1.7–1.75B for BTCUSDT on the days checked) — this is the field `providers/binance.ts` currently validates but discards (G3 in the plan's gap analysis); it is real and ready to be captured.

## What remains unresolved (explicitly, not glossed over)

- **No listing or delisting TIMESTAMP field exists anywhere in `exchangeInfo`.** Status is binary (`TRADING`/`BREAK`/others), never dated. Listing date must still be inferred from a symbol's **earliest available kline or archive file** (the convention R1's ingestion already uses for the live four-asset universe); delisting date must be inferred symmetrically from its **latest** available kline or archive file. This is a reasonable, auditable proxy — not a Binance-provided ground truth — and must be stated as such in the pre-registration's contract-mapping rules (§5.7 of the plan).
- **`BREAK` status alone cannot answer "was this symbol actively trading on date X."** It only reports current state. Point-in-time eligibility must continue to be decided by checking whether kline data actually exists (and has non-zero volume) for the relevant window — exactly what the plan's existing formation-date design already does; this finding does not change that design, it confirms status is not a shortcut around it.
- **Exhaustiveness.** Seven spot-checks is not a census of ~2,349 `BREAK` symbols. Phase 3's actual universe-construction ingestion is where full coverage gets verified, asset by asset, with every `Invalid symbol` response logged rather than silently treated as "no history."

## Verdict

**A point-in-time universe is feasible via the two newly-authorized sources (`exchangeInfo` + `data.binance.vision`), corroborated by the already-authorized `klines` endpoint.** The DT-1 plan's own pessimistic fallback branch ("if PIT is impossible, use the pre-registered mechanical fallback, labelled survivorship-biased") is **not triggered** by this probe — stop gate S3 does not fire. Phase 1b (decision-series definition, power simulation, the 12–15% objective) and Phase 2 (pre-registration) may proceed on the assumption that a real PIT universe is buildable, with the two caveats above (inferred rather than ground-truth listing/delisting dates; status is not a point-in-time proxy) carried forward explicitly into the pre-registration's own contract-mapping rules.

No code was written in this phase, per its own scope. The next step (Phase 1b) is the decision-series definition and power simulation — not yet started.
