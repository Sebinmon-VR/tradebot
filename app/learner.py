"""Walk-forward stacked learner: the layer that turns strategy votes and market features
into one calibrated probability and decides whether the system has enough edge to call a
direction at all.

Every piece is a published method:

* Stacked generalisation (Wolpert, 1992) - the strategies are level-0 models; their votes at
  every past bar become inputs to a level-1 learner that discovers which strategies actually
  work on this instrument and timeframe, and how they combine.
* Purged, embargoed walk-forward cross-validation (Lopez de Prado, "Advances in Financial
  Machine Learning", 2018) - each test fold is predicted by a model trained only on bars that
  finished before it, with `horizon` bars purged so overlapping labels cannot leak.
* Platt scaling (Platt, 1999) - the out-of-fold probabilities are recalibrated so that "P(up)
  = 65%" means calls of that strength were right about 65% of the time here.
* Base learners: L2 logistic regression, Random Forest (Breiman, 2001) and histogram gradient
  boosting (Friedman, 2001; Ke et al., 2017).
* Market factor (Sharpe, 1964 CAPM): a stock's recent NIFTY 50 returns and its return relative
  to the index are features, since most single-stock moves are market beta.
* Recency weighting: training rows and the calibration set are exponentially weighted toward the
  present, so the calibrated probability's drift component follows the prevailing regime (time-series
  momentum, Moskowitz-Ooi-Pedersen 2012) rather than a multi-year average, and the reported accuracy
  describes recent, not ancient, performance.

The learner never uses a bar after the one it is asked to predict from, so as-of analyses and
backtests are honest.
"""
from __future__ import annotations

import hashlib
import logging
import os
import pickle
import re
import threading
import time
import warnings
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .strategies import Signal, STRATEGIES, NEEDS_INTERVAL, _clip
from .data import INDIA_SESSION_UTC, is_indian, fetch_ohlcv
from .db import DB_PATH
from .priority import yield_if_busy

log = logging.getLogger("tradebot.learner")
# scikit-learn 1.9 on Python 3.14 emits this from inside its own thread pools; it is harmless noise
warnings.filterwarnings("ignore", message=".*sklearn.utils.parallel.delayed.*")

try:
    from sklearn.ensemble import RandomForestClassifier, HistGradientBoostingClassifier
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler, FunctionTransformer
    HAVE_SKLEARN = True
except Exception:  # pragma: no cover
    HAVE_SKLEARN = False

VOTE_WINDOW = 320          # bars of context each historical strategy call sees (longest lookback is 252)
MAX_ROWS = 1500            # most recent bars used for training
MIN_ROWS = 200             # labelled rows needed before the learner is trusted at all
MIN_TRAIN = 120            # smallest training set for a walk-forward fold
FOLDS = 5
TEST_SHARE = 0.6           # the most recent share of history that is predicted out-of-sample
THRESHOLDS = (0.52, 0.55, 0.58, 0.60, 0.65, 0.70)
MIN_TIER_ACC = 0.55        # a direction is only called where out-of-sample accuracy reached this
MARKET_SYMBOL = "^NSEI"
FIT_MAX_AGE = 3600         # seconds a fitted model is reused before a refit is forced (outside the NSE once-a-session rule)
FIT_SESSION_MAX_AGE = 4 * 86400     # an NSE intraday fit from the last session is reused at most this long (long weekends)
FITS_IN_MEMORY = 80        # fitted models kept in RAM (~1 MB each) (the rest are reloaded from data/cache/fits)
CLIP_SD = 4.0              # standardised features are clipped here so one outlier bar cannot swing a linear model
TRAIN_HALF_LIFE = 0.5      # training weight half-life as a share of the training rows (mild)
CAL_HALF_LIFE = 0.2        # calibration weight half-life as a share of the out-of-fold rows (fast: follows the regime)
CAL_HALF_LIFE_MIN = 40     # ... but never shorter than this many rows
TECH_COLS = ["rsi_14", "rsi_2", "stoch_k", "williams_r", "cci_20", "mfi_14", "adx", "roc_10", "roc_60",
             "bb_pct", "bb_width", "volatility_20", "supertrend_dir", "psar_dir", "cmf_20"]

LEARNER_META = {
    "logistic_regression": dict(name="Logistic Regression (walk-forward)", origin="L2-regularised logistic regression on standardised features; purged walk-forward CV (Lopez de Prado 2018)",
                                rules="Linear model of P(up in `horizon` bars) from ~70 technical, market-factor, time and strategy-vote features. Validated out-of-sample on the most recent 60% of history in 5 expanding folds."),
    "random_forest": dict(name="Random Forest (walk-forward)", origin="Breiman (2001); 200 trees, purged walk-forward CV",
                          rules="Bagged decision trees on the same feature set. Reports the walk-forward accuracy so you can see whether it has any edge on this chart."),
    "gradient_boosting": dict(name="Gradient Boosting (walk-forward)", origin="Friedman (2001); histogram-based implementation (Ke et al. 2017), purged walk-forward CV",
                              rules="Boosted shallow trees on the same feature set; captures non-linear interactions between indicators and market context."),
    "stacked_votes": dict(name="Stacked Strategy Votes (Wolpert)", origin="Stacked generalisation (Wolpert 1992): level-1 logistic regression over every strategy's vote",
                          rules="Learns a weight for every strategy from its historical votes on this instrument and timeframe - a negative weight means the strategy has been contrarian here."),
    "wf_ensemble": dict(name="Calibrated Ensemble", origin="Average of the four walk-forward learners, Platt-scaled (Platt 1999) on out-of-fold predictions",
                        rules="The final probability. A direction is called only where out-of-sample calls of the same strength were right at least 55% of the time; otherwise the system stands aside (no call)."),
}

# --------------------------------------------------------------------------- caches
CACHE_DIR = os.environ.get("TRADEBOT_CACHE", os.path.join(os.path.dirname(DB_PATH), "cache"))
_VOTES: dict[tuple[str, str], pd.DataFrame] = {}
_VOTE_LOCK = threading.Lock()
_FITS: dict[tuple[str, str, int], "Fit"] = {}
_FIT_LOCKS: dict[tuple, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _fit_lock(key: tuple) -> threading.Lock:
    with _LOCKS_GUARD:
        return _FIT_LOCKS.setdefault(key, threading.Lock())


def _vote_file(symbol: str, interval: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", f"{symbol}_{interval}")
    return os.path.join(CACHE_DIR, f"votes_{safe}.pkl")


def _load_votes(symbol: str, interval: str) -> pd.DataFrame | None:
    """Votes survive restarts: they are pure functions of closed bars, so a pickle in data/cache is safe."""
    try:
        f = _vote_file(symbol, interval)
        if os.path.exists(f):
            df = pd.read_pickle(f)
            if isinstance(df, pd.DataFrame) and "_close" in df and set(STRATEGIES) <= set(df.columns):
                return df
    except Exception as exc:  # pragma: no cover
        log.warning("could not load vote cache for %s %s: %s", symbol, interval, exc)
    return None


def _save_votes(symbol: str, interval: str, df: pd.DataFrame) -> None:
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = _vote_file(symbol, interval) + ".tmp"
        df.to_pickle(tmp)
        os.replace(tmp, _vote_file(symbol, interval))
    except Exception as exc:  # pragma: no cover
        log.warning("could not save vote cache for %s %s: %s", symbol, interval, exc)


# --------------------------------------------------------------------------- strategy votes at every bar
def _votes_for_bar(window: pd.DataFrame, sec: int) -> dict:
    row = {}
    for key, fn in STRATEGIES.items():
        try:
            s = fn(window, sec) if key in NEEDS_INTERVAL else fn(window)
            row[key] = float(s.direction) * float(np.clip(s.confidence, 0.0, 1.0))
        except Exception:
            row[key] = 0.0
    return row


def training_stride(horizon: int) -> int:
    """Adjacent bars carry almost the same `horizon`-bar label, so long horizons are sampled every 2-3 bars."""
    return int(max(1, min(3, horizon // 8)))


def _sample_bars(index: pd.Index, max_rows: int, stride: int, sec: int, cached: pd.Index | None) -> pd.DatetimeIndex:
    """Up to `max_rows` bars, every `stride`-th one, plus the last bar.  The grid is pinned to fixed clock
    slots (bar time // interval), not counted back from the last bar: counting back shifted the whole grid
    by one bar on every new candle, so nearly every cached vote missed and ~500 bars were recomputed per
    analysis.  Of the `stride` possible grids the one the cache already covers best is used."""
    t = pd.DatetimeIndex(index)
    if stride <= 1 or len(t) == 0:
        return t[-max_rows:]
    slot = np.asarray((t - pd.Timestamp("1970-01-01", tz=t.tz)) // pd.Timedelta(seconds=sec))
    phase = 0
    if cached is not None and len(cached):
        have = t.isin(cached)
        phase = max(range(stride), key=lambda ph: (int(have[slot % stride == ph].sum()), -ph))
    picked = t[slot % stride == phase][-max_rows:]
    if picked.empty or picked[-1] != t[-1]:
        picked = picked.append(t[-1:])
    return picked


def strategy_votes(symbol: str, interval: str, data: pd.DataFrame, sec: int, max_rows: int = MAX_ROWS, stride: int = 1) -> pd.DataFrame:
    """Signed vote (direction x confidence) of every strategy at up to `max_rows` closed bars of `data`
    (an indicator-enriched frame), sampled every `stride` bars and always including the last bar.
    A bar's vote depends only on bars up to it, so rows are cached per (symbol, interval) and reused
    by later analyses, as-of runs and backtests.  If a cached bar's close no longer matches (Yahoo
    re-adjusted history) the cache is rebuilt."""
    key = (symbol, interval)
    with _VOTE_LOCK:
        cached = _VOTES.get(key)
        if cached is None:
            cached = _load_votes(symbol, interval)
            if cached is not None:
                _VOTES[key] = cached
    idx = _sample_bars(data.index, max_rows, stride, sec, None if cached is None else cached.index)
    if cached is not None:
        # A bar's vote depends on every bar up to it, so if Yahoo revised a bar, drop the cached
        # votes from that bar onward (earlier ones are still exact) instead of rebuilding everything.
        common = cached.index.intersection(data.index)
        if len(common):
            same = np.isclose(cached.loc[common, "_close"].to_numpy(), data.loc[common, "close"].to_numpy(), rtol=1e-6)
            if not same.all():
                first_bad = common[int(np.argmax(~same))]
                cached = cached[cached.index < first_bad]
                log.info("vote cache for %s %s: bar %s was revised, recomputing from there", symbol, interval, first_bad)
                if cached.empty:
                    cached = None
    missing = idx if cached is None else idx.difference(cached.index)
    if len(missing):
        t0 = time.time()
        pos = data.index.get_indexer(missing)
        rows = []
        for i, p in enumerate(pos):
            if i % 20 == 0:
                yield_if_busy()          # the background scanner steps aside while you load a chart or analyse
            window = data.iloc[max(0, p - VOTE_WINDOW + 1): p + 1]
            r = _votes_for_bar(window, sec)
            r["_close"] = float(data["close"].iloc[p])
            rows.append(r)
        new = pd.DataFrame(rows, index=missing)
        cached = new if cached is None else pd.concat([cached, new]).sort_index()
        cached = cached[~cached.index.duplicated(keep="last")]
        if len(cached) > MAX_ROWS * 2:
            cached = cached.iloc[-MAX_ROWS * 2:]
        with _VOTE_LOCK:
            _VOTES[key] = cached
        _save_votes(symbol, interval, cached)
        log.info("computed strategy votes for %d bars of %s %s in %.1fs", len(missing), symbol, interval, time.time() - t0)
    return cached.reindex(idx)


# --------------------------------------------------------------------------- features
def market_features(symbol: str, interval: str, index: pd.DatetimeIndex) -> pd.DataFrame | None:
    """NIFTY 50 returns aligned to the instrument's bars (only bars at or before each timestamp)."""
    if not is_indian(symbol) or symbol == MARKET_SYMBOL:
        return None
    try:
        m = fetch_ohlcv(MARKET_SYMBOL, interval, max_age=30)      # one index download serves every stock analysed within 30 s
    except Exception as exc:
        log.warning("market factor unavailable: %s", exc)
        return None
    c = m["close"]
    f = pd.DataFrame({"mkt_ret_1": c.pct_change(), "mkt_ret_5": c.pct_change(5), "mkt_ret_20": c.pct_change(20),
                      "mkt_vol_20": c.pct_change().rolling(20).std()})
    f = f[~f.index.duplicated(keep="last")].sort_index()
    return f.reindex(index, method="ffill")


def build_features(data: pd.DataFrame, votes: pd.DataFrame, market: pd.DataFrame | None, horizon: int, sec: int) -> tuple[pd.DataFrame, pd.Series]:
    """Feature matrix (one row per bar in `votes.index`) and the label: did the close rise over the next `horizon` bars."""
    d = data.loc[votes.index]
    c, o, h, l, v = d["close"], d["open"], d["high"], d["low"], d["volume"]
    f = pd.DataFrame(index=d.index)
    for col in TECH_COLS:
        if col in d:
            f[col] = d[col]
    f["macd_hist_n"] = d["macd_hist"] / c
    f["di_diff"] = d["plus_di"] - d["minus_di"]
    full_c = data["close"]
    for n in (1, 2, 3, 5, 10, 20):
        f[f"ret_{n}"] = full_c.pct_change(n).reindex(d.index)
    f["ret_h"] = full_c.pct_change(horizon).reindex(d.index)
    f["dist_sma20"] = c / d["sma_20"] - 1
    f["dist_sma50"] = c / d["sma_50"] - 1
    f["dist_ema200"] = c / d["ema_200"] - 1
    f["dist_hma20"] = c / d["hma_20"] - 1
    f["atr_pct"] = d["atr_14"] / c
    f["vol_ratio"] = v / d["vol_sma_20"].replace(0, np.nan)
    vol_full = data["volume"]
    f["vol_z"] = ((vol_full - vol_full.rolling(20).mean()) / vol_full.rolling(20).std().replace(0, np.nan)).reindex(d.index)
    f["obv_slope"] = (data["obv"].diff(5) / data["volume"].rolling(5).sum().replace(0, np.nan)).reindex(d.index)
    f["hl_range"] = (h - l) / c
    f["body"] = (c - o) / c
    f["range_pos"] = ((c - l) / (h - l).replace(0, np.nan))
    f["gap"] = (data["open"] / data["close"].shift(1) - 1).reindex(d.index)
    r1 = full_c.pct_change()
    f["rv_ratio"] = (r1.rolling(5).std() / r1.rolling(20).std().replace(0, np.nan)).reindex(d.index)
    f["dist_dc20"] = (c - d["dc20_lower"]) / (d["dc20_upper"] - d["dc20_lower"]).replace(0, np.nan)
    cloud_top = np.maximum(d["senkou_a"], d["senkou_b"])
    cloud_bot = np.minimum(d["senkou_a"], d["senkou_b"])
    f["cloud_pos"] = np.where(c > cloud_top, (c - cloud_top) / c, np.where(c < cloud_bot, (c - cloud_bot) / c, 0.0))
    idx = pd.DatetimeIndex(d.index)
    if sec < 86400:
        # NSE session 09:15-15:30 IST = 03:45-10:00 UTC: position within the day matters (open/close effects)
        tod = ((idx.hour * 60 + idx.minute) - (3 * 60 + 45)) / 375.0
        f["tod"] = np.clip(tod, 0, 1)
        f["tod_sin"] = np.sin(2 * np.pi * f["tod"])
        f["tod_cos"] = np.cos(2 * np.pi * f["tod"])
    dow = idx.dayofweek.to_numpy()
    f["dow_sin"] = np.sin(2 * np.pi * dow / 5)
    f["dow_cos"] = np.cos(2 * np.pi * dow / 5)
    if market is not None:
        f = f.join(market)
        f["rel_5"] = f["ret_5"] - f["mkt_ret_5"]
        f["rel_20"] = f["ret_20"] - f["mkt_ret_20"]
    f = f.join(votes.drop(columns=["_close"]).add_prefix("v_"))
    fwd = full_c.shift(-horizon).reindex(d.index)
    y = (fwd > c).astype(float)
    y[fwd.isna()] = np.nan
    f = f.replace([np.inf, -np.inf], np.nan).astype(float)
    return f, y


# --------------------------------------------------------------------------- learners
def _recency_weights(n: int, half_life: float) -> np.ndarray:
    """Exponential weights, 1 for the newest row, halving every `half_life` rows, scaled to mean 1."""
    if n <= 0:
        return np.zeros(0)
    age = np.arange(n)[::-1].astype(float)
    w = 0.5 ** (age / max(float(half_life), 1.0))
    return w * (n / w.sum())


def _kish(w: np.ndarray) -> float:
    """Effective sample size of a weighted sample (Kish 1965)."""
    return float(w.sum() ** 2 / (w ** 2).sum()) if len(w) and (w ** 2).sum() > 0 else 0.0


class _Pipe:
    """A scikit-learn pipeline with fit(X, y, sample_weight) routed to its final step."""

    def __init__(self, pipe, step: str):
        self.pipe, self.step = pipe, step

    def fit(self, X, y, sample_weight=None):
        kw = {f"{self.step}__sample_weight": sample_weight} if sample_weight is not None else {}
        self.pipe.fit(X, y, **kw)
        return self

    def predict_proba(self, X):
        return self.pipe.predict_proba(X)

    @property
    def named_steps(self):
        return self.pipe.named_steps


class _ColumnSubset:
    """Fit a model on a subset of columns (used for the stacked level-1 model over strategy votes)."""

    def __init__(self, cols: list[int], model):
        self.cols, self.model = cols, model

    def fit(self, X, y, sample_weight=None):
        self.model.fit(X[:, self.cols], y, sample_weight=sample_weight)
        return self

    def predict_proba(self, X):
        return self.model.predict_proba(X[:, self.cols])


class _DropConstant:
    """Drop all-NaN / constant columns at fit time (histogram binning cannot bin fewer than two
    distinct values) and select the same columns at predict time.  Sample weights are deliberately
    NOT forwarded: the histogram booster falls back to a path that is ~35x slower with weights, and
    the other learners plus the calibration already carry the recency weighting."""

    def __init__(self, model):
        self.model, self.cols = model, None

    def fit(self, X, y, sample_weight=None):
        keep = []
        for j in range(X.shape[1]):
            col = X[:, j]
            col = col[np.isfinite(col)]
            if len(col) and np.nanmax(col) > np.nanmin(col):
                keep.append(j)
        self.cols = keep
        self.model.fit(X[:, keep], y)
        return self

    def predict_proba(self, X):
        return self.model.predict_proba(X[:, self.cols])


def _clip_sd(X):
    return np.clip(X, -CLIP_SD, CLIP_SD)


def _clipper():
    return FunctionTransformer(_clip_sd)          # a named function, not a lambda, so fitted models can be pickled


def _makers(vote_cols: list[int]) -> dict:
    return {
        "logistic_regression": lambda: _Pipe(make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), _clipper(),
                                                           LogisticRegression(C=0.02, max_iter=3000)), "logisticregression"),
        "random_forest": lambda: _Pipe(make_pipeline(SimpleImputer(strategy="median"),
                                                     RandomForestClassifier(n_estimators=200, min_samples_leaf=15, max_features="sqrt",
                                                                            n_jobs=1, random_state=42)), "randomforestclassifier"),
        "gradient_boosting": lambda: _DropConstant(HistGradientBoostingClassifier(max_iter=100, learning_rate=0.03, max_depth=3,
                                                                                  min_samples_leaf=30, l2_regularization=2.0, random_state=42)),
        "stacked_votes": lambda: _ColumnSubset(vote_cols, _Pipe(make_pipeline(StandardScaler(), _clipper(), LogisticRegression(C=0.05, max_iter=3000)),
                                                                "logisticregression")),
    }


def _logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-x))


def _logloss(p: np.ndarray, y: np.ndarray, w: np.ndarray | None = None) -> float:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    ll = -(y * np.log(p) + (1 - y) * np.log(1 - p))
    return float(np.average(ll, weights=w)) if w is not None else float(ll.mean())


@dataclass
class Fit:
    symbol: str
    interval: str
    horizon: int
    last_bar: pd.Timestamp
    fitted_at: float
    n_rows: int
    n_features: int
    folds: int
    base_rate: float                # share of the majority outcome out-of-fold ("always call the drift" accuracy)
    up_rate: float                  # share of out-of-fold windows that closed higher
    accuracy: float                 # calibrated out-of-fold accuracy at the 0.5 threshold
    logloss: float
    logloss_base: float
    tiers: list[dict]
    threshold: float
    validated: bool
    evidence: str                   # strong / weak / none
    edge_z: float
    effective_n: int
    learner_scores: dict
    models: dict = field(repr=False)
    half_life: int = 0              # calibration weight half-life in out-of-fold rows
    platt: tuple[float, float] = (1.0, 0.0)
    feature_names: list[str] = field(default_factory=list)
    learned_weights: dict = field(default_factory=dict)
    top_features: list = field(default_factory=list)

    def calibrate(self, p_raw: float) -> float:
        a, b = self.platt
        return float(_sigmoid(a * _logit(np.array([p_raw])) + b)[0])

    def tier_for(self, prob: float) -> dict:
        strength = abs(prob - 0.5) + 0.5
        best = self.tiers[0]
        for t in self.tiers:
            if strength >= t["threshold"] - 1e-12:
                best = t
        return best


def tier_evidence(tier: dict, base_rate: float, horizon: int, validated: bool) -> tuple[float, int, str]:
    """(z, effective_n, label).  z = how many standard errors the tier's out-of-sample accuracy sits above
    "always call the majority side", counting roughly n / horizon independent outcomes because adjacent
    bars share most of their `horizon`-bar window.  strong >= 1.64, weak >= 0.8, drift = reliable enough
    to call but not better than following the prevailing drift, none = not called."""
    n = int(tier.get("n") or 0)
    eff = max(1, int(round(float(tier.get("n_eff") or n) / max(1, horizon))))
    if tier.get("accuracy") is None or n == 0:
        return 0.0, eff, "none"
    se = float(np.sqrt(base_rate * (1 - base_rate) / eff))
    z = float((tier["accuracy"] - base_rate) / se) if se > 0 else 0.0
    if not validated:
        return z, eff, "none"
    return z, eff, ("strong" if z >= 1.64 else "weak" if z >= 0.8 else "drift")


def _walk_forward(X: np.ndarray, y: np.ndarray, horizon: int, makers: dict, folds: int) -> tuple[dict, int]:
    n = len(y)
    start = max(int(n * (1 - TEST_SHARE)), MIN_TRAIN + horizon)
    edges = np.linspace(start, n, folds + 1).astype(int)
    oof = {name: np.full(n, np.nan) for name in makers}
    used = 0
    for k in range(folds):
        s, e = int(edges[k]), int(edges[k + 1])
        tr_end = s - horizon                       # purge: labels of the training rows end before the test fold starts
        if tr_end < MIN_TRAIN or e <= s:
            continue
        used += 1
        w = _recency_weights(tr_end, tr_end * TRAIN_HALF_LIFE)
        for name, make in makers.items():
            yield_if_busy()
            m = make()
            m.fit(X[:tr_end], y[:tr_end], sample_weight=w)
            oof[name][s:e] = m.predict_proba(X[s:e])[:, 1]
    return oof, used


# --------------------------------------------------------------------------- fit reuse and persistence
def _fit_version() -> str:
    """Changes whenever the feature set does, so a saved model is never applied to different columns."""
    return hashlib.md5(("|".join(sorted(STRATEGIES)) + "|" + "|".join(TECH_COLS) + "|v1").encode()).hexdigest()[:10]


def _fit_file(key: tuple) -> str:
    symbol, interval, horizon = key
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", f"{symbol}_{interval}_h{horizon}")
    return os.path.join(CACHE_DIR, "fits", f"{safe}.pkl")


def _remember(key: tuple, f: "Fit") -> None:
    with _LOCKS_GUARD:
        _FITS.pop(key, None)
        _FITS[key] = f                            # dicts keep insertion order: the oldest entry is first
        while len(_FITS) > FITS_IN_MEMORY:
            _FITS.pop(next(iter(_FITS)))


def _load_fit(key: tuple) -> "Fit | None":
    try:
        path = _fit_file(key)
        if os.path.exists(path):
            with open(path, "rb") as fh:
                version, f = pickle.load(fh)
            if version == _fit_version() and isinstance(f, Fit):
                return f
    except Exception as exc:  # pragma: no cover - a stale or partial file is simply refitted
        log.warning("could not load saved fit %s: %s", key, exc)
    return None


def _save_fit(key: tuple, f: "Fit") -> None:
    try:
        path = _fit_file(key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path + ".tmp", "wb") as fh:
            pickle.dump((_fit_version(), f), fh, protocol=pickle.HIGHEST_PROTOCOL)
        os.replace(path + ".tmp", path)
    except Exception as exc:  # pragma: no cover
        log.warning("could not save fit %s: %s", key, exc)


def _reusable(f: "Fit", data: pd.DataFrame, sec: int, horizon: int) -> bool:
    """Whether a fitted model can predict from the last bar of `data` without refitting.

    Default: for an hour and until `horizon / 2` new bars.  NSE intraday: once per session - a model that
    has seen every bar of the earlier sessions is reused all day (a few more bars of today barely move a
    model trained on ~500, and it stays strictly out-of-sample), and it is refitted once today's session
    has closed.  This is what lets the scanner re-check a whole universe after every candle on one CPU."""
    last_bar = pd.Timestamp(data.index[-1])
    if f.last_bar > last_bar:
        return False
    newer = int((data.index > f.last_bar).sum())
    if newer < max(2, horizon // 2) and time.time() - f.fitted_at < FIT_MAX_AGE:
        return True
    if sec >= 86400 or not is_indian(f.symbol) or time.time() - f.fitted_at > FIT_SESSION_MAX_AGE:
        return False
    day = last_bar.normalize()
    (ch, cm) = INDIA_SESSION_UTC[1]
    if last_bar + pd.Timedelta(seconds=sec) >= day + pd.Timedelta(hours=ch, minutes=cm):
        return newer == 0                         # today's session is complete: fit on all of it once
    earlier = data.index[data.index < day]
    return len(earlier) > 0 and f.last_bar >= earlier[-1]


def fit(symbol: str, interval: str, horizon: int, data: pd.DataFrame, sec: int) -> Fit | None:
    """Train (or reuse) the walk-forward learner for this instrument / timeframe / horizon using
    only the bars in `data` (all of which must be closed)."""
    if not HAVE_SKLEARN:
        return None
    key = (symbol, interval, horizon)
    last_bar = pd.Timestamp(data.index[-1])
    with _fit_lock(key):
        cached = _FITS.get(key)
        if cached is None:
            cached = _load_fit(key)               # survives server restarts
        if cached is not None and _reusable(cached, data, sec, horizon):
            _remember(key, cached)
            return cached
        t0 = time.time()
        votes = strategy_votes(symbol, interval, data, sec, stride=training_stride(horizon))
        market = market_features(symbol, interval, votes.index)
        feats, y = build_features(data, votes, market, horizon, sec)
        labelled = y.notna() & feats.notna().mean(axis=1).gt(0.7)
        Xdf, ys = feats[labelled], y[labelled]
        if len(Xdf) < MIN_ROWS:
            log.info("learner skipped for %s %s: only %d labelled rows", symbol, interval, len(Xdf))
            return None
        names = list(Xdf.columns)
        vote_cols = [i for i, c in enumerate(names) if c.startswith("v_")]
        X, Y = Xdf.to_numpy(), ys.to_numpy()
        makers = _makers(vote_cols)
        folds = FOLDS if len(X) >= 400 else 3
        oof, used = _walk_forward(X, Y, horizon, makers, folds)
        mask = ~np.isnan(oof["logistic_regression"])
        if mask.sum() < 60 or used == 0:
            return None
        yo = Y[mask]
        half_life = max(float(CAL_HALF_LIFE_MIN), len(yo) * CAL_HALF_LIFE)
        wo = _recency_weights(len(yo), half_life)          # recent out-of-fold bars count more
        scores = {}
        for name, p in oof.items():
            po = p[mask]
            scores[name] = {"accuracy": float(np.average((po > 0.5) == (yo > 0.5), weights=wo)), "logloss": _logloss(po, yo, wo)}
        p_avg = np.mean([oof[n][mask] for n in makers], axis=0)
        # Platt scaling on the out-of-fold average, weighted toward the present
        platt = LogisticRegression(C=1e6, max_iter=1000).fit(_logit(p_avg)[:, None], yo, sample_weight=wo)
        a, b = float(platt.coef_[0][0]), float(platt.intercept_[0])
        p_cal = _sigmoid(a * _logit(p_avg) + b)
        up_rate = float(np.average(yo, weights=wo))
        base_rate = float(max(up_rate, 1 - up_rate))
        hits = ((p_cal > 0.5) == (yo > 0.5)).astype(float)
        acc = float(np.average(hits, weights=wo))
        tiers = []
        for t in THRESHOLDS:
            m = np.abs(p_cal - 0.5) >= (t - 0.5) - 1e-12
            n_t = int(m.sum())
            tiers.append({"threshold": t, "n": n_t, "n_eff": round(_kish(wo[m]), 1), "coverage": float(m.mean()),
                          "accuracy": float(np.average(hits[m], weights=wo[m])) if n_t else None})
        min_n = max(30, 2 * horizon)
        chosen = next((t for t in tiers if t["accuracy"] is not None and t["n"] >= min_n and t["accuracy"] >= MIN_TIER_ACC), None)
        validated = chosen is not None
        threshold = chosen["threshold"] if validated else 0.60
        ref = chosen or next((t for t in tiers if t["threshold"] == threshold), tiers[0])
        z, eff, evidence = tier_evidence(ref, base_rate, horizon, validated)
        # final models on every labelled row (recent rows weighted up)
        w_all = _recency_weights(len(X), len(X) * TRAIN_HALF_LIFE)
        models = {name: make().fit(X, Y, sample_weight=w_all) for name, make in makers.items()}
        stack = models["stacked_votes"].model
        coefs = stack.named_steps["logisticregression"].coef_[0]
        learned = {names[c][2:]: float(w) for c, w in zip(vote_cols, coefs)}
        rf = models["random_forest"].named_steps["randomforestclassifier"]
        imp = sorted(zip(names, rf.feature_importances_), key=lambda t: -t[1])[:10]
        res = Fit(symbol=symbol, interval=interval, horizon=horizon, last_bar=last_bar, fitted_at=time.time(),
                  n_rows=int(len(X)), n_features=len(names), folds=used, base_rate=base_rate, up_rate=up_rate, accuracy=acc,
                  logloss=_logloss(p_cal, yo, wo), logloss_base=_logloss(np.full_like(yo, up_rate), yo, wo), half_life=int(half_life),
                  tiers=tiers, threshold=threshold, validated=validated, evidence=evidence, edge_z=z, effective_n=eff,
                  learner_scores=scores, models=models, platt=(a, b), feature_names=names, learned_weights=learned,
                  top_features=[(n, float(w)) for n, w in imp])
        _remember(key, res)
        _save_fit(key, res)
        log.info("learner fitted for %s %s h=%d: %d rows, oof acc %.3f (up-rate %.3f, half-life %d), threshold %.2f, %s evidence, %.1fs",
                 symbol, interval, horizon, len(X), acc, up_rate, int(half_life), threshold, evidence, time.time() - t0)
        return res


@dataclass
class Prediction:
    fit: Fit
    prob: float                 # calibrated P(up)
    prob_raw: float
    per_learner: dict
    tier: dict
    signals: list
    evidence: str = "none"      # evidence for a call of this strength (strong / weak / drift / none)
    edge_z: float = 0.0
    effective_n: int = 0

    def summary(self) -> dict:
        f = self.fit
        return {
            "available": True, "prob_up": round(self.prob, 4), "prob_raw": round(self.prob_raw, 4),
            "n_rows": f.n_rows, "n_features": f.n_features, "folds": f.folds, "base_rate": round(f.base_rate, 4), "up_rate": round(f.up_rate, 4),
            "accuracy": round(f.accuracy, 4), "logloss": round(f.logloss, 4), "logloss_base": round(f.logloss_base, 4),
            "threshold": f.threshold, "validated": f.validated,
            "fit_evidence": f.evidence, "fit_edge_z": round(f.edge_z, 2), "fit_effective_n": f.effective_n,
            "evidence": self.evidence, "edge_z": round(self.edge_z, 2), "effective_n": self.effective_n, "tiers": f.tiers, "half_life": f.half_life,
            "tier": self.tier, "expected_accuracy": self.tier["accuracy"],
            "learners": {k: {"accuracy": round(v["accuracy"], 4), "logloss": round(v["logloss"], 4)} for k, v in f.learner_scores.items()},
            "learned_weights": {k: round(v, 3) for k, v in f.learned_weights.items()},
            "top_features": [[n, round(w, 4)] for n, w in f.top_features],
            "fitted_on": f.last_bar.isoformat(),
        }


def predict(symbol: str, interval: str, horizon: int, data: pd.DataFrame, sec: int) -> Prediction | None:
    """Fit or reuse the learner and predict from the last closed bar of `data`."""
    f = fit(symbol, interval, horizon, data, sec)
    if f is None:
        return None
    votes = strategy_votes(symbol, interval, data, sec, max_rows=1)
    market = market_features(symbol, interval, votes.index)
    feats, _ = build_features(data, votes, market, horizon, sec)
    x = feats.reindex(columns=f.feature_names).to_numpy()[-1:]
    per = {}
    for name, m in f.models.items():
        try:
            per[name] = float(m.predict_proba(x)[0][1])
        except Exception as exc:  # pragma: no cover
            log.warning("%s failed to predict: %s", name, exc)
    if not per:
        return None
    p_raw = float(np.mean(list(per.values())))
    p = f.calibrate(p_raw)
    tier = f.tier_for(p)
    signals = []
    for name, pl in per.items():
        sc = f.learner_scores[name]
        meta = LEARNER_META[name]
        d = 1 if pl > 0.53 else (-1 if pl < 0.47 else 0)
        edge = max(sc["accuracy"] - 0.5, 0.0)
        conf = _clip(abs(pl - 0.5) * 2 * (0.4 + edge * 4))
        signals.append(Signal(name, direction=d, confidence=conf,
                              reason=f"P(up) {pl*100:.0f}%; walk-forward accuracy {sc['accuracy']*100:.0f}% on {f.n_rows} bars "
                                     f"({f.folds} folds, base rate {f.base_rate*100:.0f}%)",
                              values=dict(prob_up=pl, validation_accuracy=sc["accuracy"], logloss=sc["logloss"], base_rate=f.base_rate,
                                          train_bars=f.n_rows), category="ml", **meta))
    strength = abs(p - 0.5) + 0.5
    d = (1 if p > 0.5 else -1) if strength >= f.threshold - 1e-12 else 0
    acc_here = tier["accuracy"] if tier["accuracy"] is not None else f.accuracy
    z_here, eff_here, evidence = tier_evidence(tier, f.base_rate, f.horizon, bool(d))
    conf = _clip((acc_here - 0.5) * 2) if d else _clip(1 - abs(p - 0.5) * 4) * 0.6
    if d:
        reason = (f"Calibrated P(up) {p*100:.0f}%. Out-of-sample, calls at least this strong were right {acc_here*100:.0f}% of the time "
                  f"({tier['n']} bars, {tier['coverage']*100:.0f}% of history); evidence: {evidence}")
    else:
        reason = (f"Calibrated P(up) {p*100:.0f}% - below the {f.threshold:.2f} strength where this chart's calls have been reliable"
                  + ("" if f.validated else f" (no strength level reached {MIN_TIER_ACC*100:.0f}% out-of-sample accuracy)") + "; no call")
    signals.append(Signal("wf_ensemble", direction=d, confidence=conf, reason=reason,
                          values=dict(prob_up=p, prob_raw=p_raw, expected_accuracy=acc_here, threshold=f.threshold,
                                      validated=f.validated, evidence=evidence, oof_accuracy=f.accuracy, base_rate=f.base_rate),
                          category="ml", **LEARNER_META["wf_ensemble"]))
    return Prediction(fit=f, prob=p, prob_raw=p_raw, per_learner=per, tier=tier, signals=signals,
                      evidence=evidence, edge_z=z_here, effective_n=eff_here)


# --------------------------------------------------------------------------- scoreboard (top-bar model meter)
_SCORE_CACHE: dict[str, tuple[float, dict | None]] = {}     # fit file -> (mtime, score summary); only changed files are re-read


def _fit_scores(f: "Fit") -> dict:
    return {"symbol": f.symbol, "interval": f.interval, "accuracy": f.accuracy, "base_rate": f.base_rate, "validated": f.validated,
            "fitted_at": f.fitted_at, "learners": {k: v["accuracy"] for k, v in f.learner_scores.items()}}


def scoreboard() -> dict:
    """Walk-forward scores of every learner, averaged over every chart that has a saved fit."""
    folder = os.path.join(CACHE_DIR, "fits")
    rows = []
    version = _fit_version()
    paths = [os.path.join(folder, n) for n in os.listdir(folder) if n.endswith(".pkl")] if os.path.isdir(folder) else []
    for path in paths:
        try:
            mt = os.path.getmtime(path)
            hit = _SCORE_CACHE.get(path)
            if not hit or hit[0] != mt:
                with open(path, "rb") as fh:
                    v, f = pickle.load(fh)
                hit = (mt, _fit_scores(f) if v == version and isinstance(f, Fit) else None)
                _SCORE_CACHE[path] = hit
            if hit[1]:
                rows.append(hit[1])
        except Exception as exc:  # pragma: no cover - a partial file is skipped
            log.warning("scoreboard: could not read %s: %s", path, exc)
    for gone in set(_SCORE_CACHE) - set(paths):
        _SCORE_CACHE.pop(gone, None)
    models = {}
    for key in ("logistic_regression", "random_forest", "gradient_boosting", "stacked_votes"):
        pairs = [(r["learners"][key], r["base_rate"]) for r in rows if key in r["learners"]]
        if pairs:
            models[key] = {"name": LEARNER_META[key]["name"].split(" (")[0], "accuracy": float(np.mean([a for a, _ in pairs])),
                           "beats_drift": float(np.mean([a > b for a, b in pairs])), "charts": len(pairs)}
    if rows:
        models["wf_ensemble"] = {"name": "Calibrated Ensemble", "accuracy": float(np.mean([r["accuracy"] for r in rows])),
                                 "beats_drift": float(np.mean([r["accuracy"] > r["base_rate"] for r in rows])), "charts": len(rows),
                                 "validated": float(np.mean([r["validated"] for r in rows]))}
    return {"charts": len(rows), "base_rate": float(np.mean([r["base_rate"] for r in rows])) if rows else None,
            "intervals": sorted({r["interval"] for r in rows}),
            "latest_fit": max((r["fitted_at"] for r in rows), default=None), "models": models}


def catalog() -> list[dict]:
    return [{"key": k, "kind": "model", "doc": f"{m['name']}. {m['origin']}. {m['rules']}"} for k, m in LEARNER_META.items()]
