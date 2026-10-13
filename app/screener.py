"""Market screener: batch-download a universe and compute movement metrics per symbol.

Market capitalisation (for sizing the heat-map tiles) and the sector of names that are not in
the built-in sector map are fetched from Yahoo in a background thread and cached for a day in
data/cache/screener_meta.json, so a scan never waits on a hundred quote requests.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import yfinance as yf

from . import indicators as ind
from .universe import UNIVERSES, SECTORS
from .data import normalize_symbol, DataError, yahoo
from .db import DB_PATH
from .priority import yield_if_busy

log = logging.getLogger("tradebot.screener")

_CACHE: dict[tuple, tuple[float, dict]] = {}
CACHE_TTL = 90

META_FILE = os.path.join(os.environ.get("TRADEBOT_CACHE", os.path.join(os.path.dirname(DB_PATH), "cache")), "screener_meta.json")
META_TTL = 86400
_META: dict[str, dict] = {}
_META_LOADED = False
_META_LOCK = threading.Lock()
_META_THREAD: threading.Thread | None = None


BATCH_CHUNK = 25   # tickers per Yahoo request: a chart load waits for at most one chunk, not the whole universe


def _batch(tickers: list[str], period: str = "1y", interval: str = "1d") -> dict[str, pd.DataFrame]:
    out: dict[str, pd.DataFrame] = {}
    for i in range(0, len(tickers), BATCH_CHUNK):
        yield_if_busy()
        chunk = tickers[i:i + BATCH_CHUNK]
        with yahoo(background=True):
            raw = yf.download(chunk, period=period, interval=interval, group_by="ticker", auto_adjust=True,
                              progress=False, threads=True)
        if raw is None or raw.empty:
            continue
        if not isinstance(raw.columns, pd.MultiIndex):  # single ticker
            raw = pd.concat({chunk[0]: raw}, axis=1)
        for t in chunk:
            if t not in raw.columns.get_level_values(0):
                continue
            df = raw[t].copy()
            df.columns = [str(c).lower() for c in df.columns]
            df = df.dropna(subset=["close"])
            if len(df) >= 5:
                if "volume" not in df:
                    df["volume"] = 0.0
                out[t] = df
    return out


def _metrics(sym: str, df: pd.DataFrame, ext_score: bool = True) -> dict:
    c, h, l, o, v = df["close"], df["high"], df["low"], df["open"], df["volume"].fillna(0)
    n = len(df)
    last, prev = float(c.iloc[-1]), float(c.iloc[-2])
    def chg(k):
        return float(last / c.iloc[-1 - k] - 1) * 100 if n > k else None
    rng = float((h.iloc[-1] - l.iloc[-1]) / last * 100)
    vol_avg = float(v.iloc[-21:-1].mean()) if n > 21 else float(v.iloc[:-1].mean() or 0)
    vol_ratio = float(v.iloc[-1] / vol_avg) if vol_avg > 0 else None
    rsi = float(ind.rsi(c, 14).iloc[-1]) if n > 15 else None
    atr_pct = float(ind.atr(df, 14).iloc[-1] / last * 100) if n > 15 else None
    sma50 = float(c.rolling(50).mean().iloc[-1]) if n >= 50 else None
    sma200 = float(c.rolling(200).mean().iloc[-1]) if n >= 200 else None
    macd_hist = float(ind.macd(c)["macd_hist"].iloc[-1]) if n > 35 else None
    hi52, lo52 = float(h.max()), float(l.min())
    pos52 = (last - lo52) / (hi52 - lo52) * 100 if hi52 > lo52 else None
    vol20 = float(c.pct_change().tail(20).std() * np.sqrt(252) * 100) if n > 21 else None
    gap = float(o.iloc[-1] / prev - 1) * 100
    # quick trend bias -5..+5 (not the full ensemble; that runs on the analytics page)
    bias = 0
    if sma50 is not None: bias += 1 if last > sma50 else -1
    if sma50 is not None and sma200 is not None: bias += 1 if sma50 > sma200 else -1
    if rsi is not None: bias += 1 if rsi > 50 else -1
    if macd_hist is not None: bias += 1 if macd_hist > 0 else -1
    c5 = chg(5)
    if c5 is not None: bias += 1 if c5 > 0 else -1
    volume = float(v.iloc[-1])
    # overextension score (0-100): published overbought / exhaustion rules, see overextended.py
    try:
        from .overextended import score_series
        ext = int(round(float(score_series(df).iloc[-1]))) if n >= 60 and ext_score else None
    except Exception:  # never let the extra metric break a scan
        ext = None
    return {
        "symbol": sym, "name": sym.replace(".NS", "").replace(".BO", ""), "price": round(last, 2),
        "chg_1d": round((last / prev - 1) * 100, 2), "gap": round(gap, 2), "chg_5d": None if c5 is None else round(c5, 2),
        "chg_20d": None if chg(20) is None else round(chg(20), 2), "range_pct": round(rng, 2),
        "volume": volume, "turnover": round(volume * last, 0), "vol_ratio": None if vol_ratio is None else round(vol_ratio, 2),
        "rsi": None if rsi is None else round(rsi, 1), "atr_pct": None if atr_pct is None else round(atr_pct, 2),
        "volatility": None if vol20 is None else round(vol20, 1),
        "pos_52w": None if pos52 is None else round(pos52, 1), "dist_52w_high": round((last / hi52 - 1) * 100, 2),
        "above_sma50": None if sma50 is None else bool(last > sma50), "above_sma200": None if sma200 is None else bool(last > sma200),
        "bias": bias, "ext_score": ext, "bar_time": df.index[-1].isoformat(),
        "from_open": round(float(last / o.iloc[-1] - 1) * 100, 2) if o.iloc[-1] else None,
        "high_from_open": round(float(h.iloc[-1] / o.iloc[-1] - 1) * 100, 2) if o.iloc[-1] else None,
        "low_from_open": round(float(l.iloc[-1] / o.iloc[-1] - 1) * 100, 2) if o.iloc[-1] else None,
    }


# ---------------------------------------------------------------- market cap / sector metadata
def _load_meta() -> None:
    global _META_LOADED
    if _META_LOADED:
        return
    _META_LOADED = True
    try:
        if os.path.exists(META_FILE):
            with open(META_FILE, encoding="utf-8") as fh:
                _META.update(json.load(fh))
    except Exception as exc:  # pragma: no cover
        log.warning("could not load screener meta cache: %s", exc)


def _save_meta() -> None:
    try:
        os.makedirs(os.path.dirname(META_FILE), exist_ok=True)
        tmp = META_FILE + ".tmp"
        with _META_LOCK:
            data = dict(_META)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        os.replace(tmp, META_FILE)
    except Exception as exc:  # pragma: no cover
        log.warning("could not save screener meta cache: %s", exc)


def _fetch_one(sym: str) -> tuple[str, dict]:
    cap, sector = None, None
    try:
        t = yf.Ticker(sym)
        try:
            with yahoo(background=True):
                cap = t.fast_info.market_cap
            cap = float(cap) if cap and cap > 0 else None
        except Exception:
            cap = None
        if sym.split(".")[0] not in SECTORS:
            try:
                with yahoo(background=True):
                    sector = t.info.get("sector") or None
            except Exception:
                sector = None
    except Exception:
        pass
    time.sleep(0.05)          # gentle on Yahoo's rate limit
    return sym, {"market_cap": cap, "sector": sector, "at": time.time()}


def _fetch_meta(symbols: list[str]) -> None:
    t0 = time.time()
    try:
        with ThreadPoolExecutor(max_workers=3) as ex:
            for sym, meta in ex.map(_fetch_one, symbols):
                with _META_LOCK:
                    old = _META.get(sym) or {}
                    # keep an older good value if this attempt failed (Yahoo hiccups are common)
                    if meta["market_cap"] is None and old.get("market_cap"):
                        meta["market_cap"] = old["market_cap"]
                    if meta["sector"] is None and old.get("sector"):
                        meta["sector"] = old["sector"]
                    _META[sym] = meta
        _save_meta()
        log.info("fetched market caps for %d symbols in %.1fs", len(symbols), time.time() - t0)
    except Exception:  # pragma: no cover
        log.exception("meta fetch failed")


def _ensure_meta(symbols: list[str]) -> bool:
    """Start a background fetch for symbols whose market cap is unknown or older than a day.
    Returns True while a fetch is pending."""
    global _META_THREAD
    _load_meta()
    now = time.time()
    with _META_LOCK:
        stale = [s for s in symbols if not _META.get(s) or now - _META[s].get("at", 0) > META_TTL]
    if _META_THREAD is not None and _META_THREAD.is_alive():
        return True
    if not stale:
        return False
    _META_THREAD = threading.Thread(target=_fetch_meta, args=(stale,), daemon=True, name="screener-meta")
    _META_THREAD.start()
    return True


def _decorate(rows: list[dict]) -> list[dict]:
    out = []
    with _META_LOCK:
        for r in rows:
            key = r.get("via") or r["symbol"]
            m = _META.get(key) or {}
            d = dict(r)
            d["market_cap"] = m.get("market_cap")
            d["sector"] = SECTORS.get(r["name"]) or m.get("sector") or "Other"
            out.append(d)
    return out


# ---------------------------------------------------------------- scan
def scan(universe: str = "nifty100", extra: list[str] | None = None, light: bool = False) -> dict:
    """`light=True` skips the overextension score (the costly part) - for background callers that only need prices and ranges."""
    if universe not in UNIVERSES and universe != "custom":
        raise DataError(f"Unknown universe '{universe}'. Use one of {list(UNIVERSES)} or 'custom'.")
    base = UNIVERSES.get(universe, {"name": "Custom", "exchange": "NSE", "symbols": [], "indices": {}})
    extra_syms = []
    for s in extra or []:
        s = s.strip()
        if not s:
            continue
        try:
            extra_syms.append(normalize_symbol(s, base.get("exchange", "NSE")))
        except DataError:
            continue
    symbols = list(dict.fromkeys(base["symbols"] + extra_syms))
    if not symbols:
        raise DataError("No symbols to scan.")
    key = (universe, tuple(sorted(extra_syms)), light)
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < CACHE_TTL:
        result = dict(hit[1])
    else:
        t0 = time.time()
        frames = _batch(symbols + list(base["indices"]))
        # Yahoo's BSE (.BO) history is sparse: fall back to the NSE listing of the same company.
        via: dict[str, str] = {}
        short = [s for s in symbols if s.endswith(".BO") and (s not in frames or len(frames[s]) < 30)]
        if short:
            alt = _batch([s[:-3] + ".NS" for s in short])
            for s in short:
                ns = s[:-3] + ".NS"
                if ns in alt:
                    frames[s] = alt[ns]
                    via[s] = ns
        rows, missing = [], []
        for s in symbols:
            yield_if_busy()           # when the ready-scanner runs this scan, it steps aside for interactive requests
            if s in frames:
                try:
                    m = _metrics(s, frames[s], not light)
                    m["via"] = via.get(s)
                    rows.append(m)
                except Exception as exc:  # one bad symbol must not kill the scan
                    missing.append(f"{s}: {exc}")
            else:
                missing.append(s)
        indices = []
        for s, label in base["indices"].items():
            if s in frames:
                m = _metrics(s, frames[s], not light); m["name"] = label; indices.append(m)
        result = {"universe": universe, "name": base["name"], "count": len(rows), "rows": rows, "indices": indices,
                  "missing": missing, "generated_at": datetime.now(timezone.utc).isoformat(), "took_s": round(time.time() - t0, 1)}
        _CACHE[key] = (now, result)
    # market cap / sector are attached at return time so a background fetch shows up on the next call
    result["meta_pending"] = _ensure_meta([r.get("via") or r["symbol"] for r in result["rows"]])
    result["rows"] = _decorate(result["rows"])
    return result
