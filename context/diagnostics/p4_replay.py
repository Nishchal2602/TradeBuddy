#!/usr/bin/env python3
"""
STRAT-1 P4 — deterministic-exit counterfactual.

For every champion intraday_ls position closed via Jev's discretionary
'agent_close', replay the REAL subsequent 30m true-OHLC price path (no
breach occurred before the real close, by construction -- the monitor
polls every 10 minutes and would have fired stop_loss/take_profit first
if one had happened) applying ONLY the deterministic exits: stop-loss,
take-profit, hard max-hold (1440 min), soft time-stop (480 min AND
positionPnlR < 0.5). Compare the counterfactual R against the ACTUAL
realized R (which includes Jev's real CLOSE).

Three-valued resolution per invariant I11: a single 30m bar whose high
crosses the target AND whose low crosses the stop does not reveal which
happened first -> reported as [pessimistic, optimistic].

Documented approximations (stated here, not silently assumed):
  - Bar-granularity, not the monitor's real 10-minute poll. A breach or
    time-stop crossing inside a 30m bar is resolved AT that bar, never
    finer -- a genuine, permanent fidelity limit of replaying on 30m
    bars (this is also exactly P2/Stage-2's own documented 30m-vs-10min
    gap, not a new one introduced here).
  - Exit cost on the counterfactual leg is approximated at a flat 0.15%
    of exit notional (10bps fee + 5bps slippage, the system's own
    per-side convention), expressed in R units. The real ENTRY-side cost
    and any real prior REDUCE's cost are already baked into the fetched
    trade data and are not re-estimated.
  - R is normalized against the ORIGINAL initial_risk_usd/initial_stop,
    exactly as the live system's own positionPnlR does -- a later
    MODIFY_PROTECTION tighten changes the BREACH level, never the R
    denominator.
"""
import json
from datetime import datetime, timezone

SCRATCH = "/private/tmp/claude-501/-Users-nishchal/41ee162a-edc4-4378-acfe-cc14ed21f3b8/scratchpad"

SOFT_TIME_STOP_MIN = 480
HARD_MAX_HOLD_MIN = 1440
SOFT_TIME_STOP_R_EXEMPTION = 0.5
EXIT_COST_PCT = 0.0015  # 10bps fee + 5bps slippage, one side

# Positions with a REAL reduce BEFORE their close -- remaining_fraction
# of the original quantity still open at closed_at, and the partial R
# already realized and banked (independent of whatever the counterfactual
# does afterward). Both found by direct trade-ledger inspection.
REDUCE_OVERRIDES = {
    "6bfe228e-88c3-485c-adfc-aba280831815": {"remaining_fraction": 0.75, "partial_realized_pnl_usd": -7.61568485},
    "f41a7722-8dca-46fa-a98e-6b8c096833b6": {"remaining_fraction": 0.5, "partial_realized_pnl_usd": -10.83874438},
}


import re


def parse_ts(s):
    s = s.strip()
    m = re.match(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2}(:?\d{2})?)?$", s)
    if not m:
        raise ValueError(f"unparseable timestamp: {s!r}")
    date_part, time_part, frac, tz = m.group(1), m.group(2), m.group(3) or "", m.group(4) or "+00"
    if frac:
        micro = (frac[1:] + "000000")[:6]
    else:
        micro = "000000"
    if not tz.count(":") and len(tz) > 3:
        tz = tz[:3] + ":" + tz[3:]
    elif len(tz) == 3:
        tz = tz + ":00"
    return datetime.fromisoformat(f"{date_part}T{time_part}.{micro}{tz}")


def load_json(path):
    s = open(path).read()
    return json.loads(s[s.index("{"): s.rindex("}") + 1])


def load_bars():
    bars = {}
    for asset in ("BTC", "ETH", "SUI", "AVAX"):
        rows = json.load(open(f"/tmp/bars_{asset}.json"))["rows"]
        for r in rows:
            r["close_time"] = parse_ts(r["close_time"])
            r["open"] = float(r["open"])
            r["high"] = float(r["high"])
            r["low"] = float(r["low"])
            r["close"] = float(r["close"])
        rows.sort(key=lambda r: r["close_time"])
        bars[asset] = rows
    return bars


def price_r(price, entry, initial_stop):
    # Long-only in this dataset (0 shorts ever) -- matches the system's
    # own computePriceR for the long branch.
    return (price - entry) / (entry - initial_stop)


def replay_counterfactual(pos, bars_for_asset):
    entry = float(pos["initial_entry_price"])
    initial_stop = float(pos["initial_stop_loss_price"])
    stop = float(pos["stop_loss_price"])  # current -- may be tightened by a real MODIFY_PROTECTION
    target = float(pos["take_profit_price"])
    opened_at = parse_ts(pos["opened_at"])
    closed_at = parse_ts(pos["closed_at"])

    override = REDUCE_OVERRIDES.get(pos["id"])
    remaining_fraction = override["remaining_fraction"] if override else 1.0
    banked_r = (override["partial_realized_pnl_usd"] / float(pos["initial_risk_usd"])) if override else 0.0

    window = [b for b in bars_for_asset if b["close_time"] > closed_at]
    if not window:
        return {"kind": "uncovered", "reason": "no 30m bars available after the real close"}

    for bar in window:
        elapsed_min = (bar["close_time"] - opened_at).total_seconds() / 60.0
        hit_stop = bar["low"] <= stop
        hit_target = bar["high"] >= target

        if hit_stop and hit_target:
            stop_r = banked_r + remaining_fraction * price_r(stop, entry, initial_stop) - remaining_fraction * EXIT_COST_PCT * stop / (entry - initial_stop)
            target_r = banked_r + remaining_fraction * price_r(target, entry, initial_stop) - remaining_fraction * EXIT_COST_PCT * target / (entry - initial_stop)
            return {"kind": "interval", "pessimistic": stop_r, "optimistic": target_r, "exit_bar": bar["close_time"].isoformat(), "exit_reason": "stop_loss_or_take_profit (ambiguous order, same bar)"}
        if hit_stop:
            r = banked_r + remaining_fraction * price_r(stop, entry, initial_stop) - remaining_fraction * EXIT_COST_PCT * stop / (entry - initial_stop)
            return {"kind": "point", "r": r, "exit_bar": bar["close_time"].isoformat(), "exit_reason": "stop_loss"}
        if hit_target:
            r = banked_r + remaining_fraction * price_r(target, entry, initial_stop) - remaining_fraction * EXIT_COST_PCT * target / (entry - initial_stop)
            return {"kind": "point", "r": r, "exit_bar": bar["close_time"].isoformat(), "exit_reason": "take_profit"}

        if elapsed_min >= HARD_MAX_HOLD_MIN:
            r = banked_r + remaining_fraction * price_r(bar["close"], entry, initial_stop) - remaining_fraction * EXIT_COST_PCT * bar["close"] / (entry - initial_stop)
            return {"kind": "point", "r": r, "exit_bar": bar["close_time"].isoformat(), "exit_reason": "time_stop (hard max 1440min)"}

        running_r = banked_r + remaining_fraction * price_r(bar["close"], entry, initial_stop)
        if elapsed_min >= SOFT_TIME_STOP_MIN and running_r < SOFT_TIME_STOP_R_EXEMPTION:
            r = running_r - remaining_fraction * EXIT_COST_PCT * bar["close"] / (entry - initial_stop)
            return {"kind": "point", "r": r, "exit_bar": bar["close_time"].isoformat(), "exit_reason": "time_stop (soft, 480min + R<0.5)"}

    return {"kind": "undetermined", "reason": f"no deterministic exit condition fired in the {len(window)} bars available since the real close (data cutoff reached)"}


def main():
    raw = open("/tmp/p4_full_raw.json").read()
    positions = json.loads(raw[raw.index("{"): raw.rindex("}") + 1])["rows"]
    pos_meta = {r["id"]: r for r in json.load(open("/tmp/p4_positions.json"))["rows"]}
    bars = load_bars()

    results = []
    for p in positions:
        meta = pos_meta[p["id"]]
        merged = {**p, "stop_loss_price": meta["stop_loss_price"], "take_profit_price": meta["take_profit_price"]}
        initial_risk = float(p["initial_risk_usd"])
        actual_net_r = (float(p["gross_realized"]) - float(p["total_fee"]) - float(p["total_funding"])) / initial_risk

        row = {
            "asset": p["asset"],
            "opened_at": p["opened_at"],
            "closed_at": p["closed_at"],
            "close_reason": p["close_reason"],
            "status": p["status"],
            "actual_net_r": round(actual_net_r, 3),
        }

        if p["status"] != "closed":
            row["counterfactual"] = {"kind": "n/a", "reason": "still open -- no Jev close to counterfactual yet"}
            row["needs_counterfactual"] = False
        elif p["close_reason"] != "agent_close":
            row["counterfactual"] = {"kind": "point", "r": round(actual_net_r, 3), "exit_reason": p["close_reason"]}
            row["needs_counterfactual"] = False
            row["note"] = "a deterministic exit (stop/target/time-stop) already happened for real -- actual IS the counterfactual"
        else:
            cf = replay_counterfactual(merged, bars[p["asset"]])
            if cf["kind"] in ("point",):
                cf["r"] = round(cf["r"], 3)
            elif cf["kind"] == "interval":
                cf["pessimistic"] = round(cf["pessimistic"], 3)
                cf["optimistic"] = round(cf["optimistic"], 3)
            row["counterfactual"] = cf
            row["needs_counterfactual"] = True

        results.append(row)

    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
