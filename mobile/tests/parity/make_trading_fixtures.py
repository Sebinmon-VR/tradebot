"""Parity fixtures for the paper-trading port (mobile/src/engine/trading.ts, evaluator.ts).

Runs app/trading.py and app/evaluator.py over a grid of cases - order charges, round trips, ticks and
slippage, deadlines, barrier statistics, trade plans on the bar fixtures, full ledger scenarios on a
temporary SQLite db with a fake clock and a fake price feed, and prediction grading - and dumps inputs and
outputs to fixtures/trading/*.json.  The TypeScript tests replay the same inputs.

Run from the repo root:  python mobile/tests/parity/make_trading_fixtures.py
"""
from __future__ import annotations

import json
import math
import os
import random
import sys
import tempfile
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)
from app import db, trading, evaluator, data  # noqa: E402
from app.data import DataError  # noqa: E402

HERE = os.path.dirname(__file__)
BARS_DIR = os.path.join(HERE, "fixtures")
OUT = os.path.join(HERE, "fixtures", "trading")
UTC = timezone.utc
NAMES = ["RELIANCE_NS_1d", "TCS_NS_15m", "ELECTCAST_NS_5m"]
SYMBOL = {"RELIANCE_NS_1d": ("RELIANCE.NS", "1d"), "TCS_NS_15m": ("TCS.NS", "15m"), "ELECTCAST_NS_5m": ("ELECTCAST.NS", "5m")}


def clean(x):
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (np.bool_, bool)):
        return bool(x)
    if isinstance(x, np.integer):
        return int(x)
    if isinstance(x, (float, np.floating)):
        return None if math.isnan(x) or math.isinf(x) else float(x)
    if isinstance(x, datetime):
        return x.isoformat()
    return x


def dump(name, obj):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, name + ".json"), "w") as f:
        json.dump(clean(obj), f)
    print(name, os.path.getsize(os.path.join(OUT, name + ".json")) // 1024, "KB")


def load_df(name) -> pd.DataFrame:
    with open(os.path.join(BARS_DIR, name + ".json")) as f:
        b = json.load(f)["bars"]
    idx = pd.to_datetime(b["t"], unit="s")          # naive UTC, like fetch_ohlcv
    return pd.DataFrame({"open": b["o"], "high": b["h"], "low": b["l"], "close": b["c"], "volume": [v or 0 for v in b["v"]]}, index=idx)


def load_levels(name) -> dict:
    with open(os.path.join(BARS_DIR, name + ".json")) as f:
        d = json.load(f)
    return d


CUSTOM_FEES = dict(trading.GROWW_FEES, broker="Custom", brokerage_pct=0.05, brokerage_cap=25.0, brokerage_min=0.0, dp_charge=13.5,
                   dp_waive_below=0.0, slippage_pct=0.1, stt_delivery_pct=0.1, exchange_pct=0.00345)
FEES = {"groww": dict(trading.GROWW_FEES), "custom": CUSTOM_FEES}


# ---------------------------------------------------------------- A: numerics and charges
def make_charges():
    rng = random.Random(7)
    fixed = [0, -5, 0.01, 0.5, 1, 5, 10, 49.95, 99.95, 99.99, 100, 100.05, 250, 499.99, 500, 1234.56, 4999.95, 5000, 5000.05,
             12345.6, 19999.95, 20000, 20000.05, 55555.55, 123456.78, 1e6, 2.5e6, 4166.6666, 8333.35]
    values = list(fixed)
    for _ in range(320):
        price = round(round(rng.uniform(0.5, 5000) / 0.05) * 0.05, 2)
        values.append(price * rng.randint(1, 2000))
    order = []
    for v in values:
        for fk in FEES:
            for side in ("buy", "sell"):
                for mode in ("intraday", "overnight"):
                    for dp in (False, True):
                        order.append({"in": [v, side, mode, dp, fk], "out": trading.order_charges(v, side, mode, FEES[fk], dp=dp),
                                      "ledger": trading._ledger_charges(v, side, mode, FEES[fk], dp=dp)})
    rt = []
    for _ in range(500):
        entry = round(round(rng.uniform(0.5, 4000) / 0.05) * 0.05, 2)
        exit_px = trading._tick(entry * (1 + rng.uniform(-0.06, 0.06)))
        qty = rng.choice([0, 1, 2, 3, 5, 7, 10, 25, 50, 100, 333, 1000, rng.randint(1, 5000)])
        mode = rng.choice(["intraday", "overnight"])
        short = rng.random() < 0.3
        fk = rng.choice(list(FEES))
        rt.append({"in": [entry, exit_px, qty, mode, short, fk], "out": trading.round_trip(entry, exit_px, qty, mode, FEES[fk], short=short)})
    ticks = []
    xs = [100.025, 100.075, 0.025, 0.075, 2.5, 1.005, 2.675, 99.975, 1234.5649999, 0.0, 0.01, 7.125]
    xs += [rng.uniform(0.1, 10000) for _ in range(400)]
    for x in xs:
        ticks.append({"x": x, "tick": trading._tick(x), "slip_buy": trading._slip(x, True, trading.GROWW_FEES),
                      "slip_sell": trading._slip(x, False, trading.GROWW_FEES), "slip_custom": trading._slip(x, True, CUSTOM_FEES)})
    rounds = []
    for x in [0.125, 0.375, 2.675, 1.005, 0.5, 1.5, 2.5, -0.5, -2.5, -0.125, 0.0149999, 0.015, 0.025, 0.035, 1e-9, -1e-9, 123456.785,
              4.35, 10.005, 99.995, 1234567.125, 0.045, 5.0e-3] + [rng.uniform(-1e5, 1e5) for _ in range(300)] + [round(rng.uniform(0, 1000), 3) for _ in range(300)]:
        rounds.append({"x": x, "r0": float(round(x)), "r1": round(x, 1), "r2": round(x, 2), "r3": round(x, 3), "r4": round(x, 4),
                       "f0": f"{x:.0f}", "f2": f"{x:.2f}", "fc0": f"{x:,.0f}", "fc2": f"{x:,.2f}"})
    sums = []
    for _ in range(200):
        k = rng.randint(0, 12)
        xs2 = [round(rng.uniform(-1000, 1000), rng.randint(0, 4)) for _ in range(k)]
        sums.append({"xs": xs2, "sum": float(sum(xs2))})
    sums.append({"xs": [1e16, 1.0, -1e16], "sum": float(sum([1e16, 1.0, -1e16]))})
    sums.append({"xs": [0.1] * 10, "sum": float(sum([0.1] * 10))})
    dump("charges", {"fees": FEES, "order": order, "round_trip": rt, "ticks": ticks, "rounds": rounds, "sums": sums})


# ---------------------------------------------------------------- B: deadlines
def make_deadlines():
    nows = []
    for day in (24, 25, 26, 27, 28):
        for hh, mm, ss in [(0, 0, 0), (3, 0, 0), (3, 45, 0), (5, 17, 31), (9, 10, 0), (9, 25, 0), (9, 39, 0), (9, 40, 0), (9, 41, 0), (9, 50, 0),
                           (10, 30, 0), (19, 0, 0), (22, 0, 0)]:
            nows.append(datetime(2026, 9, day, hh, mm, ss, tzinfo=UTC))
    cases = []
    for now in nows:
        for sec in (60, 300, 900, 1800, 3600, 86400, 604800):
            for horizon in ((1, 3, 7) if sec >= 86400 else (5,)):
                for hhmm in ("15:10", "09:30", "15:29"):
                    cases.append({"now": now.isoformat(), "sec": sec, "hhmm": hhmm, "horizon": horizon,
                                  "out": trading.deadlines(now, sec, hhmm, horizon)})
    so = []
    for now in nows:
        for hhmm in ("15:20", "15:10", "09:00"):
            so.append({"t": now.isoformat(), "hhmm": hhmm, "out": trading.squareoff_utc(now, hhmm).isoformat()})
    dump("deadlines", {"deadlines": cases, "squareoff": so})


# ---------------------------------------------------------------- C: barrier stats
def make_barriers():
    cases = []
    for name in NAMES:
        df = load_df(name)
        for u, d in [(0.002, 0.002), (0.01, 0.005), (0.03, 0.02), (0.001, 0.05), (0.0, 0.0)]:
            for h in (1, 5, 20):
                for n in (1500, 100, 30):
                    base = trading.barrier_rates(df, u, d, h, n)
                    tilts = [[p, r, trading._tilt(base, p, r)] for p, r in [(0.6, 0.5), (0.3, 0.55), (0.99, 0.2), (0.5, None), (None, 0.5), (0.6, 0.97), (0.01, 0.9)]]
                    cases.append({"bars": name, "u": u, "d": d, "h": h, "n": n, "out": base, "tilts": tilts})
    dump("barriers", {"cases": cases})


# ---------------------------------------------------------------- temp db + fake clock + fake market
class Clock:
    now = datetime(2026, 9, 24, 4, 16, tzinfo=UTC)


class FakeDT(datetime):
    @classmethod
    def now(cls, tz=None):
        return Clock.now if tz is not None else Clock.now.replace(tzinfo=None)


MARKET: dict[tuple, pd.DataFrame] = {}


def fake_fetch(symbol, interval, *a, **k):
    if (symbol, interval) not in MARKET:
        raise DataError(f"No data for {symbol} {interval}")
    return MARKET[(symbol, interval)]


def fresh_db():
    path = os.path.join(tempfile.mkdtemp(), "t.db")
    db.DB_PATH = path
    db.init_db(path)


def raw_rows():
    with db.connect() as con:
        return [dict(r) for r in con.execute("SELECT * FROM trades ORDER BY id").fetchall()]


trading.datetime = FakeDT
trading.fetch_ohlcv = fake_fetch
db.now_iso = lambda: Clock.now.replace(microsecond=0).isoformat()


# ---------------------------------------------------------------- D: plans
def synth_result(name, lv, df, price, direction, p_up, learner, horizon, sr):
    symbol, interval = SYMBOL[name]
    atr = lv["indicators"]["atr_14"][-1]
    summary = {"atr": atr, "pivots": lv["levels"]["pivots"], "cpr": lv["levels"]["cpr"], "camarilla": lv["levels"]["camarilla"],
               "vwap_bands": lv["levels"]["vwap_bands"], "value_area": lv["levels"]["profile"], "learner": learner}
    signals = [{"key": "ema_cross", "values": {"fast": 1.0}}]
    if sr is not None:
        signals.append({"key": "support_resistance", "values": sr})
    return {"symbol": symbol, "interval": interval, "summary": summary, "signals": signals, "price_at": price, "prob_up": p_up,
            "direction": direction, "horizon_bars": horizon}


SEED_ROWS = [
    {"symbol": "TCS.NS", "interval": "15m", "mode": "intraday", "side": "long", "status": "open", "created_at": "2026-09-24T04:00:00+00:00", "qty": 3,
     "entry_type": "market", "entry_price": 2070.05, "trigger": None, "fill_price": 2070.05, "entry_time": "2026-09-24T04:00:00+00:00", "stop": 2050.0,
     "target": 0.0, "deadline": "", "charges_json": json.dumps({"entry": {"total": 6.93, "brokerage": 5.0}}), "plan_json": None, "prediction_id": None, "note": None},
    {"symbol": "ELECTCAST.NS", "interval": "5m", "mode": "intraday", "side": "short", "status": "pending", "created_at": "2026-09-24T04:05:00+00:00", "qty": 40,
     "entry_type": "limit", "entry_price": 101.35, "trigger": None, "fill_price": None, "entry_time": None, "stop": 0.0, "target": 0.0, "deadline": "",
     "charges_json": "{}", "plan_json": None, "prediction_id": 4, "note": "x"},
]


def seed_closed():
    tid = db.insert_trade({**SEED_ROWS[0], "created_at": "2026-09-20T04:00:00+00:00"})
    db.close_trade(tid, 2061.3, "2026-09-20T06:00:00+00:00", "stop", -26.25, 14.1, -40.35, json.dumps({"entry": {"total": 6.93}, "exit": {"total": 7.17}}))


def make_plans():
    rng = random.Random(11)
    fresh_db()
    defaults = trading.get_settings()

    def st(**kw):
        s = json.loads(json.dumps(defaults))
        fees = kw.pop("fees", None)
        s.update(kw)
        if fees:
            s["fees"].update(fees)
        return s
    variants = [None, st(), st(capital=500.0), st(capital=250000.0, risk_pct=1.0), st(allow_overnight=False), st(leverage=5.0, max_positions=1),
                st(capital=2000.0, min_trade_value=500.0), st(fees=CUSTOM_FEES), st(capital=100000.0, stop_atr=0.8, entry_zone_atr=1.0, max_level_atr=8.0),
                st(capital=50000.0, min_stop_pct=0.5, min_target_costs=4.0, max_cost_share=0.2)]
    nows = [datetime(2026, 9, 28, 4, 30, 5, tzinfo=UTC), datetime(2026, 9, 28, 10, 5, tzinfo=UTC), datetime(2026, 9, 26, 7, 0, tzinfo=UTC),
            datetime(2026, 9, 29, 9, 30, tzinfo=UTC)]
    dfs = {n: load_df(n) for n in NAMES}
    lvs = {n: load_levels(n) for n in NAMES}
    cases = []
    for i in range(300):
        name = NAMES[i % 3]
        df, lv = dfs[name], lvs[name]
        last = float(df["close"].iloc[-1])
        price = last * rng.choice([1.0, 1.0, 0.997, 1.004, 0.985, 1.02, 0.9])
        direction, p_up = rng.choice([("UP", 0.62), ("DOWN", 0.35), ("SIDEWAYS", 0.52), ("SIDEWAYS", 0.45), ("UP", 0.9), ("DOWN", 0.1)])
        learner = rng.choice([{"available": True, "up_rate": 0.53}, {"available": False, "up_rate": 0.5}, None, {"available": True, "up_rate": None},
                              {"available": True, "up_rate": 0.97}])
        horizon = rng.choice([1, 5, 12, 30])
        lows, highs = df["low"].iloc[-30:], df["high"].iloc[-30:]
        sr = rng.choice([{"support": float(lows.min()), "resistance": float(highs.max())}, {"support": None, "resistance": float(highs.max())}, None, {}])
        result = synth_result(name, lv, df, price, direction, p_up, learner, horizon, sr)
        if rng.random() < 0.05:
            result["interval"] = "2h"                         # unsupported -> DataError path
        if rng.random() < 0.1:
            result["summary"]["atr"] = None
        settings = rng.choice(variants)
        now = rng.choice(nows)
        seeded = rng.random() < 0.4
        fresh_db()
        if seeded:
            for r in SEED_ROWS:
                db.insert_trade(r)
            seed_closed()
        if settings is None and rng.random() < 0.5:
            trading.save_settings({"capital": 30000, "risk_pct": 3})
        out = trading.build_plan(result, settings=settings, now=now, df=df)
        cases.append({"bars": name, "result": result, "settings": settings, "now": now.isoformat(), "rows": raw_rows(),
                      "saved_settings": db.get_setting("trading"), "out": out})
    dump("plans", {"cases": cases})


# ---------------------------------------------------------------- E: ledger scenarios
def market_upto(symbol, interval, name, upto):
    MARKET[(symbol, interval)] = load_df(name).iloc[:upto]


def idx_at(name, iso):
    df = load_df(name)
    ts = pd.Timestamp(iso).tz_convert("UTC").tz_localize(None)
    return int((df.index <= ts).sum())      # number of bars that have started by `iso`


def run_steps(steps):
    fresh_db()
    MARKET.clear()
    out = []
    ctx = {"plan": None}
    for s in steps:
        op = s["op"]
        try:
            if op == "clock":
                Clock.now = datetime.fromisoformat(s["now"])
                res = None
            elif op == "market":
                market_upto(s["symbol"], s["interval"], s["bars"], s["upto"])
                res = None
            elif op == "save_settings":
                res = trading.save_settings(s["patch"])
            elif op == "reset_settings":
                res = trading.reset_settings()
            elif op == "get_settings":
                res = trading.get_settings()
            elif op == "preview":
                a = s["args"]
                res = trading.preview_order(a["symbol"], a["side"], a.get("product"), a.get("order_type"), a["qty"], a.get("price"), a.get("trigger"),
                                            a.get("live_price"), a.get("interval", "15m"))
            elif op == "place":
                a = s["args"]
                res = trading.place_order(a["symbol"], a.get("interval", "15m"), a["side"], a.get("product"), a.get("order_type"), a["qty"], a.get("price"),
                                          a.get("trigger"), a.get("stop"), a.get("target"), a.get("live_price"), a.get("deadline"))
            elif op == "plan":
                res = trading.build_plan(s["result"], df=MARKET[(s["result"]["symbol"], s["result"]["interval"])])
                ctx["plan"] = json.loads(json.dumps(clean(res)))
            elif op == "place_trade":
                res = trading.place_trade(s["symbol"], s["interval"], ctx["plan"], s.get("prediction_id"), s.get("live_price"))
            elif op == "close":
                res = trading.close_trade(s["id"], s.get("price"), s.get("reason", "manual"))
            elif op == "check":
                res = trading.check_trades()
            elif op == "portfolio":
                res = trading.portfolio()
            elif op == "cash":
                res = trading.portfolio_cash()
            else:
                raise ValueError(op)
            out.append({"ok": res, "state": db.list_trades()})
        except (DataError, ValueError, TypeError) as exc:
            out.append({"error": str(exc), "state": db.list_trades()})
    return out


def scenario_intraday():
    tcs, ec = "TCS_NS_15m", "ELECTCAST_NS_5m"
    t0 = "2026-09-24T04:16:00+00:00"
    i0, j0 = idx_at(tcs, t0), idx_at(ec, t0)
    dt, de = load_df(tcs), load_df(ec)
    ltp, lte = float(dt["close"].iloc[i0 - 1]), float(de["close"].iloc[j0 - 1])
    tk = trading._tick
    steps = [
        {"op": "clock", "now": t0},
        {"op": "market", "symbol": "TCS.NS", "interval": "15m", "bars": tcs, "upto": i0},
        {"op": "market", "symbol": "ELECTCAST.NS", "interval": "5m", "bars": ec, "upto": j0},
        {"op": "save_settings", "patch": {"capital": 300000, "max_positions": 6, "risk_pct": "1.5", "allow_overnight": 0, "fees": {"slippage_pct": "0.04", "bogus": 1}}},
        {"op": "get_settings"},
        {"op": "cash"},
        {"op": "preview", "args": {"symbol": "TCS.NS", "side": "buy", "product": "intraday", "order_type": "market", "qty": 20, "interval": "15m"}},
        {"op": "place", "args": {"symbol": "TCS.NS", "interval": "15m", "side": "BUY", "product": "intraday", "order_type": "market", "qty": 20,
                                 "stop": tk(ltp * 0.995), "target": tk(ltp * 1.004)}},
        {"op": "place", "args": {"symbol": "TCS.NS", "interval": "15m", "side": "BUY", "product": "intraday", "order_type": "limit", "qty": 10,
                                 "price": tk(ltp * 0.998), "stop": tk(ltp * 0.99), "target": tk(ltp * 1.01)}},
        {"op": "place", "args": {"symbol": "TCS.NS", "interval": "15m", "side": "BUY", "product": "overnight", "order_type": "sl", "qty": 5,
                                 "trigger": tk(ltp * 1.002)}},
        {"op": "place", "args": {"symbol": "ELECTCAST.NS", "interval": "5m", "side": "SELL", "product": "intraday", "order_type": "market", "qty": 50,
                                 "stop": tk(lte * 1.01), "target": tk(lte * 0.99)}},
        {"op": "place", "args": {"symbol": "ELECTCAST.NS", "interval": "5m", "side": "SELL", "product": "intraday", "order_type": "limit", "qty": 30,
                                 "price": tk(lte * 1.003)}},
        {"op": "preview", "args": {"symbol": "ELECTCAST.NS", "side": "SELL", "product": "overnight", "order_type": "market", "qty": 5, "interval": "5m"}},
        {"op": "preview", "args": {"symbol": "TCS.NS", "side": "BUY", "product": "intraday", "order_type": "market", "qty": 1000000, "interval": "15m"}},
        {"op": "preview", "args": {"symbol": "TCS.NS", "side": "HOLD", "product": "cnc", "order_type": "limit", "qty": 0, "interval": "15m"}},
        {"op": "preview", "args": {"symbol": "INFY.NS", "side": "BUY", "product": "intraday", "order_type": "market", "qty": 1, "interval": "15m"}},
        {"op": "preview", "args": {"symbol": "INFY.NS", "side": "BUY", "product": "intraday", "order_type": "market", "qty": 1, "live_price": 1523.45}},
        {"op": "place", "args": {"symbol": "TCS.NS", "interval": "15m", "side": "BUY", "product": "intraday", "order_type": "sl", "qty": 1}},
        {"op": "portfolio"},
        {"op": "clock", "now": "2026-09-24T06:20:00+00:00"},
        {"op": "market", "symbol": "TCS.NS", "interval": "15m", "bars": tcs, "upto": idx_at(tcs, "2026-09-24T06:20:00+00:00")},
        {"op": "market", "symbol": "ELECTCAST.NS", "interval": "5m", "bars": ec, "upto": idx_at(ec, "2026-09-24T06:20:00+00:00")},
        {"op": "check"},
        {"op": "portfolio"},
    ]
    t1 = "2026-09-24T06:50:00+00:00"
    ltp1 = float(dt["close"].iloc[idx_at(tcs, t1) - 1])
    steps += [
        {"op": "clock", "now": t1},
        {"op": "market", "symbol": "TCS.NS", "interval": "15m", "bars": tcs, "upto": idx_at(tcs, t1)},
        {"op": "place", "args": {"symbol": "TCS.NS", "interval": "15m", "side": "BUY", "product": "intraday", "order_type": "market", "qty": 12, "stop": tk(ltp1 * 0.97)}},
        {"op": "place", "args": {"symbol": "TCS.NS", "interval": "15m", "side": "SELL", "product": "overnight", "order_type": "market", "qty": 4}},
        {"op": "place", "args": {"symbol": "TCS.NS", "interval": "15m", "side": "SELL", "product": "intraday", "order_type": "limit", "qty": 3, "price": tk(ltp1 * 1.01)}},
        {"op": "place", "args": {"symbol": "TCS.NS", "interval": "15m", "side": "SELL", "product": "intraday", "order_type": "sl", "qty": 2, "trigger": tk(ltp1 * 0.99)}},
        {"op": "place", "args": {"symbol": "ELECTCAST.NS", "interval": "5m", "side": "BUY", "product": "intraday", "order_type": "market", "qty": 500}},
        {"op": "cash"},
        {"op": "portfolio"},
        {"op": "close", "id": 4},
        {"op": "close", "id": 1},
        {"op": "close", "id": 999},
        {"op": "close", "id": 7, "price": 2100.123},
        {"op": "clock", "now": "2026-09-24T10:30:00+00:00"},
        {"op": "market", "symbol": "TCS.NS", "interval": "15m", "bars": tcs, "upto": idx_at(tcs, "2026-09-24T10:30:00+00:00")},
        {"op": "market", "symbol": "ELECTCAST.NS", "interval": "5m", "bars": ec, "upto": idx_at(ec, "2026-09-24T10:30:00+00:00")},
        {"op": "check"},
        {"op": "clock", "now": "2026-09-25T04:00:00+00:00"},
        {"op": "market", "symbol": "TCS.NS", "interval": "15m", "bars": tcs, "upto": idx_at(tcs, "2026-09-25T04:00:00+00:00")},
        {"op": "check"},
        {"op": "portfolio"},
        {"op": "cash"},
    ]
    return steps


def scenario_delivery():
    rel = "RELIANCE_NS_1d"
    df = load_df(rel)
    t0 = "2026-09-08T06:00:00+00:00"
    k0 = idx_at(rel, t0)
    ltp = float(df["close"].iloc[k0 - 1])
    tk = trading._tick
    steps = [
        {"op": "clock", "now": t0},
        {"op": "market", "symbol": "RELIANCE.NS", "interval": "1d", "bars": rel, "upto": k0},
        {"op": "save_settings", "patch": {"capital": 150000.0, "max_positions": 5}},
        {"op": "place", "args": {"symbol": "RELIANCE.NS", "interval": "1d", "side": "BUY", "product": "overnight", "order_type": "market", "qty": 12,
                                 "deadline": "2026-09-11T10:00:00+00:00", "target": tk(ltp * 1.2)}},
        {"op": "place", "args": {"symbol": "RELIANCE.NS", "interval": "1d", "side": "BUY", "product": "overnight", "order_type": "limit", "qty": 4,
                                 "price": tk(ltp * 0.985), "stop": tk(ltp * 0.95)}},
        {"op": "place", "args": {"symbol": "RELIANCE.NS", "interval": "1d", "side": "BUY", "product": "overnight", "order_type": "market", "qty": 7,
                                 "stop": tk(ltp * 0.9)}},
        {"op": "place", "args": {"symbol": "RELIANCE.NS", "interval": "1d", "side": "BUY", "product": "overnight", "order_type": "limit", "qty": 2,
                                 "price": tk(ltp * 0.5), "deadline": "2026-09-10T10:00:00+00:00"}},
        {"op": "portfolio"},
        {"op": "clock", "now": "2026-09-15T11:00:00+00:00"},
        {"op": "market", "symbol": "RELIANCE.NS", "interval": "1d", "bars": rel, "upto": idx_at(rel, "2026-09-15T11:00:00+00:00")},
        {"op": "check"},
        {"op": "portfolio"},
        {"op": "close", "id": 3, "price": 1301.37},
        {"op": "place", "args": {"symbol": "RELIANCE.NS", "interval": "1d", "side": "BUY", "product": "overnight", "order_type": "market", "qty": 3}},
        {"op": "close", "id": 5},
        {"op": "place", "args": {"symbol": "RELIANCE.NS", "interval": "1d", "side": "SELL", "product": "overnight", "order_type": "market", "qty": 5}},
        {"op": "place", "args": {"symbol": "RELIANCE.NS", "interval": "1d", "side": "SELL", "product": "intraday", "order_type": "market", "qty": 1}},
        {"op": "portfolio"},
        {"op": "place", "args": {"symbol": "RELIANCE.NS", "interval": "1d", "side": "SELL", "product": "overnight", "order_type": "market", "qty": 100}},
        {"op": "portfolio"},
        {"op": "reset_settings"},
        {"op": "portfolio"},
    ]
    return steps


def scenario_plan():
    tcs = "TCS_NS_15m"
    lv = load_levels(tcs)
    t0 = "2026-09-29T04:20:00+00:00"
    k0 = idx_at(tcs, t0)
    df = load_df(tcs).iloc[:k0]
    steps = [{"op": "clock", "now": t0}, {"op": "market", "symbol": "TCS.NS", "interval": "15m", "bars": tcs, "upto": k0},
             {"op": "save_settings", "patch": {"capital": 400000, "max_cost_share": 0.9, "min_trade_value": 100}}]
    last = float(df["close"].iloc[-1])
    for i, (mult, direction, p) in enumerate([(1.0, "UP", 0.7), (0.997, "UP", 0.66), (1.0, "DOWN", 0.3), (1.01, "SIDEWAYS", 0.55)]):
        res = synth_result(tcs, lv, df, last * mult, direction, p, {"available": True, "up_rate": 0.51}, 8,
                           {"support": float(df["low"].iloc[-30:].min()), "resistance": float(df["high"].iloc[-30:].max())})
        steps += [{"op": "plan", "result": res}, {"op": "place_trade", "symbol": "TCS.NS", "interval": "15m", "prediction_id": 100 + i}]
    steps += [{"op": "portfolio"}, {"op": "clock", "now": "2026-09-29T09:50:00+00:00"},
              {"op": "market", "symbol": "TCS.NS", "interval": "15m", "bars": tcs, "upto": 10 ** 6}, {"op": "check"}, {"op": "portfolio"}]
    return steps


def make_ledger():
    scen = {}
    for name, fn in (("intraday", scenario_intraday), ("delivery", scenario_delivery), ("plan", scenario_plan)):
        steps = fn()
        scen[name] = {"steps": steps, "results": run_steps(steps)}
    dump("ledger", scen)


# ---------------------------------------------------------------- F: evaluator
def make_evaluator():
    rng = random.Random(5)
    grades, resolves, forming = [], [], []
    now_holder = {"now": None}
    evaluator.bar_is_forming = lambda s, i, lb: data.bar_is_forming(s, i, lb, now=now_holder["now"])
    evaluator.db.resolve_prediction = lambda *a, **k: None
    for name in NAMES:
        df = load_df(name)
        symbol, interval = SYMBOL[name]
        for _ in range(120):
            cut = rng.randint(50, len(df) - 2)
            h = rng.randint(1, 20)
            path = df.iloc[cut + 1: cut + 1 + h]
            if not len(path):
                continue
            price = float(df["close"].iloc[cut]) * rng.choice([1.0, 0.99, 1.01])
            direction = rng.choice(["UP", "DOWN", "SIDEWAYS"])
            target = rng.choice([None, price * 1.01, price * 0.99, price * 1.001])
            o, r, m = evaluator.grade(direction, price, target, None, path)
            grades.append({"bars": name, "start": cut + 1, "end": cut + 1 + h, "direction": direction, "price": price, "target": target,
                           "out": [o, r, m]})
        for _ in range(80):
            upto = rng.randint(60, len(df))
            sub = df.iloc[:upto]
            bi = rng.randint(max(0, upto - 30), upto - 1)
            bar_time = sub.index[bi].isoformat()
            last = sub.index[-1].to_pydatetime()
            sec = data.interval_seconds(interval)
            now = last + timedelta(seconds=rng.choice([10, sec - 1, sec, sec + 5, 3 * 3600, 86400 * 2]))
            now_holder["now"] = now
            p = {"id": rng.randint(1, 1000), "symbol": symbol, "interval": interval, "bar_time": bar_time, "horizon_bars": rng.randint(1, 15),
                 "direction": rng.choice(["UP", "DOWN", "SIDEWAYS"]), "price_at": float(sub["close"].iloc[bi]),
                 "target_price": rng.choice([None, float(sub["close"].iloc[bi]) * 1.005]), "expected_move_pct": 0.5}
            res = evaluator._try_resolve(p, sub)
            resolves.append({"bars": name, "upto": upto, "now": now.replace(tzinfo=UTC).isoformat(), "p": p, "out": res,
                             "done": int((sub.index > pd.Timestamp(bar_time)).sum())})
    base = datetime(2026, 9, 25, 0, 0)
    for sym in ("TCS.NS", "AAPL", "^NSEI", "X.BO"):
        for iv in ("5m", "1d", "1wk"):
            for lb in (datetime(2026, 9, 21), datetime(2026, 9, 25, 9, 55), datetime(2026, 9, 24)):
                for dh in (-2, 0, 9, 10, 10.01, 24, 30, 24 * 4 + 10, 24 * 6):
                    now = base + timedelta(hours=dh)
                    forming.append({"symbol": sym, "interval": iv, "last": lb.replace(tzinfo=UTC).isoformat(), "now": now.replace(tzinfo=UTC).isoformat(),
                                    "out": data.bar_is_forming(sym, iv, pd.Timestamp(lb), now=now)})
    dump("evaluator", {"grades": grades, "resolves": resolves, "forming": forming})


if __name__ == "__main__":
    make_charges()
    make_deadlines()
    make_barriers()
    make_plans()
    make_ledger()
    make_evaluator()
