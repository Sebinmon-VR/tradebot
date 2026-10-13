"""Ready-to-trade scanner: keeps a list of stocks that pass the whole pipeline right now.

A background thread walks a universe (NIFTY 100 by default) and runs, for every stock, exactly what
the chart page runs when you press Analyze: the 40 strategies, the walk-forward learner (a direction
only where out-of-sample calls of that strength were right >= 55% of the time) and the broker-costed
trade plan.  A stock is *ready* when the plan's verdict is "trade" (enter at market now) or "wait"
(a limit order at the nearest level); everything else is counted under the reason it failed, so the
page shows the tradable names first and never asks you to analyse one stock at a time.

Order of work:
  1. a cheap pre-filter on daily bars (one batched Yahoo download for the universe): drop stocks whose
     single share costs more than the capital, and rank the rest by daily ATR % (a stock that does not
     move cannot pay ~0.4% of round-trip charges) - names already cached go first on a cold start;
  2. the full analysis, one stock at a time, in that order;
  3. after every bar close in market hours, every stock whose last analysis is older than that bar is
     analysed again - stocks with an UP / DOWN call first.  Models are fitted once per session (learner.py),
     so a candle costs one new bar of strategy votes and a prediction per stock;
  4. between candles, every ~15 s, each listed stock's trade plan is re-run at its live price from the Yahoo
     tick stream (live.py): a limit order whose level is reached becomes "trade now", an entry the price ran
     away from drops out.  The call itself (direction, probability) always comes from the last closed candle.

Results are kept in memory and in data/cache/ready.json, so the list is on screen the moment the
server starts.  The thread always yields to interactive requests (see priority.py).
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone

from . import db, screener, trading
from .data import DataError, INDIA_SESSION_UTC, fetch_ohlcv, interval_seconds
from .ensemble import analyze
from .learner import CACHE_DIR, _vote_file
from .priority import background, yield_if_busy
from .universe import UNIVERSES
from . import tradingdays

log = logging.getLogger("tradebot.ready")

STATE_FILE = os.path.join(CACHE_DIR, "ready.json")
INTERVALS = ("5m", "15m", "30m", "1h")
DEFAULTS = {"universe": "movers", "interval": "15m"}     # "movers" = the 2% movers list (movers.py)
BAR_GRACE = 25            # seconds after a bar closes before re-analysing (Yahoo publishes the bar a little late)
MIN_TURNOVER = 2e7       # rupees of daily turnover: thinner stocks are skipped (wide spreads, slippage)
IDLE_SLEEP = 30
LIVE_EVERY = 15           # seconds between live-price re-checks of the list in market hours
LIVE_MOVE = 0.0015        # re-plan a stock once its price has moved 0.15% since its last plan (a plan costs ~20 ms here, ~150 ms on the B1 host)

_LOCK = threading.RLock()
_ROWS: dict[str, dict[str, dict]] = {}        # "universe|interval" -> symbol -> row
_STATUS = {"running": False, "current": None, "done": 0, "total": 0, "pass_started": None, "pass_finished": None,
           "skipped": [], "error": None, "universe": None, "interval": None}
_HOLIDAY: dict[str, str] = {"date": ""}       # a weekday on which the session clock says open but no bar printed
_DONE: dict[str, str] = {}                    # "universe|interval" -> bar boundary the last complete pass covered
_CTX: dict[tuple[str, str], tuple[dict, object]] = {}   # (key, symbol) -> (analysis, price history) behind the row, for live re-plans
_LIVE = {"at": 0.0}
_WAKE = threading.Event()
_STOP = threading.Event()
_THREAD: threading.Thread | None = None
_LOADED = False


# ---------------------------------------------------------------- config and persistence
def get_config() -> dict:
    cfg = dict(DEFAULTS)
    cfg.update({k: v for k, v in (db.get_setting("ready") or {}).items() if k in DEFAULTS})
    if cfg["universe"] not in UNIVERSES and cfg["universe"] != "movers":
        cfg["universe"] = DEFAULTS["universe"]
    if cfg["interval"] not in INTERVALS:
        cfg["interval"] = DEFAULTS["interval"]
    return cfg


def set_config(patch: dict) -> dict:
    cfg = get_config()
    if patch.get("universe") in UNIVERSES or patch.get("universe") == "movers":
        cfg["universe"] = patch["universe"]
    if patch.get("interval") in INTERVALS:
        cfg["interval"] = patch["interval"]
    db.set_setting("ready", cfg)
    _WAKE.set()
    return cfg


def _key(cfg: dict) -> str:
    return f"{cfg['universe']}|{cfg['interval']}"


def _universe(cfg: dict) -> dict:
    """Symbols to scan.  "movers" is dynamic: the stocks that most often move 2% in a session (movers.py)."""
    if cfg["universe"] == "movers":
        from . import movers
        return {"name": f"2% movers · top {movers.TOP_N}", "exchange": "NSE", "symbols": movers.top_symbols(),
                "source": movers.SOURCE_UNIVERSE}
    return {**UNIVERSES[cfg["universe"]], "source": cfg["universe"]}


def _load() -> None:
    global _LOADED
    if _LOADED:
        return
    _LOADED = True
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, encoding="utf-8") as fh:
                _ROWS.update(json.load(fh))
    except Exception as exc:  # pragma: no cover
        log.warning("could not load ready list: %s", exc)


def _save() -> None:
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with _LOCK:
            data = json.dumps(_ROWS)
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(data)
        os.replace(tmp, STATE_FILE)
    except Exception as exc:  # pragma: no cover
        log.warning("could not save ready list: %s", exc)


# ---------------------------------------------------------------- market clock
def _session(day: datetime) -> tuple[datetime, datetime]:
    (oh, om), (ch, cm) = INDIA_SESSION_UTC
    d = day.replace(hour=0, minute=0, second=0, microsecond=0)
    return d.replace(hour=oh, minute=om), d.replace(hour=ch, minute=cm)


def market_open(now: datetime | None = None) -> bool:
    """Inside the 09:15-15:30 IST session on an NSE trading day (tradingdays.py), and not a holiday the
    scanner detected itself (a day missing from the calendar)."""
    now = now or datetime.now(timezone.utc)
    return tradingdays.is_open(now) and _HOLIDAY["date"] != now.date().isoformat()


def _check_holiday(now: datetime, sec: int, rows: list[dict]) -> bool:
    """NSE holidays are not in the clock: if a full bar after today's open has passed and none of the stocks
    analysed so far has a bar from today, the exchange is shut today."""
    o, _ = _session(now)
    if now < o + timedelta(seconds=2 * sec + BAR_GRACE):
        return False
    bars = [r.get("bar_time") for r in rows if r.get("bar_time")]
    if len(bars) < 5 or any(b[:10] == now.date().isoformat() for b in bars):
        return False
    _HOLIDAY["date"] = now.date().isoformat()
    log.info("no bars today from %d stocks: treating %s as an exchange holiday", len(bars), _HOLIDAY["date"])
    return True


def last_boundary(now: datetime, sec: int) -> datetime:
    """Close time of the most recent bar (aware UTC): bars start at the 09:15 IST open; outside the session
    it is the last session's close."""
    d = now
    for _ in range(15):
        o, c = _session(d)
        if tradingdays.is_trading_day(d.date()) and _HOLIDAY["date"] != d.date().isoformat() and now >= o + timedelta(seconds=sec):
            if now >= c:
                return c
            k = int((now - o).total_seconds() // sec)
            return min(c, o + timedelta(seconds=k * sec))
        d = (d - timedelta(days=1)).replace(hour=23, minute=59)
    return now


def published_boundary(now: datetime, sec: int) -> datetime:
    """Close of the latest bar Yahoo has had time to publish (closed at least BAR_GRACE seconds ago)."""
    return last_boundary(now - timedelta(seconds=BAR_GRACE), sec)


def next_boundary(now: datetime, sec: int) -> datetime | None:
    if not market_open(now):
        return None
    o, c = _session(now)
    k = int((now - o).total_seconds() // sec) + 1
    return min(c, o + timedelta(seconds=k * sec))


# ---------------------------------------------------------------- one stock
_REASON_GROUPS = [
    ("no validated edge", "No validated edge - the model stands aside"),
    ("cannot short-sell", "DOWN call - delivery can't short"),
    ("support level within", "No entry level nearby"),
    ("resistance level within", "No entry level nearby"),
    ("far enough", "Target too close to pay the charges"),
    ("not positive after charges", "Loses money after charges on average"),
    ("charges would take", "Charges eat too much of the profit"),
    ("capital too small", "Too expensive for your capital"),
    ("risk budget", "Stop too wide for your risk budget"),
    ("below the", "Trade too small for the flat charges"),
]


def _reason_group(direction: str, reasons: list[str]) -> str | None:
    if direction == "SIDEWAYS":
        return _REASON_GROUPS[0][1]
    for r in reasons:
        for needle, label in _REASON_GROUPS:
            if needle in r:
                return label
    return reasons[0][:60] if reasons else None


def _plan_fields(res: dict, plan: dict) -> dict:
    """The parts of a row that follow the price (re-computed by live_refresh between candles)."""
    best = plan.get("best") or {}
    prob = best.get("prob") or {}
    reasons = list(plan.get("reasons") or ([plan["reason"]] if plan.get("reason") else []))
    verdict = plan.get("verdict") if plan.get("available") else "no trade"
    return {
        "verdict": verdict, "reasons": reasons, "reason_group": None if verdict in ("trade", "wait") else _reason_group(res.get("direction"), reasons),
        "side": plan.get("side"), "entry_type": plan.get("entry_type"), "entry": plan.get("entry"), "level_name": plan.get("level_name"),
        "stop": plan.get("stop"), "target": best.get("target"), "target_name": best.get("target_name"), "mode": best.get("mode"),
        "deadline": best.get("deadline_label"), "qty": plan.get("qty_affordable") if plan.get("qty_affordable") else plan.get("qty"),
        "value": plan.get("value"), "net_win": best.get("net_win"), "net_loss": best.get("net_loss"), "expectancy": best.get("expectancy"),
        "p_target": prob.get("target"), "p_stop": prob.get("stop"), "rr": best.get("rr"), "charges": (best.get("charges") or {}).get("total"),
        "cost_pct": plan.get("cost_pct") if plan.get("cost_pct") is not None else (best.get("charges") or {}).get("pct_of_value"),
    }


def _row(sym: str, pre: dict, res: dict, plan: dict, boundary: str, took: float) -> dict:
    summary = res.get("summary") or {}
    learner = summary.get("learner") or {}
    return {
        "symbol": sym, "name": sym.replace(".NS", "").replace(".BO", ""), "sector": pre.get("sector"),
        "price": res.get("price_at"), "chg_1d": pre.get("chg_1d"), "atr_pct": pre.get("atr_pct"),
        "interval": res.get("interval"), "horizon": res.get("horizon_bars"),
        "direction": res.get("direction"), "prob_up": res.get("prob_up"),
        "accuracy": summary.get("expected_accuracy"), "evidence": learner.get("evidence"),
        **_plan_fields(res, plan),
        "bar_time": res.get("bar_time"), "analyzed_at": datetime.now(timezone.utc).isoformat(), "boundary": boundary, "took_s": round(took, 1),
    }


def _analyze_one(sym: str, cfg: dict, pre: dict, boundary: str, settings: dict) -> dict:
    t0 = time.time()
    try:
        raw = fetch_ohlcv(sym, cfg["interval"])          # one download serves the analysis and the plan
        res = analyze(sym, cfg["interval"], df=raw)
        plan = trading.build_plan(res, settings, df=raw, check_positions=False)
        row = _row(sym, pre, res, plan, boundary, time.time() - t0)
        row["spark"] = [round(float(x), 2) for x in raw["close"].tail(64)]     # mini chart on the card
        row["plan_price"] = row["price"]
        _CTX[(_key(cfg), sym)] = (res, raw[["high", "low", "close"]])
        _save_prediction(row, res, (_ROWS.get(_key(cfg)) or {}).get(sym) or {})
        return row
    except DataError as exc:
        return {"symbol": sym, "name": sym.replace(".NS", "").replace(".BO", ""), "verdict": "error", "reasons": [str(exc)],
                "reason_group": "No data", "analyzed_at": datetime.now(timezone.utc).isoformat(), "boundary": boundary, "took_s": round(time.time() - t0, 1)}


def _save_prediction(row: dict, res: dict, prev: dict) -> None:
    """A ready call is a real prediction: store it (once per bar) so its track record is graded like any other."""
    if row.get("verdict") != "trade":
        return
    if prev.get("saved_bar") == res["bar_time"]:
        row["prediction_id"], row["saved_bar"] = prev.get("prediction_id"), prev.get("saved_bar")
        return
    try:
        row["prediction_id"] = db.insert_prediction({**res, "source": "ready"})
        row["saved_bar"] = res["bar_time"]
    except Exception as exc:  # pragma: no cover
        log.warning("could not save ready prediction for %s: %s", row.get("symbol"), exc)


# ---------------------------------------------------------------- live prices between candles
def live_symbols() -> list[str]:
    """Stocks on the current list (main.py keeps the tick stream following them in market hours)."""
    with _LOCK:
        return sorted((_ROWS.get(_key(get_config())) or {}).keys())


def live_refresh(cfg: dict) -> int:
    """Re-check every listed stock against its latest trade from the tick stream: the price on the row
    follows the market, and a stock with an UP / DOWN call gets its trade plan re-run at that price.
    Returns how many plans were re-run."""
    from .live import hub
    now = datetime.now(timezone.utc)
    if not market_open(now):
        return 0
    _LIVE["at"] = time.time()
    key = _key(cfg)
    open_ms = _session(now)[0].timestamp() * 1000
    settings = None
    with _LOCK:
        items = list((_ROWS.get(key) or {}).items())
    n = 0
    for sym, row in items:
        tick = hub.last_tick(sym)
        if not tick or tick["time"] < open_ms:
            continue                                # no trade printed today yet
        px = round(float(tick["price"]), 2)
        live = {"price": px, "live_at": datetime.fromtimestamp(tick["time"] / 1000, timezone.utc).isoformat()}
        if tick.get("change_percent") is not None:
            live["chg_1d"] = round(float(tick["change_percent"]), 2)
        ctx = _CTX.get((key, sym))
        ref = row.get("plan_price") or row.get("price")
        if ctx and row.get("direction") in ("UP", "DOWN") and ref and abs(px / ref - 1) >= LIVE_MOVE:
            res, hist = ctx
            settings = settings or trading.get_settings()
            plan = trading.build_plan({**res, "price_at": px}, settings, df=hist, check_positions=False)
            live.update(_plan_fields(res, plan), plan_price=px, planned_at=now.isoformat())
            _save_prediction(live, res, row)
            n += 1
        with _LOCK:
            row.update(live)
    return n


def _live_due() -> bool:
    return time.time() - _LIVE["at"] >= LIVE_EVERY


# ---------------------------------------------------------------- pre-filter
PREFILTER_TTL = 1800      # daily metrics barely change within half an hour; don't re-download the universe every pass
_PRE: dict[tuple, tuple[float, tuple]] = {}


def _prefilter(cfg: dict, settings: dict) -> tuple[list[tuple[str, dict]], list[dict]]:
    k = (cfg["universe"], cfg["interval"], float(settings["capital"]))
    hit = _PRE.get(k)
    if hit and time.time() - hit[0] < PREFILTER_TTL:
        return hit[1]
    out = _prefilter_now(cfg, settings)
    if out[0]:
        _PRE[k] = (time.time(), out)
    return out


def _prefilter_now(cfg: dict, settings: dict) -> tuple[list[tuple[str, dict]], list[dict]]:
    uni = _universe(cfg)
    capital = float(settings["capital"])
    if not uni["symbols"]:
        return [], []
    try:
        # only the stocks being scanned (40 movers, not the whole 277-stock source list), without the costly extra score
        scan = screener.scan("custom", uni["symbols"], light=True) if cfg["universe"] == "movers" else screener.scan(uni["source"], light=True)
        rows = {r["symbol"]: r for r in scan["rows"]}
    except Exception as exc:
        log.warning("ready pre-filter scan failed, analysing the whole universe unranked: %s", exc)
        rows = {}
    keep, skipped = [], []
    for sym in uni["symbols"]:
        r = rows.get(sym) or {}
        price, turnover = r.get("price"), r.get("turnover")
        if price is not None and price > capital:
            skipped.append({"symbol": sym, "reason": f"one share ({price:,.0f}) costs more than your capital ({capital:,.0f})"})
            continue
        if turnover is not None and turnover < MIN_TURNOVER:
            skipped.append({"symbol": sym, "reason": f"thin trading (turnover {turnover / 1e7:.1f} cr)"})
            continue
        keep.append((sym, r))
    cached = {sym for sym, _ in keep if os.path.exists(_vote_file(sym, cfg["interval"]))}
    keep.sort(key=lambda t: (t[0] not in cached, -(t[1].get("atr_pct") or 0)))
    return keep, skipped


# ---------------------------------------------------------------- the loop
def _pass(cfg: dict) -> int:
    """Analyse every stock that is due.  Returns how many were analysed."""
    settings = trading.get_settings()
    sec = interval_seconds(cfg["interval"])
    now = datetime.now(timezone.utc)
    if _HOLIDAY["date"] == now.date().isoformat():
        boundary = last_boundary(_session(now)[0] - timedelta(seconds=1), sec)    # nothing new since the last session
    else:
        boundary = published_boundary(now, sec)
    b_iso = boundary.isoformat()
    key = _key(cfg)
    with _LOCK:
        rows = _ROWS.setdefault(key, {})
    todo, skipped = _prefilter(cfg, settings)
    if not todo:
        _STATUS.update(error=None, total=0, done=0, universe=cfg["universe"], interval=cfg["interval"])
        return -1                                   # nothing to scan yet (the movers list is still being measured)
    universe_syms = {s for s, _ in todo}
    with _LOCK:
        for s in [s for s in rows if s not in universe_syms]:
            rows.pop(s, None)                       # now filtered out (price above capital, thin) or left the universe
    live = market_open(now)
    # after a restart the analysis behind a called stock's row is gone, so re-analyse it once to let its plan follow the price
    due = [(s, pre) for s, pre in todo if (rows.get(s) or {}).get("boundary", "") < b_iso
           or (live and (rows.get(s) or {}).get("direction") in ("UP", "DOWN") and (key, s) not in _CTX)]
    due.sort(key=lambda t: (rows.get(t[0]) or {}).get("direction") not in ("UP", "DOWN"))   # stable: called stocks first
    _STATUS.update(skipped=skipped, total=len(todo), done=len(todo) - len(due), universe=cfg["universe"], interval=cfg["interval"])
    if not due:
        _DONE[key] = b_iso
        return 0
    _STATUS.update(running=True, pass_started=datetime.now(timezone.utc).isoformat(), error=None)
    n = 0
    try:
        for sym, pre in due:
            if _STOP.is_set() or _key(get_config()) != key:
                break                               # stopped, or the universe / timeframe was changed
            yield_if_busy()
            if _live_due():
                live_refresh(cfg)
            _STATUS["current"] = sym
            row = _analyze_one(sym, cfg, pre, b_iso, settings)
            with _LOCK:
                rows[sym] = row
            n += 1
            _STATUS["done"] += 1
            if n == 5 and market_open(now) and _check_holiday(now, sec, [rows[x] for x, _ in due[:5] if x in rows]):
                break
            if n % 5 == 0:
                _save()
    finally:
        _STATUS.update(running=False, current=None, pass_finished=datetime.now(timezone.utc).isoformat())
        _save()
    if n == len(due):
        _DONE[key] = b_iso
    return n


def _idle_until_open(cfg: dict) -> float | None:
    """Outside the session, once every stock has been analysed on the last session's bars there is nothing
    to do until the next open: no downloads on evenings, weekends or holidays.  Returns seconds to sleep."""
    now = datetime.now(timezone.utc)
    if market_open(now):
        return None
    sec = interval_seconds(cfg["interval"])
    if _DONE.get(_key(cfg)) != published_boundary(now, sec).isoformat():
        return None
    return max(60.0, (tradingdays.next_open(now) - now).total_seconds() + BAR_GRACE)


def _loop() -> None:
    with background():
        _load()
        while not _STOP.is_set():
            try:
                cfg = get_config()
                idle = _idle_until_open(cfg)
                if idle is not None:
                    _STATUS.update(running=False, current=None)
                    _WAKE.wait(min(idle, 6 * 3600))      # a config change or rescan wakes it early
                    _WAKE.clear()
                    continue
                n = _pass(cfg)
                if n < 0:
                    _WAKE.wait(30)
                    _WAKE.clear()
                    continue
                if n:
                    log.info("ready scan %s: analysed %d stocks", _key(cfg), n)
            except Exception as exc:
                log.exception("ready scan failed")
                _STATUS.update(running=False, error=str(exc))
                _WAKE.wait(120)
            # follow live prices until a newer candle than the last complete pass is published (a candle that
            # closed while a slow pass was running is scanned straight away); a config change / rescan wakes us early
            cfg = get_config()
            sec = interval_seconds(cfg["interval"])
            while not _STOP.is_set():
                now = datetime.now(timezone.utc)
                nb = next_boundary(now, sec)
                if nb is None:
                    _WAKE.wait(IDLE_SLEEP)
                    break
                if _DONE.get(_key(cfg)) != published_boundary(now, sec).isoformat():
                    break
                left = (nb - now).total_seconds() + BAR_GRACE
                if _WAKE.wait(max(1.0, min(left, LIVE_EVERY))):
                    break
                try:
                    live_refresh(cfg)
                except Exception:
                    log.exception("live refresh failed")
            _WAKE.clear()


def start() -> None:
    global _THREAD
    if _THREAD is not None and _THREAD.is_alive():
        return
    _STOP.clear()
    _THREAD = threading.Thread(target=_loop, daemon=True, name="ready-scanner")
    _THREAD.start()


def stop() -> None:
    _STOP.set()
    _WAKE.set()


def rescan() -> None:
    """Re-analyse every stock now (e.g. after changing capital or fee settings)."""
    with _LOCK:
        rows = _ROWS.get(_key(get_config())) or {}
        for r in rows.values():
            r["boundary"] = ""
    _DONE.clear()
    _WAKE.set()


# ---------------------------------------------------------------- API view
_ORDER = {"trade": 0, "wait": 1}


def view() -> dict:
    _load()
    cfg = get_config()
    st = trading.get_settings()
    now = datetime.now(timezone.utc)
    sec = interval_seconds(cfg["interval"])
    b_iso = published_boundary(now, sec).isoformat()
    with _LOCK:
        rows = [dict(r) for r in (_ROWS.get(_key(cfg)) or {}).values()]
    for r in rows:
        r["stale"] = (r.get("boundary") or "") < b_iso       # analysed on an older candle; queued for re-analysis
    ready = [r for r in rows if r.get("verdict") in _ORDER]
    ready.sort(key=lambda r: (_ORDER[r["verdict"]], -(r.get("expectancy") or -1e9), -(r.get("accuracy") or 0)))
    others = [r for r in rows if r.get("verdict") not in _ORDER]
    groups: dict[str, int] = {}
    for r in others:
        g = r.get("reason_group") or "Other"
        groups[g] = groups.get(g, 0) + 1
    # names with a validated call that failed only on costs / levels are the ones to keep an eye on
    watch = [r for r in others if r.get("direction") in ("UP", "DOWN")]
    watch.sort(key=lambda r: -(r.get("accuracy") or 0))
    others.sort(key=lambda r: (r.get("direction") not in ("UP", "DOWN"), r.get("name") or ""))
    open_n = len(db.list_trades(status="open")) + len(db.list_trades(status="pending"))
    nb = next_boundary(now, sec)
    return {
        "config": cfg, "universe_name": _universe(cfg)["name"],
        "universes": [{"key": "movers", "name": "2% movers (best for small capital)", "count": 40}]
                     + [{"key": k, "name": v["name"], "count": len(v["symbols"])} for k, v in UNIVERSES.items() if v.get("exchange") == "NSE"],
        "intervals": list(INTERVALS),
        "market_open": market_open(now), "market": tradingdays.status(now), "next_refresh": None if nb is None else (nb + timedelta(seconds=BAR_GRACE)).isoformat(),
        "status": {k: v for k, v in _STATUS.items() if k != "skipped"}, "skipped": _STATUS["skipped"],
        "capital": st["capital"], "broker": st["fees"]["broker"], "open_positions": open_n, "max_positions": st["max_positions"],
        "ready": ready, "watch": watch[:12], "others": others, "groups": sorted(groups.items(), key=lambda t: -t[1]),
        "analysed": len(rows), "stale": sum(r["stale"] for r in rows), "server_time": now.isoformat(),
        "live_at": (max((r.get("live_at") or "" for r in rows), default="") or None) if market_open(now) else None,   # newest tick on the list
    }


def calls() -> dict[str, dict]:
    """Latest scanner row per symbol across every universe scanned on the current timeframe (newest wins)."""
    cfg = get_config()
    out: dict[str, dict] = {}
    with _LOCK:
        for key, rows in _ROWS.items():
            if not key.endswith("|" + cfg["interval"]):
                continue
            for sym, r in rows.items():
                if sym not in out or (r.get("analyzed_at") or "") > (out[sym].get("analyzed_at") or ""):
                    out[sym] = r
    return out
