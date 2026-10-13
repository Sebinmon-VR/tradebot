"""Real-world trading strategies.

Each strategy is a published / widely-used system, implemented with its standard
parameters. A strategy inspects the indicator-enriched DataFrame and returns a
`Signal` with a direction (+1 up, -1 down, 0 neutral), a confidence in [0, 1],
and a human-readable reason that cites the rule that fired.

Categories: trend, momentum, volatility, volume, price_action, levels

Strategies in NEEDS_INTERVAL also receive the bar length in seconds: on intraday charts their
reference levels (pivots, CPR, Camarilla, value area, gaps, session VWAP) come from the previous
*session*, on daily / weekly charts from the previous bar.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict, field
from typing import Callable

import numpy as np
import pandas as pd

from . import indicators as ind


@dataclass
class Signal:
    key: str
    name: str
    origin: str
    category: str
    direction: int
    confidence: float
    reason: str
    rules: str
    values: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["confidence"] = round(float(np.clip(self.confidence, 0, 1)), 3)
        def clean(v):
            if isinstance(v, (bool, np.bool_)):
                return bool(v)
            if isinstance(v, (int, float, np.integer, np.floating)):
                return round(float(v), 4) if np.isfinite(v) else None
            if isinstance(v, dict):
                return {k: clean(x) for k, x in v.items()}
            if isinstance(v, (list, tuple)):
                return [clean(x) for x in v]
            return v
        d["values"] = clean(self.values)
        return d


def _clip(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    if x is None or not np.isfinite(x):
        return lo
    return float(np.clip(x, lo, hi))


def _last(df: pd.DataFrame, col: str, back: int = 0) -> float:
    v = df[col].iloc[-1 - back]
    return float(v) if pd.notna(v) else float("nan")


def _slope(series: pd.Series, n: int = 5) -> float:
    s = series.dropna().tail(n)
    if len(s) < 3:
        return 0.0
    x = np.arange(len(s))
    return float(np.polyfit(x, s.to_numpy(), 1)[0])


# =============================================================================
#  TREND STRATEGIES
# =============================================================================

def golden_cross(df: pd.DataFrame) -> Signal:
    """SMA50 / SMA200 Golden Cross & Death Cross - the classic long-term trend filter."""
    s50, s200, c = _last(df, "sma_50"), _last(df, "sma_200"), _last(df, "close")
    meta = dict(name="Golden / Death Cross", origin="Classic institutional trend rule (SMA 50/200)",
                category="trend", rules="Bullish when SMA50 > SMA200 and price above both; bearish when SMA50 < SMA200 and price below.")
    if np.isnan(s200):
        return Signal("golden_cross", direction=0, confidence=0, reason="Not enough history for SMA200", **meta)
    spread = (s50 - s200) / s200
    recent_cross = np.sign(df["sma_50"] - df["sma_200"]).diff().tail(10).abs().sum() > 0
    if s50 > s200 and c > s50:
        conf = _clip(0.45 + abs(spread) * 5 + (0.25 if recent_cross else 0))
        return Signal("golden_cross", direction=1, confidence=conf,
                      reason=f"SMA50 above SMA200 by {spread*100:.1f}%; price above SMA50" + (" (fresh golden cross)" if recent_cross else ""),
                      values=dict(sma50=s50, sma200=s200, spread_pct=spread * 100), **meta)
    if s50 < s200 and c < s50:
        conf = _clip(0.45 + abs(spread) * 5 + (0.25 if recent_cross else 0))
        return Signal("golden_cross", direction=-1, confidence=conf,
                      reason=f"SMA50 below SMA200 by {abs(spread)*100:.1f}%; price below SMA50" + (" (fresh death cross)" if recent_cross else ""),
                      values=dict(sma50=s50, sma200=s200, spread_pct=spread * 100), **meta)
    return Signal("golden_cross", direction=0, confidence=0.2, reason="Price and moving averages not aligned",
                  values=dict(sma50=s50, sma200=s200), **meta)


def ema_crossover(df: pd.DataFrame) -> Signal:
    """EMA 9/21 crossover - the standard swing / day-trading fast trend signal."""
    e9, e21 = df["ema_9"], df["ema_21"]
    diff = np.sign(e9 - e21)
    bars_since = int((diff != diff.iloc[-1]).to_numpy()[::-1].argmax()) if (diff != diff.iloc[-1]).any() else len(df)
    c = _last(df, "close")
    gap = (_last(df, "ema_9") - _last(df, "ema_21")) / c
    meta = dict(name="EMA 9/21 Crossover", origin="Common swing-trading fast/slow EMA system",
                category="trend", rules="Long when EMA9 crosses above EMA21; short when it crosses below. Fresher crosses score higher.")
    if np.isnan(gap):
        return Signal("ema_crossover", direction=0, confidence=0, reason="Insufficient data", **meta)
    fresh = max(0.0, 1 - bars_since / 15)
    conf = _clip(0.35 + fresh * 0.4 + abs(gap) * 20)
    d = int(diff.iloc[-1])
    return Signal("ema_crossover", direction=d, confidence=conf,
                  reason=f"EMA9 {'above' if d > 0 else 'below'} EMA21 for {bars_since} bars (gap {gap*100:.2f}%)",
                  values=dict(ema9=_last(df, "ema_9"), ema21=_last(df, "ema_21"), bars_since_cross=bars_since), **meta)


def macd_strategy(df: pd.DataFrame) -> Signal:
    """Gerald Appel's MACD (12,26,9): signal-line cross + zero-line + histogram momentum."""
    m, s, h = _last(df, "macd"), _last(df, "macd_signal"), _last(df, "macd_hist")
    h_prev = _last(df, "macd_hist", 1)
    meta = dict(name="MACD Crossover", origin="Gerald Appel (1979), 12/26/9",
                category="momentum", rules="Bullish: MACD above signal (esp. above zero) with rising histogram. Bearish: the reverse.")
    if np.isnan(h):
        return Signal("macd", direction=0, confidence=0, reason="Insufficient data", **meta)
    cross_series = np.sign(df["macd"] - df["macd_signal"])
    fresh_cross = cross_series.iloc[-1] != cross_series.iloc[-4:-1].mode().iloc[0] if len(df) > 4 else False
    price = _last(df, "close")
    strength = _clip(abs(h) / price * 300)
    if m > s:
        conf = _clip(0.35 + strength + (0.2 if fresh_cross else 0) + (0.1 if m > 0 else 0) + (0.1 if h > h_prev else 0))
        return Signal("macd", direction=1, confidence=conf,
                      reason=f"MACD above signal{' (fresh bullish cross)' if fresh_cross else ''}; {'above' if m > 0 else 'below'} zero line; histogram {'rising' if h > h_prev else 'fading'}",
                      values=dict(macd=m, signal=s, hist=h), **meta)
    conf = _clip(0.35 + strength + (0.2 if fresh_cross else 0) + (0.1 if m < 0 else 0) + (0.1 if h < h_prev else 0))
    return Signal("macd", direction=-1, confidence=conf,
                  reason=f"MACD below signal{' (fresh bearish cross)' if fresh_cross else ''}; {'below' if m < 0 else 'above'} zero line; histogram {'falling' if h < h_prev else 'recovering'}",
                  values=dict(macd=m, signal=s, hist=h), **meta)


def adx_dmi(df: pd.DataFrame) -> Signal:
    """Wilder's ADX / DMI: trade in the direction of DI dominance only when ADX shows a trend (>20-25)."""
    a, p, m = _last(df, "adx"), _last(df, "plus_di"), _last(df, "minus_di")
    meta = dict(name="ADX / DMI Trend", origin="J. Welles Wilder (1978), 14-period",
                category="trend", rules="ADX > 25 = trending. +DI > -DI bullish, -DI > +DI bearish. ADX < 20 = no trend (neutral).")
    if np.isnan(a):
        return Signal("adx_dmi", direction=0, confidence=0, reason="Insufficient data", **meta)
    if a < 20:
        return Signal("adx_dmi", direction=0, confidence=0.4, reason=f"ADX {a:.1f} < 20: range-bound, no trend to follow",
                      values=dict(adx=a, plus_di=p, minus_di=m), **meta)
    d = 1 if p > m else -1
    rising = _slope(df["adx"], 5) > 0
    conf = _clip(0.3 + (a - 20) / 40 + (0.15 if rising else 0) + abs(p - m) / 100)
    return Signal("adx_dmi", direction=d, confidence=conf,
                  reason=f"ADX {a:.1f} ({'strengthening' if rising else 'weakening'}) with {'+DI' if d > 0 else '-DI'} dominant ({p:.1f} vs {m:.1f})",
                  values=dict(adx=a, plus_di=p, minus_di=m), **meta)


def supertrend_strategy(df: pd.DataFrame) -> Signal:
    """Supertrend (10, 3) - ATR-based trailing trend indicator popular with Indian intraday traders."""
    d, st, c = _last(df, "supertrend_dir"), _last(df, "supertrend"), _last(df, "close")
    meta = dict(name="Supertrend", origin="Olivier Seban; ATR(10) x 3",
                category="trend", rules="Long while close is above the Supertrend line; short while below. Flips on close crossing the line.")
    if np.isnan(st) or d == 0:
        return Signal("supertrend", direction=0, confidence=0, reason="Insufficient data", **meta)
    flips = df["supertrend_dir"].diff().abs().tail(5).sum() > 0
    dist = abs(c - st) / c
    conf = _clip(0.45 + dist * 8 + (0.15 if flips else 0))
    return Signal("supertrend", direction=int(d), confidence=conf,
                  reason=f"Price {'above' if d > 0 else 'below'} Supertrend ({st:.2f}), {dist*100:.1f}% away" + (" - recent flip" if flips else ""),
                  values=dict(supertrend=st, direction=d), **meta)


def parabolic_sar_strategy(df: pd.DataFrame) -> Signal:
    """Wilder's Parabolic SAR (0.02, 0.2) stop-and-reverse."""
    d, ps, c = _last(df, "psar_dir"), _last(df, "psar"), _last(df, "close")
    meta = dict(name="Parabolic SAR", origin="J. Welles Wilder (1978), AF 0.02 step, 0.20 max",
                category="trend", rules="Dots below price = uptrend (long); dots above price = downtrend (short).")
    if np.isnan(ps):
        return Signal("parabolic_sar", direction=0, confidence=0, reason="Insufficient data", **meta)
    run = int((df["psar_dir"] == d).to_numpy()[::-1].argmin() or len(df))
    conf = _clip(0.4 + min(run, 20) / 50 + abs(c - ps) / c * 5)
    return Signal("parabolic_sar", direction=int(d), confidence=conf,
                  reason=f"SAR {'below' if d > 0 else 'above'} price for {run} bars (SAR {ps:.2f})",
                  values=dict(psar=ps, bars_in_trend=run), **meta)


def ichimoku_strategy(df: pd.DataFrame) -> Signal:
    """Ichimoku Kinko Hyo: price vs Kumo cloud, Tenkan/Kijun cross, cloud colour."""
    c, t, k, sa, sb = (_last(df, "close"), _last(df, "tenkan"), _last(df, "kijun"),
                       _last(df, "senkou_a"), _last(df, "senkou_b"))
    meta = dict(name="Ichimoku Cloud", origin="Goichi Hosoda (1960s), 9/26/52",
                category="trend", rules="Bullish: price above cloud, Tenkan > Kijun, green cloud (A > B). Bearish: the mirror. Inside cloud = neutral.")
    if any(np.isnan(x) for x in (sa, sb, t, k)):
        return Signal("ichimoku", direction=0, confidence=0, reason="Insufficient data", **meta)
    top, bot = max(sa, sb), min(sa, sb)
    score = 0
    parts = []
    if c > top:
        score += 2; parts.append("price above cloud")
    elif c < bot:
        score -= 2; parts.append("price below cloud")
    else:
        parts.append("price inside cloud")
    if t > k:
        score += 1; parts.append("Tenkan > Kijun")
    else:
        score -= 1; parts.append("Tenkan < Kijun")
    if sa > sb:
        score += 1; parts.append("bullish (green) cloud")
    else:
        score -= 1; parts.append("bearish (red) cloud")
    # Chikou (lagging span) confirmation: today's close vs close 26 bars ago
    if len(df) > 27:
        past = _last(df, "close", 26)
        if c > past:
            score += 1; parts.append("Chikou above price")
        else:
            score -= 1; parts.append("Chikou below price")
    d = 1 if score >= 2 else (-1 if score <= -2 else 0)
    conf = _clip(abs(score) / 5)
    return Signal("ichimoku", direction=d, confidence=conf if d else 0.3, reason=", ".join(parts),
                  values=dict(tenkan=t, kijun=k, senkou_a=sa, senkou_b=sb, score=score), **meta)


def hull_ma_trend(df: pd.DataFrame) -> Signal:
    """Alan Hull's HMA(20) slope - a low-lag trend direction filter."""
    h, hp = _last(df, "hma_20"), _last(df, "hma_20", 2)
    c = _last(df, "close")
    meta = dict(name="Hull MA Slope", origin="Alan Hull (2005), HMA 20",
                category="trend", rules="Long when HMA is rising and price above it; short when falling and price below.")
    if np.isnan(h) or np.isnan(hp):
        return Signal("hull_ma", direction=0, confidence=0, reason="Insufficient data", **meta)
    slope = (h - hp) / c
    d = 1 if slope > 0 else -1
    agree = (c > h) if d > 0 else (c < h)
    conf = _clip(0.3 + abs(slope) * 100 + (0.2 if agree else -0.1))
    return Signal("hull_ma", direction=d, confidence=conf,
                  reason=f"HMA20 {'rising' if d > 0 else 'falling'} ({slope*100:.2f}%/bar); price {'above' if c > h else 'below'} HMA",
                  values=dict(hma20=h, slope_pct=slope * 100), **meta)


def elder_triple_screen(df: pd.DataFrame) -> Signal:
    """Alexander Elder's Triple Screen: higher-timeframe tide (EMA13 slope / MACD-hist on 5x bars),
    then trade pullbacks on the base timeframe oscillator (Stochastic / Force Index)."""
    meta = dict(name="Elder Triple Screen", origin="Dr. Alexander Elder, 'Trading for a Living' (1993)",
                category="trend", rules="Screen 1: higher-timeframe trend via EMA13 slope & MACD histogram. Screen 2: buy pullbacks (Stoch < 30) in uptrend, sell rallies (Stoch > 70) in downtrend.")
    # Higher timeframe: aggregate 5 bars into one
    n = len(df) // 5 * 5
    if n < 100:
        return Signal("elder_triple_screen", direction=0, confidence=0, reason="Insufficient data", **meta)
    hi = df["close"].iloc[-n:].to_numpy().reshape(-1, 5)[:, -1]
    hs = pd.Series(hi)
    ema13 = ind.ema(hs, 13)
    mh = ind.macd(hs)["macd_hist"]
    tide = 0
    if ema13.iloc[-1] > ema13.iloc[-2] and mh.iloc[-1] > mh.iloc[-2]:
        tide = 1
    elif ema13.iloc[-1] < ema13.iloc[-2] and mh.iloc[-1] < mh.iloc[-2]:
        tide = -1
    k = _last(df, "stoch_k")
    if tide == 0:
        return Signal("elder_triple_screen", direction=0, confidence=0.3, reason="Higher-timeframe EMA13 and MACD histogram disagree: no tide",
                      values=dict(stoch_k=k), **meta)
    if tide > 0:
        pullback = k < 30
        conf = _clip(0.5 + (0.35 if pullback else 0.0) - (0.15 if k > 80 else 0))
        return Signal("elder_triple_screen", direction=1, confidence=conf,
                      reason=f"Weekly-equivalent tide up (EMA13 rising, MACD-hist rising); Stoch {k:.0f}{' = pullback entry zone' if pullback else ''}",
                      values=dict(stoch_k=k, tide=tide), **meta)
    rally = k > 70
    conf = _clip(0.5 + (0.35 if rally else 0.0) - (0.15 if k < 20 else 0))
    return Signal("elder_triple_screen", direction=-1, confidence=conf,
                  reason=f"Weekly-equivalent tide down (EMA13 falling, MACD-hist falling); Stoch {k:.0f}{' = rally short zone' if rally else ''}",
                  values=dict(stoch_k=k, tide=tide), **meta)


def chandelier_exit(df: pd.DataFrame) -> Signal:
    """Chuck LeBeau's Chandelier Exit: 22-bar high - 3 x ATR(22) (long) / 22-bar low + 3 x ATR (short)."""
    c = _last(df, "close")
    a = _last(df, "atr_22")
    meta = dict(name="Chandelier Exit", origin="Chuck LeBeau; 22-period high/low, 3 x ATR(22)",
                category="volatility", rules="Stay long while close > 22-bar high - 3 ATR; stay short while close < 22-bar low + 3 ATR.")
    if np.isnan(a):
        return Signal("chandelier_exit", direction=0, confidence=0, reason="Insufficient data", **meta)
    hh = float(df["high"].rolling(22).max().iloc[-1])
    ll = float(df["low"].rolling(22).min().iloc[-1])
    long_stop, short_stop = hh - 3 * a, ll + 3 * a
    if c > long_stop and c > short_stop:
        conf = _clip(0.4 + (c - long_stop) / (3 * a) * 0.4)
        return Signal("chandelier_exit", direction=1, confidence=conf, reason=f"Close above long chandelier stop {long_stop:.2f}",
                      values=dict(long_stop=long_stop, short_stop=short_stop), **meta)
    if c < short_stop and c < long_stop:
        conf = _clip(0.4 + (short_stop - c) / (3 * a) * 0.4)
        return Signal("chandelier_exit", direction=-1, confidence=conf, reason=f"Close below short chandelier stop {short_stop:.2f}",
                      values=dict(long_stop=long_stop, short_stop=short_stop), **meta)
    return Signal("chandelier_exit", direction=0, confidence=0.3, reason="Price between chandelier stops (no regime)",
                  values=dict(long_stop=long_stop, short_stop=short_stop), **meta)


def heikin_ashi_trend(df: pd.DataFrame) -> Signal:
    """Heikin-Ashi candle colour run; candles with no wick against the trend = strong trend."""
    ha = df[["ha_open", "ha_close", "ha_high", "ha_low"]].tail(6)
    color = np.sign(ha["ha_close"] - ha["ha_open"])
    last = int(color.iloc[-1])
    meta = dict(name="Heikin-Ashi Trend", origin="Japanese 'average bar' charting; widely used trend filter",
                category="price_action", rules="Consecutive same-colour HA candles = trend. No lower wick (bull) / no upper wick (bear) = strong.")
    if last == 0:
        return Signal("heikin_ashi", direction=0, confidence=0.2, reason="Doji-like HA candle", **meta)
    run = 0
    for v in color.to_numpy()[::-1]:
        if v == last:
            run += 1
        else:
            break
    row = ha.iloc[-1]
    strong = (row["ha_low"] >= min(row["ha_open"], row["ha_close"]) * 0.9995) if last > 0 else (row["ha_high"] <= max(row["ha_open"], row["ha_close"]) * 1.0005)
    conf = _clip(0.3 + run * 0.1 + (0.2 if strong else 0))
    return Signal("heikin_ashi", direction=last, confidence=conf,
                  reason=f"{run} consecutive {'green' if last > 0 else 'red'} HA candles{' with no opposing wick (strong)' if strong else ''}",
                  values=dict(run=run), **meta)


# =============================================================================
#  MOMENTUM / OSCILLATOR STRATEGIES
# =============================================================================

def rsi_wilder(df: pd.DataFrame) -> Signal:
    """Wilder's RSI(14): 30/70 reversal zones, 50 midline as trend bias, plus simple divergence check."""
    r, c = _last(df, "rsi_14"), _last(df, "close")
    meta = dict(name="RSI 14 (Wilder)", origin="J. Welles Wilder (1978)",
                category="momentum", rules="RSI < 30 oversold (bullish reversal), > 70 overbought (bearish). Between: RSI > 50 bullish bias, < 50 bearish. Divergence strengthens the call.")
    if np.isnan(r):
        return Signal("rsi_wilder", direction=0, confidence=0, reason="Insufficient data", **meta)
    # divergence over last 20 bars
    w = df.tail(20)
    price_hh = w["close"].iloc[-1] >= w["close"].max() * 0.995
    price_ll = w["close"].iloc[-1] <= w["close"].min() * 1.005
    rsi_lower_high = w["rsi_14"].iloc[-1] < w["rsi_14"].max() - 3
    rsi_higher_low = w["rsi_14"].iloc[-1] > w["rsi_14"].min() + 3
    if r < 30:
        conf = _clip(0.5 + (30 - r) / 30 + (0.2 if price_ll and rsi_higher_low else 0))
        return Signal("rsi_wilder", direction=1, confidence=conf,
                      reason=f"RSI {r:.1f} oversold" + (" with bullish divergence" if price_ll and rsi_higher_low else ""), values=dict(rsi=r), **meta)
    if r > 70:
        conf = _clip(0.5 + (r - 70) / 30 + (0.2 if price_hh and rsi_lower_high else 0))
        return Signal("rsi_wilder", direction=-1, confidence=conf,
                      reason=f"RSI {r:.1f} overbought" + (" with bearish divergence" if price_hh and rsi_lower_high else ""), values=dict(rsi=r), **meta)
    d = 1 if r > 50 else -1
    if price_hh and rsi_lower_high:
        return Signal("rsi_wilder", direction=-1, confidence=0.45, reason=f"Bearish RSI divergence (price at highs, RSI {r:.1f} lower high)", values=dict(rsi=r), **meta)
    if price_ll and rsi_higher_low:
        return Signal("rsi_wilder", direction=1, confidence=0.45, reason=f"Bullish RSI divergence (price at lows, RSI {r:.1f} higher low)", values=dict(rsi=r), **meta)
    return Signal("rsi_wilder", direction=d, confidence=_clip(0.15 + abs(r - 50) / 60),
                  reason=f"RSI {r:.1f} {'above' if d > 0 else 'below'} 50 midline (mild {'bullish' if d > 0 else 'bearish'} bias)", values=dict(rsi=r), **meta)


def connors_rsi2(df: pd.DataFrame) -> Signal:
    """Larry Connors' RSI(2) mean-reversion: buy RSI2 < 10 above SMA200, sell RSI2 > 90 below SMA200. Exit at SMA5."""
    r2, c, s200, s5 = _last(df, "rsi_2"), _last(df, "close"), _last(df, "sma_200"), float(df["close"].rolling(5).mean().iloc[-1])
    meta = dict(name="Connors RSI-2", origin="Larry Connors & Cesar Alvarez, 'Short Term Trading Strategies That Work' (2008)",
                category="momentum", rules="Long: close > SMA200 and RSI(2) < 10 (extreme 5). Short: close < SMA200 and RSI(2) > 90. Exit when price crosses SMA5.")
    if np.isnan(s200):
        # fall back to SMA100 as long-term filter when history is short
        s200 = _last(df, "sma_100")
        if np.isnan(s200):
            return Signal("connors_rsi2", direction=0, confidence=0, reason="Needs 200-bar history for trend filter", **meta)
    if c > s200 and r2 < 10:
        conf = _clip(0.55 + (10 - r2) / 20)
        return Signal("connors_rsi2", direction=1, confidence=conf, reason=f"Above SMA200 with RSI(2) {r2:.1f} < 10: oversold pullback in uptrend",
                      values=dict(rsi2=r2, sma200=s200, sma5=s5), **meta)
    if c < s200 and r2 > 90:
        conf = _clip(0.55 + (r2 - 90) / 20)
        return Signal("connors_rsi2", direction=-1, confidence=conf, reason=f"Below SMA200 with RSI(2) {r2:.1f} > 90: overbought bounce in downtrend",
                      values=dict(rsi2=r2, sma200=s200, sma5=s5), **meta)
    return Signal("connors_rsi2", direction=0, confidence=0.25, reason=f"No setup (RSI2 {r2:.1f}, price {'above' if c > s200 else 'below'} SMA200)",
                  values=dict(rsi2=r2, sma200=s200), **meta)


def stochastic_lane(df: pd.DataFrame) -> Signal:
    """George Lane's Stochastic (14,3,3): %K/%D crosses in the 20/80 zones."""
    k, d, kp, dp = _last(df, "stoch_k"), _last(df, "stoch_d"), _last(df, "stoch_k", 1), _last(df, "stoch_d", 1)
    meta = dict(name="Stochastic Oscillator", origin="George Lane (1950s), 14/3/3",
                category="momentum", rules="Bullish: %K crosses above %D below 20. Bearish: %K crosses below %D above 80. Mid-range crosses are weaker.")
    if np.isnan(k) or np.isnan(dp):
        return Signal("stochastic", direction=0, confidence=0, reason="Insufficient data", **meta)
    cross_up = kp <= dp and k > d
    cross_dn = kp >= dp and k < d
    if cross_up:
        conf = _clip(0.35 + (0.4 if k < 25 else 0.1))
        return Signal("stochastic", direction=1, confidence=conf, reason=f"%K crossed above %D at {k:.0f}{' (oversold zone)' if k < 25 else ''}", values=dict(k=k, d=d), **meta)
    if cross_dn:
        conf = _clip(0.35 + (0.4 if k > 75 else 0.1))
        return Signal("stochastic", direction=-1, confidence=conf, reason=f"%K crossed below %D at {k:.0f}{' (overbought zone)' if k > 75 else ''}", values=dict(k=k, d=d), **meta)
    if k < 20:
        return Signal("stochastic", direction=1, confidence=0.35, reason=f"Stochastic {k:.0f} oversold, awaiting cross", values=dict(k=k, d=d), **meta)
    if k > 80:
        return Signal("stochastic", direction=-1, confidence=0.35, reason=f"Stochastic {k:.0f} overbought, awaiting cross", values=dict(k=k, d=d), **meta)
    dd = 1 if k > d else -1
    return Signal("stochastic", direction=dd, confidence=0.15, reason=f"%K {'above' if dd > 0 else 'below'} %D mid-range ({k:.0f})", values=dict(k=k, d=d), **meta)


def cci_lambert(df: pd.DataFrame) -> Signal:
    """Donald Lambert's CCI(20): +100/-100 breakout rules (trend) and extremes (reversal)."""
    v, vp = _last(df, "cci_20"), _last(df, "cci_20", 1)
    meta = dict(name="CCI (Lambert)", origin="Donald Lambert (1980), 20-period",
                category="momentum", rules="Cross above +100 = bullish momentum; cross below -100 = bearish. Beyond +/-200 = exhaustion.")
    if np.isnan(v):
        return Signal("cci", direction=0, confidence=0, reason="Insufficient data", **meta)
    if v > 200:
        return Signal("cci", direction=-1, confidence=0.4, reason=f"CCI {v:.0f} > 200: exhaustion, reversal risk", values=dict(cci=v), **meta)
    if v < -200:
        return Signal("cci", direction=1, confidence=0.4, reason=f"CCI {v:.0f} < -200: capitulation, reversal potential", values=dict(cci=v), **meta)
    if v > 100:
        return Signal("cci", direction=1, confidence=_clip(0.4 + (0.2 if vp <= 100 else 0) + (v - 100) / 300), reason=f"CCI {v:.0f} above +100{' (fresh cross)' if vp <= 100 else ''}", values=dict(cci=v), **meta)
    if v < -100:
        return Signal("cci", direction=-1, confidence=_clip(0.4 + (0.2 if vp >= -100 else 0) + (-100 - v) / 300), reason=f"CCI {v:.0f} below -100{' (fresh cross)' if vp >= -100 else ''}", values=dict(cci=v), **meta)
    return Signal("cci", direction=int(np.sign(v)), confidence=0.15, reason=f"CCI {v:.0f} inside +/-100 band", values=dict(cci=v), **meta)


def williams_r_strategy(df: pd.DataFrame) -> Signal:
    """Larry Williams' %R(14): -20 / -80 zones."""
    w = _last(df, "williams_r")
    meta = dict(name="Williams %R", origin="Larry Williams, 14-period",
                category="momentum", rules="Below -80 oversold (bullish), above -20 overbought (bearish).")
    if np.isnan(w):
        return Signal("williams_r", direction=0, confidence=0, reason="Insufficient data", **meta)
    if w < -80:
        return Signal("williams_r", direction=1, confidence=_clip(0.4 + (-80 - w) / 40), reason=f"%R {w:.0f} oversold", values=dict(williams_r=w), **meta)
    if w > -20:
        return Signal("williams_r", direction=-1, confidence=_clip(0.4 + (w + 20) / 40), reason=f"%R {w:.0f} overbought", values=dict(williams_r=w), **meta)
    d = 1 if w > -50 else -1
    return Signal("williams_r", direction=d, confidence=0.15, reason=f"%R {w:.0f} mid-range", values=dict(williams_r=w), **meta)


def momentum_12_1(df: pd.DataFrame) -> Signal:
    """Jegadeesh & Titman (1993) cross-sectional momentum, adapted to a single asset:
    return over the past 12 'months' skipping the most recent 1 (uses 60-bar / 5-bar analog)."""
    c = df["close"]
    if len(c) < 70:
        return Signal("momentum_12_1", "Academic Momentum (12-1)", "Jegadeesh & Titman (1993)", "momentum", 0, 0, "Insufficient data", "")
    mom = float(c.iloc[-6] / c.iloc[-66] - 1)
    vol = float(c.pct_change().tail(60).std() * np.sqrt(60)) or 1e-9
    z = mom / vol
    d = 1 if mom > 0 else -1
    meta = dict(name="Academic Momentum (12-1)", origin="Jegadeesh & Titman (1993); 60-bar lookback skipping last 5",
                category="momentum", rules="Positive trailing return (excluding the most recent bars) predicts continuation; negative predicts further weakness.")
    return Signal("momentum_12_1", direction=d, confidence=_clip(0.25 + abs(z) * 0.35),
                  reason=f"Trailing 60-bar return (skip 5) {mom*100:+.1f}%, vol-adjusted {z:+.2f}", values=dict(momentum_pct=mom * 100, z=z), **meta)


def fifty_two_week_high(df: pd.DataFrame) -> Signal:
    """George & Hwang (2004): nearness to the 52-week high predicts future returns."""
    n = min(len(df), 252)
    hi = float(df["high"].tail(n).max())
    lo = float(df["low"].tail(n).min())
    c = _last(df, "close")
    ratio = c / hi
    pos = (c - lo) / (hi - lo) if hi > lo else 0.5
    meta = dict(name="52-Week High Momentum", origin="George & Hwang, Journal of Finance (2004)",
                category="momentum", rules="Price within ~5% of its 52-week high = bullish anchoring effect; near the 52-week low = bearish.")
    if ratio > 0.95:
        return Signal("fifty_two_week_high", direction=1, confidence=_clip(0.4 + (ratio - 0.95) * 8), reason=f"Price at {ratio*100:.1f}% of {n}-bar high", values=dict(high=hi, low=lo, ratio=ratio), **meta)
    if pos < 0.15:
        return Signal("fifty_two_week_high", direction=-1, confidence=_clip(0.4 + (0.15 - pos) * 2), reason=f"Price in bottom {pos*100:.0f}% of {n}-bar range", values=dict(high=hi, low=lo, ratio=ratio), **meta)
    return Signal("fifty_two_week_high", direction=1 if pos > 0.5 else -1, confidence=0.15, reason=f"Price at {pos*100:.0f}% of {n}-bar range", values=dict(high=hi, low=lo, ratio=ratio), **meta)


# =============================================================================
#  VOLATILITY / BREAKOUT STRATEGIES
# =============================================================================

def bollinger_breakout(df: pd.DataFrame) -> Signal:
    """John Bollinger's Squeeze: BandWidth at a 120-bar low then a close outside the bands starts a move."""
    bw, u, l, c = _last(df, "bb_width"), _last(df, "bb_upper"), _last(df, "bb_lower"), _last(df, "close")
    meta = dict(name="Bollinger Squeeze Breakout", origin="John Bollinger, 'Bollinger on Bollinger Bands' (2001); 20/2",
                category="volatility", rules="BandWidth at multi-period low = squeeze. Close above upper band = bullish breakout; below lower = bearish. Walking the band continues the trend.")
    if np.isnan(bw):
        return Signal("bollinger_breakout", direction=0, confidence=0, reason="Insufficient data", **meta)
    bw_min = float(df["bb_width"].tail(120).min())
    squeeze = bw <= bw_min * 1.25
    recently_squeezed = float(df["bb_width"].tail(10).min()) <= bw_min * 1.25
    if c > u:
        conf = _clip(0.45 + (0.3 if recently_squeezed else 0))
        return Signal("bollinger_breakout", direction=1, confidence=conf, reason=f"Close above upper band{' after squeeze' if recently_squeezed else ' (walking the band)'}", values=dict(bandwidth=bw, upper=u, lower=l), **meta)
    if c < l:
        conf = _clip(0.45 + (0.3 if recently_squeezed else 0))
        return Signal("bollinger_breakout", direction=-1, confidence=conf, reason=f"Close below lower band{' after squeeze' if recently_squeezed else ' (walking the band)'}", values=dict(bandwidth=bw, upper=u, lower=l), **meta)
    if squeeze:
        return Signal("bollinger_breakout", direction=0, confidence=0.5, reason=f"Squeeze in progress (BandWidth {bw:.3f} near 120-bar low) - breakout pending, direction unknown", values=dict(bandwidth=bw), **meta)
    return Signal("bollinger_breakout", direction=0, confidence=0.15, reason="Inside bands, no squeeze", values=dict(bandwidth=bw), **meta)


def bollinger_mean_reversion(df: pd.DataFrame) -> Signal:
    """Bollinger %B mean reversion when ADX shows no trend."""
    pct, a, r = _last(df, "bb_pct"), _last(df, "adx"), _last(df, "rsi_14")
    meta = dict(name="Bollinger %B Mean Reversion", origin="John Bollinger; classic range-trading application (with ADX < 25 filter)",
                category="volatility", rules="In a non-trending market (ADX < 25), %B < 0 = buy back toward the middle band; %B > 1 = sell.")
    if np.isnan(pct) or np.isnan(a):
        return Signal("bollinger_mr", direction=0, confidence=0, reason="Insufficient data", **meta)
    trending = a >= 25
    if pct < 0.05:
        conf = _clip((0.55 if not trending else 0.25) + (0.15 if r < 35 else 0))
        return Signal("bollinger_mr", direction=1, confidence=conf, reason=f"%B {pct:.2f} at/below lower band{', ADX low (range)' if not trending else ', but ADX trending - weaker'}", values=dict(pct_b=pct, adx=a), **meta)
    if pct > 0.95:
        conf = _clip((0.55 if not trending else 0.25) + (0.15 if r > 65 else 0))
        return Signal("bollinger_mr", direction=-1, confidence=conf, reason=f"%B {pct:.2f} at/above upper band{', ADX low (range)' if not trending else ', but ADX trending - weaker'}", values=dict(pct_b=pct, adx=a), **meta)
    return Signal("bollinger_mr", direction=0, confidence=0.15, reason=f"%B {pct:.2f} inside bands", values=dict(pct_b=pct, adx=a), **meta)


def ttm_squeeze(df: pd.DataFrame) -> Signal:
    """John Carter's TTM Squeeze: Bollinger inside Keltner = squeeze on; fire in the momentum direction on release."""
    bu, bl, ku, kl = _last(df, "bb_upper"), _last(df, "bb_lower"), _last(df, "kc_upper"), _last(df, "kc_lower")
    meta = dict(name="TTM Squeeze", origin="John Carter, 'Mastering the Trade' (2005); BB(20,2) inside KC(20,1.5)",
                category="volatility", rules="Squeeze ON when Bollinger Bands sit inside Keltner Channels. When it releases, trade the direction of the momentum histogram (linear regression of price vs. midline).")
    if any(np.isnan(x) for x in (bu, bl, ku, kl)):
        return Signal("ttm_squeeze", direction=0, confidence=0, reason="Insufficient data", **meta)
    on = pd.Series((df["bb_upper"] < df["kc_upper"]) & (df["bb_lower"] > df["kc_lower"]))
    # momentum: close minus mean of (donchian mid, sma20) regressed over 20 bars
    base = (df["dc20_mid"] + df["sma_20"]) / 2
    mom_series = (df["close"] - base).tail(20).dropna()
    mom = float(np.polyval(np.polyfit(np.arange(len(mom_series)), mom_series.to_numpy(), 1), len(mom_series) - 1)) if len(mom_series) >= 5 else 0.0
    d = 1 if mom > 0 else -1
    if bool(on.iloc[-1]):
        return Signal("ttm_squeeze", direction=0, confidence=0.45, reason=f"Squeeze ON (volatility compressed); momentum leaning {'up' if d > 0 else 'down'} - wait for release",
                      values=dict(squeeze_on=True, momentum=mom), **meta)
    released_recently = bool(on.tail(6).iloc[:-1].any())
    conf = _clip(0.3 + (0.4 if released_recently else 0) + abs(mom) / _last(df, "close") * 20)
    return Signal("ttm_squeeze", direction=d, confidence=conf,
                  reason=f"Squeeze {'just fired' if released_recently else 'off'}; momentum {'positive' if d > 0 else 'negative'}",
                  values=dict(squeeze_on=False, momentum=mom, fired=released_recently), **meta)


def turtle_breakout(df: pd.DataFrame) -> Signal:
    """Turtle Trading (Richard Dennis & William Eckhardt, 1983): System 1 = 20-day Donchian breakout,
    System 2 = 55-day breakout. Exit on 10-day opposite breakout."""
    c = _last(df, "close")
    u20, l20 = _last(df, "dc20_upper", 1), _last(df, "dc20_lower", 1)
    u55, l55 = _last(df, "dc55_upper", 1), _last(df, "dc55_lower", 1)
    meta = dict(name="Turtle Breakout (Donchian)", origin="Richard Dennis & William Eckhardt (1983); Donchian 20/55, exit 10",
                category="volatility", rules="Buy a close above the prior 20-bar high (55-bar for System 2); sell a close below the prior 20-bar low. Exit on a 10-bar reverse breakout.")
    if np.isnan(u55):
        return Signal("turtle", direction=0, confidence=0, reason="Insufficient data", **meta)
    hi10 = float(df["high"].iloc[-11:-1].max())
    lo10 = float(df["low"].iloc[-11:-1].min())
    if c > u55:
        return Signal("turtle", direction=1, confidence=0.8, reason="Close above 55-bar high (System 2 entry)", values=dict(dc55_high=u55, dc20_high=u20), **meta)
    if c < l55:
        return Signal("turtle", direction=-1, confidence=0.8, reason="Close below 55-bar low (System 2 entry)", values=dict(dc55_low=l55, dc20_low=l20), **meta)
    if c > u20:
        return Signal("turtle", direction=1, confidence=0.65, reason="Close above 20-bar high (System 1 entry)", values=dict(dc20_high=u20), **meta)
    if c < l20:
        return Signal("turtle", direction=-1, confidence=0.65, reason="Close below 20-bar low (System 1 entry)", values=dict(dc20_low=l20), **meta)
    # In-position logic: where is price relative to the channel
    mid = (u20 + l20) / 2
    pos = (c - l20) / (u20 - l20) if u20 > l20 else 0.5
    if c < lo10 and pos > 0.5:
        return Signal("turtle", direction=-1, confidence=0.35, reason="10-bar low broken: long exit signal", values=dict(pos=pos), **meta)
    if c > hi10 and pos < 0.5:
        return Signal("turtle", direction=1, confidence=0.35, reason="10-bar high broken: short exit signal", values=dict(pos=pos), **meta)
    return Signal("turtle", direction=0, confidence=0.2, reason=f"Inside 20-bar channel ({pos*100:.0f}% of range)", values=dict(pos=pos, dc20_high=u20, dc20_low=l20), **meta)


def keltner_pullback(df: pd.DataFrame) -> Signal:
    """Linda Raschke's Keltner Channel trend-pullback: trend by channel breakouts, enter on pullbacks to the EMA20 midline."""
    c, ku, km, kl = _last(df, "close"), _last(df, "kc_upper"), _last(df, "kc_mid"), _last(df, "kc_lower")
    meta = dict(name="Keltner Pullback", origin="Chester Keltner / Linda Bradford Raschke; EMA20 +/- 1.5 ATR",
                category="volatility", rules="Recent close above upper channel = uptrend; buy pullbacks to the midline. Recent close below lower = downtrend; sell rallies to midline.")
    if np.isnan(ku):
        return Signal("keltner_pullback", direction=0, confidence=0, reason="Insufficient data", **meta)
    w = df.tail(15)
    up_trend = bool((w["close"] > w["kc_upper"]).any())
    dn_trend = bool((w["close"] < w["kc_lower"]).any())
    near_mid = abs(c - km) < _last(df, "atr_14") * 0.5
    if up_trend and not dn_trend:
        conf = _clip(0.4 + (0.3 if near_mid and c >= km else 0) + (0.1 if c > ku else 0))
        return Signal("keltner_pullback", direction=1, confidence=conf, reason=f"Uptrend (recent close above upper Keltner){'; pullback to midline' if near_mid else ''}", values=dict(kc_mid=km), **meta)
    if dn_trend and not up_trend:
        conf = _clip(0.4 + (0.3 if near_mid and c <= km else 0) + (0.1 if c < kl else 0))
        return Signal("keltner_pullback", direction=-1, confidence=conf, reason=f"Downtrend (recent close below lower Keltner){'; rally to midline' if near_mid else ''}", values=dict(kc_mid=km), **meta)
    return Signal("keltner_pullback", direction=0, confidence=0.2, reason="No clean Keltner trend", values=dict(kc_mid=km), **meta)


def volume_breakout(df: pd.DataFrame) -> Signal:
    """Stan Weinstein / classic breakout confirmation: a range break on >= 1.5x average volume."""
    c, v, va = _last(df, "close"), _last(df, "volume"), _last(df, "vol_sma_20")
    meta = dict(name="Volume-Confirmed Breakout", origin="Stan Weinstein 'Secrets for Profiting in Bull and Bear Markets' (1988); Stage analysis",
                category="volume", rules="A close beyond the prior 20-bar range on >= 1.5x 20-bar average volume is confirmed; breakouts on low volume are suspect.")
    if np.isnan(va) or va == 0:
        return Signal("volume_breakout", direction=0, confidence=0, reason="No volume data", **meta)
    hi = float(df["high"].iloc[-21:-1].max())
    lo = float(df["low"].iloc[-21:-1].min())
    ratio = v / va
    if c > hi:
        conf = _clip(0.3 + (0.4 if ratio >= 1.5 else -0.1) + min(ratio, 3) / 10)
        return Signal("volume_breakout", direction=1, confidence=conf, reason=f"Breakout above 20-bar high on {ratio:.1f}x volume{'' if ratio >= 1.5 else ' (weak volume)'}", values=dict(volume_ratio=ratio), **meta)
    if c < lo:
        conf = _clip(0.3 + (0.4 if ratio >= 1.5 else -0.1) + min(ratio, 3) / 10)
        return Signal("volume_breakout", direction=-1, confidence=conf, reason=f"Breakdown below 20-bar low on {ratio:.1f}x volume{'' if ratio >= 1.5 else ' (weak volume)'}", values=dict(volume_ratio=ratio), **meta)
    bar_dir = int(np.sign(c - _last(df, "open")))
    if ratio >= 2 and bar_dir != 0:
        return Signal("volume_breakout", direction=bar_dir, confidence=0.35, reason=f"Volume climax {ratio:.1f}x on a {'green' if bar_dir > 0 else 'red'} bar", values=dict(volume_ratio=ratio), **meta)
    return Signal("volume_breakout", direction=0, confidence=0.15, reason=f"No breakout; volume {ratio:.1f}x average", values=dict(volume_ratio=ratio), **meta)


def opening_range_breakout(df: pd.DataFrame, interval_seconds: int) -> Signal:
    """Toby Crabel's Opening Range Breakout (intraday only): break of the first 30 minutes' range."""
    meta = dict(name="Opening Range Breakout", origin="Toby Crabel, 'Day Trading with Short Term Price Patterns' (1990)",
                category="price_action", rules="Intraday: the first 30 minutes define the range; a close above it is bullish, below it bearish for the session.")
    if interval_seconds >= 3600:
        return Signal("orb", direction=0, confidence=0, reason="Intraday strategy - not applicable on this timeframe", **meta)
    day = df.index[-1].normalize()
    session = df[df.index.normalize() == day]
    bars = max(1, int(1800 // interval_seconds))
    if len(session) <= bars:
        return Signal("orb", direction=0, confidence=0.2, reason="Opening range still forming", **meta)
    orb_hi = float(session["high"].iloc[:bars].max())
    orb_lo = float(session["low"].iloc[:bars].min())
    c = _last(df, "close")
    if c > orb_hi:
        return Signal("orb", direction=1, confidence=_clip(0.45 + (c - orb_hi) / (orb_hi - orb_lo + 1e-9) * 0.2), reason=f"Trading above the opening range high {orb_hi:.2f}", values=dict(orb_high=orb_hi, orb_low=orb_lo), **meta)
    if c < orb_lo:
        return Signal("orb", direction=-1, confidence=_clip(0.45 + (orb_lo - c) / (orb_hi - orb_lo + 1e-9) * 0.2), reason=f"Trading below the opening range low {orb_lo:.2f}", values=dict(orb_high=orb_hi, orb_low=orb_lo), **meta)
    return Signal("orb", direction=0, confidence=0.25, reason=f"Inside opening range {orb_lo:.2f} - {orb_hi:.2f}", values=dict(orb_high=orb_hi, orb_low=orb_lo), **meta)


# =============================================================================
#  VOLUME STRATEGIES
# =============================================================================

def obv_granville(df: pd.DataFrame) -> Signal:
    """Joseph Granville's On-Balance Volume: OBV trend confirms price; divergence warns."""
    o, oe = _last(df, "obv"), _last(df, "obv_ema")
    meta = dict(name="On-Balance Volume", origin="Joseph Granville (1963)",
                category="volume", rules="OBV above its 20-EMA and rising confirms an uptrend (volume flows in); OBV falling while price rises = bearish divergence.")
    if np.isnan(oe) or df["volume"].tail(20).sum() == 0:
        return Signal("obv", direction=0, confidence=0, reason="No volume data", **meta)
    w = df.tail(20)
    obv_slope = _slope(w["obv"], 20)
    price_slope = _slope(w["close"], 20)
    obv_up = o > oe and obv_slope > 0
    obv_dn = o < oe and obv_slope < 0
    if obv_up and price_slope < 0:
        return Signal("obv", direction=1, confidence=0.5, reason="Bullish divergence: OBV rising while price falls (accumulation)", values=dict(obv=o, obv_ema=oe), **meta)
    if obv_dn and price_slope > 0:
        return Signal("obv", direction=-1, confidence=0.5, reason="Bearish divergence: OBV falling while price rises (distribution)", values=dict(obv=o, obv_ema=oe), **meta)
    if obv_up:
        return Signal("obv", direction=1, confidence=0.45, reason="OBV above its EMA and rising: volume confirms uptrend", values=dict(obv=o, obv_ema=oe), **meta)
    if obv_dn:
        return Signal("obv", direction=-1, confidence=0.45, reason="OBV below its EMA and falling: volume confirms downtrend", values=dict(obv=o, obv_ema=oe), **meta)
    return Signal("obv", direction=0, confidence=0.2, reason="OBV mixed", values=dict(obv=o, obv_ema=oe), **meta)


def vwap_strategy(df: pd.DataFrame, interval_seconds: int) -> Signal:
    """Institutional VWAP: price above VWAP = buyers in control (session VWAP intraday, 20-bar rolling otherwise)."""
    c = _last(df, "close")
    meta = dict(name="VWAP", origin="Institutional execution benchmark; standard intraday bias tool",
                category="volume", rules="Price above VWAP = bullish bias (longs favoured, VWAP acts as support); below = bearish. Distance is normalised by ATR.")
    if interval_seconds < 86400:
        v = float(ind.vwap(df).iloc[-1])
        label = "session VWAP"
    else:
        v = _last(df, "vwap_20")
        label = "20-bar VWAP"
    a = _last(df, "atr_14")
    if np.isnan(v) or np.isnan(a) or a == 0:
        return Signal("vwap", direction=0, confidence=0, reason="No volume data", **meta)
    dist = (c - v) / a
    d = 1 if dist > 0 else -1
    conf = _clip(0.3 + min(abs(dist), 2) * 0.2)
    return Signal("vwap", direction=d, confidence=conf, reason=f"Price {abs(dist):.2f} ATR {'above' if d > 0 else 'below'} {label} ({v:.2f})", values=dict(vwap=v, atr_distance=dist), **meta)


def mfi_strategy(df: pd.DataFrame) -> Signal:
    """Money Flow Index (volume-weighted RSI): 20/80 zones."""
    m = _last(df, "mfi_14")
    meta = dict(name="Money Flow Index", origin="Gene Quong & Avrum Soudack; 14-period",
                category="volume", rules="MFI < 20 oversold (bullish), > 80 overbought (bearish).")
    if np.isnan(m) or df["volume"].tail(20).sum() == 0:
        return Signal("mfi", direction=0, confidence=0, reason="No volume data", **meta)
    if m < 20:
        return Signal("mfi", direction=1, confidence=_clip(0.4 + (20 - m) / 30), reason=f"MFI {m:.0f} oversold", values=dict(mfi=m), **meta)
    if m > 80:
        return Signal("mfi", direction=-1, confidence=_clip(0.4 + (m - 80) / 30), reason=f"MFI {m:.0f} overbought", values=dict(mfi=m), **meta)
    return Signal("mfi", direction=1 if m > 50 else -1, confidence=0.12, reason=f"MFI {m:.0f} neutral zone", values=dict(mfi=m), **meta)


def chaikin_money_flow_strategy(df: pd.DataFrame) -> Signal:
    """Marc Chaikin's CMF(20): sustained > +0.05 accumulation, < -0.05 distribution."""
    v = _last(df, "cmf_20")
    meta = dict(name="Chaikin Money Flow", origin="Marc Chaikin; 20-period",
                category="volume", rules="CMF > +0.05 = buying pressure (bullish); < -0.05 = selling pressure (bearish).")
    if np.isnan(v) or df["volume"].tail(20).sum() == 0:
        return Signal("cmf", direction=0, confidence=0, reason="No volume data", **meta)
    if abs(v) < 0.05:
        return Signal("cmf", direction=0, confidence=0.15, reason=f"CMF {v:+.3f} near zero", values=dict(cmf=v), **meta)
    return Signal("cmf", direction=int(np.sign(v)), confidence=_clip(0.35 + abs(v) * 2), reason=f"CMF {v:+.3f}: {'accumulation' if v > 0 else 'distribution'}", values=dict(cmf=v), **meta)


# =============================================================================
#  PRICE ACTION / LEVELS
# =============================================================================

def candlestick_patterns(df: pd.DataFrame) -> Signal:
    """Japanese candlestick reversal patterns as catalogued by Steve Nison."""
    meta = dict(name="Candlestick Patterns", origin="Steve Nison, 'Japanese Candlestick Charting Techniques' (1991)",
                category="price_action", rules="Detects Engulfing, Hammer / Hanging Man, Shooting Star, Morning / Evening Star, Three White Soldiers / Black Crows, Doji. Reversal patterns count more after an extended move.")
    o, h, l, c = (df[k].to_numpy()[-5:] for k in ("open", "high", "low", "close"))
    body = c - o
    rng = np.maximum(h - l, 1e-9)
    upper = h - np.maximum(o, c)
    lower = np.minimum(o, c) - l
    found: list[tuple[str, int, float]] = []
    # trend context: last 10 bars before the pattern
    prior = df["close"].iloc[-12:-2]
    down_move = prior.iloc[-1] < prior.iloc[0] * 0.98
    up_move = prior.iloc[-1] > prior.iloc[0] * 1.02
    # Engulfing
    if body[-2] < 0 < body[-1] and c[-1] > o[-2] and o[-1] < c[-2]:
        found.append(("Bullish Engulfing", 1, 0.55 + (0.2 if down_move else 0)))
    if body[-2] > 0 > body[-1] and c[-1] < o[-2] and o[-1] > c[-2]:
        found.append(("Bearish Engulfing", -1, 0.55 + (0.2 if up_move else 0)))
    # Hammer / Hanging man / Shooting star / Inverted hammer
    small_body = abs(body[-1]) <= rng[-1] * 0.35
    if small_body and lower[-1] >= 2 * abs(body[-1]) and upper[-1] <= rng[-1] * 0.15:
        found.append(("Hammer", 1, 0.5 + (0.2 if down_move else -0.2)) if down_move or not up_move else ("Hanging Man", -1, 0.45))
    if small_body and upper[-1] >= 2 * abs(body[-1]) and lower[-1] <= rng[-1] * 0.15:
        found.append(("Shooting Star", -1, 0.5 + (0.2 if up_move else -0.2)) if up_move or not down_move else ("Inverted Hammer", 1, 0.45))
    # Doji
    if abs(body[-1]) <= rng[-1] * 0.08:
        found.append(("Doji (indecision)", 0, 0.3))
    # Morning / Evening star
    if body[-3] < 0 and abs(body[-2]) < rng[-2] * 0.3 and body[-1] > 0 and c[-1] > (o[-3] + c[-3]) / 2:
        found.append(("Morning Star", 1, 0.7))
    if body[-3] > 0 and abs(body[-2]) < rng[-2] * 0.3 and body[-1] < 0 and c[-1] < (o[-3] + c[-3]) / 2:
        found.append(("Evening Star", -1, 0.7))
    # Three soldiers / crows
    if all(body[-3:] > 0) and c[-1] > c[-2] > c[-3] and all(upper[-3:] < rng[-3:] * 0.3):
        found.append(("Three White Soldiers", 1, 0.6))
    if all(body[-3:] < 0) and c[-1] < c[-2] < c[-3] and all(lower[-3:] < rng[-3:] * 0.3):
        found.append(("Three Black Crows", -1, 0.6))
    if not found:
        return Signal("candlesticks", direction=0, confidence=0.1, reason="No notable pattern on the last bars", values=dict(patterns=[]), **meta)
    score = sum(d * cnf for _, d, cnf in found)
    d = int(np.sign(score))
    conf = _clip(abs(score))
    return Signal("candlesticks", direction=d, confidence=conf if d else 0.3, reason=", ".join(n for n, _, _ in found),
                  values=dict(patterns=[n for n, _, _ in found]), **meta)


def floor_pivots(df: pd.DataFrame, interval_seconds: int) -> Signal:
    """Classic floor-trader pivot points (P, R1-3, S1-3) from the previous session (intraday) or previous bar."""
    pv = ind.pivot_points(df, interval_seconds < 86400)
    c = _last(df, "close")
    a = _last(df, "atr_14")
    meta = dict(name="Pivot Points", origin="Classic floor-trader pivots (CME pit tradition); previous session's H/L/C on intraday charts",
                category="levels", rules="Above the pivot = bullish bias, targets R1/R2; below = bearish, targets S1/S2. Price sitting at S1/R1 within 0.3 ATR is a bounce zone.")
    if np.isnan(a):
        return Signal("floor_pivots", direction=0, confidence=0, reason="Insufficient data", values=pv, **meta)
    near = {k: abs(c - v) < a * 0.3 for k, v in pv.items() if k in ("pivot", "r1", "r2", "r3", "s1", "s2", "s3")}
    if near["s1"] or near["s2"]:
        return Signal("floor_pivots", direction=1, confidence=0.45, reason=f"Price at support {'S1' if near['s1'] else 'S2'} - bounce zone", values=pv, **meta)
    if near["r1"] or near["r2"]:
        return Signal("floor_pivots", direction=-1, confidence=0.45, reason=f"Price at resistance {'R1' if near['r1'] else 'R2'} - rejection zone", values=pv, **meta)
    d = 1 if c > pv["pivot"] else -1
    return Signal("floor_pivots", direction=d, confidence=0.3, reason=f"Price {'above' if d > 0 else 'below'} pivot {pv['pivot']:.2f}", values=pv, **meta)


def fibonacci_retracement(df: pd.DataFrame) -> Signal:
    """Fibonacci retracement of the last major swing: 38.2 / 50 / 61.8 pullbacks in the swing direction."""
    fib = ind.fibonacci_levels(df, 100)
    c = _last(df, "close")
    a = _last(df, "atr_14")
    lv = fib["levels"]
    meta = dict(name="Fibonacci Retracement", origin="Classic Fibonacci pullback trading (Elliott / Gann tradition)",
                category="levels", rules="In an up-swing, a pullback holding 38.2/50/61.8% is a buy zone; in a down-swing a bounce into those levels is a sell zone. Beyond 78.6% the swing is invalidated.")
    if np.isnan(a):
        return Signal("fibonacci", direction=0, confidence=0, reason="Insufficient data", values=lv, **meta)
    zone_hits = [k for k in ("0.382", "0.500", "0.618") if abs(c - lv[k]) < a * 0.5]
    if fib["up_swing"]:
        if zone_hits:
            return Signal("fibonacci", direction=1, confidence=0.5 + 0.1 * ("0.618" in zone_hits), reason=f"Pullback in up-swing at {', '.join(zone_hits)} retracement", values=lv, **meta)
        if c < lv["0.786"]:
            return Signal("fibonacci", direction=-1, confidence=0.4, reason="Retraced beyond 78.6%: up-swing invalidated", values=lv, **meta)
        return Signal("fibonacci", direction=1, confidence=0.2, reason="Up-swing intact, not at a fib level", values=lv, **meta)
    if zone_hits:
        return Signal("fibonacci", direction=-1, confidence=0.5 + 0.1 * ("0.618" in zone_hits), reason=f"Bounce in down-swing at {', '.join(zone_hits)} retracement", values=lv, **meta)
    if c > lv["0.786"]:
        return Signal("fibonacci", direction=1, confidence=0.4, reason="Retraced beyond 78.6%: down-swing invalidated", values=lv, **meta)
    return Signal("fibonacci", direction=-1, confidence=0.2, reason="Down-swing intact, not at a fib level", values=lv, **meta)


def support_resistance(df: pd.DataFrame) -> Signal:
    """Swing-point support / resistance: reaction at the nearest level, or a clean break."""
    sh, sl = ind.swing_points(df, 5)
    c = _last(df, "close")
    a = _last(df, "atr_14")
    meta = dict(name="Support / Resistance", origin="Classic technical analysis (Edwards & Magee, 'Technical Analysis of Stock Trends', 1948)",
                category="levels", rules="Nearest swing-high resistance / swing-low support. A close through a level on the last bar = breakout; a hold within 0.5 ATR = bounce.")
    if np.isnan(a):
        return Signal("support_resistance", direction=0, confidence=0, reason="Insufficient data", **meta)
    hist = df.iloc[:-1]
    res = hist.loc[sh.iloc[:-1], "high"]
    sup = hist.loc[sl.iloc[:-1], "low"]
    res_above = res[res > c]
    sup_below = sup[sup < c]
    nearest_res = float(res_above.min()) if len(res_above) else float("nan")
    nearest_sup = float(sup_below.max()) if len(sup_below) else float("nan")
    prev_close = _last(df, "close", 1)
    broke_res = res[(res > prev_close) & (res < c)]
    broke_sup = sup[(sup < prev_close) & (sup > c)]
    vals = dict(resistance=nearest_res, support=nearest_sup)
    if len(broke_res):
        return Signal("support_resistance", direction=1, confidence=0.55, reason=f"Broke above resistance {float(broke_res.max()):.2f}", values=vals, **meta)
    if len(broke_sup):
        return Signal("support_resistance", direction=-1, confidence=0.55, reason=f"Broke below support {float(broke_sup.min()):.2f}", values=vals, **meta)
    if not np.isnan(nearest_sup) and c - nearest_sup < a * 0.5:
        return Signal("support_resistance", direction=1, confidence=0.4, reason=f"Holding at support {nearest_sup:.2f}", values=vals, **meta)
    if not np.isnan(nearest_res) and nearest_res - c < a * 0.5:
        return Signal("support_resistance", direction=-1, confidence=0.4, reason=f"Pressing resistance {nearest_res:.2f}", values=vals, **meta)
    if not np.isnan(nearest_sup) and not np.isnan(nearest_res):
        pos = (c - nearest_sup) / (nearest_res - nearest_sup)
        return Signal("support_resistance", direction=0, confidence=0.15, reason=f"Mid-range between {nearest_sup:.2f} and {nearest_res:.2f} ({pos*100:.0f}%)", values=vals, **meta)
    return Signal("support_resistance", direction=0, confidence=0.1, reason="No nearby levels", values=vals, **meta)


# =============================================================================
#  SESSION LEVELS, VOLUME-AT-PRICE, GAPS, NARROW RANGE, ALLIGATOR
# =============================================================================

def cpr_strategy(df: pd.DataFrame, interval_seconds: int) -> Signal:
    """Frank Ochoa's Central Pivot Range: previous-session pivot / BC / TC; price above the range is bullish,
    below bearish; a narrow CPR marks a likely trend day."""
    meta = dict(name="Central Pivot Range (CPR)", origin="Frank Ochoa, 'Secrets of a Pivot Boss' (2010); previous-session pivot, BC, TC",
                category="levels", rules="Close above the top central pivot (TC) = bullish bias; below the bottom central (BC) = bearish; inside the range = no bias. A narrow CPR (< 1/12 of the previous session's range) signals a trend day and strengthens the call.")
    cp = ind.cpr_levels(df, interval_seconds < 86400)
    c, a = _last(df, "close"), _last(df, "atr_14")
    if not cp or np.isnan(a) or a == 0:
        return Signal("cpr", direction=0, confidence=0, reason="Insufficient data", **meta)
    narrow = cp["narrow"]
    if c > cp["tc"]:
        conf = _clip(0.4 + (0.2 if narrow else 0) + min((c - cp["tc"]) / a, 2) * 0.05)
        return Signal("cpr", direction=1, confidence=conf, reason=f"Close above CPR top {cp['tc']:.2f}{' (narrow CPR: trend day likely)' if narrow else ''}", values=cp, **meta)
    if c < cp["bc"]:
        conf = _clip(0.4 + (0.2 if narrow else 0) + min((cp["bc"] - c) / a, 2) * 0.05)
        return Signal("cpr", direction=-1, confidence=conf, reason=f"Close below CPR bottom {cp['bc']:.2f}{' (narrow CPR: trend day likely)' if narrow else ''}", values=cp, **meta)
    return Signal("cpr", direction=0, confidence=0.3, reason=f"Inside the CPR {cp['bc']:.2f} - {cp['tc']:.2f}: no bias yet", values=cp, **meta)


def camarilla_strategy(df: pd.DataFrame, interval_seconds: int) -> Signal:
    """Camarilla pivots: fade the H3 / L3 reversal zone, follow a break of H4 / L4."""
    meta = dict(name="Camarilla Pivots", origin="Nick Scott (1989); widely used by Indian intraday traders. H3/L3 reversal, H4/L4 breakout",
                category="levels", rules="Price within 0.3 ATR of H3 = sell zone (reversal), of L3 = buy zone. A close above H4 = breakout long; below L4 = breakdown short.")
    lv = ind.camarilla_levels(df, interval_seconds < 86400)
    c, a = _last(df, "close"), _last(df, "atr_14")
    if not lv or np.isnan(a) or a == 0:
        return Signal("camarilla", direction=0, confidence=0, reason="Insufficient data", **meta)
    if c > lv["h4"]:
        return Signal("camarilla", direction=1, confidence=0.6, reason=f"Close above H4 {lv['h4']:.2f}: breakout", values=lv, **meta)
    if c < lv["l4"]:
        return Signal("camarilla", direction=-1, confidence=0.6, reason=f"Close below L4 {lv['l4']:.2f}: breakdown", values=lv, **meta)
    if abs(c - lv["h3"]) < a * 0.3:
        return Signal("camarilla", direction=-1, confidence=0.45, reason=f"At H3 {lv['h3']:.2f}: reversal zone, expect a fade", values=lv, **meta)
    if abs(c - lv["l3"]) < a * 0.3:
        return Signal("camarilla", direction=1, confidence=0.45, reason=f"At L3 {lv['l3']:.2f}: reversal zone, expect a bounce", values=lv, **meta)
    d = 1 if c > lv["ref_close"] else -1
    return Signal("camarilla", direction=d, confidence=0.15, reason=f"Inside the Camarilla range, {'above' if d > 0 else 'below'} the previous close", values=lv, **meta)


def vwap_bands_strategy(df: pd.DataFrame, interval_seconds: int) -> Signal:
    """Session VWAP with volume-weighted standard-deviation bands: stretched beyond 2 sigma reverts unless the trend is strong."""
    meta = dict(name="VWAP Bands", origin="Session VWAP +/- volume-weighted standard deviation; institutional benchmark (Brian Shannon, 'Maximum Trading Gains with Anchored VWAP', 2023)",
                category="volume", rules="Price more than 2 sigma above VWAP is stretched: fade it unless ADX > 25 (then ride the band). More than 2 sigma below: the mirror. Within 0.5 sigma = at fair value, no bias.")
    vb = ind.vwap_bands(df, interval_seconds < 86400)
    c, adx = _last(df, "close"), _last(df, "adx")
    if not vb or vb["sd"] <= 0:
        return Signal("vwap_bands", direction=0, confidence=0, reason="No volume data", **meta)
    dist = (c - vb["vwap"]) / vb["sd"]
    vals = dict(vwap=vb["vwap"], sd=vb["sd"], upper2=vb["upper2"], lower2=vb["lower2"], sigma_distance=dist)
    trending = not np.isnan(adx) and adx > 25
    if dist >= 2:
        return (Signal("vwap_bands", direction=1, confidence=0.3, reason=f"{dist:.1f} sigma above VWAP with ADX {adx:.0f}: riding the upper band", values=vals, **meta) if trending
                else Signal("vwap_bands", direction=-1, confidence=0.45, reason=f"{dist:.1f} sigma above VWAP: stretched, fade toward {vb['vwap']:.2f}", values=vals, **meta))
    if dist <= -2:
        return (Signal("vwap_bands", direction=-1, confidence=0.3, reason=f"{-dist:.1f} sigma below VWAP with ADX {adx:.0f}: riding the lower band", values=vals, **meta) if trending
                else Signal("vwap_bands", direction=1, confidence=0.45, reason=f"{-dist:.1f} sigma below VWAP: stretched, bounce toward {vb['vwap']:.2f}", values=vals, **meta))
    if abs(dist) < 0.5:
        return Signal("vwap_bands", direction=0, confidence=0.2, reason=f"At VWAP ({dist:+.1f} sigma): fair value", values=vals, **meta)
    d = 1 if dist > 0 else -1
    return Signal("vwap_bands", direction=d, confidence=0.2, reason=f"{abs(dist):.1f} sigma {'above' if d > 0 else 'below'} VWAP, inside the bands", values=vals, **meta)


def opening_gap(df: pd.DataFrame, interval_seconds: int) -> Signal:
    """Gap trading: a gap that holds beyond the open tends to continue (gap-and-go); one that trades back through the open tends to fill."""
    meta = dict(name="Opening Gap", origin="Gap statistics (Scott Andrews, 'Understanding Gaps', 2011): gap-and-go vs gap-fill",
                category="price_action", rules="Gap >= 0.3% vs the previous close. Gap up holding above the open = continuation; trading back below the open = fade toward the previous close (fill). Already filled = no edge. Mirror for gap downs.")
    intraday = interval_seconds < 86400
    if intraday:
        ref = ind.session_reference(df, True)
        if ref is None:
            return Signal("opening_gap", direction=0, confidence=0, reason="Insufficient data", **meta)
        today = df[df.index.normalize() == df.index[-1].normalize()]
        prev_close, open_px = float(ref["close"]), float(today["open"].iloc[0])
    else:
        if len(df) < 2:
            return Signal("opening_gap", direction=0, confidence=0, reason="Insufficient data", **meta)
        prev_close, open_px = float(df["close"].iloc[-2]), float(df["open"].iloc[-1])
    c = _last(df, "close")
    gap = (open_px / prev_close - 1) * 100 if prev_close else 0.0
    vals = dict(gap_pct=gap, open=open_px, prev_close=prev_close)
    if abs(gap) < 0.3:
        return Signal("opening_gap", direction=0, confidence=0.15, reason=f"No meaningful gap ({gap:+.2f}%)", values=vals, **meta)
    if gap > 0:
        if c <= prev_close:
            return Signal("opening_gap", direction=0, confidence=0.25, reason=f"Gap up {gap:+.2f}% already filled", values=vals, **meta)
        if c < open_px:
            return Signal("opening_gap", direction=-1, confidence=0.5, reason=f"Gap up {gap:+.2f}% fading below the open: fill toward {prev_close:.2f}", values=vals, **meta)
        return Signal("opening_gap", direction=1, confidence=0.4, reason=f"Gap up {gap:+.2f}% holding above the open (gap-and-go)", values=vals, **meta)
    if c >= prev_close:
        return Signal("opening_gap", direction=0, confidence=0.25, reason=f"Gap down {gap:+.2f}% already filled", values=vals, **meta)
    if c > open_px:
        return Signal("opening_gap", direction=1, confidence=0.5, reason=f"Gap down {gap:+.2f}% recovering above the open: fill toward {prev_close:.2f}", values=vals, **meta)
    return Signal("opening_gap", direction=-1, confidence=0.4, reason=f"Gap down {gap:+.2f}% holding below the open (gap-and-go)", values=vals, **meta)


def nr7_crabel(df: pd.DataFrame) -> Signal:
    """Toby Crabel's NR7: the narrowest range in seven bars precedes a range expansion; trade the break of that bar."""
    meta = dict(name="NR7 Narrow Range", origin="Toby Crabel, 'Day Trading with Short Term Price Patterns and Opening Range Breakout' (1990)",
                category="price_action", rules="A bar with the narrowest range of the last 7 (NR7) precedes expansion. If the last bar was NR7: breakout pending, no direction. If the previous bar was NR7: a close above its high = long, below its low = short.")
    if len(df) < 9:
        return Signal("nr7", direction=0, confidence=0, reason="Insufficient data", **meta)
    rng = (df["high"] - df["low"]).tail(8).to_numpy()
    if rng[-1] <= rng[-7:].min():
        return Signal("nr7", direction=0, confidence=0.4, reason="Last bar is an NR7: range contraction, breakout pending", values=dict(range=float(rng[-1])), **meta)
    if rng[-2] <= rng[-8:-1].min():
        hi, lo, c = float(df["high"].iloc[-2]), float(df["low"].iloc[-2]), _last(df, "close")
        if c > hi:
            return Signal("nr7", direction=1, confidence=0.55, reason=f"Broke above the NR7 bar's high {hi:.2f}", values=dict(nr7_high=hi, nr7_low=lo), **meta)
        if c < lo:
            return Signal("nr7", direction=-1, confidence=0.55, reason=f"Broke below the NR7 bar's low {lo:.2f}", values=dict(nr7_high=hi, nr7_low=lo), **meta)
        return Signal("nr7", direction=0, confidence=0.3, reason=f"Inside the NR7 bar's range {lo:.2f} - {hi:.2f}", values=dict(nr7_high=hi, nr7_low=lo), **meta)
    return Signal("nr7", direction=0, confidence=0.1, reason="No narrow-range setup", **meta)


def market_profile_strategy(df: pd.DataFrame, interval_seconds: int) -> Signal:
    """Market Profile value area: acceptance above the value area high is bullish, below the value area low bearish."""
    meta = dict(name="Market Profile Value Area", origin="J. Peter Steidlmayer, CBOT Market Profile (1984); volume-at-price of the previous session, 70% value area",
                category="levels", rules="Close above the value area high (VAH) = buyers accepting higher prices; below the value area low (VAL) = sellers in control; inside value = balance, lean by side of the point of control (POC).")
    mp = ind.market_profile(df, interval_seconds < 86400)
    c, a = _last(df, "close"), _last(df, "atr_14")
    if not mp or np.isnan(a) or a == 0:
        return Signal("market_profile", direction=0, confidence=0, reason="No volume data", **meta)
    if c > mp["vah"]:
        return Signal("market_profile", direction=1, confidence=_clip(0.45 + min((c - mp["vah"]) / a, 2) * 0.05), reason=f"Accepted above value area high {mp['vah']:.2f}", values=mp, **meta)
    if c < mp["val"]:
        return Signal("market_profile", direction=-1, confidence=_clip(0.45 + min((mp["val"] - c) / a, 2) * 0.05), reason=f"Rejected below value area low {mp['val']:.2f}", values=mp, **meta)
    d = 1 if c > mp["poc"] else -1
    return Signal("market_profile", direction=d, confidence=0.15, reason=f"Inside value area ({mp['val']:.2f} - {mp['vah']:.2f}), {'above' if d > 0 else 'below'} POC {mp['poc']:.2f}", values=mp, **meta)


def alligator_williams(df: pd.DataFrame) -> Signal:
    """Bill Williams' Alligator: lips > teeth > jaw with price above = eating up (trend); intertwined = sleeping."""
    meta = dict(name="Williams Alligator", origin="Bill Williams, 'Trading Chaos' (1995); SMMA 13/8/5 shifted 8/5/3",
                category="trend", rules="Lips above teeth above jaw with price above the lips = uptrend (long). The mirror = downtrend (short). Lines intertwined = the alligator sleeps: no trade.")
    al = ind.alligator(df)
    jaw, teeth, lips = (float(al[k].iloc[-1]) for k in ("jaw", "teeth", "lips"))
    c, a = _last(df, "close"), _last(df, "atr_14")
    if any(np.isnan(x) for x in (jaw, teeth, lips)) or np.isnan(a) or a == 0:
        return Signal("alligator", direction=0, confidence=0, reason="Insufficient data", **meta)
    spread = (lips - jaw) / a
    vals = dict(jaw=jaw, teeth=teeth, lips=lips, spread_atr=spread)
    if lips > teeth > jaw and c > lips:
        return Signal("alligator", direction=1, confidence=_clip(0.4 + min(spread, 3) * 0.1), reason=f"Alligator eating up: lips > teeth > jaw, price above ({spread:.1f} ATR mouth)", values=vals, **meta)
    if lips < teeth < jaw and c < lips:
        return Signal("alligator", direction=-1, confidence=_clip(0.4 + min(-spread, 3) * 0.1), reason=f"Alligator eating down: lips < teeth < jaw, price below ({-spread:.1f} ATR mouth)", values=vals, **meta)
    return Signal("alligator", direction=0, confidence=0.25, reason="Alligator sleeping: lines intertwined", values=vals, **meta)


# =============================================================================
#  REGISTRY
# =============================================================================

STRATEGIES: dict[str, Callable] = {
    "golden_cross": golden_cross,
    "ema_crossover": ema_crossover,
    "macd": macd_strategy,
    "adx_dmi": adx_dmi,
    "supertrend": supertrend_strategy,
    "parabolic_sar": parabolic_sar_strategy,
    "ichimoku": ichimoku_strategy,
    "hull_ma": hull_ma_trend,
    "elder_triple_screen": elder_triple_screen,
    "chandelier_exit": chandelier_exit,
    "heikin_ashi": heikin_ashi_trend,
    "rsi_wilder": rsi_wilder,
    "connors_rsi2": connors_rsi2,
    "stochastic": stochastic_lane,
    "cci": cci_lambert,
    "williams_r": williams_r_strategy,
    "momentum_12_1": momentum_12_1,
    "fifty_two_week_high": fifty_two_week_high,
    "bollinger_breakout": bollinger_breakout,
    "bollinger_mr": bollinger_mean_reversion,
    "ttm_squeeze": ttm_squeeze,
    "turtle": turtle_breakout,
    "keltner_pullback": keltner_pullback,
    "volume_breakout": volume_breakout,
    "orb": opening_range_breakout,
    "obv": obv_granville,
    "vwap": vwap_strategy,
    "mfi": mfi_strategy,
    "cmf": chaikin_money_flow_strategy,
    "candlesticks": candlestick_patterns,
    "floor_pivots": floor_pivots,
    "fibonacci": fibonacci_retracement,
    "support_resistance": support_resistance,
    "cpr": cpr_strategy,
    "camarilla": camarilla_strategy,
    "vwap_bands": vwap_bands_strategy,
    "opening_gap": opening_gap,
    "nr7": nr7_crabel,
    "market_profile": market_profile_strategy,
    "alligator": alligator_williams,
}

# strategies whose levels depend on whether the bars are intraday (previous session) or daily+ (previous bar)
NEEDS_INTERVAL = {"orb", "vwap", "floor_pivots", "cpr", "camarilla", "vwap_bands", "opening_gap", "market_profile"}


def run_all(df: pd.DataFrame, interval_seconds: int) -> list[Signal]:
    out: list[Signal] = []
    for key, fn in STRATEGIES.items():
        try:
            sig = fn(df, interval_seconds) if key in NEEDS_INTERVAL else fn(df)
        except Exception as exc:  # a single strategy must never break the analysis
            sig = Signal(key, key, "", "error", 0, 0.0, f"error: {exc}", "")
        out.append(sig)
    return out


def catalog() -> list[dict]:
    """Static description of each strategy (for the UI's strategy reference)."""
    import inspect
    rows = []
    for key, fn in STRATEGIES.items():
        rows.append({"key": key, "doc": inspect.getdoc(fn) or ""})
    return rows
