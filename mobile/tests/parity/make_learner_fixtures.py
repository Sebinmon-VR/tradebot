"""Parity fixtures for the walk-forward learner (app/learner.py) and the scikit-learn pieces it uses.

For each case the bars come from the existing bar fixtures (fixtures/<case>.json) so the TS side sees the
same data.  Python computes the strategy votes (strategy_votes), the NIFTY 50 factor, the feature matrix,
the out-of-fold predictions, the calibrated fit and the final prediction, and the per-fold outputs of every
scikit-learn model.  The TS tests start from the Python votes, so they do not depend on strategies.ts.

Run from the repo root:  python mobile/tests/parity/make_learner_fixtures.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(__file__))
os.environ["TRADEBOT_CACHE"] = tempfile.mkdtemp(prefix="learner_fx_")   # never touch the app's vote cache

from make_fixtures import clean  # noqa: E402
from app import learner as L  # noqa: E402
from app.indicators import compute_all  # noqa: E402
from app.data import fetch_ohlcv  # noqa: E402
from app.ensemble import DEFAULT_HORIZON  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.ensemble import RandomForestClassifier  # noqa: E402
from sklearn.impute import SimpleImputer  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402
from sklearn.metrics import roc_auc_score, log_loss  # noqa: E402

FX = os.path.join(os.path.dirname(__file__), "fixtures")
OUT = os.path.join(FX, "learner")
CASES = [("RELIANCE_NS_1d", "RELIANCE.NS", "1d", 86400), ("TCS_NS_15m", "TCS.NS", "15m", 900), ("ELECTCAST_NS_5m", "ELECTCAST.NS", "5m", 300)]
ONLY = sys.argv[1:]


def frame_from_fixture(name: str) -> pd.DataFrame:
    b = json.load(open(os.path.join(FX, name + ".json")))["bars"]
    idx = pd.to_datetime(b["t"], unit="s")                        # naive UTC, exactly what fetch_ohlcv returns
    v = [0.0 if x is None else x for x in b["v"]]
    return pd.DataFrame({"open": b["o"], "high": b["h"], "low": b["l"], "close": b["c"], "volume": v}, index=idx).astype(float)


def bars_json(df: pd.DataFrame) -> dict:
    return {"t": [int(pd.Timestamp(t).tz_localize("UTC").timestamp()) for t in df.index], "o": df["open"].tolist(), "h": df["high"].tolist(),
            "l": df["low"].tolist(), "c": df["close"].tolist(), "v": df["volume"].fillna(0).tolist()}


def ts(index) -> list[int]:
    return [int(pd.Timestamp(t).tz_localize("UTC").timestamp()) for t in index]


def per_fold_models(X, Y, horizon, vote_cols, folds):
    """Every scikit-learn model of learner.py on every walk-forward fold, plus reference variants."""
    n = len(Y)
    start = max(int(n * (1 - L.TEST_SHARE)), L.MIN_TRAIN + horizon)
    edges = np.linspace(start, n, folds + 1).astype(int)
    out = []
    for k in range(folds):
        s, e = int(edges[k]), int(edges[k + 1])
        tr_end = s - horizon
        if tr_end < L.MIN_TRAIN or e <= s:
            continue
        w = L._recency_weights(tr_end, tr_end * L.TRAIN_HALF_LIFE)
        Xtr, ytr, Xte, yte = X[:tr_end], Y[:tr_end], X[s:e], Y[s:e]
        imp = SimpleImputer(strategy="median").fit(Xtr)
        Xi = imp.transform(Xtr)
        sc = StandardScaler().fit(Xi)
        rec = {"s": s, "e": e, "tr_end": tr_end, "weights": w.tolist(), "imputer_stats": imp.statistics_.tolist(),
               "scaler_mean": sc.mean_.tolist(), "scaler_scale": sc.scale_.tolist()}
        makers = L._makers(vote_cols)
        for name, make in makers.items():
            m = make().fit(Xtr, ytr, sample_weight=w)
            rec[name] = m.predict_proba(Xte)[:, 1].tolist()
            if name == "logistic_regression":
                lr = m.named_steps["logisticregression"]
                rec["lr_coef"], rec["lr_intercept"] = lr.coef_[0].tolist(), float(lr.intercept_[0])
            if name == "stacked_votes":
                lr = m.model.named_steps["logisticregression"]
                rec["stack_coef"], rec["stack_intercept"] = lr.coef_[0].tolist(), float(lr.intercept_[0])
            if name == "gradient_boosting":
                rec["hgb_cols"] = m.cols
        # tight-tolerance logistic regression: the exact optimum of the same objective
        for tag, cols, C, pre in (("lr_tight", None, 0.02, True), ("stack_tight", vote_cols, 0.05, False)):
            A = Xtr if cols is None else Xtr[:, cols]
            B = Xte if cols is None else Xte[:, cols]
            steps = []
            if pre:
                ii = SimpleImputer(strategy="median").fit(A)
                A, B = ii.transform(A), ii.transform(B)
            ss = StandardScaler().fit(A)
            A = np.clip(ss.transform(A), -L.CLIP_SD, L.CLIP_SD)
            B = np.clip(ss.transform(B), -L.CLIP_SD, L.CLIP_SD)
            lr = LogisticRegression(C=C, max_iter=100000, tol=1e-12).fit(A, ytr, sample_weight=w)
            rec[tag + "_coef"], rec[tag + "_intercept"] = lr.coef_[0].tolist(), float(lr.intercept_[0])
            rec[tag] = lr.predict_proba(B)[:, 1].tolist()
        # random forest seed spread: how much the forest's own randomness moves AUC / log-loss
        Xi_te = imp.transform(Xte)
        spread = []
        for seed in range(5):
            rf = RandomForestClassifier(n_estimators=200, min_samples_leaf=15, max_features="sqrt", n_jobs=-1, random_state=seed).fit(Xi, ytr, sample_weight=w)
            p = rf.predict_proba(Xi_te)[:, 1]
            spread.append({"auc": float(roc_auc_score(yte, p)) if len(set(yte)) > 1 else None, "logloss": float(log_loss(yte, np.clip(p, 1e-6, 1 - 1e-6), labels=[0, 1])),
                           "acc": float(np.mean((p > 0.5) == (yte > 0.5)))})
        rec["rf_seed_spread"] = spread
        out.append(rec)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, sym, iv, sec in CASES:
        if ONLY and name not in ONLY:
            continue
        t0 = time.time()
        raw = frame_from_fixture(name)
        data = compute_all(raw)
        horizon = int(DEFAULT_HORIZON[iv])
        mkt = fetch_ohlcv(L.MARKET_SYMBOL, iv, fresh=False)
        mkt = mkt[(mkt.index <= raw.index[-1] + pd.Timedelta(days=3))]
        L.fetch_ohlcv = lambda s, i, **kw: mkt.copy()               # the market factor comes from the saved NIFTY bars
        captured = {}
        orig_wf = L._walk_forward

        def wf(X, y, h, makers, folds):
            oof, used = orig_wf(X, y, h, makers, folds)
            captured.update(oof={k: v.tolist() for k, v in oof.items()}, used=used, folds=folds)
            return oof, used
        L._walk_forward = wf
        L._FITS.clear()
        stride = L.training_stride(horizon)
        f = L.fit(sym, iv, horizon, data, sec)
        L._walk_forward = orig_wf
        pred = L.predict(sym, iv, horizon, data, sec)
        votes_all = L._VOTES[(sym, iv)]
        votes = L.strategy_votes(sym, iv, data, sec, stride=stride)
        market = L.market_features(sym, iv, votes.index)
        feats, y = L.build_features(data, votes, market, horizon, sec)
        labelled = y.notna() & feats.notna().mean(axis=1).gt(0.7)
        names = list(feats.columns)
        vote_cols = [i for i, c in enumerate(names) if c.startswith("v_")]
        X, Y = feats[labelled].to_numpy(), y[labelled].to_numpy()
        folds = L.FOLDS if len(X) >= 400 else 3
        fx = {
            "symbol": sym, "interval": iv, "sec": sec, "horizon": horizon, "stride": stride,
            "market_bars": bars_json(mkt),
            "votes": {"t": ts(votes_all.index), "close": votes_all["_close"].tolist(), "keys": [c for c in votes_all.columns if c != "_close"],
                      "cols": [votes_all[c].tolist() for c in votes_all.columns if c != "_close"]},
            "votes_idx": ts(votes.index),
            "market_features": {c: market[c].tolist() for c in market.columns} if market is not None else None,
            "feature_names": names, "features": [feats[c].tolist() for c in names], "y": y.tolist(), "labelled": labelled.tolist(),
            "captured": captured,
        }
        if f is not None:
            fx["fit"] = {k: getattr(f, k) for k in ("n_rows", "n_features", "folds", "base_rate", "up_rate", "accuracy", "logloss", "logloss_base", "tiers",
                                                    "threshold", "validated", "evidence", "edge_z", "effective_n", "learner_scores", "half_life", "platt",
                                                    "feature_names", "learned_weights", "top_features")}
            fx["fit"]["last_bar"] = int(pd.Timestamp(f.last_bar).tz_localize("UTC").timestamp())
            fx["fit"]["rf_importances"] = f.models["random_forest"].named_steps["randomforestclassifier"].feature_importances_.tolist()
        if pred is not None:
            fx["prediction"] = {"prob": pred.prob, "prob_raw": pred.prob_raw, "per_learner": pred.per_learner, "tier": pred.tier, "evidence": pred.evidence,
                                "edge_z": pred.edge_z, "effective_n": pred.effective_n, "signals": [s.to_dict() for s in pred.signals], "summary": pred.summary()}
        fx["folds_detail"] = per_fold_models(X, Y, horizon, vote_cols, folds)
        with open(os.path.join(OUT, name + ".json"), "w") as fh:
            json.dump(clean(fx), fh)
        print(name, "rows", len(X), "features", len(names), "fit", f is not None, "pred", pred is not None, f"{time.time() - t0:.1f}s", flush=True)


if __name__ == "__main__":
    main()
