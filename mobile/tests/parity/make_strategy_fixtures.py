"""Parity fixtures for the strategy / model / ensemble ports: the bars of the indicator fixtures
(make_fixtures.py) run through app.strategies, app.models and the pure part of app.ensemble.analyze
at many cut points, so most rules fire at least once.

Run from the repo root (after make_fixtures.py):  python mobile/tests/parity/make_strategy_fixtures.py
"""
from __future__ import annotations

import json
import math
import os
import sys
from dataclasses import asdict
from types import SimpleNamespace

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)
from app import indicators as ind  # noqa: E402
from app import strategies, models, ensemble  # noqa: E402
from app.strategies import Signal  # noqa: E402

SRC = os.path.join(os.path.dirname(__file__), "fixtures")
OUT = os.path.join(SRC, "strategies")
CASES = {"RELIANCE_NS_1d": ("1d", 86400), "TCS_NS_15m": ("15m", 900), "ELECTCAST_NS_5m": ("5m", 300)}
VOTE_WINDOW = 320      # app.learner.VOTE_WINDOW: the window each historical strategy call sees

# a made-up track record (same shape as db.strategy_stats()) so the adaptive multiplier is exercised
STATS = {
    "macd": {"key": "macd", "name": "MACD Crossover", "category": "momentum", "correct": 14, "incorrect": 6, "neutral": 2},
    "rsi_wilder": {"key": "rsi_wilder", "name": "RSI 14 (Wilder)", "category": "momentum", "correct": 3, "incorrect": 9, "neutral": 0},
    "supertrend": {"key": "supertrend", "name": "Supertrend", "category": "trend", "correct": 40, "incorrect": 12, "neutral": 1},
    "linreg": {"key": "linreg", "name": "Linear Regression Trend", "category": "statistical", "correct": 5, "incorrect": 5, "neutral": 0},
    "turtle": {"key": "turtle", "name": "Turtle", "category": "volatility", "correct": 0, "incorrect": 0, "neutral": 3},
}


def clean(x):
    """JSON-safe without rounding (NaN / inf -> None)."""
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
    if isinstance(x, pd.Timestamp):
        return str(x)
    return x


def raw(sig: Signal) -> dict:
    return clean(asdict(sig))


def frame(bars: dict, ist: bool) -> pd.DataFrame:
    idx = pd.to_datetime(bars["t"], unit="s")
    df = pd.DataFrame({"open": bars["o"], "high": bars["h"], "low": bars["l"], "close": bars["c"],
                       "volume": [v if v is not None else 0.0 for v in bars["v"]]}, index=idx).astype(float)
    if ist:
        df.index = df.index.tz_localize("UTC").tz_convert("Asia/Kolkata")
    return df


def cut_points(n: int, count: int = 30, lo: int = 60) -> list[int]:
    pts = sorted({int(round(x)) for x in np.linspace(lo, n - 1, count)} | {n, 15, 30, 45})
    return [p for p in pts if lo <= p <= n or (lo <= 60 and p in (15, 30, 45))]


def fake_learner(prob: float, tier_acc, threshold: float = 0.58):
    fit = SimpleNamespace(threshold=threshold, learned_weights={"macd": 1.234, "rsi_wilder": 0.4, "linreg": 0.8}, accuracy=0.57)
    sigs = [
        Signal("wf_ensemble", "Walk-forward ensemble", "test", "ml", 1 if prob > 0.5 else -1, 0.42, "fake", "", dict(prob_up=prob)),
        Signal("logit", "Logistic regression", "test", "ml", -1, 0.3, "fake", "", dict(prob_up=0.45)),
    ]
    summary = {"available": True, "prob_up": prob, "threshold": threshold, "tier": {"accuracy": tier_acc}}
    spec = {"prob": prob, "threshold": threshold, "tier_accuracy": tier_acc, "fit_accuracy": fit.accuracy,
            "learned_weights": fit.learned_weights, "signals": [raw(s) for s in sigs], "summary": summary}
    lp = SimpleNamespace(prob=prob, fit=fit, tier={"accuracy": tier_acc}, signals=sigs, summary=lambda: summary)
    return lp, spec


def ensemble_cases(df_utc: pd.DataFrame, interval: str, ends: list[int]) -> list[dict]:
    out = []
    captured: dict = {}
    orig_s, orig_m = ensemble.run_strategies, ensemble.run_models

    def cap_s(data, sec):
        s = orig_s(data, sec); captured["s"] = s; return s

    def cap_m(data, h):
        s = orig_m(data, h); captured["m"] = s; return s

    ensemble.run_strategies, ensemble.run_models = cap_s, cap_m
    ensemble.db.strategy_stats = lambda: STATS
    try:
        for end in ends:
            for variant in ("none", "call", "nocall"):
                lp, spec = (None, None) if variant == "none" else fake_learner(0.63, 0.61) if variant == "call" else fake_learner(0.52, None)
                ensemble.learner.predict = lambda *a, _lp=lp, **k: _lp
                sub = df_utc.iloc[:end]
                res = ensemble.analyze("X", interval, df=sub, as_of=sub.index[-1])
                sigs = [raw(s) for s in captured["s"] + captured["m"]]
                out.append({"end": end, "variant": variant, "learner": spec, "stats": STATS, "signals": sigs, "result": clean(res)})
    finally:
        ensemble.run_strategies, ensemble.run_models = orig_s, orig_m
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, (interval, sec) in CASES.items():
        with open(os.path.join(SRC, name + ".json")) as f:
            src = json.load(f)
        dfi = frame(src["bars"], ist=True)
        allc = ind.compute_all(dfi)
        n = len(allc)
        horizon = ensemble.DEFAULT_HORIZON[interval]
        cuts = [{"start": 0, "end": e, "signals": [raw(s) for s in strategies.run_all(allc.iloc[:e], sec)]} for e in cut_points(n)]
        # the learner's view: a VOTE_WINDOW-bar window of the full-history frame
        for e in cut_points(n, 12, VOTE_WINDOW + 5):
            s = e - VOTE_WINDOW
            cuts.append({"start": s, "end": e, "signals": [raw(x) for x in strategies.run_all(allc.iloc[s:e], sec)]})
        mods = [{"end": e, "signals": [raw(s) for s in models.run_all(allc.iloc[:e], horizon)]} for e in cut_points(n, 10, 40)]
        ens = ensemble_cases(frame(src["bars"], ist=False), interval, [n, int(n * 0.8), int(n * 0.55)])
        levels = [{"end": e, "levels": clean(ensemble.chart_levels(dfi.iloc[:e]))} for e in (n, int(n * 0.7))]
        with open(os.path.join(OUT, name + ".json"), "w") as f:
            json.dump({"name": name, "interval": interval, "sec": sec, "horizon": horizon, "cuts": cuts, "models": mods,
                       "ensemble": ens, "chart_levels": levels, "catalog": strategies.catalog()}, f)
        print(name, n, "cuts", len(cuts), "models", len(mods), "ensemble", len(ens))


if __name__ == "__main__":
    main()
