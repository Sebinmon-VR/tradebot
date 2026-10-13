"""Statistical prediction models.

Each model forecasts the direction of the close `horizon` bars ahead and returns
a `Signal` (same shape as the rule-based strategies) whose `values` carry
`prob_up` and `expected_return_pct`.  The machine-learning layer lives in
`learner.py`: it is validated walk-forward and produces the final calibrated
probability, so it is not a plain vote like the models here.
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from .strategies import Signal, _clip
from . import indicators as ind

warnings.filterwarnings("ignore")

# ----------------------------------------------------------------- statistical
def linear_regression_trend(df: pd.DataFrame, horizon: int, window: int = 60) -> Signal:
    """OLS trend on log price: slope significance (t-stat) and R-squared give direction & confidence."""
    meta = dict(name="Linear Regression Trend", origin="Ordinary least squares on log price (classic regression channel)",
                category="statistical", rules="Fit a line through the last 60 log-closes. Positive, statistically significant slope = up; negative = down. R-squared measures how clean the trend is.")
    y = np.log(df["close"].tail(window).to_numpy())
    n = len(y)
    if n < 20:
        return Signal("linreg", direction=0, confidence=0, reason="Insufficient data", **meta)
    x = np.arange(n)
    slope, intercept = np.polyfit(x, y, 1)
    fitted = intercept + slope * x
    resid = y - fitted
    ss_res, ss_tot = float((resid ** 2).sum()), float(((y - y.mean()) ** 2).sum()) or 1e-12
    r2 = 1 - ss_res / ss_tot
    se = np.sqrt(ss_res / max(n - 2, 1) / ((x - x.mean()) ** 2).sum())
    t = slope / se if se > 0 else 0.0
    spot = float(df["close"].iloc[-1])
    exp_ret = (np.exp(slope * horizon) - 1) * 100
    proj = spot * (1 + exp_ret / 100)
    d = 1 if slope > 0 else -1
    conf = _clip(min(abs(t), 8) / 8 * 0.6 + r2 * 0.4)
    prob = _clip(0.5 + d * conf / 2)
    return Signal("linreg", direction=d, confidence=conf,
                  reason=f"Slope {slope*100:+.3f}%/bar, t-stat {t:.1f}, R2 {r2:.2f}; projected {exp_ret:+.2f}% in {horizon} bars",
                  values=dict(prob_up=prob, expected_return_pct=exp_ret, r2=r2, t_stat=t, projected_price=proj), **meta)


def ar_returns(df: pd.DataFrame, horizon: int, p: int = 5, window: int = 250) -> Signal:
    """Autoregressive AR(p) model on log returns, iterated `horizon` steps ahead."""
    meta = dict(name="Autoregressive AR(5)", origin="Box-Jenkins time-series forecasting (AR component of ARIMA)",
                category="statistical", rules="Regress each return on the previous 5 returns, then roll the forecast forward. Sign of the cumulative forecast gives direction; size relative to volatility gives confidence.")
    r = np.log(df["close"]).diff().dropna().tail(window).to_numpy()
    if len(r) < p * 6:
        return Signal("ar_model", direction=0, confidence=0, reason="Insufficient data", **meta)
    X = np.column_stack([r[p - i - 1:len(r) - i - 1] for i in range(p)] + [np.ones(len(r) - p)])
    y = r[p:]
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid_sd = float(np.std(y - X @ beta)) or 1e-9
    hist = list(r[-p:])
    fc = []
    for _ in range(horizon):
        xrow = np.array(hist[-p:][::-1] + [1.0])
        nxt = float(xrow @ beta)
        fc.append(nxt)
        hist.append(nxt)
    cum = float(np.sum(fc))
    exp_ret = (np.exp(cum) - 1) * 100
    z = cum / (resid_sd * np.sqrt(horizon))
    d = 1 if cum > 0 else -1
    conf = _clip(abs(z) * 0.8)
    prob = _clip(0.5 + d * conf / 2)
    return Signal("ar_model", direction=d, confidence=conf,
                  reason=f"AR(5) forecasts {exp_ret:+.2f}% over {horizon} bars (z {z:+.2f})",
                  values=dict(prob_up=prob, expected_return_pct=exp_ret, z=z), **meta)


def monte_carlo_gbm(df: pd.DataFrame, horizon: int, paths: int = 4000, window: int = 250, seed: int = 7) -> Signal:
    """Geometric Brownian Motion Monte Carlo: probability of finishing above spot after `horizon` bars."""
    meta = dict(name="Monte Carlo (GBM)", origin="Black-Scholes-Merton style geometric Brownian motion simulation",
                category="statistical", rules="Simulate thousands of price paths using historical drift (shrunk 50% toward zero) and volatility. P(final > spot) is the up-probability; the 10th/90th percentiles bound the expected range.")
    r = np.log(df["close"]).diff().dropna().tail(window).to_numpy()
    if len(r) < 30:
        return Signal("monte_carlo", direction=0, confidence=0, reason="Insufficient data", **meta)
    mu = float(r.mean()) * 0.5
    sigma = float(r.std()) or 1e-9
    rng = np.random.default_rng(seed)
    shocks = rng.standard_normal((paths, horizon))
    cum = (mu - 0.5 * sigma ** 2) * horizon + sigma * shocks.sum(axis=1)
    spot = float(df["close"].iloc[-1])
    final = spot * np.exp(cum)
    prob = float((final > spot).mean())
    q10, q50, q90 = (float(np.percentile(final, q)) for q in (10, 50, 90))
    d = 1 if prob > 0.5 else -1
    conf = _clip(abs(prob - 0.5) * 2.5)
    return Signal("monte_carlo", direction=d, confidence=conf,
                  reason=f"P(up) {prob*100:.0f}%; median {q50:.2f}, 80% range {q10:.2f} - {q90:.2f}",
                  values=dict(prob_up=prob, expected_return_pct=(q50 / spot - 1) * 100, q10=q10, q50=q50, q90=q90,
                              sigma_per_bar=sigma, drift_per_bar=mu), **meta)


def knn_pattern_analog(df: pd.DataFrame, horizon: int, window: int = 20, k: int = 30) -> Signal:
    """Nearest-neighbour analog forecasting: find the most similar past price patterns and see what followed."""
    meta = dict(name="Pattern Analog (kNN)", origin="Analog / nearest-neighbour forecasting (Lorenz 1969; widely used pattern-matching approach)",
                category="statistical", rules="Normalise the last 20 returns, find the 30 most similar historical windows (Euclidean distance) and measure what price did over the next `horizon` bars. Share of positive outcomes = P(up).")
    r = np.log(df["close"]).diff().dropna().to_numpy()
    n = len(r)
    if n < window + horizon + k + 20:
        return Signal("knn_analog", direction=0, confidence=0, reason="Insufficient history for analogs", **meta)
    def norm(v):
        s = v.std()
        return (v - v.mean()) / (s if s > 0 else 1)
    cur = norm(r[-window:])
    cands = []
    for i in range(window, n - horizon):
        seg = norm(r[i - window:i])
        dist = float(np.linalg.norm(seg - cur))
        fwd = float(np.sum(r[i:i + horizon]))
        cands.append((dist, fwd))
    cands.sort(key=lambda t: t[0])
    top = cands[:k]
    fwd = np.array([f for _, f in top])
    prob = float((fwd > 0).mean())
    exp_ret = (np.exp(float(np.median(fwd))) - 1) * 100
    d = 1 if prob > 0.5 else -1
    conf = _clip(abs(prob - 0.5) * 2)
    return Signal("knn_analog", direction=d, confidence=conf,
                  reason=f"{int(prob*k)} of {k} closest historical patterns went up; median move {exp_ret:+.2f}%",
                  values=dict(prob_up=prob, expected_return_pct=exp_ret, neighbours=k), **meta)


def hurst_regime(df: pd.DataFrame) -> Signal:
    """Hurst exponent regime detector: tells the ensemble whether to trust trend or mean-reversion strategies."""
    h = ind.hurst_exponent(df["close"].tail(300))
    meta = dict(name="Hurst Regime", origin="H.E. Hurst (1951); Peters, 'Fractal Market Analysis' (1994)",
                category="regime", rules="H > 0.55 = persistent / trending market (weight trend-followers up). H < 0.45 = mean-reverting (weight oscillators up). ~0.5 = random walk.")
    label = "trending" if h > 0.55 else ("mean-reverting" if h < 0.45 else "random-walk")
    return Signal("hurst", direction=0, confidence=_clip(abs(h - 0.5) * 4), reason=f"Hurst {h:.2f}: {label} regime",
                  values=dict(hurst=h, regime=label), **meta)


MODELS = {
    "linreg": linear_regression_trend,
    "ar_model": ar_returns,
    "monte_carlo": monte_carlo_gbm,
    "knn_analog": knn_pattern_analog,
}


def run_all(df: pd.DataFrame, horizon: int) -> list[Signal]:
    out: list[Signal] = []
    for key, fn in MODELS.items():
        try:
            out.append(fn(df, horizon))
        except Exception as exc:
            out.append(Signal(key, key, "", "error", 0, 0.0, f"error: {exc}", ""))
    try:
        out.append(hurst_regime(df))
    except Exception as exc:
        out.append(Signal("hurst", "Hurst Regime", "", "regime", 0, 0.0, f"error: {exc}", ""))
    return out
