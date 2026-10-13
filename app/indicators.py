"""Technical indicators implemented with pandas/numpy.

Every function takes an OHLCV DataFrame (columns open, high, low, close, volume)
and returns a Series or DataFrame aligned to its index. `compute_all` attaches
the standard indicator set used by the strategies.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


# ---------------------------------------------------------------- moving averages
def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def wma(s: pd.Series, n: int) -> pd.Series:
    w = np.arange(1, n + 1, dtype=float)
    return s.rolling(n).apply(lambda x: float(np.dot(x, w) / w.sum()), raw=True)


def hma(s: pd.Series, n: int) -> pd.Series:
    """Hull Moving Average (Alan Hull, 2005)."""
    half = wma(s, max(2, n // 2))
    full = wma(s, n)
    return wma(2 * half - full, max(2, int(np.sqrt(n))))


def rma(s: pd.Series, n: int) -> pd.Series:
    """Wilder's smoothing (used by RSI, ATR, ADX)."""
    return s.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()


# ---------------------------------------------------------------- momentum
def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    """Relative Strength Index (J. Welles Wilder, 1978)."""
    delta = close.diff()
    up = delta.clip(lower=0)
    down = -delta.clip(upper=0)
    rs = rma(up, n) / rma(down, n).replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50)


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.DataFrame:
    """MACD (Gerald Appel, 1979)."""
    line = ema(close, fast) - ema(close, slow)
    sig = ema(line, signal)
    return pd.DataFrame({"macd": line, "macd_signal": sig, "macd_hist": line - sig})


def stochastic(df: pd.DataFrame, k: int = 14, d: int = 3, smooth: int = 3) -> pd.DataFrame:
    """Stochastic oscillator (George Lane, 1950s)."""
    low_k = df["low"].rolling(k).min()
    high_k = df["high"].rolling(k).max()
    raw = 100 * (df["close"] - low_k) / (high_k - low_k).replace(0, np.nan)
    k_s = raw.rolling(smooth).mean()
    return pd.DataFrame({"stoch_k": k_s, "stoch_d": k_s.rolling(d).mean()})


def williams_r(df: pd.DataFrame, n: int = 14) -> pd.Series:
    """Williams %R (Larry Williams)."""
    hh = df["high"].rolling(n).max()
    ll = df["low"].rolling(n).min()
    return -100 * (hh - df["close"]) / (hh - ll).replace(0, np.nan)


def cci(df: pd.DataFrame, n: int = 20) -> pd.Series:
    """Commodity Channel Index (Donald Lambert, 1980)."""
    tp = (df["high"] + df["low"] + df["close"]) / 3
    ma = tp.rolling(n).mean()
    md = (tp - ma).abs().rolling(n).mean()
    return (tp - ma) / (0.015 * md.replace(0, np.nan))


def roc(close: pd.Series, n: int = 10) -> pd.Series:
    return 100 * (close / close.shift(n) - 1)


def mfi(df: pd.DataFrame, n: int = 14) -> pd.Series:
    """Money Flow Index (Gene Quong & Avrum Soudack)."""
    tp = (df["high"] + df["low"] + df["close"]) / 3
    flow = tp * df["volume"]
    pos = flow.where(tp > tp.shift(1), 0.0)
    neg = flow.where(tp < tp.shift(1), 0.0)
    ratio = pos.rolling(n).sum() / neg.rolling(n).sum().replace(0, np.nan)
    return (100 - 100 / (1 + ratio)).fillna(50)


# ---------------------------------------------------------------- volatility
def true_range(df: pd.DataFrame) -> pd.Series:
    prev = df["close"].shift(1)
    return pd.concat([df["high"] - df["low"], (df["high"] - prev).abs(), (df["low"] - prev).abs()], axis=1).max(axis=1)


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    """Average True Range (Wilder)."""
    return rma(true_range(df), n)


def bollinger(close: pd.Series, n: int = 20, k: float = 2.0) -> pd.DataFrame:
    """Bollinger Bands (John Bollinger, 1980s)."""
    mid = sma(close, n)
    sd = close.rolling(n).std(ddof=0)
    upper, lower = mid + k * sd, mid - k * sd
    return pd.DataFrame({
        "bb_upper": upper, "bb_mid": mid, "bb_lower": lower,
        "bb_width": (upper - lower) / mid.replace(0, np.nan),
        "bb_pct": (close - lower) / (upper - lower).replace(0, np.nan),
    })


def keltner(df: pd.DataFrame, n: int = 20, mult: float = 1.5) -> pd.DataFrame:
    """Keltner Channels (Chester Keltner; Linda Raschke's EMA/ATR variant)."""
    mid = ema(df["close"], n)
    rng = atr(df, n) * mult
    return pd.DataFrame({"kc_upper": mid + rng, "kc_mid": mid, "kc_lower": mid - rng})


def donchian(df: pd.DataFrame, n: int = 20) -> pd.DataFrame:
    """Donchian Channel (Richard Donchian) - basis of the Turtle system."""
    upper = df["high"].rolling(n).max()
    lower = df["low"].rolling(n).min()
    return pd.DataFrame({"dc_upper": upper, "dc_lower": lower, "dc_mid": (upper + lower) / 2})


# ---------------------------------------------------------------- trend
def adx(df: pd.DataFrame, n: int = 14) -> pd.DataFrame:
    """Average Directional Index with +DI / -DI (Wilder)."""
    up = df["high"].diff()
    down = -df["low"].diff()
    plus_dm = up.where((up > down) & (up > 0), 0.0)
    minus_dm = down.where((down > up) & (down > 0), 0.0)
    tr = rma(true_range(df), n)
    plus_di = 100 * rma(plus_dm, n) / tr.replace(0, np.nan)
    minus_di = 100 * rma(minus_dm, n) / tr.replace(0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return pd.DataFrame({"adx": rma(dx, n), "plus_di": plus_di, "minus_di": minus_di})


def supertrend(df: pd.DataFrame, n: int = 10, mult: float = 3.0) -> pd.DataFrame:
    """Supertrend (Olivier Seban)."""
    hl2 = (df["high"] + df["low"]) / 2
    a = atr(df, n)
    a_np = a.to_numpy()
    upper = (hl2 + mult * a).to_numpy()
    lower = (hl2 - mult * a).to_numpy()
    close = df["close"].to_numpy()
    n_rows = len(df)
    st = np.full(n_rows, np.nan)
    direction = np.zeros(n_rows)
    fu, fl = upper.copy(), lower.copy()
    for i in range(1, n_rows):
        if np.isnan(a_np[i]) or np.isnan(a_np[i - 1]):
            continue
        fl[i] = lower[i] if (lower[i] > fl[i - 1] or close[i - 1] < fl[i - 1]) else fl[i - 1]
        fu[i] = upper[i] if (upper[i] < fu[i - 1] or close[i - 1] > fu[i - 1]) else fu[i - 1]
        prev_dir = direction[i - 1] if direction[i - 1] != 0 else 1
        if prev_dir == 1:
            direction[i] = -1 if close[i] < fl[i] else 1
        else:
            direction[i] = 1 if close[i] > fu[i] else -1
        st[i] = fl[i] if direction[i] == 1 else fu[i]
    return pd.DataFrame({"supertrend": st, "supertrend_dir": direction}, index=df.index)


def parabolic_sar(df: pd.DataFrame, af0: float = 0.02, af_step: float = 0.02, af_max: float = 0.2) -> pd.DataFrame:
    """Parabolic SAR (Wilder)."""
    high, low = df["high"].to_numpy(), df["low"].to_numpy()
    n = len(df)
    sar = np.full(n, np.nan)
    trend = np.zeros(n)
    if n < 3:
        return pd.DataFrame({"psar": sar, "psar_dir": trend}, index=df.index)
    up = high[1] > high[0]
    ep = high[0] if up else low[0]
    af = af0
    sar[0] = low[0] if up else high[0]
    for i in range(1, n):
        prev = sar[i - 1]
        cur = prev + af * (ep - prev)
        if up:
            cur = min(cur, low[i - 1], low[i - 2] if i >= 2 else low[i - 1])
            if low[i] < cur:
                up, cur, ep, af = False, ep, low[i], af0
            elif high[i] > ep:
                ep, af = high[i], min(af + af_step, af_max)
        else:
            cur = max(cur, high[i - 1], high[i - 2] if i >= 2 else high[i - 1])
            if high[i] > cur:
                up, cur, ep, af = True, ep, high[i], af0
            elif low[i] < ep:
                ep, af = low[i], min(af + af_step, af_max)
        sar[i] = cur
        trend[i] = 1 if up else -1
    return pd.DataFrame({"psar": sar, "psar_dir": trend}, index=df.index)


def ichimoku(df: pd.DataFrame, tenkan: int = 9, kijun: int = 26, senkou: int = 52) -> pd.DataFrame:
    """Ichimoku Kinko Hyo (Goichi Hosoda, 1960s). Cloud is shifted forward by kijun."""
    def mid(n):
        return (df["high"].rolling(n).max() + df["low"].rolling(n).min()) / 2
    t, k = mid(tenkan), mid(kijun)
    span_a = ((t + k) / 2).shift(kijun)
    span_b = mid(senkou).shift(kijun)
    return pd.DataFrame({"tenkan": t, "kijun": k, "senkou_a": span_a, "senkou_b": span_b,
                         "chikou": df["close"].shift(-kijun)})


# ---------------------------------------------------------------- volume
def obv(df: pd.DataFrame) -> pd.Series:
    """On-Balance Volume (Joseph Granville, 1963)."""
    sign = np.sign(df["close"].diff()).fillna(0)
    return (sign * df["volume"]).cumsum()


def vwap(df: pd.DataFrame, n: int | None = None) -> pd.Series:
    """Volume Weighted Average Price. Rolling window if n given, else anchored per session."""
    tp = (df["high"] + df["low"] + df["close"]) / 3
    pv = tp * df["volume"]
    if n:
        return pv.rolling(n).sum() / df["volume"].rolling(n).sum().replace(0, np.nan)
    day = df.index.normalize()
    return pv.groupby(day).cumsum() / df["volume"].groupby(day).cumsum().replace(0, np.nan)


def chaikin_money_flow(df: pd.DataFrame, n: int = 20) -> pd.Series:
    """Chaikin Money Flow (Marc Chaikin)."""
    rng = (df["high"] - df["low"]).replace(0, np.nan)
    mfv = (((df["close"] - df["low"]) - (df["high"] - df["close"])) / rng * df["volume"]).fillna(0.0)
    return mfv.rolling(n).sum() / df["volume"].rolling(n).sum().replace(0, np.nan)


# ---------------------------------------------------------------- price structure
def heikin_ashi(df: pd.DataFrame) -> pd.DataFrame:
    ha_close = (df["open"] + df["high"] + df["low"] + df["close"]) / 4
    o = df["open"].to_numpy()
    c = ha_close.to_numpy()
    ho = np.empty(len(df))
    ho[0] = (o[0] + df["close"].iloc[0]) / 2
    for i in range(1, len(df)):
        ho[i] = (ho[i - 1] + c[i - 1]) / 2
    ha_open = pd.Series(ho, index=df.index)
    return pd.DataFrame({"ha_open": ha_open, "ha_close": ha_close,
                         "ha_high": pd.concat([df["high"], ha_open, ha_close], axis=1).max(axis=1),
                         "ha_low": pd.concat([df["low"], ha_open, ha_close], axis=1).min(axis=1)})


def is_intraday_index(index: pd.DatetimeIndex) -> bool:
    """True when bars are shorter than a day (median spacing of the last few bars)."""
    if len(index) < 3:
        return False
    d = np.diff(np.asarray(index[-10:]).astype("datetime64[s]")).astype(float)
    return bool(np.median(d) < 86400)


def session_reference(df: pd.DataFrame, intraday: bool) -> pd.Series | None:
    """The bar whose open/high/low/close anchors floor pivots, CPR and Camarilla levels: for intraday
    data the whole previous session (the previous calendar day's bars aggregated), otherwise the
    previous bar.  Named by the session date."""
    if len(df) < 2:
        return None
    if not intraday:
        return df.iloc[-2]
    day = df.index.normalize()
    days = day.unique()
    if len(days) < 2:
        return None
    prev = df[day == days[-2]]
    return pd.Series({"open": float(prev["open"].iloc[0]), "high": float(prev["high"].max()), "low": float(prev["low"].min()),
                      "close": float(prev["close"].iloc[-1]), "volume": float(prev["volume"].sum())}, name=days[-2])


def pivot_points(df: pd.DataFrame, intraday: bool = False) -> dict:
    """Classic floor-trader pivots from the previous session (intraday) or the previous bar (daily+)."""
    prev = session_reference(df, intraday)
    if prev is None:
        prev = df.iloc[-1]
    h, l, c = float(prev["high"]), float(prev["low"]), float(prev["close"])
    p = (h + l + c) / 3
    r1, s1 = 2 * p - l, 2 * p - h
    r2, s2 = p + (h - l), p - (h - l)
    r3, s3 = h + 2 * (p - l), l - 2 * (h - p)
    return {"pivot": p, "r1": r1, "r2": r2, "r3": r3, "s1": s1, "s2": s2, "s3": s3,
            "ref_high": h, "ref_low": l, "ref_close": c, "ref_time": str(getattr(prev, "name", ""))[:19]}


def cpr_levels(df: pd.DataFrame, intraday: bool = False) -> dict:
    """Central Pivot Range (Frank Ochoa): pivot, bottom central (BC) and top central (TC) from the reference session."""
    prev = session_reference(df, intraday)
    if prev is None:
        prev = df.iloc[-1]
    h, l, c = float(prev["high"]), float(prev["low"]), float(prev["close"])
    p = (h + l + c) / 3
    bc = (h + l) / 2
    tc = 2 * p - bc
    top, bottom = max(tc, bc), min(tc, bc)
    rng = h - l
    return {"pivot": p, "tc": top, "bc": bottom, "width": top - bottom, "width_pct": (top - bottom) / p * 100 if p else 0.0,
            "narrow": bool(rng > 0 and (top - bottom) < rng / 12), "ref_range": rng}


def camarilla_levels(df: pd.DataFrame, intraday: bool = False) -> dict:
    """Camarilla pivots (Nick Scott, 1989): H1-H4 / L1-L4 from the reference session's range and close."""
    prev = session_reference(df, intraday)
    if prev is None:
        prev = df.iloc[-1]
    h, l, c = float(prev["high"]), float(prev["low"]), float(prev["close"])
    rng = h - l
    out = {"ref_close": c}
    for i, k in ((1, 12), (2, 6), (3, 4), (4, 2)):
        out[f"h{i}"] = c + rng * 1.1 / k
        out[f"l{i}"] = c - rng * 1.1 / k
    return out


def vwap_bands(df: pd.DataFrame, intraday: bool = False, window: int = 20) -> dict:
    """Session VWAP (intraday) or rolling-window VWAP with volume-weighted standard-deviation bands."""
    seg = df[df.index.normalize() == df.index[-1].normalize()] if intraday else df.tail(window)
    tp = (seg["high"] + seg["low"] + seg["close"]) / 3
    v = seg["volume"].fillna(0)
    tv = float(v.sum())
    if tv <= 0 or len(seg) < 2:
        return {}
    vwap = float((tp * v).sum() / tv)
    sd = float(np.sqrt(((tp - vwap) ** 2 * v).sum() / tv))
    return {"vwap": vwap, "sd": sd, "upper1": vwap + sd, "lower1": vwap - sd, "upper2": vwap + 2 * sd, "lower2": vwap - 2 * sd, "bars": int(len(seg))}


def market_profile(df: pd.DataFrame, intraday: bool = False, window: int = 20, bins: int = 24) -> dict:
    """Volume-at-price profile of the previous session (intraday) or the last `window` bars (daily+):
    point of control (POC) and the 70% value area (VAH / VAL), after Steidlmayer's Market Profile."""
    if intraday:
        day = df.index.normalize()
        days = day.unique()
        seg = df[day == days[-2]] if len(days) >= 2 else df[day == days[-1]]
    else:
        seg = df.iloc[-window - 1:-1] if len(df) > window else df
    v_all = seg["volume"].fillna(0)
    lo, hi = float(seg["low"].min()), float(seg["high"].max())
    if hi <= lo or float(v_all.sum()) <= 0 or len(seg) < 2:
        return {}
    edges = np.linspace(lo, hi, bins + 1)
    vol = np.zeros(bins)
    for bh, bl, bv in zip(seg["high"].to_numpy(), seg["low"].to_numpy(), v_all.to_numpy()):
        if bv <= 0:
            continue
        a = int(np.clip(np.searchsorted(edges, bl, side="right") - 1, 0, bins - 1))
        b = int(np.clip(np.searchsorted(edges, bh, side="left") - 1, a, bins - 1))
        vol[a:b + 1] += bv / (b - a + 1)
    poc = int(np.argmax(vol))
    total = float(vol.sum())
    area, lo_i, hi_i = float(vol[poc]), poc, poc
    while area < 0.7 * total and (lo_i > 0 or hi_i < bins - 1):
        up = vol[hi_i + 1] if hi_i < bins - 1 else -1.0
        dn = vol[lo_i - 1] if lo_i > 0 else -1.0
        if up >= dn:
            hi_i += 1; area += up
        else:
            lo_i -= 1; area += dn
    mid = (edges[:-1] + edges[1:]) / 2
    return {"poc": float(mid[poc]), "vah": float(edges[hi_i + 1]), "val": float(edges[lo_i]), "high": hi, "low": lo, "bars": int(len(seg))}


def alligator(df: pd.DataFrame) -> pd.DataFrame:
    """Bill Williams' Alligator: smoothed MAs of the median price, jaw 13 shifted 8, teeth 8 shifted 5, lips 5 shifted 3."""
    mp = (df["high"] + df["low"]) / 2
    return pd.DataFrame({"jaw": rma(mp, 13).shift(8), "teeth": rma(mp, 8).shift(5), "lips": rma(mp, 5).shift(3)})


def swing_points(df: pd.DataFrame, lookback: int = 5) -> tuple[pd.Series, pd.Series]:
    """Boolean series of swing highs / lows (fractal style, `lookback` bars either side)."""
    h, l = df["high"], df["low"]
    sh = (h == h.rolling(2 * lookback + 1, center=True).max())
    sl = (l == l.rolling(2 * lookback + 1, center=True).min())
    return sh.fillna(False), sl.fillna(False)


def fibonacci_levels(df: pd.DataFrame, n: int = 100) -> dict:
    """Fibonacci retracement levels of the last `n`-bar swing."""
    w = df.tail(n)
    hi, lo = float(w["high"].max()), float(w["low"].min())
    hi_i, lo_i = w["high"].idxmax(), w["low"].idxmin()
    up_swing = bool(lo_i < hi_i)
    diff = hi - lo
    ratios = [0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0]
    if up_swing:
        levels = {f"{r:.3f}": hi - diff * r for r in ratios}
    else:
        levels = {f"{r:.3f}": lo + diff * r for r in ratios}
    return {"high": hi, "low": lo, "up_swing": up_swing, "levels": levels}


def hurst_exponent(close: pd.Series, max_lag: int = 40) -> float:
    """Hurst exponent. >0.5 trending (persistent), <0.5 mean reverting, ~0.5 random walk."""
    s = close.dropna().to_numpy()
    if len(s) < max_lag * 2:
        return 0.5
    lags = list(range(2, max_lag))
    tau = np.array([np.sqrt(np.std(s[lag:] - s[:-lag])) for lag in lags])
    if np.any(tau <= 0):
        return 0.5
    poly = np.polyfit(np.log(lags), np.log(tau), 1)
    return float(np.clip(poly[0] * 2.0, 0.0, 1.0))


# ---------------------------------------------------------------- bundle
def compute_all(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    c = out["close"]
    for n in (10, 20, 50, 100, 200):
        out[f"sma_{n}"] = sma(c, n)
    for n in (9, 12, 13, 21, 26, 50, 200):
        out[f"ema_{n}"] = ema(c, n)
    out["hma_20"] = hma(c, 20)
    out["rsi_14"] = rsi(c, 14)
    out["rsi_2"] = rsi(c, 2)
    out = out.join(macd(c))
    out = out.join(stochastic(out))
    out["williams_r"] = williams_r(out)
    out["cci_20"] = cci(out)
    out["roc_10"] = roc(c, 10)
    out["roc_60"] = roc(c, 60)
    out["mfi_14"] = mfi(out)
    out["atr_14"] = atr(out)
    out["atr_22"] = atr(out, 22)
    out = out.join(bollinger(c))
    out = out.join(keltner(out))
    out = out.join(donchian(out, 20).rename(columns={"dc_upper": "dc20_upper", "dc_lower": "dc20_lower", "dc_mid": "dc20_mid"}))
    out = out.join(donchian(out, 55).rename(columns={"dc_upper": "dc55_upper", "dc_lower": "dc55_lower", "dc_mid": "dc55_mid"}))
    out = out.join(adx(out))
    out = out.join(supertrend(out))
    out = out.join(parabolic_sar(out))
    out = out.join(ichimoku(out))
    out["obv"] = obv(out)
    out["obv_ema"] = ema(out["obv"], 20)
    out["vwap_20"] = vwap(out, 20)
    out["cmf_20"] = chaikin_money_flow(out)
    out = out.join(heikin_ashi(out))
    out["vol_sma_20"] = sma(out["volume"], 20)
    out["ret_1"] = c.pct_change()
    out["volatility_20"] = out["ret_1"].rolling(20).std() * np.sqrt(252)
    return out
