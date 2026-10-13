"""Combine every strategy and model vote into one prediction.

Two layers:

1. Rule ensemble - every strategy and statistical model votes; weight = base weight (by
   category) x regime adjustment (Hurst) x adaptive accuracy multiplier learned from resolved
   predictions and user feedback.  This gives the bull / bear scores and a rule probability.
2. Walk-forward learner (`learner.py`) - the strategies' votes at every past bar, technical
   features, time-of-day and the NIFTY market factor are fed to four published learners that are
   validated out-of-sample on this very instrument and timeframe.  Its Platt-calibrated
   probability is the final P(up), and a direction is only called where out-of-sample calls of
   the same strength were right at least 55% of the time.  Otherwise the system stands aside
   (SIDEWAYS = no call), which the evaluator does not count against accuracy.

When there is too little history for the learner (< 200 labelled bars) the rule probability is
used with the original 0.58 / 0.42 thresholds.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from . import db, learner
from .data import interval_seconds, bar_is_forming
from .strategies import Signal, run_all as run_strategies
from .models import run_all as run_models
from .indicators import compute_all, pivot_points, fibonacci_levels, cpr_levels, camarilla_levels, is_intraday_index, vwap_bands, market_profile

log = logging.getLogger("tradebot.ensemble")
MAX_LIVE_GAP = 0.2          # a live tick further than this from the last bar (20% = widest NSE circuit) is rejected

BASE_WEIGHT = {
    "trend": 1.0, "momentum": 0.8, "volatility": 0.9, "volume": 0.7,
    "price_action": 0.6, "levels": 0.6, "statistical": 0.9, "ml": 1.1, "regime": 0.0, "error": 0.0,
}

# Strategies whose logic is mean-reverting (fade the move) vs trend-following.
MEAN_REVERSION_KEYS = {"rsi_wilder", "connors_rsi2", "stochastic", "williams_r", "mfi", "bollinger_mr",
                       "floor_pivots", "fibonacci", "support_resistance", "cci", "camarilla", "vwap_bands",
                       "opening_gap", "market_profile"}
TREND_KEYS = {"golden_cross", "ema_crossover", "macd", "adx_dmi", "supertrend", "parabolic_sar", "ichimoku",
              "hull_ma", "elder_triple_screen", "chandelier_exit", "heikin_ashi", "momentum_12_1",
              "fifty_two_week_high", "turtle", "keltner_pullback", "volume_breakout", "bollinger_breakout",
              "ttm_squeeze", "linreg", "cpr", "nr7", "alligator"}

DEFAULT_HORIZON = {"1m": 30, "5m": 24, "15m": 16, "30m": 14, "1h": 12, "1d": 10, "1wk": 6}
FALLBACK_THRESHOLD = 0.58


def adaptive_multiplier(stat: dict | None) -> float:
    """Bayesian-smoothed hit rate -> weight multiplier in [0.3, 2.0]. Few samples => close to 1."""
    if not stat:
        return 1.0
    n = stat["correct"] + stat["incorrect"]
    if n == 0:
        return 1.0
    acc = (stat["correct"] + 1) / (n + 2)
    raw = acc / 0.5
    shrink = min(n, 25) / 25          # trust the stat more as samples accumulate
    return float(np.clip(1 + (raw - 1) * shrink, 0.3, 2.0))


def regime_multiplier(key: str, hurst: float) -> float:
    if hurst > 0.55:
        boost = 1 + (hurst - 0.55) * 4     # up to ~1.4 at H=0.65
        return boost if key in TREND_KEYS else (1 / boost if key in MEAN_REVERSION_KEYS else 1.0)
    if hurst < 0.45:
        boost = 1 + (0.45 - hurst) * 4
        return boost if key in MEAN_REVERSION_KEYS else (1 / boost if key in TREND_KEYS else 1.0)
    return 1.0


def _expires_at(interval: str, horizon: int, last_bar: pd.Timestamp) -> str:
    """Rough wall-clock estimate of when `horizon` more bars will have printed."""
    sec = interval_seconds(interval)
    if sec >= 86400 * 7:
        delta = timedelta(days=7 * horizon)
    elif sec >= 86400:
        delta = timedelta(days=horizon * 7 / 5 + 1)     # skip weekends
    else:
        session = 6.5 * 3600                            # typical cash session
        bars_per_day = session / sec
        days = horizon / bars_per_day
        delta = timedelta(days=days * 7 / 5 + (0 if days < 0.5 else 1))
    return (last_bar.to_pydatetime().replace(tzinfo=timezone.utc) + delta).isoformat()


def analyze(symbol: str, interval: str = "1d", horizon: int | None = None, exchange: str = "",
            df: pd.DataFrame | None = None, as_of: str | pd.Timestamp | None = None,
            live_price: float | None = None) -> dict:
    """Run the full analysis. `as_of` truncates history to that bar so the prediction is made
    with only the information available at that time (used for testing on previous days).

    Signals are always computed on CLOSED bars.  If the last bar in the data is still forming,
    it is excluded from every indicator, strategy and model (a half-finished candle distorts
    RSI, MACD, breakouts and pattern rules), and its latest trade - or `live_price`, the most
    recent streamed tick - is used as the entry price for target / stop / forecast.  The
    prediction therefore covers the forming bar plus the next horizon-1 bars, exactly what the
    evaluator grades."""
    from .data import fetch_ohlcv, normalize_symbol, DataError
    symbol_q = normalize_symbol(symbol, exchange)
    horizon = int(horizon or DEFAULT_HORIZON.get(interval, 10))
    raw = df if df is not None else fetch_ohlcv(symbol_q, interval)
    if as_of is not None:
        cutoff = pd.Timestamp(as_of)
        if cutoff.tzinfo is not None:
            cutoff = cutoff.tz_convert("UTC").tz_localize(None)
        raw = raw[raw.index <= cutoff]
        if len(raw) < 60:
            raise DataError(f"Only {len(raw)} bars available before {cutoff}; need at least 60.")
    sec = interval_seconds(interval)
    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    forming_bar = None
    last_bar_forming = as_of is None and bar_is_forming(symbol_q, interval, raw.index[-1], now_utc)
    if last_bar_forming and len(raw) > 60:
        forming_bar = raw.iloc[-1]
        raw = raw.iloc[:-1]
    data = compute_all(raw)
    data_symbol = raw.attrs.get("data_symbol", symbol_q)

    # ---- layer 1: rule ensemble ------------------------------------------------------------
    signals: list[Signal] = run_strategies(data, sec) + run_models(data, horizon)
    stats = db.strategy_stats()
    hurst = next((s.values.get("hurst", 0.5) for s in signals if s.key == "hurst"), 0.5)

    bull = bear = neutral = 0.0
    rows = []
    model_probs: list[tuple[float, float]] = []

    def add_row(s: Signal, counts: bool) -> dict:
        base = BASE_WEIGHT.get(s.category, 0.5)
        reg = regime_multiplier(s.key, hurst)
        adp = adaptive_multiplier(stats.get(s.key))
        w = base * reg * adp
        contrib = w * s.confidence
        row = s.to_dict()
        row.update({"weight": round(w, 3), "base_weight": base, "regime_mult": round(reg, 3), "adaptive_mult": round(adp, 3),
                    "contribution": round(contrib, 3), "history": stats.get(s.key), "counts_in_rule_score": counts})
        rows.append(row)
        return row

    for s in signals:
        r = add_row(s, True)
        w, contrib = r["weight"], r["contribution"]
        if s.direction > 0:
            bull += contrib
        elif s.direction < 0:
            bear += contrib
        else:
            neutral += contrib * 0.5
        if "prob_up" in s.values and s.confidence > 0:
            model_probs.append((float(s.values["prob_up"]), w * max(s.confidence, 0.15)))

    total = bull + bear + neutral
    net = (bull - bear) / total if total > 0 else 0.0
    rule_prob = 0.5 + net / 2
    if model_probs:
        mp = sum(p * w for p, w in model_probs) / sum(w for _, w in model_probs)
        fallback_prob = 0.65 * rule_prob + 0.35 * mp
    else:
        mp = None
        fallback_prob = rule_prob
    fallback_prob = float(np.clip(fallback_prob, 0.02, 0.98))

    # ---- layer 2: walk-forward learner ------------------------------------------------------
    lp = None
    try:
        lp = learner.predict(data_symbol, interval, horizon, data, sec)
    except Exception:
        log.exception("learner failed for %s %s; using the rule ensemble", data_symbol, interval)
    if lp is not None:
        for s in lp.signals:
            add_row(s, False)          # shown in the table, but they are the final layer, not rule votes
        prob_up = float(np.clip(lp.prob, 0.02, 0.98))
        threshold = lp.fit.threshold
        prob_source = "walk-forward learner"
        learner_summary = lp.summary()
        for r in rows:                 # the level-1 weight each strategy earned on this chart
            if r["key"] in lp.fit.learned_weights:
                r["learned_weight"] = round(lp.fit.learned_weights[r["key"]], 3)
    else:
        prob_up = fallback_prob
        threshold = FALLBACK_THRESHOLD
        prob_source = "rule ensemble"
        learner_summary = {"available": False, "reason": "not enough history for walk-forward validation (need 200+ labelled bars)"}

    if prob_up >= threshold:
        direction = "UP"
    elif prob_up <= 1 - threshold:
        direction = "DOWN"
    else:
        direction = "SIDEWAYS"
    voters = [r for r in rows if r["direction"] != 0 and r["confidence"] >= 0.2]
    d_int = {"UP": 1, "DOWN": -1, "SIDEWAYS": 0}[direction]
    agreeing = sum(1 for r in voters if r["direction"] == d_int)
    agreement = agreeing / len(voters) if voters else 0.0
    expected_accuracy = None
    if lp is not None and direction != "SIDEWAYS":
        expected_accuracy = lp.tier["accuracy"] if lp.tier["accuracy"] is not None else lp.fit.accuracy
        confidence = float(np.clip((expected_accuracy - 0.5) * 2, 0, 1))
    elif direction == "SIDEWAYS":
        confidence = float(np.clip(1 - abs(prob_up - 0.5) * 4, 0, 1)) * 0.6
    else:
        confidence = float(np.clip(abs(prob_up - 0.5) * 2 * (0.5 + 0.5 * agreement), 0, 1))

    # --- price targets ---------------------------------------------------
    last = data.iloc[-1]
    price = float(last["close"])
    price_source = "last close"
    if forming_bar is not None:
        price = float(forming_bar["close"]); price_source = "forming bar"
    if live_price and live_price > 0:
        if abs(live_price / price - 1) <= MAX_LIVE_GAP:
            price = float(live_price); price_source = "live tick"
        else:   # beyond any NSE circuit band: the tick belongs to another chart, so it would corrupt the call
            log.warning("ignored live price %.2f for %s: last bar closed at %.2f", live_price, symbol_q, price)
    atr = float(last["atr_14"]) if pd.notna(last["atr_14"]) else price * 0.01
    mc = next((s for s in signals if s.key == "monte_carlo"), None)
    sigma_move = None
    if mc and "sigma_per_bar" in mc.values:
        sigma_move = price * (np.exp(mc.values["sigma_per_bar"] * np.sqrt(horizon)) - 1)
    atr_move = atr * np.sqrt(horizon) * 0.8
    expected_move = float(np.nanmax([atr_move, sigma_move or 0.0]))
    model_ret = [s.values["expected_return_pct"] for s in signals if "expected_return_pct" in s.values and s.confidence > 0.2]
    if model_ret:
        m = abs(float(np.median(model_ret))) / 100 * price
        expected_move = max(expected_move * 0.7, min(expected_move * 1.5, m)) if m > 0 else expected_move
    if direction == "UP":
        target, stop = price + expected_move, price - 1.5 * atr
    elif direction == "DOWN":
        target, stop = price - expected_move, price + 1.5 * atr
    else:
        target, stop = price, None
    rr = (abs(target - price) / abs(price - stop)) if stop else None

    categories: dict[str, dict] = {}
    for r in rows:
        c = categories.setdefault(r["category"], {"bull": 0.0, "bear": 0.0, "count": 0})
        if r["direction"] > 0:
            c["bull"] += r["contribution"]
        elif r["direction"] < 0:
            c["bear"] += r["contribution"]
        c["count"] += 1

    summary = {
        "bull_score": round(bull, 3), "bear_score": round(bear, 3), "neutral_score": round(neutral, 3),
        "net": round(net, 3), "rule_prob_up": round(rule_prob, 3), "model_prob_up": round(mp, 3) if mp is not None else None,
        "fallback_prob_up": round(fallback_prob, 3), "prob_source": prob_source, "threshold": threshold,
        "expected_accuracy": round(expected_accuracy, 4) if expected_accuracy is not None else None,
        "no_call": direction == "SIDEWAYS", "learner": learner_summary,
        "agreement": round(agreement, 3), "voters": len(voters), "agreeing": agreeing,
        "hurst": round(float(hurst), 3), "regime": next((s.values.get("regime") for s in signals if s.key == "hurst"), None),
        "atr": round(atr, 4), "expected_move": round(expected_move, 4), "risk_reward": round(rr, 2) if rr else None,
        "categories": categories,
        "pivots": pivot_points(data, sec < 86400), "cpr": cpr_levels(data, sec < 86400), "camarilla": camarilla_levels(data, sec < 86400),
        "vwap_bands": vwap_bands(data, sec < 86400), "value_area": market_profile(data, sec < 86400),
        "fibonacci": fibonacci_levels(data, 100),
    }
    last_bar = data.index[-1]

    # --- projected path for the next `horizon` bars (median + 80% band) --------
    sigma = float(mc.values["sigma_per_bar"]) if mc and "sigma_per_bar" in mc.values else atr / price
    t0 = int(pd.Timestamp(last_bar).timestamp())
    forecast = []
    for k in range(1, horizon + 1):
        median = price + d_int * expected_move * np.sqrt(k / horizon)
        band = 1.28 * sigma * np.sqrt(k)
        forecast.append({"time": t0 + k * sec, "bar": k, "median": round(median, 4),
                         "upper": round(median * np.exp(band), 4), "lower": round(median * np.exp(-band), 4)})
    nb = forecast[0]
    next_bar = {"direction": direction, "prob_up": round(prob_up, 4), "expected_close": nb["median"],
                "range_low": nb["lower"], "range_high": nb["upper"], "time": nb["time"]}
    return {
        "symbol": symbol_q, "interval": interval, "horizon_bars": horizon,
        "bar_time": last_bar.isoformat(), "created_at": db.now_iso(),
        "last_bar_forming": bool(last_bar_forming), "price_source": price_source,
        "forming_bar_time": forming_bar.name.isoformat() if forming_bar is not None else None,
        "as_of": pd.Timestamp(as_of).isoformat() if as_of is not None else None,
        "data_symbol": data_symbol, "note": raw.attrs.get("note"),
        "forecast": forecast, "next_bar": next_bar,
        "price_at": price, "direction": direction, "prob_up": round(prob_up, 4), "confidence": round(confidence, 4),
        "target_price": round(target, 4), "stop_price": round(stop, 4) if stop else None,
        "expected_move_pct": round(expected_move / price * 100, 4),
        "expires_at": _expires_at(interval, horizon, last_bar),
        "signals": rows, "summary": summary,
        "indicators": {k: (round(float(last[k]), 4) if pd.notna(last[k]) else None) for k in
                       ("open", "high", "low", "close", "volume", "sma_20", "sma_50", "sma_200", "ema_9", "ema_21", "ema_50", "ema_200",
                        "rsi_14", "rsi_2", "macd", "macd_signal", "macd_hist", "adx", "plus_di", "minus_di", "stoch_k", "stoch_d",
                        "cci_20", "williams_r", "mfi_14", "atr_14", "bb_upper", "bb_mid", "bb_lower", "bb_width", "bb_pct",
                        "kc_upper", "kc_lower", "supertrend", "psar", "tenkan", "kijun", "senkou_a", "senkou_b", "obv", "vwap_20",
                        "cmf_20", "hma_20", "volatility_20", "vol_sma_20")},
    }


def chart_levels(df: pd.DataFrame) -> dict:
    """Floor pivots, CPR and Camarilla levels for the last bar's session, drawn as lines on the chart."""
    intraday = is_intraday_index(pd.DatetimeIndex(df.index))
    try:
        return {"intraday": intraday, "pivots": pivot_points(df, intraday), "cpr": cpr_levels(df, intraday),
                "camarilla": camarilla_levels(df, intraday)}
    except Exception:  # pragma: no cover - a levels failure must never break the chart
        return {}


def chart_payload(df: pd.DataFrame, max_bars: int = 600, since: int | None = None) -> dict:
    """Candles + overlay series + session levels for the front-end chart.

    `since` (unix seconds) returns only bars at or after that time - indicators are still
    computed on the full history so the values match a full load exactly."""
    levels = chart_levels(df)
    data = compute_all(df).tail(max_bars)
    if since is not None:
        data = data[data.index >= pd.Timestamp(int(since), unit="s")]
        if data.empty:
            return {"candles": [], "volume": [], "overlays": {}, "panes": {}, "last": None, "levels": levels}
    ts = pd.DatetimeIndex(data.index).as_unit("s").asi8.tolist()

    def series(col):
        vals = data[col]
        return [{"time": t, "value": round(float(v), 6)} for t, v in zip(ts, vals) if pd.notna(v)]

    candles = [{"time": t, "open": float(o), "high": float(h), "low": float(l), "close": float(c)}
               for t, o, h, l, c in zip(ts, data["open"], data["high"], data["low"], data["close"])]
    volume = [{"time": t, "value": float(v), "color": "rgba(38,166,154,0.5)" if c >= o else "rgba(239,83,80,0.5)"}
              for t, v, o, c in zip(ts, data["volume"], data["open"], data["close"])]
    overlays = {k: series(k) for k in ("sma_20", "sma_50", "sma_200", "ema_9", "ema_21", "bb_upper", "bb_lower",
                                        "supertrend", "psar", "vwap_20", "senkou_a", "senkou_b", "kc_upper", "kc_lower")}
    panes = {k: series(k) for k in ("rsi_14", "macd", "macd_signal", "macd_hist", "adx", "stoch_k", "stoch_d", "obv", "cci_20", "mfi_14")}
    return {"candles": candles, "volume": volume, "overlays": overlays, "panes": panes, "levels": levels,
            "last": {"time": ts[-1], "close": float(data["close"].iloc[-1])}}
