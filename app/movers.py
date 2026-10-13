"""2% movers: stocks that regularly travel the distance a small account needs.

At Rs 2,000 a Groww intraday round trip costs ~0.7-0.8% (the Rs 5 minimum brokerage per order; Zerodha's is
~0.15%), so a trade only pays if the stock can move well beyond its costs within the session.  This module measures, for every liquid
NSE stock you can afford, over the last ~60 sessions of 5-minute bars:

  * how often the day's high reached the target above the open, and the low the same distance below;
  * the median intraday range;
  * what simply buying at 09:30 with that target and a 0.5% stop did, net of your charges -
    the honest base rate (measured 2026-10-02 on 205 stocks x 58 sessions: about -0.85% per trade at
    Rs 2,000, the same in both halves of the period).

So the list tells you WHERE a 2% move is possible, not WHICH WAY it will go.  The direction comes from the
ready-to-trade scanner, which can be pointed at this list (universe "movers"); its call is shown per row.

The statistics are computed once per trading day (one batched download, ~30 s, in the background) and
saved to data/cache/movers.json; today's move from the open is added live from the daily screener scan.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import screener, trading, tradingdays
from .learner import CACHE_DIR
from .priority import background, yield_if_busy
from .universe import UNIVERSES

log = logging.getLogger("tradebot.movers")

SOURCE_UNIVERSE = "nse_all"
TARGETS = (1.0, 1.5, 2.0, 3.0)
DEFAULT_TARGET = 2.0
BLIND_STOP = 0.5           # % stop for the "just buy at 09:30" base rate
MIN_TURNOVER = 2e7         # rupees per day (median)
TOP_N = 40                 # how many movers the ready scanner watches when its universe is "movers"
FILE = os.path.join(CACHE_DIR, "movers.json")

_LOCK = threading.Lock()
_STATE: dict = {"stats": None, "running": False, "error": None}


# ---------------------------------------------------------------- statistics
def _ist(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    idx = df.index.tz_localize("UTC") if df.index.tz is None else df.index
    df.index = idx.tz_convert("Asia/Kolkata")
    return df


def _barrier(hi: np.ndarray, lo: np.ndarray, cl: np.ndarray, entry: float, up: float, dn: float) -> float:
    """Return % of a long from `entry`: +up at the target, -dn at the stop (a bar touching both = stop), else the last close."""
    t, s = entry * (1 + up / 100), entry * (1 - dn / 100)
    for i in range(len(hi)):
        if lo[i] <= s:
            return -dn
        if hi[i] >= t:
            return up
    return (cl[-1] / entry - 1) * 100 if len(cl) else 0.0


def _stock_stats(df: pd.DataFrame, cost_pct: float) -> dict | None:
    df = _ist(df).dropna(subset=["close"])
    sessions = []
    for day, d in df.groupby(df.index.date):
        d = d.between_time("09:15", "15:10")
        if len(d) >= 60:
            sessions.append(d)
    if len(sessions) < 20:
        return None
    out = {"sessions": len(sessions), "turnover": float(np.median([float((d["close"] * d["volume"]).sum()) for d in sessions])),
           "range": float(np.median([(d["high"].max() - d["low"].min()) / d["open"].iloc[0] * 100 for d in sessions]))}
    for tgt in TARGETS:
        up = dn = 0
        blind = []
        for d in sessions:
            o = float(d["open"].iloc[0])
            up += d["high"].max() >= o * (1 + tgt / 100)
            dn += d["low"].min() <= o * (1 - tgt / 100)
            hi, lo, cl = d["high"].to_numpy(float), d["low"].to_numpy(float), d["close"].to_numpy(float)
            blind.append(_barrier(hi[3:], lo[3:], cl[3:], float(d["open"].iloc[3]), tgt, BLIND_STOP) - cost_pct)
        k = f"{tgt:g}"
        out[f"up_{k}"] = up / len(sessions)
        out[f"dn_{k}"] = dn / len(sessions)
        out[f"blind_{k}"] = float(np.mean(blind))
    return out


def compute(capital: float) -> dict:
    """Download ~60 sessions of 5-minute bars for the source universe and measure every affordable, liquid stock."""
    t0 = time.time()
    syms = UNIVERSES[SOURCE_UNIVERSE]["symbols"]
    with background():
        frames = screener._batch(syms, "60d", "5m")
        return _measure(frames, capital, t0)


def _measure(frames: dict, capital: float, t0: float) -> dict:
    fees = trading.get_settings()["fees"]
    rows, skipped = [], 0
    for sym, df in frames.items():
        yield_if_busy()                      # steps aside while you load a page
        price = float(df["close"].dropna().iloc[-1])
        if price > capital or price < 10:
            skipped += 1
            continue
        qty = max(1, int(capital // price))
        cost = trading.round_trip(price, price, qty, "intraday", fees)["pct_of_value"]
        st = _stock_stats(df, cost)
        if st is None or st["turnover"] < MIN_TURNOVER:
            continue
        rows.append({"symbol": sym, "name": sym.replace(".NS", ""), "price": round(price, 2), "qty": qty, "cost_pct": cost, **st})
    blind = {f"{t:g}": float(np.mean([r[f"blind_{t:g}"] for r in rows])) if rows else None for t in TARGETS}
    res = {"computed_at": datetime.now(timezone.utc).isoformat(), "trading_day": tradingdays.ist_now().date().isoformat(),
           "capital": capital, "rows": rows, "blind": blind, "skipped_price": skipped, "took_s": round(time.time() - t0, 1),
           "sessions": int(np.median([r["sessions"] for r in rows])) if rows else 0}
    log.info("movers: %d stocks measured in %.0fs", len(rows), time.time() - t0)
    return res


def _load() -> dict | None:
    if _STATE["stats"] is None and os.path.exists(FILE):
        try:
            with open(FILE, encoding="utf-8") as fh:
                _STATE["stats"] = json.load(fh)
        except Exception as exc:  # pragma: no cover
            log.warning("could not read movers cache: %s", exc)
    return _STATE["stats"]


def _fresh(stats: dict | None, capital: float) -> bool:
    """Good for the whole day; only recomputed on a trading day after a new session has been added."""
    if not stats or float(stats.get("capital", 0)) != float(capital):
        return False
    today = tradingdays.ist_now().date()
    last_session = today if tradingdays.is_trading_day(today) else tradingdays.previous_trading_day(today)
    return stats.get("trading_day", "") >= last_session.isoformat()


def _run(capital: float) -> None:
    try:
        res = compute(capital)
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(FILE + ".tmp", "w", encoding="utf-8") as fh:
            json.dump(res, fh)
        os.replace(FILE + ".tmp", FILE)
        _STATE.update(stats=res, error=None)
    except Exception as exc:
        log.exception("movers computation failed")
        _STATE["error"] = str(exc)
    finally:
        _STATE["running"] = False


def ensure(capital: float | None = None) -> dict | None:
    """Return the statistics, starting a background recomputation when they are stale."""
    capital = float(capital or trading.get_settings()["capital"])
    stats = _load()
    with _LOCK:
        if not _fresh(stats, capital) and not _STATE["running"]:
            _STATE["running"] = True
            threading.Thread(target=_run, args=(capital,), daemon=True, name="movers").start()
    return stats


def top_symbols(n: int = TOP_N, target: float = DEFAULT_TARGET) -> list[str]:
    """The stocks that most often reach the target in either direction (for the ready scanner)."""
    stats = ensure()
    if not stats:
        return []
    k = f"{target:g}"
    rows = sorted(stats["rows"], key=lambda r: -(r[f"up_{k}"] + r[f"dn_{k}"]))
    return [r["symbol"] for r in rows[:n]]


# ---------------------------------------------------------------- today's move (live, refreshed in the background)
_LIVE: dict = {"at": 0.0, "rows": {}, "running": False}
LIVE_TTL_OPEN, LIVE_TTL_CLOSED = 300, 6 * 3600


def _refresh_live() -> None:
    try:
        with background():
            syms = [r["symbol"] for r in (_STATE["stats"] or {}).get("rows", [])]
            res = screener.scan("custom", syms, light=True) if syms else screener.scan(SOURCE_UNIVERSE, light=True)
            _LIVE["rows"] = {r["symbol"]: r for r in res["rows"]}
        _LIVE["at"] = time.time()
    except Exception as exc:  # today's numbers are a bonus; the statistics stand on their own
        log.warning("movers live scan failed: %s", exc)
    finally:
        _LIVE["running"] = False


def live_rows() -> dict:
    """Last daily-screener rows for the source universe; a stale copy triggers a background refresh."""
    ttl = LIVE_TTL_OPEN if tradingdays.is_open() else LIVE_TTL_CLOSED
    if time.time() - _LIVE["at"] > ttl and not _LIVE["running"]:
        _LIVE["running"] = True
        threading.Thread(target=_refresh_live, daemon=True, name="movers-live").start()
    return _LIVE["rows"]


# ---------------------------------------------------------------- API view
def view(target: float = DEFAULT_TARGET) -> dict:
    target = min(TARGETS, key=lambda t: abs(t - target))
    k = f"{target:g}"
    st = trading.get_settings()
    stats = ensure(st["capital"])
    market = tradingdays.status()
    if not stats:
        return {"ready": False, "running": _STATE["running"], "error": _STATE["error"], "target": target, "targets": list(TARGETS),
                "market": market, "capital": st["capital"], "rows": []}
    live = live_rows()
    from . import ready
    calls = ready.calls()
    rows = []
    for r in stats["rows"]:
        lv = live.get(r["symbol"]) or {}
        c = calls.get(r["symbol"]) or {}
        rows.append({
            "symbol": r["symbol"], "name": r["name"], "price": lv.get("price", r["price"]), "qty": r["qty"], "cost_pct": r["cost_pct"],
            "up": r[f"up_{k}"], "down": r[f"dn_{k}"], "either": max(r[f"up_{k}"], r[f"dn_{k}"]), "range": r["range"], "blind": r[f"blind_{k}"],
            "sector": lv.get("sector"), "chg_1d": lv.get("chg_1d"), "from_open": lv.get("from_open"),
            "high_from_open": lv.get("high_from_open"), "low_from_open": lv.get("low_from_open"),
            "call": c.get("direction"), "verdict": c.get("verdict"), "accuracy": c.get("accuracy"), "reason": c.get("reason_group"),
        })
    rows.sort(key=lambda x: -(x["up"] + x["down"]))
    return {"ready": True, "running": _STATE["running"], "error": _STATE["error"], "target": target, "targets": list(TARGETS),
            "market": market, "capital": st["capital"], "computed_at": stats["computed_at"], "sessions": stats["sessions"],
            "blind": stats["blind"].get(k), "blind_stop": BLIND_STOP, "stale_capital": float(stats["capital"]) != float(st["capital"]),
            "rows": rows, "top_n": TOP_N}
