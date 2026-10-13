"""SQLite persistence: predictions, user feedback and per-strategy accuracy."""
from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

DB_PATH = os.environ.get("TRADEBOT_DB", os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "tradebot.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    horizon_bars INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    bar_time TEXT NOT NULL,
    price_at REAL NOT NULL,
    direction TEXT NOT NULL,            -- UP / DOWN / SIDEWAYS
    prob_up REAL NOT NULL,
    confidence REAL NOT NULL,
    target_price REAL,
    stop_price REAL,
    expected_move_pct REAL,
    expires_at TEXT,
    signals_json TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending / resolved
    auto_outcome TEXT,                  -- correct / incorrect (system evaluation)
    resolved_price REAL,
    resolved_at TEXT,
    actual_move_pct REAL,
    user_verdict TEXT,                  -- correct / incorrect / partial (latest feedback)
    user_rating INTEGER,
    user_note TEXT,
    source TEXT NOT NULL DEFAULT 'live' -- live / asof / backtest
);
CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prediction_id INTEGER NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
    verdict TEXT NOT NULL,
    rating INTEGER,
    note TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS strategy_stats (
    key TEXT PRIMARY KEY,
    name TEXT,
    category TEXT,
    correct INTEGER NOT NULL DEFAULT 0,
    incorrect INTEGER NOT NULL DEFAULT 0,
    neutral INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pred_symbol ON predictions(symbol, created_at);
CREATE INDEX IF NOT EXISTS idx_pred_status ON predictions(status);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL                 -- JSON
);
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    mode TEXT NOT NULL,                 -- intraday / overnight
    side TEXT NOT NULL DEFAULT 'long',  -- long / short (shorts are intraday only)
    status TEXT NOT NULL,               -- pending / open / closed / cancelled
    created_at TEXT NOT NULL,
    qty INTEGER NOT NULL,
    entry_type TEXT NOT NULL,           -- market / limit
    entry_price REAL NOT NULL,          -- planned entry (limit / trigger price for pending orders)
    trigger REAL,                       -- SL orders: trigger price
    fill_price REAL,
    entry_time TEXT,
    stop REAL NOT NULL,
    target REAL NOT NULL,
    deadline TEXT NOT NULL,
    exit_price REAL,
    exit_time TEXT,
    exit_reason TEXT,                   -- stop / target / deadline / manual / squareoff / expired
    gross_pnl REAL,
    charges REAL,
    net_pnl REAL,
    charges_json TEXT,
    plan_json TEXT,
    prediction_id INTEGER,
    note TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def init_db(path: str | None = None) -> None:
    p = path or DB_PATH
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with connect(p) as con:
        con.executescript(SCHEMA)
        cols = {r["name"] for r in con.execute("PRAGMA table_info(predictions)").fetchall()}
        if "source" not in cols:  # migration for databases created before the column existed
            con.execute("ALTER TABLE predictions ADD COLUMN source TEXT NOT NULL DEFAULT 'live'")
        tcols = {r["name"] for r in con.execute("PRAGMA table_info(trades)").fetchall()}
        if tcols and "side" not in tcols:
            con.execute("ALTER TABLE trades ADD COLUMN side TEXT NOT NULL DEFAULT 'long'")
        if tcols and "trigger" not in tcols:
            con.execute("ALTER TABLE trades ADD COLUMN trigger REAL")


@contextmanager
def connect(path: str | None = None):
    con = sqlite3.connect(path or DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        yield con
        con.commit()
    finally:
        con.close()


def _row(r: sqlite3.Row | None) -> dict | None:
    if r is None:
        return None
    d = dict(r)
    for k in ("signals_json", "summary_json"):
        if k in d and d[k]:
            d[k[:-5]] = json.loads(d[k])
            del d[k]
    return d


# ---------------------------------------------------------------- predictions
def insert_prediction(p: dict) -> int:
    """Store a call.  One call per chart, horizon and bar: re-analysing the same bar replaces the earlier
    call (same id) instead of adding a copy, so one move is never graded several times."""
    source = p.get("source") or "live"
    with connect() as con:
        old = con.execute("""SELECT id FROM predictions WHERE symbol=? AND interval=? AND horizon_bars=? AND bar_time=? AND source=?
                             ORDER BY id DESC LIMIT 1""", (p["symbol"], p["interval"], p["horizon_bars"], p["bar_time"], source)).fetchone()
        if old:
            con.execute(
                """UPDATE predictions SET created_at=?, price_at=?, direction=?, prob_up=?, confidence=?, target_price=?, stop_price=?,
                   expected_move_pct=?, expires_at=?, signals_json=?, summary_json=?, status='pending', auto_outcome=NULL,
                   resolved_price=NULL, resolved_at=NULL, actual_move_pct=NULL WHERE id=?""",
                (p.get("created_at") or now_iso(), p["price_at"], p["direction"], p["prob_up"], p["confidence"], p.get("target_price"),
                 p.get("stop_price"), p.get("expected_move_pct"), p.get("expires_at"), json.dumps(p["signals"]), json.dumps(p["summary"]),
                 old["id"]))
            return int(old["id"])
        cur = con.execute(
            """INSERT INTO predictions (symbol, interval, horizon_bars, created_at, bar_time, price_at, direction,
               prob_up, confidence, target_price, stop_price, expected_move_pct, expires_at, signals_json, summary_json, source)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (p["symbol"], p["interval"], p["horizon_bars"], p.get("created_at") or now_iso(), p["bar_time"],
             p["price_at"], p["direction"], p["prob_up"], p["confidence"], p.get("target_price"), p.get("stop_price"),
             p.get("expected_move_pct"), p.get("expires_at"), json.dumps(p["signals"]), json.dumps(p["summary"]),
             p.get("source") or "live"))
        return int(cur.lastrowid)


def get_prediction(pid: int) -> dict | None:
    with connect() as con:
        return _row(con.execute("SELECT * FROM predictions WHERE id=?", (pid,)).fetchone())


def list_predictions(symbol: str | None = None, status: str | None = None, limit: int = 100, offset: int = 0,
                     source: str | None = None) -> list[dict]:
    q = "SELECT * FROM predictions"
    where, args = [], []
    if symbol:
        where.append("symbol LIKE ?"); args.append(symbol.upper() + "%")
    if status:
        where.append("status=?"); args.append(status)
    if source:
        where.append("source=?"); args.append(source)
    if where:
        q += " WHERE " + " AND ".join(where)
    q += " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
    args += [limit, offset]
    with connect() as con:
        return [_row(r) for r in con.execute(q, args).fetchall()]


def pending_predictions() -> list[dict]:
    with connect() as con:
        return [_row(r) for r in con.execute("SELECT * FROM predictions WHERE status='pending' ORDER BY created_at").fetchall()]


def resolve_prediction(pid: int, outcome: str, resolved_price: float, actual_move_pct: float) -> None:
    with connect() as con:
        con.execute("""UPDATE predictions SET status='resolved', auto_outcome=?, resolved_price=?, resolved_at=?, actual_move_pct=?
                       WHERE id=?""", (outcome, resolved_price, now_iso(), actual_move_pct, pid))


def delete_prediction(pid: int) -> bool:
    with connect() as con:
        cur = con.execute("DELETE FROM predictions WHERE id=?", (pid,))
        return cur.rowcount > 0


# ---------------------------------------------------------------- feedback
def add_feedback(pid: int, verdict: str, rating: int | None, note: str | None) -> dict:
    with connect() as con:
        con.execute("INSERT INTO feedback (prediction_id, verdict, rating, note, created_at) VALUES (?,?,?,?,?)",
                    (pid, verdict, rating, note, now_iso()))
        con.execute("UPDATE predictions SET user_verdict=?, user_rating=?, user_note=? WHERE id=?",
                    (verdict, rating, note, pid))
    rebuild_stats()
    return get_prediction(pid)


def list_feedback(pid: int | None = None, limit: int = 200) -> list[dict]:
    with connect() as con:
        if pid is None:
            rows = con.execute("SELECT f.*, p.symbol, p.direction FROM feedback f JOIN predictions p ON p.id=f.prediction_id ORDER BY f.created_at DESC LIMIT ?", (limit,)).fetchall()
        else:
            rows = con.execute("SELECT * FROM feedback WHERE prediction_id=? ORDER BY created_at DESC LIMIT ?", (pid, limit)).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------- statistics
DIR_TO_INT = {"UP": 1, "DOWN": -1, "SIDEWAYS": 0}


def final_outcome(p: dict) -> str | None:
    """User verdict overrides the automatic evaluation.  `no_call` = the system stood aside."""
    if p.get("user_verdict") in ("correct", "incorrect"):
        return p["user_verdict"]
    if p.get("user_verdict") == "partial":
        return "partial"
    return p.get("auto_outcome")


def actual_direction(p: dict) -> int | None:
    """Best estimate of what the market actually did, as +1 / -1 / 0."""
    if p.get("actual_move_pct") is not None and p.get("status") == "resolved":
        thr = (p.get("expected_move_pct") or 1.0) * 0.25
        m = p["actual_move_pct"]
        return 1 if m > thr else (-1 if m < -thr else 0)
    out = final_outcome(p)
    pred = DIR_TO_INT.get(p["direction"], 0)
    if out == "correct":
        return pred
    if out == "incorrect" and pred != 0:
        return -pred
    return None


def rebuild_stats() -> None:
    """Recompute per-strategy hit rates from every prediction that has a known outcome."""
    counts: dict[str, dict] = {}
    with connect() as con:
        rows = [_row(r) for r in con.execute("SELECT * FROM predictions WHERE status='resolved' OR user_verdict IS NOT NULL").fetchall()]
        for p in rows:
            actual = actual_direction(p)
            if actual is None:
                continue
            for s in p["signals"]:
                key = s["key"]
                c = counts.setdefault(key, {"name": s.get("name", key), "category": s.get("category", ""), "correct": 0, "incorrect": 0, "neutral": 0})
                d = int(s.get("direction", 0))
                if d == 0 or s.get("confidence", 0) < 0.2:
                    c["neutral"] += 1
                elif d == actual:
                    c["correct"] += 1
                elif actual == 0:
                    c["neutral"] += 1
                else:
                    c["incorrect"] += 1
        con.execute("DELETE FROM strategy_stats")
        con.executemany("INSERT INTO strategy_stats (key, name, category, correct, incorrect, neutral) VALUES (?,?,?,?,?,?)",
                        [(k, v["name"], v["category"], v["correct"], v["incorrect"], v["neutral"]) for k, v in counts.items()])


def strategy_stats() -> dict[str, dict]:
    with connect() as con:
        return {r["key"]: dict(r) for r in con.execute("SELECT * FROM strategy_stats").fetchall()}


def overall_stats() -> dict:
    with connect() as con:
        rows = [_row(r) for r in con.execute("SELECT * FROM predictions").fetchall()]
    total = len(rows)
    resolved = [p for p in rows if final_outcome(p) in ("correct", "incorrect", "partial")]
    no_call = sum(1 for p in rows if final_outcome(p) == "no_call")
    correct = sum(1 for p in resolved if final_outcome(p) == "correct")
    partial = sum(1 for p in resolved if final_outcome(p) == "partial")
    incorrect = sum(1 for p in resolved if final_outcome(p) == "incorrect")
    with_feedback = sum(1 for p in rows if p.get("user_verdict"))
    by_dir: dict[str, dict] = {}
    by_symbol: dict[str, dict] = {}
    for p in resolved:
        o = final_outcome(p)
        for bucket, key in ((by_dir, p["direction"]), (by_symbol, p["symbol"])):
            b = bucket.setdefault(key, {"correct": 0, "incorrect": 0, "partial": 0})
            b[o] += 1
    ratings = [p["user_rating"] for p in rows if p.get("user_rating")]
    return {
        "total_predictions": total,
        "pending": sum(1 for p in rows if p["status"] == "pending" and not p.get("user_verdict")),
        "evaluated": len(resolved),
        "no_call": no_call,
        "correct": correct, "partial": partial, "incorrect": incorrect,
        "accuracy": (correct + 0.5 * partial) / len(resolved) if resolved else None,
        "with_user_feedback": with_feedback,
        "avg_user_rating": sum(ratings) / len(ratings) if ratings else None,
        "by_direction": by_dir,
        "by_symbol": by_symbol,
    }


# ---------------------------------------------------------------- settings (JSON key/value)
def get_setting(key: str):
    with connect() as con:
        r = con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(r["value"]) if r else None


def set_setting(key: str, value) -> None:
    with connect() as con:
        con.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, json.dumps(value)))


# ---------------------------------------------------------------- paper trades
def _trade_row(r: sqlite3.Row | None) -> dict | None:
    if r is None:
        return None
    d = dict(r)
    d["plan"] = json.loads(d["plan_json"]) if d.get("plan_json") else None
    d["charges_detail"] = json.loads(d["charges_json"]) if d.get("charges_json") else {}
    d["stop"] = d.get("stop") or None          # 0 = no stop attached
    d["target"] = d.get("target") or None
    d["deadline"] = d.get("deadline") or None
    d["side"] = d.get("side") or "long"
    return d


def insert_trade(t: dict) -> int:
    cols = ("symbol", "interval", "mode", "side", "status", "created_at", "qty", "entry_type", "entry_price", "trigger", "fill_price", "entry_time",
            "stop", "target", "deadline", "charges_json", "plan_json", "prediction_id", "note")
    with connect() as con:
        cur = con.execute(f"INSERT INTO trades ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", [t.get(c) for c in cols])
        return int(cur.lastrowid)


def get_trade(tid: int) -> dict | None:
    with connect() as con:
        return _trade_row(con.execute("SELECT * FROM trades WHERE id=?", (tid,)).fetchone())


def list_trades(status: str | None = None, limit: int = 500) -> list[dict]:
    with connect() as con:
        if status:
            rows = con.execute("SELECT * FROM trades WHERE status=? ORDER BY created_at DESC, id DESC LIMIT ?", (status, limit)).fetchall()
        else:
            rows = con.execute("SELECT * FROM trades ORDER BY created_at DESC, id DESC LIMIT ?", (limit,)).fetchall()
        return [_trade_row(r) for r in rows]


def fill_trade(tid: int, fill_price: float, entry_time: str, charges_json: str) -> None:
    with connect() as con:
        con.execute("UPDATE trades SET status='open', fill_price=?, entry_time=?, charges_json=? WHERE id=?", (fill_price, entry_time, charges_json, tid))


def close_trade(tid: int, exit_price: float, exit_time: str, reason: str, gross: float, charges: float, net: float, charges_json: str) -> None:
    with connect() as con:
        con.execute("""UPDATE trades SET status='closed', exit_price=?, exit_time=?, exit_reason=?, gross_pnl=?, charges=?, net_pnl=?, charges_json=?
                       WHERE id=?""", (exit_price, exit_time, reason, gross, charges, net, charges_json, tid))


TRADE_EDITABLE = {"qty", "stop", "target", "deadline", "charges_json", "note", "trigger", "entry_price"}


def update_trade(tid: int, fields: dict) -> None:
    f = {k: v for k, v in fields.items() if k in TRADE_EDITABLE}
    if not f:
        return
    with connect() as con:
        con.execute(f"UPDATE trades SET {', '.join(k + '=?' for k in f)} WHERE id=?", [*f.values(), tid])


def cancel_trade(tid: int) -> None:
    with connect() as con:
        con.execute("UPDATE trades SET status='cancelled', exit_time=?, exit_reason='cancelled' WHERE id=? AND status IN ('pending', 'open')", (now_iso(), tid))
