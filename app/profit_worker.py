"""Separate process that runs the independent profit model:  python -m app.profit_worker

The server starts it at idle CPU priority (profit_bridge.py); it can also be run by hand.  Only one copy runs
(a lock file).  It never downloads prices: bars, the stock list and the fee settings come from the server's
read-only /api/internal/* endpoints, which serve what the server already holds in memory.  It writes only its
own files (data/cache/profit/, data/profit.db) and quits when the server has been unreachable for a while.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from logging.handlers import RotatingFileHandler

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")         # one core at most, so the server's own work is never starved

import pandas as pd  # noqa: E402

from . import profit_model as pm  # noqa: E402
from .data import bar_is_forming  # noqa: E402

log = logging.getLogger("tradebot.profit")
SERVER_GONE = 600          # seconds without a reply from the server before the worker exits
PARENT = int(os.environ.get("TRADEBOT_PARENT_PID") or 0)   # the server process that launched this worker
CHECK_EVERY = 15           # seconds between "is the server process still there?" checks while waiting


class ServerGone(Exception):
    pass


def parent_alive() -> bool:
    """False once the server process that started this worker has ended (window closed, Ctrl+C, crash)."""
    if not PARENT:
        return True                            # started by hand: rely on SERVER_GONE instead
    if os.name == "nt":
        import ctypes
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x00100000, False, PARENT)      # SYNCHRONIZE
        if not h:
            return False
        try:
            return k32.WaitForSingleObject(h, 0) == 0x102   # WAIT_TIMEOUT: still running
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(PARENT, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
MARKET_SYMBOL = "^NSEI"


class Server:
    def __init__(self, url: str, token: str):
        self.url, self.token = url.rstrip("/"), token

    def get(self, path: str, **params):
        q = ("?" + urllib.parse.urlencode(params)) if params else ""
        req = urllib.request.Request(self.url + path + q, headers={"X-Profit-Token": self.token})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise

    def bars(self, symbol: str, interval: str) -> pd.DataFrame | None:
        d = self.get("/api/internal/bars", symbol=symbol, interval=interval)
        if not d or not d.get("t"):
            return None
        idx = pd.to_datetime(d["t"], unit="s")
        df = pd.DataFrame({"open": d["o"], "high": d["h"], "low": d["l"], "close": d["c"], "volume": d["v"]}, index=idx, dtype=float)
        if not df.index.is_unique or not df.index.is_monotonic_increasing:
            log.warning("bars for %s %s came back with bad timestamps; skipped", symbol, interval)
            return None
        if len(df) and bar_is_forming(symbol, interval, df.index[-1]):
            df = df.iloc[:-1]
        return df


def _single_instance():
    os.makedirs(pm.CACHE_DIR, exist_ok=True)
    fh = open(os.path.join(pm.CACHE_DIR, "worker.lock"), "a+")
    try:
        if os.name == "nt":
            import msvcrt
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return None
    return fh                                  # keep the handle open: the lock lives as long as the process


def _lower_priority() -> None:
    try:
        if os.name != "nt":
            os.nice(19)
    except Exception:
        pass


class Worker:
    def __init__(self, server: Server):
        self.server = server
        old = pm.read_state()
        self.state = {"latest": old.get("latest") or {}, "reports": old.get("reports") or {},
                      "status": {"pid": os.getpid(), "started": pm.now_iso(), "running": False, "done": 0, "total": 0,
                                 "current": None, "pass_started": None, "pass_finished": None, "error": None, "heartbeat": pm.now_iso()}}
        self.fits: dict[tuple[str, str], pm.ProfitFit] = {}

    def save(self, **status) -> None:
        self.state["status"].update(status, heartbeat=pm.now_iso())
        pm.write_state(self.state)

    def one(self, symbol: str, interval: str, market: pd.DataFrame | None, settings: dict, market_open: bool) -> None:
        key = f"{symbol}|{interval}"
        bars = self.server.bars(symbol, interval)
        if bars is None or len(bars) < 300:
            return
        f = self.fits.get((symbol, interval)) or pm.load_fit(symbol, interval)
        prev = self.state["latest"].get(key)
        fresh = pm.fit_is_fresh(f, bars, market_open)
        if fresh and prev and prev.get("bar_time") == pd.Timestamp(bars.index[-1]).isoformat():
            self.fits[(symbol, interval)] = f
            return                             # nothing new on this chart
        data = pm.prepare(bars)
        if not fresh:
            f = pm.fit(symbol, interval, data, market, settings)
            if f is None:
                return
            pm.save_fit(f)
            self.state["reports"][key] = pm.report_of(f)
        elif key not in self.state["reports"]:
            self.state["reports"][key] = pm.report_of(f)
        self.fits[(symbol, interval)] = f
        pred = pm.predict(f, data, market, settings)
        self.state["latest"][key] = pred
        if market_open:
            pm.record(pred)

    def grade_pending(self) -> int:
        n, cache = 0, {}
        for call in pm.pending_calls():
            k = (call["symbol"], call["interval"])
            if k not in cache:
                cache[k] = self.server.bars(*k)
            if cache[k] is not None and pm.grade(call, cache[k]):
                n += 1
        return n

    def scan(self) -> dict:
        u = self.server.get("/api/internal/universe")
        interval, symbols, settings = u["interval"], u["symbols"], u["settings"]
        if interval not in pm.HORIZON:
            self.save(running=False, error=f"timeframe {interval} is not supported by the profit model")
            return u
        keep = {f"{s}|{interval}" for s in symbols}
        for part in ("latest", "reports"):
            self.state[part] = {k: v for k, v in self.state[part].items() if k in keep}
        market = self.server.bars(MARKET_SYMBOL, interval)
        self.save(running=True, total=len(symbols), done=0, pass_started=pm.now_iso(), error=None, interval=interval,
                  broker=settings["fees"].get("broker"))
        for i, sym in enumerate(symbols):
            if not parent_alive():
                raise ServerGone()
            self.save(current=sym, done=i)
            try:
                self.one(sym, interval, market, settings, bool(u.get("market_open")))
            except Exception as exc:
                log.exception("profit model failed for %s", sym)
                self.state["status"]["error"] = f"{sym}: {exc}"
            time.sleep(0.05)
        graded = self.grade_pending()
        self.save(running=False, current=None, done=len(symbols), pass_finished=pm.now_iso(), graded=graded)
        return u


def main() -> int:
    os.makedirs(pm.CACHE_DIR, exist_ok=True)
    handler = RotatingFileHandler(os.path.join(pm.CACHE_DIR, "worker.log"), maxBytes=1_000_000, backupCount=1, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, handlers=[handler], format="%(asctime)s %(levelname)s %(message)s")
    lock = _single_instance()
    if lock is None:
        log.info("another profit worker is already running; exiting")
        return 0
    _lower_priority()
    url = os.environ.get("TRADEBOT_PROFIT_URL", "http://127.0.0.1:8003")
    token = os.environ.get("TRADEBOT_PROFIT_TOKEN")
    if not token:
        try:
            with open(os.path.join(pm.CACHE_DIR, "token"), encoding="utf-8") as fh:
                token = fh.read().strip()
        except FileNotFoundError:
            token = ""
    w = Worker(Server(url, token))
    log.info("profit worker %d started against %s", os.getpid(), url)
    last_ok = time.time()
    paused = os.path.join(pm.CACHE_DIR, "paused")
    while True:
        if os.path.exists(paused):
            log.info("paused (data/cache/profit/paused exists); exiting")
            w.save(running=False, error="paused")
            return 0
        try:
            u = w.scan()
            last_ok = time.time()
            wait = float(u.get("next_scan_in") or 1800)
        except ServerGone:
            log.info("the server has stopped; exiting")
            w.save(running=False, current=None, error="stopped with the server")
            return 0
        except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
            if time.time() - last_ok > SERVER_GONE:
                log.info("server unreachable for %ds (%s); exiting", SERVER_GONE, exc)
                return 0
            w.save(running=False, error=f"server unreachable: {exc}")
            wait = 30
        except Exception as exc:
            log.exception("profit scan failed")
            w.save(running=False, error=str(exc))
            wait = 120
        end = time.time() + max(15.0, min(wait, 1800.0))
        while time.time() < end:                 # sleep in short steps so closing the app stops the worker quickly
            if not parent_alive():
                log.info("the server has stopped; exiting")
                w.save(running=False, current=None, error="stopped with the server")
                return 0
            if os.path.exists(paused):
                break
            time.sleep(min(CHECK_EVERY, max(0.0, end - time.time())))


if __name__ == "__main__":
    sys.exit(main())
