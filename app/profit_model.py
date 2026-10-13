"""Profit model: an independent, report-only learner for "would this trade have made money after fees?".

The main learner (learner.py) predicts direction: "is the close higher `horizon` bars from now?".  A call can be
right on direction and still lose money (a 0.05% rise does not pay the charges, or the stop is hit first).
This model asks the trading question instead, with the triple-barrier method (Lopez de Prado, *Advances in
Financial Machine Learning*, 2018, ch. 3):

* at every past bar it replays an intraday trade entered on the next bar's open, long and short separately;
* the trade ends at whichever comes first: the target (PT_ATR x ATR), the stop (SL_ATR x ATR, assumed first
  when one bar touches both), `horizon` bars, or the plan's intraday exit (15:10 IST); no entries after 14:45;
* the label is whether the net result after the broker's round-trip charges and slippage was positive.

Two models per chart and side (logistic regression + gradient boosting on the main learner's feature set) are
validated walk-forward with a purge gap, like learner.py.  The report compares the trades the model would have
taken out-of-sample with simply taking every trade.

Isolation: this module runs only inside the separate worker process (profit_worker.py).  It gets bars and
settings from the server's read-only internal endpoints, keeps its own vote cache, fits, state file and
database (data/profit.db), and only *reads* the main learner's vote cache files.  Nothing here can change the
main learner's calls, the trade plans, the Ready list, settings or any paper trade.
"""
from __future__ import annotations

import json
import logging
import math
import os
import pickle
import re
import sqlite3
import time
import warnings
from dataclasses import dataclass, field
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from . import learner, trading
from .data import interval_seconds
from .db import DB_PATH
from .indicators import compute_all
from .strategies import STRATEGIES

log = logging.getLogger("tradebot.profit")

MODEL_VERSION = "p1"
PT_ATR = 1.5                 # target = entry +/- 1.5 x ATR(14) of the signal bar
SL_ATR = 1.0                 # stop   = entry -/+ 1.0 x ATR(14)
HORIZON = {"5m": 24, "15m": 16, "30m": 14, "1h": 12}      # vertical barrier: the main learner's horizon
EXIT_UTC = 9 * 60 + 40       # 15:10 IST, the plan's intraday exit: the last bar starting before it is the latest exit
LAST_ENTRY_UTC = 9 * 60 + 15  # 14:45 IST: no new entries after this
THRESHOLDS = (0.50, 0.55, 0.60, 0.65, 0.70)
MIN_TRADES = 30              # out-of-sample trades needed before a probability level is trusted
MIN_T = 1.0                  # ... and its average net result must sit this many standard errors above zero
MIN_ROWS = 250
TEST_SHARE = 0.6
FOLDS = 5
TRAIN_HALF_LIFE = 0.5

CACHE_DIR = os.path.join(learner.CACHE_DIR, "profit")
STATE_FILE = os.path.join(CACHE_DIR, "state.json")
PROFIT_DB = os.environ.get("TRADEBOT_PROFIT_DB", os.path.join(os.path.dirname(DB_PATH), "profit.db"))
SCHEMA = """
CREATE TABLE IF NOT EXISTS profit_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    bar_time TEXT NOT NULL,              -- the signal bar; the trade enters on the next bar's open
    created_at TEXT NOT NULL,
    side TEXT NOT NULL,                  -- LONG / SHORT
    p_win REAL NOT NULL,
    exp_net_pct REAL,                    -- out-of-sample average net % of trades at this probability level
    ref_price REAL NOT NULL,             -- signal bar close (the entry is the next open)
    atr REAL NOT NULL,
    cost_pct REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending / resolved / void
    entry_price REAL, exit_price REAL, exit_reason TEXT, net_pct REAL, resolved_at TEXT,
    UNIQUE(symbol, interval, bar_time, side)
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _safe(symbol: str, interval: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", f"{symbol}_{interval}")


def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(PROFIT_DB), exist_ok=True)
    con = sqlite3.connect(PROFIT_DB, timeout=10)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def write_state(state: dict) -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, default=str)
    os.replace(tmp, STATE_FILE)


def read_state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, ValueError):
        return {}


# --------------------------------------------------------------------------- the trade replay (labels and grading)
def session_bounds(index: pd.DatetimeIndex) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per bar: its session day, the last bar of that session starting before the 15:10 IST exit (-1 if none),
    and whether a new entry is still allowed at it (starts before 14:45 IST)."""
    t = pd.DatetimeIndex(index)
    minutes = np.asarray(t.hour * 60 + t.minute)
    can_hold = minutes < EXIT_UTC
    can_enter = minutes < LAST_ENTRY_UTC
    day = np.asarray(t.normalize())
    last = np.full(len(t), -1, dtype=int)
    cur_day, cur_last = None, -1
    for i in range(len(t) - 1, -1, -1):
        if day[i] != cur_day:
            cur_day, cur_last = day[i], -1
        if cur_last < 0 and can_hold[i]:
            cur_last = i
        last[i] = cur_last
    return day, last, can_enter


def replay(o, h, l, c, day, last, can_enter, i: int, side: int, atr: float, cost_pct: float, horizon: int) -> dict | None:
    """Net % of a trade signalled at bar i and entered on bar i+1's open.  None when it cannot be traded
    (no next bar in the same session, too late to enter) or its outcome is not known yet."""
    n = len(c)
    e = i + 1
    if e >= n or day[e] != day[i] or not can_enter[e] or not (atr > 0) or not (cost_pct == cost_pct):
        return None
    end = last[e]
    if end < e:
        return None
    end = min(end, e + horizon - 1)
    entry = o[e]
    target = entry + side * PT_ATR * atr
    stop = entry - side * SL_ATR * atr
    exit_px = reason = None
    j = e
    for j in range(e, min(end, n - 1) + 1):
        if side > 0:
            if l[j] <= stop:                           # a gap through the stop fills at the open
                exit_px, reason = (min(stop, o[j]) if j > e else stop), "stop"
            elif h[j] >= target:
                exit_px, reason = (max(target, o[j]) if j > e else target), "target"
        else:
            if h[j] >= stop:
                exit_px, reason = (max(stop, o[j]) if j > e else stop), "stop"
            elif l[j] <= target:
                exit_px, reason = (min(target, o[j]) if j > e else target), "target"
        if reason:
            break
    if reason is None:
        if end > n - 1:
            return None                                # the trade would still be open: outcome unknown
        exit_px, reason, j = c[end], "time", end
    gross = (exit_px / entry - 1) * 100 if side > 0 else (1 - exit_px / entry) * 100
    return {"entry": float(entry), "exit": float(exit_px), "reason": reason, "net_pct": float(gross - cost_pct), "exit_index": int(j)}


def cost_pct(price: float, side: int, settings: dict) -> float:
    """Round-trip charges + slippage as % of the trade value, for the shares the configured capital buys."""
    if not (price > 0):
        return float("nan")
    qty = max(1, int(settings["capital"] * max(1.0, float(settings.get("leverage") or 1.0)) // price))
    return float(trading.round_trip(price, price, qty, "intraday", settings["fees"], short=side < 0)["pct_of_value"])


def labels(data: pd.DataFrame, rows: pd.DatetimeIndex, horizon: int, settings: dict) -> pd.DataFrame:
    """Long and short net % (after charges) of a trade signalled at each bar in `rows`."""
    o, h, l, c = (data[k].to_numpy(float) for k in ("open", "high", "low", "close"))
    atr = data["atr_14"].to_numpy(float)
    day, last, can_enter = session_bounds(data.index)
    pos = data.index.get_indexer(rows)
    out = {"net_long": np.full(len(rows), np.nan), "net_short": np.full(len(rows), np.nan)}
    for k, i in enumerate(pos):
        if i < 0:
            continue
        for side, col in ((1, "net_long"), (-1, "net_short")):
            r = replay(o, h, l, c, day, last, can_enter, i, side, atr[i], cost_pct(c[i], side, settings), horizon)
            if r:
                out[col][k] = r["net_pct"]
    return pd.DataFrame(out, index=rows)


# --------------------------------------------------------------------------- features (own vote cache)
def _own_vote_file(symbol: str, interval: str) -> str:
    return os.path.join(CACHE_DIR, "votes", f"{_safe(symbol, interval)}.pkl")


def _read_votes(path: str) -> pd.DataFrame | None:
    try:
        if os.path.exists(path):
            df = pd.read_pickle(path)
            if isinstance(df, pd.DataFrame) and "_close" in df and set(STRATEGIES) <= set(df.columns):
                return df
    except Exception:
        pass
    return None


def strategy_votes(symbol: str, interval: str, data: pd.DataFrame, sec: int, stride: int) -> pd.DataFrame:
    """Every strategy's vote at the sampled bars.  Reuses rows from the main learner's vote cache (read only)
    and from this model's own cache; computes the rest here and saves them only to the own cache."""
    have = [v for v in (_read_votes(_own_vote_file(symbol, interval)), _read_votes(learner._vote_file(symbol, interval))) if v is not None]
    cached = pd.concat(have).sort_index() if have else None
    if cached is not None:
        cached = cached[~cached.index.duplicated(keep="first")]
        common = cached.index.intersection(data.index)
        same = np.isclose(cached.loc[common, "_close"].to_numpy(float), data.loc[common, "close"].to_numpy(float), rtol=1e-6)
        cached = cached.loc[common[same]]                 # a revised bar's vote is recomputed
    idx = learner._sample_bars(data.index, learner.MAX_ROWS, stride, sec, None if cached is None else cached.index)
    missing = idx if cached is None else idx.difference(cached.index)
    if len(missing):
        t0 = time.time()
        rows = []
        for p in data.index.get_indexer(missing):
            window = data.iloc[max(0, p - learner.VOTE_WINDOW + 1): p + 1]
            r = learner._votes_for_bar(window, sec)
            r["_close"] = float(data["close"].iloc[p])
            rows.append(r)
        new = pd.DataFrame(rows, index=missing)
        cached = new if cached is None else pd.concat([cached, new]).sort_index()
        cached = cached[~cached.index.duplicated(keep="last")].iloc[-learner.MAX_ROWS * 2:]
        os.makedirs(os.path.dirname(_own_vote_file(symbol, interval)), exist_ok=True)
        cached.to_pickle(_own_vote_file(symbol, interval) + ".tmp")
        os.replace(_own_vote_file(symbol, interval) + ".tmp", _own_vote_file(symbol, interval))
        log.info("votes for %d bars of %s %s in %.1fs", len(missing), symbol, interval, time.time() - t0)
    return cached.reindex(idx)


def market_features(market: pd.DataFrame | None, index: pd.DatetimeIndex) -> pd.DataFrame | None:
    """NIFTY 50 returns aligned to the stock's bars (the main learner's definition)."""
    if market is None or len(market) < 30:
        return None
    c = market["close"]
    f = pd.DataFrame({"mkt_ret_1": c.pct_change(), "mkt_ret_5": c.pct_change(5), "mkt_ret_20": c.pct_change(20),
                      "mkt_vol_20": c.pct_change().rolling(20).std()})
    f = f[~f.index.duplicated(keep="last")].sort_index()
    return f.reindex(index, method="ffill")


def features(symbol: str, interval: str, data: pd.DataFrame, market: pd.DataFrame | None, horizon: int) -> pd.DataFrame:
    sec = interval_seconds(interval)
    votes = strategy_votes(symbol, interval, data, sec, learner.training_stride(horizon))
    feats, _direction_label = learner.build_features(data, votes, market_features(market, votes.index), horizon, sec)
    return feats


# --------------------------------------------------------------------------- models
def _makers() -> dict:
    return {
        "logistic": lambda: make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=0.02, max_iter=3000)),
        "boosting": lambda: HistGradientBoostingClassifier(max_iter=150, learning_rate=0.04, max_depth=3, min_samples_leaf=30,
                                                           l2_regularization=2.0, random_state=42),
    }


def _clip(X: np.ndarray) -> np.ndarray:
    return np.clip(X, -1e9, 1e9)


def _fit_model(name: str, m, X, y, w):
    if len(np.unique(y)) < 2:
        return None
    if name == "logistic":
        return m.fit(_clip(X), y, logisticregression__sample_weight=w)
    return m.fit(_clip(X), y, sample_weight=w)


def _proba(m, X) -> np.ndarray:
    if m is None:
        return np.full(len(X), np.nan)
    return m.predict_proba(_clip(X))[:, 1]


def _tiers(p: np.ndarray, net: np.ndarray) -> list[dict]:
    out = []
    for t in THRESHOLDS:
        x = net[p >= t]
        k = len(x)
        sd = float(x.std(ddof=1)) if k > 1 else 0.0
        out.append({"threshold": t, "n": k, "win": float((x > 0).mean()) if k else None, "avg_net": float(x.mean()) if k else None,
                    "t": round(float(x.mean() / (sd / math.sqrt(k))), 2) if sd > 0 else 0.0})
    return out


def _side_report(p_oof: np.ndarray, net: np.ndarray) -> dict:
    ok = ~np.isnan(p_oof) & ~np.isnan(net)
    p, x = p_oof[ok], net[ok]
    tiers = _tiers(p, x)
    good = [t for t in tiers if t["n"] >= MIN_TRADES and t["avg_net"] is not None and t["avg_net"] > 0 and t["t"] >= MIN_T]
    chosen = max(good, key=lambda t: t["t"]) if good else None
    return {"tested": int(ok.sum()),
            "baseline": {"n": int(len(x)), "win": float((x > 0).mean()) if len(x) else None, "avg_net": float(x.mean()) if len(x) else None},
            "model": tiers[0],                 # P(win) >= 50%: no level picked in hindsight
            "tiers": tiers, "chosen": chosen, "validated": chosen is not None}


@dataclass
class ProfitFit:
    symbol: str
    interval: str
    horizon: int
    last_bar: pd.Timestamp
    fitted_at: float
    n_rows: int
    feature_names: list[str]
    sides: dict                                  # "long" / "short" -> report
    models: dict = field(repr=False)             # "long" / "short" -> {"logistic": m, "boosting": m}
    version: str = MODEL_VERSION


def fit(symbol: str, interval: str, data: pd.DataFrame, market: pd.DataFrame | None, settings: dict) -> ProfitFit | None:
    """Walk-forward fit of the long and short profit models on closed, indicator-enriched bars."""
    horizon = HORIZON[interval]
    t0 = time.time()
    feats = features(symbol, interval, data, market, horizon)
    lab = labels(data, feats.index, horizon, settings)
    usable = feats.notna().mean(axis=1).gt(0.7)
    feats, lab = feats[usable], lab[usable]
    X = feats.to_numpy(float)
    reports, models = {}, {}
    for side in ("long", "short"):
        net = lab[f"net_{side}"].to_numpy(float)
        has = ~np.isnan(net)
        Xs, ns = X[has], net[has]
        if len(Xs) < MIN_ROWS:
            log.info("skipped %s %s: only %d tradable rows", symbol, interval, len(Xs))
            return None
        y = (ns > 0).astype(int)
        n = len(y)
        edges = np.linspace(max(int(n * (1 - TEST_SHARE)), 120 + horizon), n, FOLDS + 1).astype(int)
        oof = {name: np.full(n, np.nan) for name in _makers()}
        for k in range(FOLDS):
            s, e = int(edges[k]), int(edges[k + 1])
            tr_end = s - horizon                       # purge: training trades end before the test block starts
            if tr_end < 120 or e <= s:
                continue
            w = learner._recency_weights(tr_end, tr_end * TRAIN_HALF_LIFE)
            for name, make in _makers().items():
                oof[name][s:e] = _proba(_fit_model(name, make(), Xs[:tr_end], y[:tr_end], w), Xs[s:e])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)      # rows before the first test block have no prediction yet
            p_avg = np.nanmean(np.vstack(list(oof.values())), axis=0)
        rep = _side_report(p_avg, ns)
        rep["learners"] = {name: _side_report(p, ns)["model"] for name, p in oof.items()}
        w_all = learner._recency_weights(n, n * TRAIN_HALF_LIFE)
        models[side] = {name: _fit_model(name, make(), Xs, y, w_all) for name, make in _makers().items()}
        reports[side] = rep
    log.info("fitted %s %s in %.1fs (long %s, short %s)", symbol, interval, time.time() - t0,
             "edge" if reports["long"]["validated"] else "no edge", "edge" if reports["short"]["validated"] else "no edge")
    return ProfitFit(symbol=symbol, interval=interval, horizon=horizon, last_bar=pd.Timestamp(data.index[-1]), fitted_at=time.time(),
                     n_rows=int(len(X)), feature_names=list(feats.columns), sides=reports, models=models)


def _fit_file(symbol: str, interval: str) -> str:
    return os.path.join(CACHE_DIR, "fits", f"{_safe(symbol, interval)}.pkl")


def load_fit(symbol: str, interval: str) -> ProfitFit | None:
    try:
        with open(_fit_file(symbol, interval), "rb") as fh:
            f = pickle.load(fh)
        return f if isinstance(f, ProfitFit) and f.version == MODEL_VERSION else None
    except Exception:
        return None


def save_fit(f: ProfitFit) -> None:
    path = _fit_file(f.symbol, f.interval)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "wb") as fh:
        pickle.dump(f, fh, protocol=pickle.HIGHEST_PROTOCOL)
    os.replace(path + ".tmp", path)


def fit_is_fresh(f: ProfitFit | None, data: pd.DataFrame, market_open: bool) -> bool:
    """Refit once per session: in market hours a fit that has seen every earlier session is kept all day;
    after the close the day's bars are folded in (off-hours, when the CPU is free)."""
    if f is None:
        return False
    idx = data.index
    if market_open:
        earlier = idx[idx.normalize() < idx[-1].normalize()]
        need = earlier[-1] if len(earlier) else idx[0]
    else:
        need = idx[-1]
    return f.last_bar >= need


# --------------------------------------------------------------------------- predict, record, grade
def report_of(f: ProfitFit) -> dict:
    return {"symbol": f.symbol, "interval": f.interval, "rows": f.n_rows, "fitted_at": f.fitted_at, "fitted_on": f.last_bar.isoformat(),
            "long": f.sides["long"], "short": f.sides["short"]}


def predict(f: ProfitFit, data: pd.DataFrame, market: pd.DataFrame | None, settings: dict) -> dict:
    feats = features(f.symbol, f.interval, data, market, f.horizon)
    x = feats.reindex(columns=f.feature_names).iloc[[-1]].to_numpy(float)
    bar = pd.Timestamp(feats.index[-1])
    price, atr = float(data["close"].iloc[-1]), float(data["atr_14"].iloc[-1])
    sides = {}
    for side, sgn in (("long", 1), ("short", -1)):
        ps = [p for p in (_proba(m, x)[0] for m in f.models[side].values() if m is not None) if p == p]
        p = float(np.mean(ps)) if ps else None
        ch = f.sides[side]["chosen"]
        sides[side] = {"p_win": p, "take": bool(ch and p is not None and p >= ch["threshold"]), "level": ch["threshold"] if ch else None,
                       "exp_net_pct": ch["avg_net"] if ch else None, "exp_win": ch["win"] if ch else None,
                       "cost_pct": round(cost_pct(price, sgn, settings), 4),
                       "target": round(price + sgn * PT_ATR * atr, 2), "stop": round(price - sgn * SL_ATR * atr, 2)}
    nxt = bar + pd.Timedelta(seconds=interval_seconds(f.interval))
    in_time = (nxt.hour * 60 + nxt.minute) < LAST_ENTRY_UTC and nxt.normalize() == bar.normalize()
    takes = [s for s in ("long", "short") if sides[s]["take"]]
    decision = max(takes, key=lambda s: sides[s]["exp_net_pct"]) if (takes and in_time) else None
    if decision:
        why = None
    elif takes:
        why = "too late in the session for a new intraday trade"
    elif f.sides["long"]["validated"] or f.sides["short"]["validated"]:
        why = "P(win) is below this stock's tested level"
    else:
        why = "no probability level made money after charges out-of-sample on this stock"
    return {"symbol": f.symbol, "interval": f.interval, "bar_time": bar.isoformat(), "price": round(price, 2), "atr": round(atr, 4),
            "decision": decision.upper() if decision else "SKIP", "why": why, "long": sides["long"], "short": sides["short"],
            "fitted_at": f.fitted_at, "analysed_at": now_iso()}


def record(pred: dict) -> bool:
    """Store a TAKE decision once per bar, so the model builds its own live record."""
    if pred["decision"] not in ("LONG", "SHORT"):
        return False
    s = pred[pred["decision"].lower()]
    with connect() as con:
        cur = con.execute("""INSERT OR IGNORE INTO profit_calls (symbol, interval, bar_time, created_at, side, p_win, exp_net_pct,
                             ref_price, atr, cost_pct) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                          (pred["symbol"], pred["interval"], pred["bar_time"], now_iso(), pred["decision"], s["p_win"], s["exp_net_pct"],
                           pred["price"], pred["atr"], s["cost_pct"]))
        return cur.rowcount > 0


def pending_calls() -> list[dict]:
    with connect() as con:
        return [dict(r) for r in con.execute("SELECT * FROM profit_calls WHERE status='pending'").fetchall()]


def grade(call: dict, bars: pd.DataFrame) -> bool:
    """Grade one live call against closed bars with the same replay that made the training labels."""
    bar = pd.Timestamp(call["bar_time"])
    bar = bar.tz_convert(None) if bar.tzinfo else bar
    if bar not in bars.index:
        stale = (pd.Timestamp.now(tz="UTC").tz_localize(None) - bar).days > 5
        if stale:
            with connect() as con:
                con.execute("UPDATE profit_calls SET status='void', resolved_at=? WHERE id=?", (now_iso(), call["id"]))
        return stale
    o, h, l, c = (bars[k].to_numpy(float) for k in ("open", "high", "low", "close"))
    day, last, can_enter = session_bounds(bars.index)
    i = int(bars.index.get_loc(bar))
    r = replay(o, h, l, c, day, last, can_enter, i, 1 if call["side"] == "LONG" else -1, call["atr"], call["cost_pct"],
               HORIZON.get(call["interval"], 16))
    if r is None:
        if i + 1 < len(bars) and (day[i + 1] != day[i] or not can_enter[i + 1]):
            with connect() as con:             # the session ended before the entry bar
                con.execute("UPDATE profit_calls SET status='void', resolved_at=? WHERE id=?", (now_iso(), call["id"]))
            return True
        return False
    with connect() as con:
        con.execute("UPDATE profit_calls SET status='resolved', entry_price=?, exit_price=?, exit_reason=?, net_pct=?, resolved_at=? WHERE id=?",
                    (r["entry"], r["exit"], r["reason"], r["net_pct"], now_iso(), call["id"]))
    return True


def prepare(bars: pd.DataFrame) -> pd.DataFrame:
    return compute_all(bars)
