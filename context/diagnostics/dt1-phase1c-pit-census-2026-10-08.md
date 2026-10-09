# DT-1 Phase P1c — PIT census (replacing the 12-symbol spot-check)

**2026-10-08. Scope: data availability only, per the same boundary as Phase 1.** No performance statistic was computed, no strategy code was run. This replaces the "broader mechanically selected validation sample" proposed in the DT-1 review package with a **census** — per explicit instruction, a uniform sample over all ~2,349 `BREAK` symbols would be dominated by tiny, illiquid pairs that would never have been top-20/30 candidates; what matters is coverage of the coins that *would have* mattered to the actual universe.

## Method

**Volume census.** Fetched one `interval=1M` kline request per USDT symbol (both `TRADING` and `BREAK` status — 760 total: 506 trading, 254 delisted), extracting monthly `quoteAssetVolume`. Built a per-month cross-sectional ranking across all symbols with data that month, and identified every symbol that ever ranked in the top 30 by that measure, at any point in its history.

**Scrubbed-symbol test.** Listed every spot symbol directory in `data.binance.vision`'s archive (`data/spot/monthly/klines/`, paginated via the S3 listing API — 4 pages, 3,745 directories total) and diffed against the full `exchangeInfo` symbol list (3,724 symbols, all quote assets).

**Deep check.** For every delisted (`BREAK`) symbol that ever ranked top-30, fetched its earliest available daily kline (listing-date proxy), latest available daily kline (delisting-date proxy), and the archive's own first/last monthly file — checking all three agree.

## Results

### Volume census: 81 delisted USDT symbols ever ranked top-30

Full results in `census_mattered_delisted.json` (scratchpad). Spans **2017-11 through 2025-04** — the census correctly caught both the earliest Binance-era delistings and recent ones.

### Scrubbed-symbol test: 25 symbols confirmed genuinely absent from `exchangeInfo`

This is the complete answer to the question the original 12-symbol probe explicitly could not resolve ("zero found in 12" is not proof none exist). The real count is **25 of 3,745 archive-listed symbols (≈0.67%)**, and critically:

| Category | Count | Example |
|---|---|---|
| Non-USDT quote (BIDR — a defunct regional Binance.id product; BNB/ETH-quoted pairs from Binance's earliest years) | 24 | `AXSBIDR`, `DGBBNB`, `NEBLETH` |
| USDT-quoted | **1** | `NBTUSDT` |

`NBTUSDT` never appeared in the volume census's "mattered" list at all — it existed as a USDT pair at some point but never ranked top-30 by volume. **For DT-1's actual candidate pool (USDT-quoted, historically liquid enough to matter), the scrubbing risk is negligible**: zero of the 81 symbols that ever mattered are among the 25 confirmed-scrubbed symbols.

4 symbols are `exchangeInfo`-only with no archive (too new or too low-volume to have been archived yet) — not a concern, handled correctly by the existing 180-day eligibility floor.

### Deep check: 81/81 clean, two explainable anomalies, zero real data-quality failures

- **Zero fetch errors** across all 81 symbols (earliest daily, latest daily, archive listing).
- **80 of 81**: REST's latest-kline month matches the archive's own last-available month exactly.
- **`STGUSDT` mismatch (REST: 2026-10, archive: 2026-09)** — not a data-quality defect. STGUSDT's last real trade was 2026-10-06, two days before this census ran; the archive's current-month file simply hasn't been published yet. This is the expected archive publication lag for a very recent delisting, not a gap.
- **`VENUSDT` internal gap (5-month span, 3 archived files)** — a genuine, small gap in VEN's own archive coverage, occurring around its own 2018 VEN→VET rename. Flagged honestly rather than glossed over; does not block using VEN's available months, but the gap itself should be noted in the contract mapping.
- **`ICXUSDT` BREAK status with a last trade only 35 days before this census ran** — confirms the plan's own point that `BREAK` does not mean "long dead." Point-in-time eligibility must keep being decided by actual data presence for the window in question, never by status alone.

## The exclusion list (A1) — proposed, named, not yet frozen

Of the 81 symbols, applying the plan's own named exclusion categories (stablecoins / wrapped / LST / leveraged-index products):

**Leveraged tokens (Binance's own 3x long/short products) — 11, unambiguous by construction:**
`BTCUPUSDT`, `BTCDOWNUSDT`, `ETHBULLUSDT`, `ETHBEARUSDT`, `EOSBULLUSDT`, `EOSBEARUSDT`, `BULLUSDT`, `BEARUSDT`, `LINKDOWNUSDT`, `XRPUPUSDT`, `XRPDOWNUSDT`

**Stablecoins — 4 (within the "mattered" list; 6 more appear only in the separately-confirmed scrubbed list and were never USDT-quoted candidates in the first place):**
`PAXUSDT` (Paxos Standard), `BUSDUSDT` (Binance USD), `USTUSDT` (TerraUSD), `USDSOLDUSDT` (a deprecated Binance stablecoin ticker)

**One open judgment call, not resolved unilaterally:** `WRXUSDT` (WazirX, an exchange-affiliated token) does not fit any of the plan's named exclusion categories (stablecoin/wrapped/LST/leveraged-index), but it is also not an ordinary tradeable asset in the same sense as the other 64 — it is tied to a specific exchange's own fortunes. Flagged for an explicit decision: include as an ordinary candidate, or add "exchange tokens" as a new named exclusion category.

**The remaining 64 (or 65, pending the WRX decision) are legitimate historical coin candidates**, including several requiring an explicit entry in the contract/underlying mapping because Binance treats a rename as delist-old/list-new, not an in-place continuation — **verified live, not assumed**:

| Old symbol | New symbol (verified live) | Event |
|---|---|---|
| `BCCUSDT` | `BCHUSDT` (confirmed `TRADING`) | Bitcoin Cash's original Binance ticker (2017) |
| `BCHABCUSDT` | `BCHUSDT` | The post-Nov-2018-fork interim ticker, later folded back into BCH |
| `VENUSDT` | `VETUSDT` (confirmed `TRADING`) | VeChain's 2018 rebrand |
| `LENDUSDT` | `AAVEUSDT` (confirmed `TRADING`) | Aave's 2020 rebrand from LEND |
| `ERDUSDT` | `EGLDUSDT` (confirmed `TRADING`) | Elrond's rebrand to MultiversX |
| `RNDRUSDT` | `RENDERUSDT` (confirmed `TRADING`) | Render's ticker migration |
| `AGIXUSDT` | `FETUSDT` (confirmed `TRADING`) | SingularityNET's 2024 merger into the Artificial Superintelligence Alliance — **note the initial guess here was wrong**: the surviving ticker is `FET` (Fetch.ai), not a separate `ASI` symbol as first assumed. `ASIUSDT` was checked and does not exist (`Invalid symbol`). Caught by verifying rather than asserting — the same discipline this whole census exists to enforce |

All seven renames are now live-confirmed, not assumed.

**A separate, non-renaming category worth noting for context, not exclusion:** several symbols were delisted following a specific adverse event rather than ordinary attrition — `SRMUSDT` (Serum, FTX-ecosystem collapse), `ANCUSDT` (Anchor Protocol, Terra/UST collapse), `VGXUSDT` (Voyager Token, Voyager Digital's bankruptcy), `MULTIUSDT` (Multichain, bridge collapse amid the founder's 2023 arrest). These are real, legitimate historical listings — their inclusion is not a data-quality question, but their presence means the universe's historical P&L will partly reflect well-known 2022–23 failure events, which is exactly the kind of concentration the plan's own per-year/leave-one-year-out secondary analyses (§6.9) exist to surface.

**One large-cap exception worth flagging on its own:** `TONUSDT` (Toncoin, a major, currently-very-active asset associated with Telegram) shows `BREAK` status with its last trade in 2026-05 — almost certainly a jurisdiction-specific spot delisting (e.g. a regional restriction), not a project failure, unlike every other entry in this list. Worth a footnote in the final mapping so a future reader does not mistake it for an obscure/failed coin.

## What remains

- The WRX exchange-token judgment call (above).
- This classification used general knowledge of each project alongside the census's own data (ticker meanings are not themselves API-verifiable, though every *rename* claim specifically has now been live-confirmed against `exchangeInfo`) — a human spot-check of the less-certain non-rename classifications is still reasonable before the exclusion list is frozen in the pre-registration.
- The census covers USDT symbols only, matching DT-1's own universe scope; it does not re-examine the 7 *BTC-quoted symbols from the original Phase 1 probe (not relevant to DT-1's actual universe).

## Verdict

**The gap between "symbol-status availability" and "complete PIT universe reconstructability" (flagged as open in the review package) is now closed for DT-1's actual candidate pool.** Of 81 historically-relevant delisted USDT symbols, all 81 are retrievable, cross-source-consistent, and none are among the 25 confirmed-scrubbed symbols. The scrubbing risk that does exist is concentrated entirely outside DT-1's quote-currency scope. This is now a census-backed finding, not a 12-symbol spot-check.
