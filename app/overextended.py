"""Overextended screener: stocks that have run too far, too fast, and are statistically due for a
pullback.

The score (0-100) adds up published overbought / exhaustion rules, each computed on daily bars and
scaled from "just triggered" (0) to "extreme" (1) times its weight:

  RSI-14 above 70 ............ J. Welles Wilder, "New Concepts in Technical Trading Systems" (1978)
  RSI-2 above 90 ............. Larry Connors & Cesar Alvarez, "Short Term Trading Strategies That Work" (2009)
  Close above the upper Bollinger Band (%B > 1) ... John Bollinger, "Bollinger on Bollinger Bands" (2001)
  Stretch above the 20- and 50-day SMA in ATR units ... distance from the mean in volatility units
                               (Linda Raschke & Larry Connors, "Street Smarts", 1995)
  Consecutive up closes ...... Connors & Alvarez (2009): runs of up days mean-revert
  20-day rate of change vs its own volatility ... Martin Pring, "Technical Analysis Explained": ROC extremes
  Buying climax .............. Richard Wyckoff (1930s); Stan Weinstein, "Secrets for Profiting in Bull and
                               Bear Markets" (1988): volume >= 2x average on an up day at a new high
  Bearish reversal candle at the highs ... Steve Nison, "Japanese Candlestick Charting Techniques" (1991):
                               shooting star, bearish engulfing, dark cloud cover, gravestone doji
  Bearish RSI divergence ..... Wilder (1978) / Andrew Cardwell: a new 20-day high with RSI-14 below its peak

Being stretched is a SHORT-TERM statement (days), not a trend call: the momentum literature (Jegadeesh &
Titman 1993; George & Hwang 2004) finds that strong stocks keep going for months, while Connors and
Bollinger find that the sessions right after an extreme tend to give some of it back.  So the module
also measures, for every stock, what actually happened the previous times its own score crossed the
"extended" line: how often it was lower five sessions later, by how much, and the typical dip within
ten sessions - and the same pooled over the whole universe as a base rate.
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

log = logging.getLogger("tradebot.overextended")

CACHE_TTL = 120
_CACHE: dict[tuple, tuple[float, dict]] = {}
HIST_THRESHOLD = 35          # an "episode" starts when the score crosses this line (the "extended" tier)
FWD_BARS, DIP_BARS = 5, 10   # sessions ahead for the return check / the deepest dip
# tiers set from the NIFTY 100 distribution (2 years of daily bars): 20+ on about 6% of bars, 35+ on 2%, 50+ on 0.6%
TIERS = ((50, "stretched"), (35, "extended"), (20, "warming"))
MIN_SCORE = 20               # rows below this are not returned

RULES = {
    "rsi14": dict(label="RSI-14 overbought", weight=12, lo=70, hi=82,
                  origin="J. Welles Wilder, New Concepts in Technical Trading Systems (1978)",
                  rule="RSI-14 above 70; full points at 82"),
    "rsi2": dict(label="RSI-2 extreme", weight=10, lo=90, hi=98,
                 origin="Larry Connors & Cesar Alvarez, Short Term Trading Strategies That Work (2009)",
                 rule="RSI-2 above 90; full points at 98"),
    "bb": dict(label="Above upper Bollinger Band", weight=12, lo=1.0, hi=1.2,
               origin="John Bollinger, Bollinger on Bollinger Bands (2001)",
               rule="%B above 1.0 (close beyond the 20-day, 2-sigma band); full points at 1.2"),
    "sma20": dict(label="Stretched from 20-day SMA", weight=14, lo=1.5, hi=3.5,
                  origin="Linda Raschke & Larry Connors, Street Smarts (1995): distance from the mean in ATR units",
                  rule="Close more than 1.5 ATR above the 20-day SMA; full points at 3.5 ATR"),
    "sma50": dict(label="Stretched from 50-day SMA", weight=8, lo=3, hi=7,
                  origin="Distance from the intermediate mean in ATR units (Raschke & Connors)",
                  rule="Close more than 3 ATR above the 50-day SMA; full points at 7 ATR"),
    "streak": dict(label="Up-day streak", weight=8, lo=3, hi=6,
                   origin="Connors & Alvarez (2009): consecutive up closes mean-revert",
                   rule="4 or more consecutive up closes; full points at 6"),
    "roc": dict(label="Parabolic 20-day run", weight=10, lo=1.5, hi=2.5,
                origin="Martin Pring, Technical Analysis Explained: rate-of-change extremes",
                rule="20-day return above 1.5x the stock's own 20-day volatility; full points at 2.5x"),
    "climax": dict(label="Buying-climax volume", weight=8, lo=1.5, hi=3.5,
                   origin="Richard Wyckoff (1930s); Stan Weinstein, Secrets for Profiting in Bull and Bear Markets (1988)",
                   rule="Volume at least 2x the 20-day average on an up day that made a 20-day high; full points at 3.5x"),
    "candle": dict(label="Bearish reversal candle at the highs", weight=10,
                   origin="Steve Nison, Japanese Candlestick Charting Techniques (1991)",
                   rule="Shooting star, bearish engulfing, dark cloud cover or gravestone doji within a bar of a 20-day high"),
    "divergence": dict(label="Bearish RSI divergence", weight=8,
                       origin="Wilder (1978); Andrew Cardwell's RSI divergence work",
                       rule="New 20-day closing high while RSI-14 sits 5+ points below its own 20-day peak"),
}
assert sum(r["weight"] for r in RULES.values()) == 100


def _ramp(x: pd.Series, lo: float, hi: float) -> pd.Series:
    return ((x - lo) / (hi - lo)).clip(lower=0.0, upper=1.0).fillna(0.0)


def components(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, pd.DataFrame]:
    """Every rule as a 0..1 series over the whole frame, the total score, and the raw readings."""
    c, h, l, o = df["close"], df["high"], df["low"], df["open"]
    v = df["volume"].fillna(0.0)
    rsi14, rsi2 = ind.rsi(c, 14), ind.rsi(c, 2)
    bb = ind.bollinger(c, 20, 2.0)
    atr = ind.atr(df, 14).replace(0, np.nan)
    sma20, sma50 = c.rolling(20).mean(), c.rolling(50).mean()
    st20, st50 = (c - sma20) / atr, (c - sma50) / atr
    up = c.diff() > 0
    streak = up.astype(int).groupby((~up).cumsum()).cumsum()
    ret = c.pct_change()
    roc20 = c.pct_change(20)
    z20 = roc20 / (ret.rolling(20).std() * np.sqrt(20)).replace(0, np.nan)
    vratio = v / v.rolling(20).mean().shift(1).replace(0, np.nan)
    hi20_prev = h.rolling(20).max().shift(1)
    climax_ctx = (vratio >= 2) & (c > o) & (h >= hi20_prev)
    body = c - o
    rng = (h - l).replace(0, np.nan)
    upper = h - np.maximum(o, c)
    lower = np.minimum(o, c) - l
    shooting = (body.abs() <= 0.35 * rng) & (upper >= 2 * body.abs()) & (lower <= 0.15 * rng)
    engulf = (body.shift(1) > 0) & (body < 0) & (c < o.shift(1)) & (o > c.shift(1))
    dark = (body.shift(1) > 0) & (body < 0) & (o > h.shift(1)) & (c < (o.shift(1) + c.shift(1)) / 2)
    gravestone = (body.abs() <= 0.08 * rng) & (upper >= 0.6 * rng)
    near_high = h.rolling(2).max() >= h.rolling(20).max().shift(2)
    candle = near_high & (shooting | engulf | dark | gravestone)
    pattern = np.select([engulf, dark, shooting, gravestone],
                        ["Bearish engulfing", "Dark cloud cover", "Shooting star", "Gravestone doji"], "")
    new_high = c >= c.rolling(20).max()
    rsi_peak = rsi14.rolling(20).max()
    diverg = new_high & (rsi14 <= rsi_peak - 5) & (rsi14 > 55)
    R = lambda key, x: _ramp(x, RULES[key]["lo"], RULES[key]["hi"])
    parts = pd.DataFrame({
        "rsi14": R("rsi14", rsi14), "rsi2": R("rsi2", rsi2), "bb": R("bb", bb["bb_pct"]),
        "sma20": R("sma20", st20), "sma50": R("sma50", st50), "streak": R("streak", streak.astype(float)),
        "roc": R("roc", z20), "climax": R("climax", vratio).where(climax_ctx, 0.0),
        "candle": candle.astype(float), "divergence": diverg.astype(float),
    }, index=df.index)
    score = sum(parts[k] * RULES[k]["weight"] for k in RULES)
    raw = pd.DataFrame({"rsi14": rsi14, "rsi2": rsi2, "bb_pct": bb["bb_pct"], "st20": st20, "st50": st50,
                        "streak": streak, "roc20": roc20 * 100, "z20": z20, "vratio": vratio, "atr": atr,
                        "sma20": sma20, "sma50": sma50, "rsi_peak": rsi_peak, "pattern": pattern}, index=df.index)
    return parts, score, raw


def score_series(df: pd.DataFrame) -> pd.Series:
    """The 0-100 overextension score for every bar (used by the market map)."""
    return components(df)[1]


def tier(score: float) -> str | None:
    for lo, name in TIERS:
        if score >= lo:
            return name
    return None


def episodes(score: pd.Series, close: pd.Series, low: pd.Series, threshold: float = HIST_THRESHOLD) -> dict:
    """What happened after the previous times the score crossed `threshold`: share of episodes that were
    lower FWD_BARS sessions later, the average forward return, and the median deepest dip within DIP_BARS."""
    on = (score >= threshold).to_numpy()
    start = on & ~np.concatenate([[False], on[:-1]])
    idx = np.flatnonzero(start)
    usable = idx[idx < len(close) - FWD_BARS]
    cl, lo = close.to_numpy(dtype=float), low.to_numpy(dtype=float)
    on_for = 0
    for flag in on[::-1]:
        if not flag:
            break
        on_for += 1
    # unconditional base rate on the same stock: how often ANY bar closed lower FWD_BARS sessions later
    fwd_all = cl[FWD_BARS:] / cl[:-FWD_BARS] - 1 if len(cl) > FWD_BARS else np.array([])
    out = {"threshold": threshold, "fwd_bars": FWD_BARS, "dip_bars": DIP_BARS, "episodes": int(len(usable)), "on_for": on_for,
           "lower_share": None, "avg_fwd_pct": None, "median_dip_pct": None, "worst_fwd_pct": None, "best_fwd_pct": None,
           "uncond_lower_share": round(float((fwd_all < 0).mean()), 3) if len(fwd_all) else None,
           "uncond_avg_fwd_pct": round(float(fwd_all.mean() * 100), 2) if len(fwd_all) else None,
           "_uncond": (int((fwd_all < 0).sum()), int(len(fwd_all)), float(fwd_all.sum()))}
    if not len(usable):
        return out
    fwd = cl[usable + FWD_BARS] / cl[usable] - 1
    dips = np.array([np.nanmin(lo[i + 1:i + 1 + DIP_BARS]) / cl[i] - 1 for i in usable])
    out.update({"lower_share": round(float((fwd < 0).mean()), 3), "avg_fwd_pct": round(float(fwd.mean() * 100), 2),
                "median_dip_pct": round(float(np.median(dips) * 100), 2), "worst_fwd_pct": round(float(fwd.min() * 100), 2),
                "best_fwd_pct": round(float(fwd.max() * 100), 2), "_fwd": fwd, "_dips": dips})
    return out


def _value_text(key: str, r: pd.Series) -> str:
    if key == "rsi14":
        return f"RSI-14 {r['rsi14']:.0f}"
    if key == "rsi2":
        return f"RSI-2 {r['rsi2']:.0f}"
    if key == "bb":
        return f"%B {r['bb_pct']:.2f}"
    if key == "sma20":
        return f"{r['st20']:.1f} ATR above the 20-day SMA"
    if key == "sma50":
        return f"{r['st50']:.1f} ATR above the 50-day SMA"
    if key == "streak":
        return f"{int(r['streak'])} up closes in a row"
    if key == "roc":
        return f"20-day {r['roc20']:+.1f}% = {r['z20']:.1f}x its volatility"
    if key == "climax":
        return f"volume {r['vratio']:.1f}x the 20-day average at a 20-day high"
    if key == "candle":
        return str(r["pattern"]) or "reversal candle"
    if key == "divergence":
        return f"new 20-day high with RSI-14 {r['rsi14']:.0f} vs peak {r['rsi_peak']:.0f}"
    return ""


def _num(x, d: int = 2):
    try:
        return None if x is None or pd.isna(x) else round(float(x), d)
    except (TypeError, ValueError):
        return None


def row(sym: str, df: pd.DataFrame) -> dict:
    parts, score, raw = components(df)
    s = float(score.iloc[-1])
    r = raw.iloc[-1]
    c = df["close"]
    last = float(c.iloc[-1])
    fired = []
    for k, meta in RULES.items():
        p = float(parts[k].iloc[-1])
        if p > 0:
            fired.append({"key": k, "label": meta["label"], "origin": meta["origin"], "rule": meta["rule"],
                          "points": round(p * meta["weight"], 1), "max_points": meta["weight"], "value": _value_text(k, r)})
    fired.sort(key=lambda x: -x["points"])
    hist = episodes(score, c, df["low"])
    n = len(df)

    def chg(k):
        return _num((last / float(c.iloc[-1 - k]) - 1) * 100) if n > k else None

    spark = c.tail(60)
    spark_sma = raw["sma20"].tail(60)
    hi52 = float(df["high"].tail(252).max())
    return {
        "symbol": sym, "name": sym.replace(".NS", "").replace(".BO", ""), "price": round(last, 2),
        "chg_1d": chg(1), "chg_5d": chg(5), "chg_20d": chg(20),
        "score": int(round(s)), "tier": tier(s), "rules": fired,
        "rsi14": _num(r["rsi14"], 1), "rsi2": _num(r["rsi2"], 1), "bb_pct": _num(r["bb_pct"]), "stretch20": _num(r["st20"], 1),
        "stretch50": _num(r["st50"], 1), "streak": int(r["streak"]) if pd.notna(r["streak"]) else 0, "z20": _num(r["z20"], 1),
        "vol_ratio": _num(r["vratio"]), "atr_pct": _num(r["atr"] / last * 100), "sma20": _num(r["sma20"]),
        "to_sma20_pct": _num((r["sma20"] / last - 1) * 100), "dist_52w_high": _num((last / hi52 - 1) * 100),
        "history": {k: v for k, v in hist.items() if not k.startswith("_")},
        "spark": [round(float(x), 2) for x in spark], "spark_sma": [None if pd.isna(x) else round(float(x), 2) for x in spark_sma],
        "bar_time": df.index[-1].isoformat(), "_hist": hist,
    }


def scan(universe: str = "nifty100", extra: list[str] | None = None, min_score: int = MIN_SCORE) -> dict:
    from . import screener   # shares the batch downloader and the sector / market-cap cache
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
    key = (universe, tuple(sorted(extra_syms)))
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < CACHE_TTL:
        result = dict(hit[1])
    else:
        t0 = time.time()
        frames = screener._batch(symbols, "2y")
        via: dict[str, str] = {}
        short = [s for s in symbols if s.endswith(".BO") and (s not in frames or len(frames[s]) < 60)]
        if short:
            alt = screener._batch([s[:-3] + ".NS" for s in short], "2y")
            for s in short:
                ns = s[:-3] + ".NS"
                if ns in alt:
                    frames[s] = alt[ns]
                    via[s] = ns
        rows, missing = [], []
        fwd_all, dip_all = [], []
        u_lower = u_total = 0
        u_sum = 0.0
        for s in symbols:
            df = frames.get(s)
            if df is None or len(df) < 60:
                missing.append(s)
                continue
            try:
                m = row(s, df)
            except Exception as exc:  # one bad symbol must not kill the scan
                missing.append(f"{s}: {exc}")
                continue
            h = m.pop("_hist")
            ul, ut, us = h.get("_uncond", (0, 0, 0.0))
            u_lower += ul
            u_total += ut
            u_sum += us
            if "_fwd" in h:
                fwd_all.append(h["_fwd"])
                dip_all.append(h["_dips"])
            m["via"] = via.get(s)
            rows.append(m)
        fwd = np.concatenate(fwd_all) if fwd_all else np.array([])
        dips = np.concatenate(dip_all) if dip_all else np.array([])
        base_rate = {"threshold": HIST_THRESHOLD, "fwd_bars": FWD_BARS, "dip_bars": DIP_BARS, "episodes": int(len(fwd)),
                     "lower_share": round(float((fwd < 0).mean()), 3) if len(fwd) else None,
                     "avg_fwd_pct": round(float(fwd.mean() * 100), 2) if len(fwd) else None,
                     "median_dip_pct": round(float(np.median(dips) * 100), 2) if len(dips) else None,
                     "uncond_lower_share": round(u_lower / u_total, 3) if u_total else None,
                     "uncond_avg_fwd_pct": round(u_sum / u_total * 100, 2) if u_total else None,
                     "years": 2}
        rows.sort(key=lambda x: (-x["score"], -(x["chg_20d"] or 0)))
        counts = {name: sum(1 for r in rows if r["tier"] == name) for _, name in TIERS}
        result = {"universe": universe, "name": base["name"], "scanned": len(symbols), "rows": rows, "counts": counts,
                  "tiers": [{"min": lo, "name": name} for lo, name in TIERS],
                  "base_rate": base_rate, "missing": missing, "generated_at": datetime.now(timezone.utc).isoformat(),
                  "took_s": round(time.time() - t0, 1), "rules": [{"key": k, **v} for k, v in RULES.items()]}
        _CACHE[key] = (now, result)
    result["meta_pending"] = screener._ensure_meta([r.get("via") or r["symbol"] for r in result["rows"]])
    result["rows"] = [r for r in screener._decorate(result["rows"]) if r["score"] >= min_score]
    result["count"] = len(result["rows"])
    return result
