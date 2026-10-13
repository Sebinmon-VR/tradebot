"""Parity fixtures for the scanners (market map metrics, multi-day overextended, today's run / fall from the open),
computed by the Python engine on the bars already saved by make_fixtures.py.
Run from the repo root:  python mobile/tests/parity/make_scanner_fixtures.py
"""
from __future__ import annotations

import json
import os
import sys
import warnings

import pandas as pd

warnings.filterwarnings("ignore")
HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "..", "..")))
from app import intraday_ext, overextended, screener  # noqa: E402

sys.path.insert(0, HERE)
from make_fixtures import clean  # noqa: E402

FX = os.path.join(HERE, "fixtures")


def frame(bars: dict, tz: str | None) -> pd.DataFrame:
    idx = pd.to_datetime(bars["t"], unit="s", utc=True)
    idx = idx.tz_convert(tz) if tz else idx.tz_localize(None)
    return pd.DataFrame({"open": bars["o"], "high": bars["h"], "low": bars["l"], "close": bars["c"], "volume": [v or 0 for v in bars["v"]]}, index=idx)


def strip(d: dict) -> dict:
    return {k: v for k, v in d.items() if not k.startswith("_")}


def main():
    out = {}
    daily = json.load(open(os.path.join(FX, "RELIANCE_NS_1d.json")))
    df = frame(daily["bars"], None)
    out["overextended"] = {"bars": "RELIANCE_NS_1d", "cuts": {}}
    for cut in (len(df), len(df) - 40, len(df) - 200, 600):
        r = overextended.row("RELIANCE.NS", df.iloc[:cut])
        out["overextended"]["cuts"][str(cut)] = strip(r)
    out["overextended"]["score"] = overextended.score_series(df).tolist()
    one_year = df[df.index > df.index[-1] - pd.Timedelta(days=365)]
    out["screener"] = strip(screener._metrics("RELIANCE.NS", one_year))
    intra = json.load(open(os.path.join(FX, "ELECTCAST_NS_5m.json")))
    di = frame(intra["bars"], "Asia/Kolkata")
    out["intraday"] = {"bars": "ELECTCAST_NS_5m"}
    for side in ("up", "down"):
        f = intraday_ext.features(di, side)
        out["intraday"][side] = {"row": strip(intraday_ext.row("ELECTCAST.NS", di, side)), "score": f["score"].tolist(), "rvol": f["rvol"].tolist(),
                                 "vwap_z": f["vwap_z"].tolist(), "fading": [bool(x) for x in f["fading"]]}
    json.dump(clean(out), open(os.path.join(FX, "scanners.json"), "w"))
    print("ok")


if __name__ == "__main__":
    main()
