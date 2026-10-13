"""Trade planning with the chosen broker's fee schedule (Zerodha or Groww), and a platform-style paper-trading ledger.

Orders behave like a broker's order panel:

* BUY / SELL, product Intraday (MIS: must be squared off, short-selling allowed) or Delivery
  (CNC: STT both sides, DP charge on the sell, no short-selling);
* Market (fills now at the last price plus slippage), Limit (waits for the price), SL (a trigger
  that becomes a market order);
* an optional stop-loss and target attached to the position (the auto-exit engine watches them);
* a SELL against a long position exits it (market = now, limit = sets the target, SL = sets the
  stop); a SELL with nothing held opens an intraday short.  A BUY against a short covers it.
* intraday positions still open at the broker's square-off time are closed with the square-off
  charge, like the real thing.

The trade *plan* (build_plan) turns an analysis into a costed, level-based long trade for the
configured capital: entry at a support level, stop just below it, target at the resistance with
the best net expectancy, every charge line by line, the break-even move, and barrier
probabilities measured on the chart's own history tilted by the calibrated forecast.
"""
from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from . import db
from .data import fetch_ohlcv, interval_seconds, DataError, INDIA_SESSION_UTC

log = logging.getLogger("tradebot.trading")

# Brokers' published equity schedules, all editable in the app.  Percentages are of the order value;
# rupee amounts are per order / per stock per day.  Statutory lines (STT, stamp, exchange, SEBI, GST)
# are the same at every broker.
ZERODHA_FEES = {
    "broker": "Zerodha",                                                    # zerodha.com/charges
    "brokerage_pct": 0.03, "brokerage_cap": 20.0, "brokerage_min": 0.0,    # intraday, per executed order: min(0.03%, 20)
    "brokerage_delivery_pct": 0.0, "brokerage_delivery_cap": 0.0, "brokerage_delivery_min": 0.0,   # delivery: free
    "stt_delivery_pct": 0.1,                                                # delivery: on buy and on sell
    "stt_intraday_sell_pct": 0.025,                                         # intraday: sell side only
    "stamp_delivery_pct": 0.015, "stamp_intraday_pct": 0.003,               # buy side
    "exchange_pct": 0.00297,                                                # NSE transaction charge, both sides
    "sebi_pct": 0.0001, "ipft_pct": 0.0001,                                 # both sides
    "gst_pct": 18.0,                                                        # on brokerage + exchange + SEBI + IPFT
    "dp_charge": 13.5, "dp_waive_below": 0.0,                               # delivery sell, per stock per day (+GST); no waiver
    "auto_squareoff": 50.0,                                                 # if Zerodha closes an intraday position for you (+GST)
    "slippage_pct": 0.05,                                                   # per side, model assumption
}
GROWW_FEES = {
    "broker": "Groww",                                                      # groww.in/pricing
    "brokerage_pct": 0.1, "brokerage_cap": 20.0, "brokerage_min": 5.0,     # intraday, per executed order: min(0.1%, 20), at least 5
    "brokerage_delivery_pct": 0.1, "brokerage_delivery_cap": 20.0, "brokerage_delivery_min": 5.0,  # delivery: the same
    "stt_delivery_pct": 0.1,                                                # delivery: on buy and on sell
    "stt_intraday_sell_pct": 0.025,                                         # intraday: sell side only
    "stamp_delivery_pct": 0.015, "stamp_intraday_pct": 0.003,               # buy side
    "exchange_pct": 0.00297,                                                # NSE transaction charge, both sides
    "sebi_pct": 0.0001, "ipft_pct": 0.0001,                                 # both sides
    "gst_pct": 18.0,                                                        # on brokerage + exchange + SEBI + IPFT
    "dp_charge": 20.0, "dp_waive_below": 100.0,                             # delivery sell, per stock per day (+GST); waived under 100 debit value
    "auto_squareoff": 50.0,                                                 # if Groww closes an intraday position for you (+GST)
    "slippage_pct": 0.05,                                                   # per side, model assumption
}
BROKERS = {"zerodha": ZERODHA_FEES, "groww": GROWW_FEES}
DEFAULT_BROKER = "zerodha"
DEFAULT_SETTINGS = {
    "capital": 10000.0, "risk_pct": 2.0, "max_positions": 2, "allow_overnight": True, "leverage": 1.0,
    "intraday_exit": "15:10",            # IST; the plan's own exit, before the broker square-off
    "squareoff_time": "15:20",           # IST; the broker closes intraday positions still open, with the square-off charge
    "min_trade_value": 2000.0,           # below this the flat charges eat the trade
    "max_cost_share": 0.4,               # charges may take at most this share of the expected gross profit
    "stop_atr": 0.4, "entry_zone_atr": 0.35, "max_level_atr": 4.0,
    "min_stop_pct": 0.15,                # a stop tighter than this share of the price is inside the noise
    "min_target_costs": 2.0,             # the move to the target must cover the round-trip charges this many times
    "broker": DEFAULT_BROKER,            # key of BROKERS; switching it resets "fees" to that broker's schedule
    "fees": ZERODHA_FEES,
}
TICK = 0.05
IST = timezone(timedelta(hours=5, minutes=30))
SIDES = ("BUY", "SELL")
PRODUCTS = ("intraday", "overnight")
ORDER_TYPES = ("market", "limit", "sl")


# ---------------------------------------------------------------- settings
def _broker_key(name) -> str:
    key = str(name or "").strip().lower()
    return key if key in BROKERS else DEFAULT_BROKER


def get_settings() -> dict:
    saved = db.get_setting("trading") or {}
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in DEFAULT_SETTINGS.items()}
    out["broker"] = _broker_key(saved.get("broker"))
    out["fees"] = dict(BROKERS[out["broker"]])
    for k, v in saved.items():
        if k == "fees" and isinstance(v, dict):
            # edits only apply to the broker they were made for (older saves were Groww-only and had no "broker")
            if str(v.get("broker", "")).lower() == out["broker"]:
                out["fees"].update({fk: fv for fk, fv in v.items() if fk in out["fees"] and fk != "broker"})
        elif k in out and k != "broker":
            out[k] = v
    return out


def brokers() -> list[dict]:
    return [{"key": k, "name": v["broker"]} for k, v in BROKERS.items()]


def save_settings(patch: dict) -> dict:
    cur = get_settings()
    if "broker" in patch and _broker_key(patch["broker"]) != cur["broker"]:
        cur["broker"] = _broker_key(patch["broker"])
        cur["fees"] = dict(BROKERS[cur["broker"]])
        patch = {k: v for k, v in patch.items() if k != "fees"}    # the form's fee fields belong to the old broker
    for k, v in patch.items():
        if k == "fees" and isinstance(v, dict):
            for fk, fv in v.items():
                if fk in cur["fees"] and fk != "broker":
                    cur["fees"][fk] = float(fv)
        elif k in DEFAULT_SETTINGS and k not in ("fees", "broker"):
            cur[k] = type(DEFAULT_SETTINGS[k])(v) if not isinstance(DEFAULT_SETTINGS[k], bool) else bool(v)
    db.set_setting("trading", cur)
    return cur


def reset_settings() -> dict:
    db.set_setting("trading", {})
    return get_settings()


# ---------------------------------------------------------------- charges
def _pct(value: float, pct: float) -> float:
    return value * pct / 100.0


def order_charges(value: float, side: str, mode: str, fees: dict, dp: bool = False) -> dict:
    """Charges for one executed order of `value` rupees. `side` is 'buy'/'sell', `mode` 'intraday'/'overnight'."""
    if value <= 0:
        return {"brokerage": 0, "stt": 0, "stamp": 0, "exchange": 0, "sebi": 0, "ipft": 0, "gst": 0, "dp": 0, "slippage": 0, "total": 0}
    b = "brokerage_delivery_" if mode == "overnight" else "brokerage_"
    brokerage = max(min(fees[b + "cap"], _pct(value, fees[b + "pct"])), fees[b + "min"])
    if mode == "overnight":
        stt = _pct(value, fees["stt_delivery_pct"])
        stamp = _pct(value, fees["stamp_delivery_pct"]) if side == "buy" else 0.0
    else:
        stt = _pct(value, fees["stt_intraday_sell_pct"]) if side == "sell" else 0.0
        stamp = _pct(value, fees["stamp_intraday_pct"]) if side == "buy" else 0.0
    exchange = _pct(value, fees["exchange_pct"])
    sebi = _pct(value, fees["sebi_pct"])
    ipft = _pct(value, fees["ipft_pct"])
    gst = _pct(brokerage + exchange + sebi + ipft, fees["gst_pct"])
    dp_charge = fees["dp_charge"] * (1 + fees["gst_pct"] / 100) if (dp and side == "sell" and mode == "overnight" and value >= fees["dp_waive_below"]) else 0.0
    slippage = _pct(value, fees["slippage_pct"])
    items = {"brokerage": brokerage, "stt": stt, "stamp": stamp, "exchange": exchange, "sebi": sebi, "ipft": ipft, "gst": gst, "dp": dp_charge, "slippage": slippage}
    items = {k: round(v, 2) for k, v in items.items()}
    items["total"] = round(sum(items.values()), 2)
    return items


def round_trip(entry: float, exit_px: float, qty: int, mode: str, fees: dict, short: bool = False) -> dict:
    """Charges for opening and closing `qty` shares (slippage included as a cost)."""
    open_side, close_side = ("sell", "buy") if short else ("buy", "sell")
    buy = order_charges(entry * qty, open_side, mode, fees)
    sell = order_charges(exit_px * qty, close_side, mode, fees, dp=not short)
    total = round(buy["total"] + sell["total"], 2)
    value = entry * qty
    return {"buy": buy, "sell": sell, "total": total, "pct_of_value": round(total / value * 100, 3) if value else 0.0,
            "per_share": round(total / qty, 4) if qty else 0.0}


def _ledger_charges(value: float, side: str, mode: str, fees: dict, dp: bool = False) -> dict:
    """Ledger charges: slippage is already inside the paper fill price, so it is not charged again."""
    c = order_charges(value, side, mode, fees, dp=dp)
    c["total"] = round(c["total"] - c["slippage"], 2)
    c["slippage"] = 0.0
    return c


# ---------------------------------------------------------------- sessions and deadlines
def _session(day: datetime) -> tuple[datetime, datetime]:
    (oh, om), (ch, cm) = INDIA_SESSION_UTC
    d = day.replace(hour=0, minute=0, second=0, microsecond=0)
    return d.replace(hour=oh, minute=om), d.replace(hour=ch, minute=cm)


def _exit_utc(day: datetime, hhmm: str) -> datetime:
    h, m = (int(x) for x in hhmm.split(":"))
    ist = day.astimezone(IST).replace(hour=h, minute=m, second=0, microsecond=0)
    return ist.astimezone(timezone.utc)


def _next_weekday(day: datetime) -> datetime:
    d = day + timedelta(days=1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def deadlines(now: datetime, sec: int, exit_hhmm: str, horizon: int) -> dict:
    """Exit deadline and the number of bars until it for each mode (now is aware UTC)."""
    if sec >= 86400:
        days = max(1, horizon)
        d = now
        for _ in range(days):
            d = _next_weekday(d)
        end = _session(d)[1]
        return {"intraday": None, "overnight": {"deadline": end, "bars": days, "label": f"close in {days} session{'s' if days > 1 else ''}"}}
    open_t, close_t = _session(now)
    exit_today = _exit_utc(now, exit_hhmm)
    session_bars = max(1, int((exit_today - open_t).total_seconds() // sec))
    if now.weekday() < 5 and now < exit_today - timedelta(seconds=2 * sec):
        bars_today = max(1, int((exit_today - max(now, open_t)).total_seconds() // sec))
        intraday = {"deadline": exit_today, "bars": bars_today, "label": "today " + exit_hhmm + " IST"}
        nxt = _next_weekday(now)
        overnight = {"deadline": _exit_utc(nxt, exit_hhmm), "bars": bars_today + session_bars, "label": "next session " + exit_hhmm + " IST"}
    else:
        nxt = _next_weekday(now) if (now.weekday() >= 5 or now >= exit_today - timedelta(seconds=2 * sec)) else now
        intraday = {"deadline": _exit_utc(nxt, exit_hhmm), "bars": session_bars, "label": "next session " + exit_hhmm + " IST"}
        nxt2 = _next_weekday(nxt)
        overnight = {"deadline": _exit_utc(nxt2, exit_hhmm), "bars": 2 * session_bars, "label": "session after next " + exit_hhmm + " IST"}
    return {"intraday": intraday, "overnight": overnight}


def squareoff_utc(entry_time: datetime, hhmm: str) -> datetime:
    """The broker square-off that applies to an intraday position opened at `entry_time`."""
    so = _exit_utc(entry_time, hhmm)
    if entry_time >= so or entry_time.weekday() >= 5:
        so = _exit_utc(_next_weekday(entry_time), hhmm)
    return so


# ---------------------------------------------------------------- barrier statistics
def barrier_rates(df: pd.DataFrame, u: float, d: float, horizon: int, n: int = 1500) -> dict:
    """How often, starting from a random past bar, price rose `u` (fraction) before falling `d`
    within `horizon` bars, fell first, or did neither. A bar that touches both counts as a stop."""
    H = max(1, int(horizon))
    c = df["close"].to_numpy(dtype=float)[-(n + H):]
    h = df["high"].to_numpy(dtype=float)[-(n + H):]
    l = df["low"].to_numpy(dtype=float)[-(n + H):]
    N = len(c) - H
    if N < 40:
        return {}
    starts = c[:N]
    hit_up = np.zeros(N, dtype=bool)
    hit_dn = np.zeros(N, dtype=bool)
    still = np.ones(N, dtype=bool)
    for k in range(1, H + 1):
        up = still & (h[k:k + N] / starts - 1 >= u)
        dn = still & (l[k:k + N] / starts - 1 <= -d)
        hit_dn |= dn
        hit_up |= up & ~dn
        still &= ~(up | dn)
    return {"target": float(hit_up.mean()), "stop": float(hit_dn.mean()), "time": float(still.mean()), "n": int(N),
            "end_up_rate": float((c[H:H + N] > starts).mean())}


def _tilt(base: dict, p_up: float | None, up_rate: float | None) -> dict:
    """Scale the historical barrier rates by today's calibrated forecast relative to the chart's base up-rate."""
    if not base:
        return {}
    if p_up is None or up_rate is None or not (0.05 < up_rate < 0.95):
        return {**base, "tilted": False}
    t = base["target"] * min(2.0, max(0.5, p_up / up_rate))
    s = base["stop"] * min(2.0, max(0.5, (1 - p_up) / (1 - up_rate)))
    tot = t + s + base["time"]
    return {**base, "target": t / tot, "stop": s / tot, "time": base["time"] / tot, "tilted": True}


# ---------------------------------------------------------------- planning
def _levels(summary: dict, signals: list[dict], price: float) -> tuple[list, list]:
    pv, cpr, cam = summary.get("pivots") or {}, summary.get("cpr") or {}, summary.get("camarilla") or {}
    vb, va = summary.get("vwap_bands") or {}, summary.get("value_area") or {}
    sr = next((s.get("values") or {} for s in signals if s.get("key") == "support_resistance"), {})
    cand = [("pivot", pv.get("pivot")), ("S1", pv.get("s1")), ("S2", pv.get("s2")), ("S3", pv.get("s3")),
            ("R1", pv.get("r1")), ("R2", pv.get("r2")), ("R3", pv.get("r3")),
            ("CPR bottom", cpr.get("bc")), ("CPR top", cpr.get("tc")),
            ("Camarilla L3", cam.get("l3")), ("Camarilla L4", cam.get("l4")), ("Camarilla H3", cam.get("h3")), ("Camarilla H4", cam.get("h4")),
            ("VWAP", vb.get("vwap")), ("VWAP -1sd", vb.get("lower1")), ("VWAP -2sd", vb.get("lower2")), ("VWAP +1sd", vb.get("upper1")), ("VWAP +2sd", vb.get("upper2")),
            ("value area low", va.get("val")), ("POC", va.get("poc")), ("value area high", va.get("vah")),
            ("swing support", sr.get("support")), ("swing resistance", sr.get("resistance")),
            ("previous session low", pv.get("ref_low")), ("previous session high", pv.get("ref_high"))]
    cand = [(n, float(v)) for n, v in cand if v is not None and isinstance(v, (int, float)) and np.isfinite(v) and v > 0]
    supports = sorted([(n, v) for n, v in cand if v <= price], key=lambda t: -t[1])
    resistances = sorted([(n, v) for n, v in cand if v > price], key=lambda t: t[1])
    return supports, resistances


def _tick(x: float) -> float:
    return round(round(x / TICK) * TICK, 2)


def build_plan(result: dict, settings: dict | None = None, now: datetime | None = None, df: pd.DataFrame | None = None,
               check_positions: bool = True) -> dict:
    """Turn an analysis result into a costed trade plan in the direction of the call: a long bought at a
    support level (intraday or delivery), or - on an intraday chart - a short sold at a resistance level
    (intraday only, since cash delivery cannot short).  `check_positions=False` leaves out the open-positions
    limit (the ready-to-trade scanner shows that once, above the list).  Never raises; returns {"available": False, ...}."""
    st = settings or get_settings()
    fees = st["fees"]
    now = now or datetime.now(timezone.utc)
    try:
        symbol, interval = result["symbol"], result["interval"]
        sec = interval_seconds(interval)
        summary, signals = result["summary"], result.get("signals") or []
        price = float(result["price_at"])
        atr = float(summary.get("atr") or price * 0.01)
        if df is None:
            df = fetch_ohlcv(result.get("data_symbol") or symbol, interval, max_age=60)   # history for barrier rates; the analysis just refreshed it
        learner = summary.get("learner") or {}
        p_up = float(result["prob_up"])
        up_rate = learner.get("up_rate") if learner.get("available") else None
        direction = result["direction"]
        long = direction == "UP" or (direction == "SIDEWAYS" and p_up >= 0.5)
        supports, resistances = _levels(summary, signals, price)
        sup_out = [(n, round(v, 2)) for n, v in supports[:6]]
        res_out = [(n, round(v, 2)) for n, v in resistances[:6]]
        if not long and sec >= 86400:
            return {"available": False, "side": "SELL", "long": False, "supports": sup_out, "resistances": res_out,
                    "reason": "The call is DOWN and cash delivery cannot short-sell (shorts are intraday only). Wait for an UP call or switch to an intraday chart."}
        if long:
            entry_levels = [(n, v) for n, v in supports if price - v <= st["max_level_atr"] * atr]
        else:
            entry_levels = [(n, v) for n, v in resistances if v - price <= st["max_level_atr"] * atr]
        if not entry_levels:
            return {"available": False, "side": "BUY" if long else "SELL", "long": long, "supports": sup_out, "resistances": res_out,
                    "reason": f"No {'support' if long else 'resistance'} level within {st['max_level_atr']:.0f} ATR {'below' if long else 'above'} the price - nothing to {'buy' if long else 'sell'} against."}
        level_name, level = entry_levels[0]
        entry_type = "market" if abs(price - level) <= st["entry_zone_atr"] * atr else "limit"
        entry = price if entry_type == "market" else _tick(level)
        if long:
            stop = _tick(min(level - st["stop_atr"] * atr, entry * (1 - st["min_stop_pct"] / 100)))
        else:
            stop = _tick(max(level + st["stop_atr"] * atr, entry * (1 + st["min_stop_pct"] / 100)))
        risk_ps = abs(entry - stop)
        if risk_ps <= 0:
            return {"available": False, "reason": "Stop would not sit on the right side of the entry.", "supports": sup_out, "resistances": res_out}
        dls = deadlines(now, sec, st["intraday_exit"], int(result["horizon_bars"]))
        cash = portfolio_cash(st)
        risk_amount = st["capital"] * st["risk_pct"] / 100
        qty_risk = int(math.floor(risk_amount / risk_ps))
        qty_cash = int(math.floor(cash * st["leverage"] / entry)) if entry > 0 else 0
        qty = max(0, min(qty_risk, qty_cash))
        qty_shown = max(1, qty)
        # the target must be worth the trip: at least 0.8 x the risk and `min_target_costs` x the round-trip charges
        cost_pct = round_trip(entry, entry, qty_shown, "intraday", fees, short=not long)["pct_of_value"]
        min_move = max(0.8 * risk_ps, entry * cost_pct / 100 * st["min_target_costs"])
        pool = resistances if long else supports
        targets = [(n, _tick(v)) for n, v in pool if (v - entry if long else entry - v) >= min_move]
        if not targets:
            nearest = pool[0] if pool else None
            return {"available": False, "side": "BUY" if long else "SELL", "long": long, "supports": sup_out, "resistances": res_out,
                    "entry": round(entry, 2), "stop": stop, "qty": qty_shown, "cost_pct": cost_pct,
                    "reason": f"No {'resistance' if long else 'support'} level far enough {'above' if long else 'below'} {entry:,.2f} to pay for the trade: "
                              f"the round trip costs {cost_pct:.2f}% on {qty_shown} shares, so the target must be at least {min_move / entry * 100:.2f}% away; nearest is "
                              + (f"{nearest[0]} at {nearest[1]:,.2f} ({abs(nearest[1] / entry - 1) * 100:.2f}%)." if nearest else "none.")}
        if sec >= 86400:
            modes = ["overnight"]
        else:
            modes = ["intraday"] + (["overnight"] if long and st["allow_overnight"] else [])
        options = []
        for mode in modes:
            dl = dls[mode]
            if not dl:
                continue
            for tname, target in targets[:4]:
                move = abs(target - entry)
                if long:
                    base = barrier_rates(df, move / entry, risk_ps / entry, dl["bars"])
                    prob = _tilt(base, p_up, up_rate)
                else:
                    raw = barrier_rates(df, risk_ps / entry, move / entry, dl["bars"])
                    base = {**raw, "target": raw["stop"], "stop": raw["target"]} if raw else {}
                    prob = _tilt(base, 1 - p_up, None if up_rate is None else 1 - up_rate)
                win_c = round_trip(entry, target, qty_shown, mode, fees, short=not long)
                loss_c = round_trip(entry, stop, qty_shown, mode, fees, short=not long)
                flat_c = round_trip(entry, entry, qty_shown, mode, fees, short=not long)
                net_win = qty_shown * move - win_c["total"]
                net_loss = -qty_shown * risk_ps - loss_c["total"]
                net_flat = -flat_c["total"]
                exp = prob["target"] * net_win + prob["stop"] * net_loss + prob["time"] * net_flat if prob else None
                options.append({"mode": mode, "target": target, "target_name": tname, "deadline": dl["deadline"].isoformat(), "deadline_label": dl["label"],
                                "bars": dl["bars"], "prob": prob, "charges": win_c, "charges_loss": loss_c["total"], "charges_flat": flat_c["total"],
                                "net_win": round(net_win, 2), "net_loss": round(net_loss, 2), "net_flat": round(net_flat, 2),
                                "expectancy": None if exp is None else round(exp, 2),
                                "rr": round((move - win_c["per_share"]) / (risk_ps + loss_c["per_share"]), 2),
                                "breakeven_pct": round(flat_c["total"] / (qty_shown * entry) * 100, 3)})
        if not options:
            return {"available": False, "reason": "No exit window available.", "supports": sup_out, "resistances": res_out}
        options.sort(key=lambda o: (-(o["expectancy"] if o["expectancy"] is not None else -1e9), o["mode"] != "intraday"))
        best = options[0]
        value = qty_shown * entry
        gross_win = qty_shown * abs(best["target"] - entry)
        cost_share = best["charges"]["total"] / gross_win if gross_win > 0 else 1.0
        reasons = []
        if direction == "SIDEWAYS":
            reasons.append("no validated edge right now (the model made no call)")
        if qty < 1:
            reasons.append(f"capital too small: 1 share costs {entry:,.2f}, cash {cash:,.0f}" if qty_cash < 1 else f"risk budget {risk_amount:,.0f} covers no share with a {risk_ps:.2f} stop distance")
        if best["expectancy"] is not None and best["expectancy"] <= 0:
            reasons.append("expected net profit is not positive after charges")
        if cost_share > st["max_cost_share"]:
            reasons.append(f"charges would take {cost_share * 100:.0f}% of the expected gross profit (limit {st['max_cost_share'] * 100:.0f}%)")
        min_value = min(st["min_trade_value"], st["capital"] * 0.5)      # small accounts: half the capital is enough
        if value < min_value:
            reasons.append(f"trade value {value:,.0f} is below the {min_value:,.0f} minimum")
        open_n = len(db.list_trades(status="open")) + len(db.list_trades(status="pending")) if check_positions else 0
        if check_positions and open_n >= st["max_positions"]:
            reasons.append(f"already {open_n} position(s) open or pending (limit {st['max_positions']})")
        verdict = "no trade" if reasons else ("wait" if entry_type == "limit" else "trade")
        return {
            "available": True, "verdict": verdict, "reasons": reasons, "side": "BUY" if long else "SELL", "long": long,
            "entry_type": entry_type, "entry": round(entry, 2), "level": round(level, 2), "level_name": level_name,
            "stop": stop, "risk_per_share": round(risk_ps, 2), "qty": qty_shown, "qty_affordable": qty, "value": round(value, 2),
            "risk_rupees": round(qty_shown * risk_ps, 2), "risk_budget": round(risk_amount, 2), "cash": round(cash, 2),
            "cost_share": round(cost_share, 3), "best": best, "options": options,
            "supports": sup_out, "resistances": res_out,
            "atr": round(atr, 4), "price": round(price, 2), "settings": {k: st[k] for k in ("capital", "risk_pct", "max_positions", "allow_overnight", "leverage", "intraday_exit")},
            "fees": fees["broker"],
        }
    except DataError as exc:
        return {"available": False, "reason": str(exc)}
    except Exception as exc:  # pragma: no cover
        log.exception("trade plan failed")
        return {"available": False, "reason": f"plan failed: {exc}"}


# ---------------------------------------------------------------- ledger helpers
def _entry_total(t: dict) -> float:
    d = t.get("charges_detail") or {}
    return float((d.get("entry") or d.get("buy") or {}).get("total", 0))


def _is_long(t: dict) -> bool:
    return (t.get("side") or "long") != "short"


def _slip(price: float, buying: bool, fees: dict) -> float:
    return _tick(price * (1 + fees["slippage_pct"] / 100)) if buying else _tick(price * (1 - fees["slippage_pct"] / 100))


def _fetch_last(symbol: str, interval: str) -> float:
    return float(fetch_ohlcv(symbol, interval)["close"].iloc[-1])


def _aware(iso: str | None) -> datetime | None:
    if not iso:
        return None
    d = datetime.fromisoformat(iso)
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def portfolio_cash(settings: dict | None = None) -> float:
    """Capital plus realised P&L, minus the value tied up in open positions (shorts block the same margin) and pending orders."""
    st = settings or get_settings()
    cash = float(st["capital"])
    for t in db.list_trades():
        if t["status"] == "closed":
            cash += float(t["net_pnl"] or 0)
        elif t["status"] == "open":
            cash -= float(t["fill_price"]) * t["qty"] + _entry_total(t)
        elif t["status"] == "pending":
            cash -= float(t["entry_price"]) * t["qty"]
    return cash


def open_positions(symbol: str | None = None) -> list[dict]:
    rows = [t for t in db.list_trades(status="open") if not symbol or t["symbol"] == symbol]
    return sorted(rows, key=lambda t: t["entry_time"] or t["created_at"])


# ---------------------------------------------------------------- orders
def preview_order(symbol: str, side: str, product: str, order_type: str, qty: int, price: float | None = None,
                  trigger: float | None = None, live_price: float | None = None, interval: str = "15m") -> dict:
    """What an order would do and cost, without placing it.  Errors are returned, not raised."""
    st = get_settings()
    fees = st["fees"]
    errors, notes = [], []
    side, product, order_type = (side or "").upper(), (product or "intraday").lower(), (order_type or "market").lower()
    if side not in SIDES:
        errors.append("side must be BUY or SELL")
    if product not in PRODUCTS:
        errors.append("product must be intraday or overnight")
    if order_type not in ORDER_TYPES:
        errors.append("order type must be market, limit or sl")
    qty = int(qty or 0)
    if qty < 1:
        errors.append("quantity must be at least 1")
    try:
        ltp = float(live_price) if live_price else _fetch_last(symbol, interval)
    except Exception as exc:
        return {"errors": [f"no price for {symbol}: {exc}"], "notes": [], "ltp": None}
    if order_type == "limit" and not price:
        errors.append("a limit order needs a price")
    if order_type == "sl" and not trigger:
        errors.append("an SL order needs a trigger price")
    ref = float(price) if (order_type == "limit" and price) else (float(trigger) if (order_type == "sl" and trigger) else ltp)
    longs = [t for t in open_positions(symbol) if _is_long(t)]
    shorts = [t for t in open_positions(symbol) if not _is_long(t)]
    held = sum(t["qty"] for t in longs)
    shorted = sum(t["qty"] for t in shorts)
    if side == "BUY":
        action = "cover_short" if shorted else "open_long"
    else:
        action = "close_long" if held else ("open_short" if product == "intraday" else "invalid")
    if action == "invalid":
        errors.append("delivery orders can only sell shares you hold; short-selling is intraday only")
    if action in ("close_long", "cover_short"):
        have = held if action == "close_long" else shorted
        if qty > have:
            notes.append(f"you hold {have}; the order will close all {have}")
            qty = have
        pos_mode = (longs or shorts)[0]["mode"]
        if product != pos_mode:
            notes.append(f"position is {pos_mode}; exit charges follow the position's product")
        product = pos_mode
    cash = portfolio_cash(st)
    open_n = len(db.list_trades(status="open")) + len(db.list_trades(status="pending"))
    charges_side = "buy" if side == "BUY" else "sell"
    entry_charges = order_charges(ref * qty, charges_side, product, fees, dp=(action == "close_long"))
    margin = ref * qty if action in ("open_long", "open_short") else 0.0
    rt = None
    if action in ("open_long", "open_short"):
        if margin > cash * st["leverage"] + 1e-9:
            errors.append(f"insufficient cash: {margin:,.0f} needed, {cash:,.0f} available")
        if open_n >= st["max_positions"]:
            errors.append(f"position limit reached ({st['max_positions']} open or pending)")
        rt = round_trip(ref, ref, qty, product, fees, short=(action == "open_short"))
    return {"errors": errors, "notes": notes, "action": action, "side": side, "product": product, "order_type": order_type, "qty": qty,
            "ltp": round(ltp, 2), "ref_price": round(ref, 2), "value": round(ref * qty, 2), "margin": round(margin, 2), "cash": round(cash, 2),
            "cash_after": round(cash - margin, 2), "charges": entry_charges, "round_trip": rt,
            "breakeven_pct": rt["pct_of_value"] if rt else None, "held": held, "shorted": shorted,
            "squareoff": squareoff_utc(datetime.now(timezone.utc), st["squareoff_time"]).isoformat() if product == "intraday" else None}


def place_order(symbol: str, interval: str, side: str, product: str, order_type: str, qty: int, price: float | None = None,
                trigger: float | None = None, stop: float | None = None, target: float | None = None, live_price: float | None = None,
                deadline: str | None = None, plan: dict | None = None, prediction_id: int | None = None) -> dict:
    """Place a paper order the way a broker panel would.  Returns {"action", "trades": [...], "notes"}."""
    pv = preview_order(symbol, side, product, order_type, qty, price, trigger, live_price, interval)
    if pv["errors"]:
        raise DataError("; ".join(pv["errors"]))
    st = get_settings()
    fees = st["fees"]
    now = datetime.now(timezone.utc)
    action, qty, product = pv["action"], pv["qty"], pv["product"]
    ltp = pv["ltp"]
    order_type = pv["order_type"]
    if action in ("close_long", "cover_short"):
        positions = [t for t in open_positions(symbol) if _is_long(t) == (action == "close_long")]
        remaining, out = qty, []
        for t in positions:
            if remaining <= 0:
                break
            q = min(remaining, t["qty"])
            if order_type == "market":
                out.append(_close_qty(t, q, ltp, now, "manual", fees))
            else:
                part = _split(t, q) if q < t["qty"] else t
                fields = {"target": float(price)} if order_type == "limit" else {"stop": float(trigger)}
                db.update_trade(part["id"], fields)
                out.append(db.get_trade(part["id"]))
            remaining -= q
        return {"action": action, "trades": out, "notes": pv["notes"]}
    long = action == "open_long"
    fill = _slip(ltp, buying=long, fees=fees) if order_type == "market" else None
    entry_price = float(price) if order_type == "limit" else (float(trigger) if order_type == "sl" else fill)
    row = {"symbol": symbol, "interval": interval, "mode": product, "side": "long" if long else "short",
           "status": "open" if fill else "pending", "created_at": now.isoformat(), "qty": qty, "entry_type": order_type,
           "entry_price": entry_price, "trigger": float(trigger) if trigger else None, "fill_price": fill,
           "entry_time": now.isoformat() if fill else None, "stop": float(stop) if stop else 0.0, "target": float(target) if target else 0.0,
           "deadline": deadline or "", "prediction_id": prediction_id, "plan_json": json.dumps(plan, default=str) if plan else None,
           "charges_json": json.dumps({"entry": _ledger_charges(fill * qty, "buy" if long else "sell", product, fees)}) if fill else "{}"}
    tid = db.insert_trade(row)
    return {"action": action, "trades": [db.get_trade(tid)], "notes": pv["notes"]}


def place_trade(symbol: str, interval: str, plan: dict, prediction_id: int | None = None, live_price: float | None = None) -> dict:
    """Record the prediction card's plan as an order (kept for the API)."""
    if not plan.get("available"):
        raise DataError("The plan is not tradeable.")
    if plan.get("qty_affordable", 0) < 1:
        raise DataError("Not enough capital for one share.")
    best = plan["best"]
    res = place_order(symbol, interval, "BUY", best["mode"], plan["entry_type"], int(plan["qty_affordable"]),
                      price=plan["entry"] if plan["entry_type"] == "limit" else None, stop=plan["stop"], target=best["target"],
                      live_price=live_price, deadline=best["deadline"], plan=plan, prediction_id=prediction_id)
    return res["trades"][0]


def _split(t: dict, q: int) -> dict:
    """Split `q` shares off an open position into a separate open row (for partial exits); returns the new row."""
    detail = t.get("charges_detail") or {}
    entry = detail.get("entry") or detail.get("buy") or {}
    frac = q / t["qty"]
    part_entry = {k: round(v * frac, 2) for k, v in entry.items()}
    rest_entry = {k: round(v - part_entry.get(k, 0), 2) for k, v in entry.items()}
    db.update_trade(t["id"], {"qty": t["qty"] - q, "charges_json": json.dumps({**detail, "entry": rest_entry})})
    row = {k: t.get(k) for k in ("symbol", "interval", "mode", "side", "status", "created_at", "entry_type", "entry_price", "trigger",
                                  "fill_price", "entry_time", "prediction_id", "plan_json", "note")}
    row.update({"qty": q, "stop": t.get("stop") or 0.0, "target": t.get("target") or 0.0, "deadline": t.get("deadline") or "",
                "charges_json": json.dumps({**detail, "entry": part_entry})})
    return db.get_trade(db.insert_trade(row))


def _close(t: dict, price: float, when: datetime, reason: str, fees: dict) -> dict:
    qty, fill, long = t["qty"], float(t["fill_price"]), _is_long(t)
    exit_px = _slip(price, buying=not long, fees=fees)
    detail = t.get("charges_detail") or {}
    detail["exit"] = _ledger_charges(exit_px * qty, "sell" if long else "buy", t["mode"], fees, dp=long)
    if reason == "squareoff":
        so = round(fees["auto_squareoff"] * (1 + fees["gst_pct"] / 100), 2)     # the broker charges 18% GST on the square-off fee
        detail["exit"]["squareoff"] = so
        detail["exit"]["total"] = round(detail["exit"]["total"] + so, 2)
    charges = round(_entry_total(t) + detail["exit"]["total"], 2)
    gross = round((exit_px - fill) * qty if long else (fill - exit_px) * qty, 2)
    db.close_trade(t["id"], exit_px, when.isoformat(), reason, gross, charges, round(gross - charges, 2), json.dumps(detail))
    return db.get_trade(t["id"])


def _close_qty(t: dict, q: int, price: float, when: datetime, reason: str, fees: dict) -> dict:
    if q >= t["qty"]:
        return _close(t, price, when, reason, fees)
    return _close(_split(t, q), price, when, reason, fees)


def close_trade(tid: int, price: float | None = None, reason: str = "manual") -> dict:
    t = db.get_trade(tid)
    if not t:
        raise DataError("Trade not found")
    st = get_settings()
    if t["status"] == "pending":
        db.cancel_trade(tid)
        return db.get_trade(tid)
    if t["status"] != "open":
        raise DataError("Trade is not open")
    if price is None:
        price = _fetch_last(t["symbol"], t["interval"])
    return _close(t, float(price), datetime.now(timezone.utc), reason, st["fees"])


def check_trades(now: datetime | None = None) -> dict:
    """Fill pending orders and exit open positions on stop / target / deadline / broker square-off using real bars."""
    now = now or datetime.now(timezone.utc)
    st = get_settings()
    fees = st["fees"]
    filled, closed, errors = [], [], []
    cache: dict[tuple, pd.DataFrame] = {}
    for t in db.list_trades(status="pending") + db.list_trades(status="open"):
        try:
            key = (t["symbol"], t["interval"])
            if key not in cache:
                cache[key] = fetch_ohlcv(t["symbol"], t["interval"])
            df = cache[key]
            sec = interval_seconds(t["interval"])
            long = _is_long(t)
            deadline = _aware(t.get("deadline"))
            since = _aware(t["entry_time"] or t["created_at"])
            bar_start = pd.Timestamp(since).tz_convert("UTC").tz_localize(None)
            bar_start = bar_start.floor(f"{sec}s") if sec < 86400 else bar_start.normalize()
            path = df[df.index >= bar_start]
            if t["status"] == "pending":
                so = squareoff_utc(since, st["squareoff_time"]) if t["mode"] == "intraday" else None
                if (deadline and now >= deadline) or (so and now >= so):
                    db.cancel_trade(t["id"]); closed.append({"id": t["id"], "reason": "expired"}); continue
                lvl = float(t["entry_price"])
                if t["entry_type"] == "limit":
                    hit = path[path["low"] <= lvl] if long else path[path["high"] >= lvl]
                else:   # sl: the trigger becomes a market order
                    hit = path[path["high"] >= lvl] if long else path[path["low"] <= lvl]
                if not len(hit):
                    continue
                bar = hit.iloc[0]
                if t["entry_type"] == "limit":
                    fill = _tick(min(lvl, float(bar["open"])) if long else max(lvl, float(bar["open"])))
                else:
                    fill = _slip(max(lvl, float(bar["open"])) if long else min(lvl, float(bar["open"])), buying=long, fees=fees)
                when = pd.Timestamp(hit.index[0]).to_pydatetime().replace(tzinfo=timezone.utc)
                db.fill_trade(t["id"], fill, when.isoformat(), json.dumps({"entry": _ledger_charges(fill * t["qty"], "buy" if long else "sell", t["mode"], fees)}))
                filled.append({"id": t["id"], "fill": fill})
                t = db.get_trade(t["id"])
                path = df[df.index >= pd.Timestamp(hit.index[0])]
                since = when
            stop, target = t.get("stop"), t.get("target")
            so = squareoff_utc(since, st["squareoff_time"]) if t["mode"] == "intraday" else None
            fill_bar = pd.Timestamp(t["entry_time"]).tz_convert("UTC").tz_localize(None) if t.get("entry_time") else None
            done = False
            for ts, bar in path.iterrows():
                ts = pd.Timestamp(ts)
                bar_end = ts.to_pydatetime().replace(tzinfo=timezone.utc) + timedelta(seconds=sec)
                o, h, l, c = (float(bar[k]) for k in ("open", "high", "low", "close"))
                in_fill_bar = fill_bar is not None and ts <= fill_bar < ts + pd.Timedelta(seconds=sec)
                hi, lo = (c, c) if in_fill_bar else (h, l)      # the fill bar is judged on its close only
                stop_hit = bool(stop) and ((lo <= stop) if long else (hi >= stop))
                target_hit = bool(target) and ((hi >= target) if long else (lo <= target))
                if stop_hit:
                    px = c if in_fill_bar else (min(stop, o) if long else max(stop, o))
                    closed.append(_close(t, px, bar_end, "stop", fees)); done = True; break
                if target_hit:
                    px = c if in_fill_bar else (max(target, o) if long else min(target, o))
                    closed.append(_close(t, px, bar_end, "target", fees)); done = True; break
                if deadline and bar_end >= deadline:
                    closed.append(_close(t, c, bar_end, "deadline", fees)); done = True; break
                if so and bar_end >= so:
                    closed.append(_close(t, c, bar_end, "squareoff", fees)); done = True; break
            if not done and len(path):
                if deadline and now >= deadline + timedelta(seconds=sec):
                    closed.append(_close(t, float(path["close"].iloc[-1]), now, "deadline", fees))
                elif so and now >= so + timedelta(seconds=sec):
                    closed.append(_close(t, float(path["close"].iloc[-1]), now, "squareoff", fees))
        except DataError as exc:
            errors.append({"id": t["id"], "error": str(exc)})
        except Exception as exc:  # pragma: no cover
            log.exception("trade check failed for %s", t["id"])
            errors.append({"id": t["id"], "error": str(exc)})
    return {"filled": filled,
            "closed": [c if "reason" in c else {"id": c["id"], "reason": c["exit_reason"], "net_pnl": c["net_pnl"]} for c in closed],
            "errors": errors}


# ---------------------------------------------------------------- portfolio
def portfolio() -> dict:
    st = get_settings()
    fees = st["fees"]
    trades = db.list_trades()
    open_t = [t for t in trades if t["status"] == "open"]
    pending = [t for t in trades if t["status"] == "pending"]
    closed = sorted([t for t in trades if t["status"] == "closed"], key=lambda t: t["exit_time"] or "")
    cash = portfolio_cash(st)
    invested = unrealised = 0.0
    last_cache: dict[tuple, float] = {}
    for t in open_t:
        key = (t["symbol"], t["interval"])
        try:
            last = last_cache[key] if key in last_cache else _fetch_last(*key)
        except Exception:
            last = float(t["fill_price"])
        last_cache[key] = last
        long = _is_long(t)
        exit_est = _ledger_charges(last * t["qty"], "sell" if long else "buy", t["mode"], fees, dp=long)["total"]
        fill = float(t["fill_price"])
        gross = (last - fill) * t["qty"] if long else (fill - last) * t["qty"]
        t["last_price"] = last
        t["unrealised"] = round(gross - _entry_total(t) - exit_est, 2)
        t["unrealised_pct"] = round(((last / fill - 1) if long else (fill / last - 1)) * 100, 2) if fill else 0.0
        tgt = t.get("target")
        if tgt and long and tgt > fill:
            t["progress"] = round((last - fill) / (tgt - fill) * 100, 1)
        elif tgt and not long and tgt < fill:
            t["progress"] = round((fill - last) / (fill - tgt) * 100, 1)
        else:
            t["progress"] = None
        t["squareoff"] = squareoff_utc(_aware(t["entry_time"]), st["squareoff_time"]).isoformat() if t["mode"] == "intraday" and t.get("entry_time") else None
        invested += fill * t["qty"]
        unrealised += t["unrealised"]
    wins = [t for t in closed if (t["net_pnl"] or 0) > 0]
    losses = [t for t in closed if (t["net_pnl"] or 0) <= 0]
    gross_win = sum(t["net_pnl"] for t in wins)
    gross_loss = -sum(t["net_pnl"] for t in losses)
    curve, eq, peak, mdd = [], float(st["capital"]), float(st["capital"]), 0.0
    for t in closed:
        eq += float(t["net_pnl"] or 0)
        peak = max(peak, eq)
        mdd = max(mdd, (peak - eq) / peak * 100 if peak else 0)
        curve.append({"time": t["exit_time"], "equity": round(eq, 2)})
    pf = (gross_win / gross_loss) if gross_loss > 0 else None
    stats = {
        "trades": len(closed), "open": len(open_t), "pending": len(pending),
        "net_pnl": round(sum(t["net_pnl"] or 0 for t in closed), 2), "gross_pnl": round(sum(t["gross_pnl"] or 0 for t in closed), 2),
        "charges": round(sum(t["charges"] or 0 for t in closed), 2),
        "win_rate": round(len(wins) / len(closed), 3) if closed else None,
        "profit_factor": round(pf, 2) if pf is not None else None,
        "expectancy": round(sum(t["net_pnl"] or 0 for t in closed) / len(closed), 2) if closed else None,
        "avg_win": round(gross_win / len(wins), 2) if wins else None, "avg_loss": round(-gross_loss / len(losses), 2) if losses else None,
        "max_drawdown_pct": round(mdd, 2), "return_pct": round((eq / float(st["capital"]) - 1) * 100, 2) if st["capital"] else None,
    }
    return {"settings": st, "capital": st["capital"], "cash": round(cash, 2), "invested": round(invested, 2), "unrealised": round(unrealised, 2),
            "equity": round(cash + invested + unrealised, 2), "open": open_t, "pending": pending, "closed": list(reversed(closed)),
            "stats": stats, "equity_curve": curve}
