"""Parity fixtures: bars downloaded by the Python engine plus what the Python engine computes from them.
The TypeScript ports read the same bars and must reproduce the numbers (see *.test.ts next to this file).

Run from the repo root:  python mobile/tests/parity/make_fixtures.py
"""
from __future__ import annotations

import json
import math
import os
import sys

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)
from app import indicators as ind  # noqa: E402
from app.data import fetch_ohlcv  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "fixtures")
CASES = [("RELIANCE.NS", "1d"), ("TCS.NS", "15m"), ("ELECTCAST.NS", "5m")]


def clean(x):
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (np.bool_, bool)):
        return bool(x)
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (float, np.floating)):
        return None if math.isnan(x) or math.isinf(x) else float(x)
    if isinstance(x, pd.Timestamp):
        return int(x.timestamp())
    return x


def bars_json(df: pd.DataFrame) -> dict:
    t = [int(pd.Timestamp(ts).tz_localize("UTC").timestamp()) if pd.Timestamp(ts).tzinfo is None else int(pd.Timestamp(ts).timestamp()) for ts in df.index]
    return {"t": t, "o": df["open"].tolist(), "h": df["high"].tolist(), "l": df["low"].tolist(), "c": df["close"].tolist(), "v": df["volume"].tolist()}


def main():
    os.makedirs(OUT, exist_ok=True)
    for sym, iv in CASES:
        df = fetch_ohlcv(sym, iv, fresh=False)
        # naive-UTC index -> IST-aware index for the session-anchored functions (as the app does for intraday)
        intraday = ind.is_intraday_index(df.index)
        dfi = df.copy()
        dfi.index = dfi.index.tz_localize("UTC").tz_convert("Asia/Kolkata")
        allc = ind.compute_all(dfi)
        cols = {c: allc[c].tolist() for c in allc.columns if c not in ("open", "high", "low", "close", "volume")}
        levels = {
            "pivots": ind.pivot_points(dfi, intraday), "cpr": ind.cpr_levels(dfi, intraday), "camarilla": ind.camarilla_levels(dfi, intraday),
            "vwap_bands": ind.vwap_bands(dfi, intraday), "profile": ind.market_profile(dfi, intraday), "fib": ind.fibonacci_levels(dfi),
            "hurst": ind.hurst_exponent(dfi["close"]), "vwap_session": ind.vwap(dfi).tolist(),
        }
        levels["pivots"].pop("ref_time", None)
        sh, sl = ind.swing_points(dfi)
        levels["swing_high"] = [bool(x) for x in sh]
        levels["swing_low"] = [bool(x) for x in sl]
        name = f"{sym.replace('.', '_')}_{iv}"
        with open(os.path.join(OUT, name + ".json"), "w") as f:
            json.dump(clean({"symbol": sym, "interval": iv, "intraday": intraday, "bars": bars_json(df), "indicators": cols, "levels": levels}), f)
        print(name, len(df))


if __name__ == "__main__":
    main()
