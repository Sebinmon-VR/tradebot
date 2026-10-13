"""Server side of the independent profit model: start / stop its worker process and read its results.

The server never imports the model itself (profit_model.py runs only in the worker).  This module launches
`python -m app.profit_worker` at idle CPU priority, hands it a random token for the read-only internal
endpoints, and reads the worker's state file and its own database (opened read-only).  If the worker is not
running or its files are missing, the readers return empty results - the rest of the app does not notice.
Set TRADEBOT_PROFIT=0 to keep the worker off.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone

from .db import DB_PATH

log = logging.getLogger("tradebot.profit")

CACHE_DIR = os.path.join(os.environ.get("TRADEBOT_CACHE", os.path.join(os.path.dirname(DB_PATH), "cache")), "profit")
STATE_FILE = os.path.join(CACHE_DIR, "state.json")
PROFIT_DB = os.environ.get("TRADEBOT_PROFIT_DB", os.path.join(os.path.dirname(DB_PATH), "profit.db"))
STALE_AFTER = 1800           # seconds without a heartbeat before the worker is shown as stopped
TOKEN = secrets.token_urlsafe(24)
_PROC: subprocess.Popen | None = None


PAUSE_FILE = os.path.join(CACHE_DIR, "paused")


def enabled() -> bool:
    """Off with TRADEBOT_PROFIT=0, or while data/cache/profit/paused exists."""
    return os.environ.get("TRADEBOT_PROFIT", "1") != "0" and not os.path.exists(PAUSE_FILE)


def token_ok(given: str | None) -> bool:
    return bool(given) and secrets.compare_digest(given, TOKEN)


def _port() -> str:
    return os.environ.get("TRADEBOT_PORT") or os.environ.get("PORT") or os.environ.get("WEBSITES_PORT") or "8003"


def start() -> None:
    """Launch the worker (idle priority, no window).  A second copy exits by itself, so this is safe on reloads."""
    global _PROC
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(os.path.join(CACHE_DIR, "token"), "w", encoding="utf-8") as fh:
            fh.write(TOKEN)                    # lets a hand-started worker (python -m app.profit_worker) talk to this server
    except OSError as exc:  # pragma: no cover
        log.warning("could not write the profit worker token: %s", exc)
    if not enabled() or (_PROC is not None and _PROC.poll() is None):
        return
    try:
        env = {**os.environ, "TRADEBOT_PROFIT_TOKEN": TOKEN, "TRADEBOT_PROFIT_URL": f"http://127.0.0.1:{_port()}",
               "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"}
        kw = {"cwd": os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "env": env,
              "stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
        if os.name == "nt":
            kw["creationflags"] = subprocess.IDLE_PRIORITY_CLASS | subprocess.CREATE_NO_WINDOW
        _PROC = subprocess.Popen([sys.executable, "-m", "app.profit_worker"], **kw)
        log.info("profit worker launched (pid %d)", _PROC.pid)
    except Exception as exc:  # pragma: no cover - the app runs fine without it
        log.warning("could not start the profit worker: %s", exc)


def stop() -> None:
    global _PROC
    if _PROC is not None and _PROC.poll() is None:
        try:
            _PROC.terminate()
            _PROC.wait(timeout=5)
        except Exception:
            try:
                _PROC.kill()
            except Exception:
                pass
    _PROC = None


# ---------------------------------------------------------------- readers (read-only)
def _state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _rows(sql: str, args: tuple = ()) -> list[dict]:
    if not os.path.exists(PROFIT_DB):
        return []
    try:
        con = sqlite3.connect(f"file:{PROFIT_DB}?mode=ro", uri=True, timeout=2)
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute(sql, args).fetchall()]
        finally:
            con.close()
    except sqlite3.Error:
        return []


def _pool(items: list) -> dict:
    items = [i for i in items if i and i.get("n")]
    n = sum(i["n"] for i in items)
    if not n:
        return {"n": 0, "win": None, "avg_net": None}
    return {"n": n, "win": sum(i["win"] * i["n"] for i in items) / n, "avg_net": sum(i["avg_net"] * i["n"] for i in items) / n}


def _live() -> dict:
    agg = _rows("""SELECT COUNT(*) n, SUM(net_pct > 0) wins, AVG(net_pct) avg_net, SUM(net_pct) total FROM profit_calls WHERE status='resolved'""")
    pend = _rows("SELECT COUNT(*) n FROM profit_calls WHERE status='pending'")
    a = agg[0] if agg else {}
    n = a.get("n") or 0
    return {"n": n, "win": (a.get("wins") or 0) / n if n else None, "avg_net": a.get("avg_net"), "total_net": a.get("total"),
            "pending": (pend[0]["n"] if pend else 0)}


def _status(st: dict) -> dict:
    s = dict(st.get("status") or {})
    hb = s.get("heartbeat")
    age = None
    if hb:
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(hb)).total_seconds()
        except ValueError:
            age = None
    s["alive"] = age is not None and age < STALE_AFTER
    s["heartbeat_age"] = age
    s["enabled"] = enabled()
    return s


def summary() -> dict:
    """The profit model's meter: tested results pooled over every fitted chart, plus its live record."""
    st = _state()
    reports = list((st.get("reports") or {}).values())
    latest = list((st.get("latest") or {}).values())
    sides = [r[s] for r in reports for s in ("long", "short") if r.get(s)]
    return {
        "charts": len(reports),
        "baseline": _pool([s.get("baseline") for s in sides]),               # take every trade
        "model": _pool([s.get("model") for s in sides]),                     # take when P(win) >= 50%
        "chosen": _pool([s.get("chosen") for s in sides]),                   # each stock's best tested level (optimistic)
        "validated_sides": sum(1 for s in sides if s.get("validated")), "sides": len(sides),
        "take_now": sum(1 for p in latest if p.get("decision") in ("LONG", "SHORT")),
        "live": _live(),
        "status": _status(st),
        "rules": {"target_atr": 1.5, "stop_atr": 1.0, "exit_ist": "15:10", "last_entry_ist": "14:45"},
    }


def page() -> dict:
    st = _state()
    latest = sorted((st.get("latest") or {}).values(), key=lambda p: (p.get("decision") == "SKIP", p.get("symbol", "")))
    reports = sorted((st.get("reports") or {}).values(),
                     key=lambda r: -max(((r.get(s) or {}).get("model") or {}).get("avg_net") or -99 for s in ("long", "short")))
    calls = _rows("SELECT * FROM profit_calls ORDER BY id DESC LIMIT 100")
    return {**summary(), "latest": latest, "reports": reports, "calls": calls}
