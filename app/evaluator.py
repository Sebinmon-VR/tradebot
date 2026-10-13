"""Automatic grading of predictions, plus historical testing (as-of and backtest)."""
from __future__ import annotations

import logging

import pandas as pd

from . import db
from .data import fetch_ohlcv, DataError, normalize_symbol, bar_is_forming

log = logging.getLogger("tradebot.evaluator")


def grade(direction: str, price_at: float, target: float | None, expected_move_pct: float | None,
          path: pd.DataFrame) -> tuple[str, float, float]:
    """Return (outcome, resolved_price, actual_move_pct) for a completed horizon.

    UP is correct if the close at the horizon is above entry OR the target was touched.
    DOWN mirrors that. SIDEWAYS means the system stood aside (no validated edge), so it is
    recorded as `no_call`: it counts in neither the numerator nor the denominator of the
    accuracy figure, but the individual strategies' votes are still graded against the move.
    """
    end_close = float(path["close"].iloc[-1])
    move_pct = (end_close / price_at - 1) * 100
    hit_target = False
    if target is not None:
        if direction == "UP":
            hit_target = bool((path["high"] >= target).any())
        elif direction == "DOWN":
            hit_target = bool((path["low"] <= target).any())
    if direction == "UP":
        ok = end_close > price_at or hit_target
    elif direction == "DOWN":
        ok = end_close < price_at or hit_target
    else:
        return "no_call", end_close, move_pct
    return ("correct" if ok else "incorrect"), end_close, move_pct


def _try_resolve(p: dict, df: pd.DataFrame) -> dict | None:
    """Resolve one prediction against `df` if enough bars have printed. Returns the result or None."""
    bar_time = pd.Timestamp(p["bar_time"])
    if len(df) and bar_is_forming(p["symbol"], p["interval"], df.index[-1]):
        df = df.iloc[:-1]                      # the forming bar is not a result yet
    future = df[df.index > bar_time]
    if len(future) < p["horizon_bars"]:
        return None
    path = future.iloc[: p["horizon_bars"]]
    outcome, end_close, move = grade(p["direction"], p["price_at"], p.get("target_price"), p.get("expected_move_pct"), path)
    db.resolve_prediction(p["id"], outcome, end_close, move)
    return {"id": p["id"], "symbol": p["symbol"], "direction": p["direction"], "outcome": outcome,
            "resolved_price": end_close, "actual_move_pct": round(move, 3)}


def resolve_one(pid: int, df: pd.DataFrame | None = None) -> dict | None:
    p = db.get_prediction(pid)
    if not p or p["status"] != "pending":
        return None
    df = df if df is not None else fetch_ohlcv(p["symbol"], p["interval"])
    res = _try_resolve(p, df)
    if res:
        db.rebuild_stats()
    return res


def resolve_pending(limit: int | None = None) -> dict:
    """Check every pending prediction; resolve those whose horizon bars have printed."""
    pending = db.pending_predictions()
    if limit:
        pending = pending[:limit]
    resolved, waiting, errors = [], [], []
    cache: dict[tuple, pd.DataFrame] = {}
    for p in pending:
        key = (p["symbol"], p["interval"])
        try:
            if key not in cache:
                cache[key] = fetch_ohlcv(p["symbol"], p["interval"], fresh=False)
            res = _try_resolve(p, cache[key])
            if res:
                resolved.append(res)
            else:
                done = int((cache[key].index > pd.Timestamp(p["bar_time"])).sum())
                waiting.append({"id": p["id"], "symbol": p["symbol"], "bars_done": done, "bars_needed": p["horizon_bars"]})
        except DataError as exc:
            errors.append({"id": p["id"], "error": str(exc)})
        except Exception as exc:  # pragma: no cover
            log.exception("resolve failed for %s", p["id"])
            errors.append({"id": p["id"], "error": str(exc)})
    if resolved:
        db.rebuild_stats()
    return {"resolved": resolved, "waiting": waiting, "errors": errors}


def backtest(symbol: str, interval: str, horizon: int | None, exchange: str = "", steps: int = 10,
             step_bars: int | None = None, save: bool = True) -> dict:
    """Walk backwards through history: at each of `steps` past points, run the full analysis using
    only the data available then, and grade it against what actually happened next.

    Predictions are stored with source='backtest' and immediately resolved, so they feed the
    per-strategy accuracy stats exactly like live feedback does.
    """
    from .ensemble import analyze, DEFAULT_HORIZON
    symbol_q = normalize_symbol(symbol, exchange)
    df = fetch_ohlcv(symbol_q, interval)
    if bar_is_forming(symbol_q, interval, df.index[-1]):
        df = df.iloc[:-1]                      # test only on completed bars
    horizon = int(horizon or DEFAULT_HORIZON.get(interval, 10))
    step_bars = int(step_bars or horizon)
    n = len(df)
    min_history = 120
    # cut points: last one must leave `horizon` future bars; earliest must keep min_history
    cuts = []
    end = n - horizon - 1
    for i in range(steps):
        idx = end - i * step_bars
        if idx < min_history:
            break
        cuts.append(idx)
    if not cuts:
        raise DataError(f"Not enough history for a backtest on {symbol_q} {interval} ({n} bars).")
    results = []
    for idx in reversed(cuts):
        past = df.iloc[: idx + 1]
        r = analyze(symbol_q, interval, horizon, df=past)
        r["created_at"] = past.index[-1].isoformat()
        r["source"] = "backtest"
        path = df.iloc[idx + 1: idx + 1 + horizon]
        outcome, end_close, move = grade(r["direction"], r["price_at"], r["target_price"], r["expected_move_pct"], path)
        row = {"bar_time": r["bar_time"], "direction": r["direction"], "prob_up": r["prob_up"], "confidence": r["confidence"],
               "expected_accuracy": r["summary"].get("expected_accuracy"), "evidence": (r["summary"].get("learner") or {}).get("evidence"),
               "price_at": round(r["price_at"], 4), "target_price": r["target_price"], "resolved_price": round(end_close, 4),
               "actual_move_pct": round(move, 3), "outcome": outcome}
        if save:
            pid = db.insert_prediction(r)
            db.resolve_prediction(pid, outcome, end_close, move)
            row["id"] = pid
        results.append(row)
    if save:
        db.rebuild_stats()
    graded = [r for r in results if r["outcome"] in ("correct", "incorrect")]
    correct = sum(1 for r in graded if r["outcome"] == "correct")
    by_dir: dict[str, dict] = {}
    for r in results:
        b = by_dir.setdefault(r["direction"], {"correct": 0, "incorrect": 0, "no_call": 0})
        b[r["outcome"]] += 1
    return {"symbol": symbol_q, "interval": interval, "horizon_bars": horizon, "steps": len(results),
            "calls": len(graded), "no_call": len(results) - len(graded),
            "correct": correct, "incorrect": len(graded) - correct,
            "accuracy": correct / len(graded) if graded else None, "by_direction": by_dir, "results": results}
