"""Intraday overextension: stocks that have run too far from TODAY's open (the daily-bar version is
overextended.py).

Every 5-minute bar gets a 0-100 score from published intraday rules, each scaled from "just
triggered" (0) to "extreme" (1) times its weight:

  Run from the open in daily-ATR units ... Wilder's ATR as the yardstick; Toby Crabel, "Day Trading with
                               Short Term Price Patterns and Opening Range Breakout" (1990), measures the
                               day's move from the open against the stock's normal daily range
  Stretch above session VWAP in standard deviations ... VWAP (Berkowitz, Logue & Noser, 1988) with
                               volume-weighted sigma bands; beyond 2 sigma is the classic fade zone
  Above yesterday's floor pivots R1 / R2 / R3 ... classic floor-trader pivots
  5-minute RSI-14 above 70 ... J. Welles Wilder (1978)
  Relative volume climax ..... Richard Wyckoff's buying climax: volume so far far above the usual for this time of day
  Giving back from the high .. a failed push: the stock has already handed back part of the run from its high

The same rules run on the mirror image (every price negated, high and low swapped) for stocks that have
FALLEN too far below the open: ATR below the open, sigma below VWAP, through S1 / S2 / S3, RSI below 30,
and bouncing back from the low.

Big up-moves from the open are often trend days that close near the high, so the module also
measures, over the last ~60 sessions, what happened after each earlier day on which a stock's score
first crossed the "extended" line: how often the close was below the price at that moment, the
average move to the close, how much further it ran first, and how deep it dipped.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import indicators as ind
from .data import DataError, normalize_symbol
from .universe import UNIVERSES

log = logging.getLogger("tradebot.intraday_ext")

IST = "Asia/Kolkata"
INTERVAL, HIST_PERIOD = "5m", "60d"      # Yahoo keeps 60 days of 5-minute bars
HIST_TTL, CACHE_TTL = 1800, 60           # full history refetched every 30 min; the scan result every minute
HIST_THRESHOLD = 35                      # an episode = the first bar of a session at or above this score
LAST_SIGNAL = (14, 30)                   # episodes after 14:30 IST leave too little of the session to judge
FADE_GIVEBACK = 0.5                     # "the push has failed": half of the run from the open handed back (see features())
SKIP_OPEN_BARS = 2                       # 09:15 and 09:20: VWAP and RSI are meaningless on one or two bars
# tiers from 60 days of 5-minute bars (NIFTY 100 + mid/small caps, before 14:30): a session peaks at 25+ on
# roughly 12% of stock-days, 35+ on about 4% and 50+ on about 1%
TIERS = ((50, "stretched"), (35, "extended"), (25, "warming"))
MIN_SCORE = 25

_HIST: dict[str, tuple[float, pd.DataFrame]] = {}
_CACHE: dict[tuple, tuple[float, dict]] = {}

RULES = {
    "run": dict(label="Run from the open", weight=30, lo=1.0, hi=2.5,
                origin="Wilder's ATR as the yardstick; Toby Crabel, Day Trading with Short Term Price Patterns and Opening Range Breakout (1990)",
                rule="Price more than 1 daily ATR above today's open; full points at 2.5 ATR"),
    "vwap": dict(label="Stretched above VWAP", weight=20, lo=1.5, hi=3.0,
                 origin="VWAP (Berkowitz, Logue & Noser, 1988) with volume-weighted standard-deviation bands",
                 rule="Price more than 1.5 sigma above the session VWAP; full points at 3 sigma"),
    "pivot": dict(label="Through the floor pivots", weight=15,
                  origin="Classic floor-trader pivots from yesterday's high, low and close",
                  rule="Above R1 = 1/3, above R2 = 2/3, above R3 = full points"),
    "rsi": dict(label="5-min RSI overbought", weight=15, lo=70, hi=85,
                origin="J. Welles Wilder, New Concepts in Technical Trading Systems (1978)",
                rule="RSI-14 on 5-minute bars above 70; full points at 85"),
    "rvol": dict(label="Volume climax", weight=10, lo=2.0, hi=5.0,
                 origin="Richard Wyckoff's buying climax; relative volume at the same time of day",
                 rule="Volume so far today at least 2x the 20-session average by this time; full points at 5x"),
    "giveback": dict(label="Giving back from the high", weight=10, lo=0.25, hi=0.6,
                     origin="Failed push / upthrust (Wyckoff): the run is already being sold",
                     rule="After a run of 1+ ATR, a quarter or more of it handed back from the high; full points at 60%"),
}
assert sum(r["weight"] for r in RULES.values()) == 100

# the same rules seen from the down side (features() computes them on the mirrored frame)
RULES_DOWN = {
    "run": dict(RULES["run"], label="Fall from the open", rule="Price more than 1 daily ATR below today's open; full points at 2.5 ATR"),
    "vwap": dict(RULES["vwap"], label="Stretched below VWAP", rule="Price more than 1.5 sigma below the session VWAP; full points at 3 sigma"),
    "pivot": dict(RULES["pivot"], label="Through the floor pivots", rule="Below S1 = 1/3, below S2 = 2/3, below S3 = full points"),
    "rsi": dict(RULES["rsi"], label="5-min RSI oversold", rule="RSI-14 on 5-minute bars below 30; full points at 15"),
    "rvol": dict(RULES["rvol"], label="Volume climax", origin="Richard Wyckoff's selling climax; relative volume at the same time of day"),
    "giveback": dict(RULES["giveback"], label="Bouncing off the low", origin="Failed break / spring (Wyckoff): the drop is already being bought",
                     rule="After a fall of 1+ ATR, a quarter or more of it recovered from the low; full points at 60%"),
}
SIDES = ("up", "down")


def _mirror(df: pd.DataFrame) -> pd.DataFrame:
    """Prices negated and high/low swapped: a fall from the open becomes a run-up, S-pivots become R-pivots
    (r1 of the mirror = -s1), VWAP and ATR carry over, RSI becomes 100 - RSI."""
    m = df.copy()
    m["open"], m["close"] = -df["open"], -df["close"]
    m["high"], m["low"] = -df["low"], -df["high"]
    return m


def _ramp(x, lo: float, hi: float) -> pd.Series:
    return ((x - lo) / (hi - lo)).clip(lower=0.0, upper=1.0).fillna(0.0)


def _ist(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    idx = df.index if df.index.tz is not None else df.index.tz_localize("UTC")
    df.index = idx.tz_convert(IST)
    return df[~df.index.duplicated(keep="last")].sort_index()


def features(df: pd.DataFrame, side: str = "up") -> pd.DataFrame:
    """Per-bar session features and rule components for an IST-indexed 5-minute frame.  For side="down" every
    column is in mirrored space (see _mirror): row() converts back for display."""
    if side == "down":
        df = _mirror(df)
    c, h, l, o = df["close"], df["high"], df["low"], df["open"]
    v = df["volume"].fillna(0.0)
    day = pd.Index(df.index.date, name="day")
    g = lambda s: s.groupby(day)
    daily = pd.DataFrame({"open": g(o).first(), "high": g(h).max(), "low": g(l).min(), "close": g(c).last()})
    daily["atr_prev"] = ind.atr(daily, 14).shift(1)
    ph, pl, pc = daily["high"].shift(1), daily["low"].shift(1), daily["close"].shift(1)
    pp = (ph + pl + pc) / 3
    daily["prev_close"], daily["p"] = pc, pp
    daily["r1"], daily["r2"], daily["r3"] = 2 * pp - pl, pp + (ph - pl), ph + 2 * (pp - pl)
    daily["h3"], daily["h4"] = pc + (ph - pl) * 1.1 / 4, pc + (ph - pl) * 1.1 / 2
    per = daily.reindex(day)
    per.index = df.index

    f = pd.DataFrame(index=df.index)
    f["day"] = day
    f["k"] = g(c).cumcount().to_numpy()
    f["open"] = g(o).transform("first").to_numpy()
    f["hi"] = g(h).cummax().to_numpy()
    f["lo"] = g(l).cummin().to_numpy()
    f["close"] = c
    f["day_close"] = g(c).transform("last").to_numpy()
    for col in ("atr_prev", "prev_close", "p", "r1", "r2", "r3", "h3", "h4"):
        f[col] = per[col]
    atr = f["atr_prev"].replace(0, np.nan)
    f["run_atr"] = (c - f["open"]) / atr
    f["high_atr"] = (f["hi"] - f["open"]) / atr
    tp = (h + l + c) / 3
    cv = g(v).cumsum().to_numpy()
    cv_ = pd.Series(cv, index=df.index).replace(0, np.nan)
    f["vwap"] = pd.Series(g(tp * v).cumsum().to_numpy(), index=df.index) / cv_
    var = pd.Series(g(tp * tp * v).cumsum().to_numpy(), index=df.index) / cv_ - f["vwap"] ** 2
    sd = np.sqrt(var.clip(lower=0)).clip(lower=0.1 * atr)          # a few bars in, sigma is tiny: floor it
    f["vwap_z"] = (c - f["vwap"]) / sd
    f["rsi"] = ind.rsi(c, 14)
    # relative volume: cumulative volume by this bar vs the mean of the previous 20 sessions at the same bar
    cvol = pd.DataFrame({"day": day, "k": f["k"].to_numpy(), "cv": cv})
    piv = cvol.pivot_table(index="day", columns="k", values="cv", aggfunc="last")
    typical = piv.rolling(20, min_periods=5).mean().shift(1)
    stacked = typical.stack()
    key = pd.MultiIndex.from_arrays([day, f["k"].to_numpy()])
    f["rvol"] = cv / stacked.reindex(key).replace(0, np.nan).to_numpy()
    push = (f["hi"] - f["open"]).replace(0, np.nan)
    f["giveback"] = ((f["hi"] - c) / push).where(f["high_atr"] >= 1.0, 0.0)
    f["chg_prev"] = (c / f["prev_close"] - 1) * 100
    f["chg_open"] = (c / f["open"] - 1) * 100
    f["gap"] = (f["open"] / f["prev_close"] - 1) * 100

    up = (c > f["open"]) & atr.notna() & (f["k"] >= SKIP_OPEN_BARS)
    R = lambda key, x: _ramp(x, RULES[key]["lo"], RULES[key]["hi"])
    piv_part = ((c > f["r1"]).astype(float) + (c > f["r2"]) + (c > f["r3"])) / 3
    parts = pd.DataFrame({
        "run": R("run", f["run_atr"]), "vwap": R("vwap", f["vwap_z"]), "pivot": piv_part,
        "rsi": R("rsi", f["rsi"]), "rvol": R("rvol", f["rvol"]), "giveback": R("giveback", f["giveback"]),
    }, index=df.index).where(up, 0.0)
    f["score"] = sum(parts[k] * RULES[k]["weight"] for k in RULES)
    for k in RULES:
        f["part_" + k] = parts[k]
    # "fading": the session already reached the extended line and has handed back half of the run from the open.
    # Measured on 60 days of NIFTY 100 + mid/small caps (2026-09-29, first such bar per session, before 14:30):
    # 63% closed lower, average -0.26% to the close, the same in both halves of the sample (n=111).  Looser
    # versions (a quarter given back, back at VWAP) and the plain "score still 35+" were close to a coin flip.
    f["peak"] = f["score"].groupby(day).cummax().to_numpy()
    f["fading"] = (f["peak"] >= HIST_THRESHOLD) & (c > f["open"]) & (f["k"] >= SKIP_OPEN_BARS) &         (f["giveback"] >= FADE_GIVEBACK)
    return f


def tier(score: float) -> str | None:
    for lo, name in TIERS:
        if score >= lo:
            return name
    return None


def _first_outcomes(hist: pd.DataFrame, mask: pd.Series) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """For the first bar of each session where `mask` holds: move to the close, the further run, the deepest
    pullback - all in the direction of the run (a negative move to the close means it reversed), so the same code
    serves the mirrored down side."""
    fwd, further, dips = [], [], []
    for ts, r in hist[mask].groupby("day").head(1).iterrows():
        rest = hist[(hist["day"] == r["day"]) & (hist.index > ts)]
        px = r["close"]
        fwd.append((r["day_close"] - px) / abs(px))
        further.append(((rest["hi"].max() - px) / abs(px)) if len(rest) else 0.0)
        dips.append(((rest["lo"].min() - px) / abs(px)) if len(rest) else 0.0)
    return np.array(fwd), np.array(further), np.array(dips)


def _summary(fwd: np.ndarray, further: np.ndarray, dips: np.ndarray, sgn: int = 1) -> dict:
    """reversal_share = closed lower (up side) / higher (down side) than the price at the signal; the percentages
    are converted back to plain price moves (sgn = -1 on the down side)."""
    if not len(fwd):
        return {"episodes": 0, "reversal_share": None, "avg_fwd_pct": None, "median_further_pct": None, "median_dip_pct": None}
    return {"episodes": int(len(fwd)), "reversal_share": round(float((fwd < 0).mean()), 3),
            "avg_fwd_pct": round(float(sgn * fwd.mean() * 100), 2), "median_further_pct": round(float(sgn * np.median(further) * 100), 2),
            "median_dip_pct": round(float(sgn * np.median(dips) * 100), 2)}


def episodes(f: pd.DataFrame, threshold: float = HIST_THRESHOLD, sgn: int = 1) -> dict:
    """Earlier sessions (not today) before 14:30: after the score first crossed `threshold` ("run"), and after the
    push first started failing ("fade"), where did the stock close that day?"""
    days = f["day"].unique()
    hist = f[f["day"] != days[-1]]
    tmin = hist.index.hour * 60 + hist.index.minute
    ok = pd.Series(tmin <= LAST_SIGNAL[0] * 60 + LAST_SIGNAL[1], index=hist.index)
    run = _first_outcomes(hist, ok & (hist["score"] >= threshold))
    fade = _first_outcomes(hist, ok & hist["fading"])
    # base rate: every bar of an up-session (price above the open) before 14:30 - how often did the day close lower?
    base = hist[ok & (hist["close"] > hist["open"]) & (hist["k"] >= SKIP_OPEN_BARS)]
    bfwd = ((base["day_close"] - base["close"]) / base["close"].abs()).to_numpy()
    return {"threshold": threshold, "sessions": int(len(days) - 1), **_summary(*run, sgn=sgn), "fade": _summary(*fade, sgn=sgn),
            "uncond_reversal_share": round(float((bfwd < 0).mean()), 3) if len(bfwd) else None,
            "_run": run, "_fade": fade, "_base": (int((bfwd < 0).sum()), int(len(bfwd)))}


def _num(x, d: int = 2):
    try:
        return None if x is None or pd.isna(x) else round(float(x), d)
    except (TypeError, ValueError):
        return None


def _value_text(key: str, d: dict, side: str) -> str:
    """Rule reading in plain price terms (`d` is the display row, already converted back from the mirror)."""
    below = side == "down"
    if key == "run":
        return f"{abs(d['run_atr']):.1f} ATR {'below' if below else 'above'} the open ({d['chg_open']:+.1f}%)"
    if key == "vwap":
        return f"{abs(d['vwap_z']):.1f} sigma {'below' if below else 'above'} VWAP {d['vwap']:.2f}"
    if key == "pivot":
        return f"{'below' if below else 'above'} {d['beyond']} ({d['levels']['l' + d['beyond'][1]]:.2f})"
    if key == "rsi":
        return f"RSI-14 (5m) {d['rsi']:.0f}"
    if key == "rvol":
        return f"volume {d['rvol']:.1f}x usual by this time"
    if key == "giveback":
        return f"{d['giveback']:.0f}% of the {'fall recovered from' if below else 'run given back from'} {d['extreme']:.2f}"
    return ""


def row(sym: str, df: pd.DataFrame, side: str = "up") -> dict:
    f = features(df, side)
    sgn = -1 if side == "down" else 1
    px = lambda x: _num(sgn * x) if x is not None and pd.notna(x) else None   # mirrored price -> real price
    last = f.iloc[-1]
    s = float(last["score"])
    hist = episodes(f, sgn=sgn)
    today = f[f["day"] == last["day"]]
    peak = today["score"].max()
    phase = "fading" if bool(last["fading"]) else "running" if s >= HIST_THRESHOLD else None
    lvl = next((n for n in ("r3", "r2", "r1") if pd.notna(last[n]) and last["close"] > last[n]), None)
    rules = RULES_DOWN if side == "down" else RULES
    d = {
        "symbol": sym, "name": sym.replace(".NS", "").replace(".BO", ""), "side": side, "price": px(last["close"]),
        "session": str(last["day"]), "bar_time": f.index[-1].isoformat(),
        "open": px(last["open"]), "extreme": px(last["hi"]), "prev_close": px(last["prev_close"]),
        "chg_prev": _num(last["chg_prev"]), "chg_open": _num(last["chg_open"]), "gap": _num(last["gap"]),
        "extreme_from_open": _num((last["hi"] / last["open"] - 1) * 100),    # the high (up) or the low (down) vs the open
        "run_atr": _num(sgn * last["run_atr"], 1), "extreme_atr": _num(sgn * last["high_atr"], 1),
        "atr_pct": _num(last["atr_prev"] / abs(last["close"]) * 100),
        "vwap": px(last["vwap"]), "vwap_z": _num(sgn * last["vwap_z"], 1),
        "rsi": _num(100 - last["rsi"] if side == "down" else last["rsi"], 0), "rvol": _num(last["rvol"], 1),
        "giveback": _num(last["giveback"] * 100 if last["high_atr"] >= 1 else None, 0),
        # yesterday's floor pivots on the side of the move: R1-R3 above (up), S1-S3 below (down)
        "level_prefix": "S" if side == "down" else "R",
        "levels": {"p": px(last["p"]), "l1": px(last["r1"]), "l2": px(last["r2"]), "l3": px(last["r3"])},
        "beyond": (("S" if side == "down" else "R") + lvl[1]) if lvl else None,
        "score": int(round(s)), "tier": tier(s), "peak_today": int(round(peak)), "phase": phase,
        "peak_time": today["score"].idxmax().strftime("%H:%M") if peak > 0 else None,
        "history": {k: v for k, v in hist.items() if not k.startswith("_")},
        "spark": [px(x) for x in today["close"]], "spark_vwap": [px(x) for x in today["vwap"]],
        "_hist": hist,
    }
    fired = []
    for k, meta in rules.items():
        p = float(last["part_" + k])
        if p > 0:
            fired.append({"key": k, "label": meta["label"], "origin": meta["origin"], "rule": meta["rule"],
                          "points": round(p * meta["weight"], 1), "max_points": meta["weight"], "value": _value_text(k, d, side)})
    fired.sort(key=lambda x: -x["points"])
    d["rules"] = fired
    return d


def _frames(symbols: list[str]) -> dict[str, pd.DataFrame]:
    """60 days of 5-minute bars per symbol: the history is cached for HIST_TTL, the current session refetched."""
    from . import screener
    now = time.time()
    stale = [s for s in symbols if s not in _HIST or now - _HIST[s][0] > HIST_TTL]
    if stale:
        for s, df in screener._batch(stale, HIST_PERIOD, INTERVAL).items():
            _HIST[s] = (now, _ist(df))
    fresh = [s for s in symbols if s in _HIST and s not in stale]
    if fresh:
        for s, df in screener._batch(fresh, "1d", INTERVAL).items():
            old = _HIST[s][1]
            _HIST[s] = (_HIST[s][0], _ist(pd.concat([old, _ist(df)[old.columns.intersection(df.columns)]])))
    return {s: _HIST[s][1] for s in symbols if s in _HIST}


def scan(universe: str = "nifty100", extra: list[str] | None = None, min_score: int = MIN_SCORE, side: str = "up") -> dict:
    from . import screener
    if side not in SIDES:
        raise DataError(f"side must be one of {SIDES}")
    sgn = -1 if side == "down" else 1
    if universe not in UNIVERSES and universe != "custom":
        raise DataError(f"Unknown universe '{universe}'. Use one of {list(UNIVERSES)} or 'custom'.")
    base = UNIVERSES.get(universe, {"name": "Custom", "exchange": "NSE", "symbols": []})
    extra_syms = []
    for s in extra or []:
        try:
            if s.strip():
                extra_syms.append(normalize_symbol(s.strip(), base.get("exchange", "NSE")))
        except DataError:
            continue
    symbols = list(dict.fromkeys(base["symbols"] + extra_syms))
    if not symbols:
        raise DataError("No symbols to scan.")
    key = (universe, tuple(sorted(extra_syms)), side)
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < CACHE_TTL:
        result = dict(hit[1])
    else:
        t0 = time.time()
        frames = _frames(symbols)
        rows, missing = [], []
        pools = {"_run": [], "_fade": []}
        b_lower = b_total = 0
        for s in symbols:
            df = frames.get(s)
            if df is None or len(df) < 300:
                missing.append(s)
                continue
            try:
                m = row(s, df, side)
            except Exception as exc:  # one bad symbol must not kill the scan
                log.debug("intraday row failed for %s", s, exc_info=True)
                missing.append(f"{s}: {exc}")
                continue
            h = m.pop("_hist")
            for k in pools:
                pools[k].append(h[k])
            b_lower += h["_base"][0]; b_total += h["_base"][1]
            rows.append(m)
        pooled = {k: tuple(np.concatenate([t[i] for t in v]) if v else np.array([]) for i in range(3)) for k, v in pools.items()}
        sessions = [r["session"] for r in rows]
        latest = max(sessions) if sessions else None
        rows = [r for r in rows if r["session"] == latest]    # a stale symbol (suspended, no bars today) is not "today"
        base_rate = {"threshold": HIST_THRESHOLD, **_summary(*pooled["_run"], sgn=sgn), "fade": _summary(*pooled["_fade"], sgn=sgn),
                     "uncond_reversal_share": round(b_lower / b_total, 3) if b_total else None,
                     "fade_rule": f"after reaching {HIST_THRESHOLD}+, at least {int(FADE_GIVEBACK * 100)}% of the "
                                  + ("fall from the open recovered" if side == "down" else "run from the open given back")}
        rows.sort(key=lambda x: (-x["peak_today"], -sgn * (x["chg_open"] or 0)))
        counts = {name: sum(1 for r in rows if tier(r["peak_today"]) == name) for _, name in TIERS}
        counts["fading"] = sum(1 for r in rows if r["phase"] == "fading")
        counts["running"] = sum(1 for r in rows if r["phase"] == "running")
        result = {"universe": universe, "name": base["name"], "scanned": len(symbols), "session": latest, "rows": rows,
                  "counts": counts, "tiers": [{"min": lo, "name": name} for lo, name in TIERS], "base_rate": base_rate,
                  "missing": missing, "generated_at": datetime.now(timezone.utc).isoformat(), "took_s": round(time.time() - t0, 1),
                  "rules": [{"key": k, **v} for k, v in (RULES_DOWN if side == "down" else RULES).items()], "mode": "intraday", "side": side}
        _CACHE[key] = (now, result)
    result["meta_pending"] = screener._ensure_meta([r["symbol"] for r in result["rows"]])
    result["rows"] = [r for r in screener._decorate(result["rows"]) if r["peak_today"] >= min_score]
    result["count"] = len(result["rows"])
    return result
