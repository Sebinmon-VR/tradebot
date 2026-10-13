"""FastAPI application: REST API + static front-end."""
from __future__ import annotations

import asyncio
import inspect
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from urllib.parse import quote as urlquote
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi import Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
import pandas as pd
from pydantic import BaseModel, Field

from . import db, evaluator, screener, learner, trading, overextended, intraday_ext, ready, priority, tradingdays, movers, auth
from . import profit_bridge
from .live import hub
from .universe import UNIVERSES
from .data import (DataError, INTERVALS, EXCHANGE_SUFFIX, ALIASES, fetch_ohlcv, normalize_symbol, search_symbols,
                   bar_is_forming, interval_seconds, peek_ohlcv)
from .ensemble import analyze, chart_payload, DEFAULT_HORIZON, BASE_WEIGHT, adaptive_multiplier
from .strategies import STRATEGIES
from .models import MODELS, hurst_regime

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("tradebot")

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
RESOLVE_EVERY = int(os.environ.get("TRADEBOT_RESOLVE_SECONDS", "600"))
TRADE_CHECK_EVERY = int(os.environ.get("TRADEBOT_TRADE_CHECK_SECONDS", "60"))


async def _resolver_loop():
    first = True
    while True:
        if not first and not tradingdays.is_trading_day(tradingdays.ist_now().date()):
            await asyncio.sleep(RESOLVE_EVERY)      # weekends and NSE holidays: nothing new to grade
            continue
        first = False
        try:
            res = await asyncio.to_thread(evaluator.resolve_pending)
            if res["resolved"]:
                log.info("auto-resolved %d predictions", len(res["resolved"]))
        except Exception:
            log.exception("resolver loop failed")
        await asyncio.sleep(RESOLVE_EVERY)


async def _trade_loop():
    """Fill pending paper orders and exit open paper trades against real bars."""
    while True:
        try:
            if not tradingdays.is_trading_day(tradingdays.ist_now().date()):
                pass                                # no session today: orders cannot fill or exit
            elif db.list_trades(status="open") or db.list_trades(status="pending"):
                res = await asyncio.to_thread(trading.check_trades)
                if res["filled"] or res["closed"]:
                    log.info("paper trades: %d filled, %d closed", len(res["filled"]), len(res["closed"]))
        except Exception:
            log.exception("trade loop failed")
        await asyncio.sleep(TRADE_CHECK_EVERY)


async def _ready_ticks_loop():
    """Keep the tick stream following the ready list's stocks in market hours, so the scanner can re-check
    every plan against the live price between candles (ready.live_refresh)."""
    while True:
        try:
            hub.watch(ready.live_symbols() if ready.market_open() else [])
        except Exception:
            log.exception("ready tick watch failed")
        await asyncio.sleep(20)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    tasks = [asyncio.create_task(_resolver_loop()), asyncio.create_task(_trade_loop()), asyncio.create_task(_ready_ticks_loop())]
    ready.start()
    profit_bridge.start()          # the independent profit model: a separate idle-priority process (TRADEBOT_PROFIT=0 to skip)
    yield
    profit_bridge.stop()
    ready.stop()
    for t in tasks:
        t.cancel()
    await hub.stop()


app = FastAPI(title="Trading Analytics & Prediction", version="1.0", lifespan=lifespan)


@app.middleware("http")
async def require_login(request: Request, call_next):
    """Hosted app: everything except the login page needs the signed cookie (auth.py; off when no password is set)."""
    path = request.url.path
    if path.startswith("/api/internal/"):
        # read-only feed for the profit-model worker: its token only, never a browser session
        if not profit_bridge.token_ok(request.headers.get("x-profit-token")):
            return JSONResponse({"detail": "Forbidden"}, status_code=403)
        return await call_next(request)
    if auth.enabled() and not auth.is_open_path(path) and not auth.valid(request.cookies.get(auth.COOKIE)):
        if path.startswith("/api/"):
            return JSONResponse({"detail": "Not signed in"}, status_code=401)
        nxt = path + (("?" + request.url.query) if request.url.query else "")
        return RedirectResponse("/login?next=" + urlquote(nxt), status_code=303)
    return await call_next(request)


@app.middleware("http")
async def no_stale_pages(request, call_next):
    """Pages and static files are revalidated on every navigation (ETag -> 304), so a browser coming
    back from another page never runs an old app.js against a newer server."""
    response = await call_next(request)
    if request.url.path.startswith("/static/") or "text/html" in response.headers.get("content-type", ""):
        response.headers["Cache-Control"] = "no-cache"
    return response


# ------------------------------------------------------------------ schemas
class AnalyzeRequest(BaseModel):
    symbol: str = Field(..., examples=["RELIANCE"])
    exchange: str = Field("", examples=["NSE"])
    interval: str = Field("1d")
    horizon: Optional[int] = Field(None, ge=1, le=200, description="Bars ahead to predict")
    save: bool = True
    as_of: Optional[str] = Field(None, description="ISO date/time: analyze as if it were then (previous-day testing)")
    live_price: Optional[float] = Field(None, gt=0, description="Latest streamed price; used as the entry when the last bar is still forming")
    live_symbol: Optional[str] = Field(None, description="Ticker the live price was streamed for; a price from another chart is ignored")


class BacktestRequest(BaseModel):
    symbol: str
    exchange: str = ""
    interval: str = "1d"
    horizon: Optional[int] = Field(None, ge=1, le=200)
    steps: int = Field(10, ge=1, le=100, description="How many historical points to test")
    step_bars: Optional[int] = Field(None, ge=1, le=500, description="Bars between test points (default = horizon)")
    save: bool = True


class TradeRequest(BaseModel):
    symbol: str
    interval: str
    exchange: str = ""
    plan: dict
    prediction_id: Optional[int] = None
    live_price: Optional[float] = Field(None, gt=0)


class CloseRequest(BaseModel):
    price: Optional[float] = Field(None, gt=0)


class OrderRequest(BaseModel):
    symbol: str
    exchange: str = ""
    interval: str = "15m"
    side: str = "BUY"                       # BUY / SELL
    product: str = "intraday"               # intraday (MIS) / overnight (CNC delivery)
    order_type: str = "market"              # market / limit / sl
    qty: int = Field(1, ge=1, le=100000)
    price: Optional[float] = Field(None, gt=0)
    trigger: Optional[float] = Field(None, gt=0)
    stop: Optional[float] = Field(None, gt=0)
    target: Optional[float] = Field(None, gt=0)
    live_price: Optional[float] = Field(None, gt=0)


class FeedbackRequest(BaseModel):
    verdict: str = Field(..., pattern="^(correct|partial|incorrect)$")
    rating: Optional[int] = Field(None, ge=1, le=5)
    note: Optional[str] = Field(None, max_length=2000)


# ------------------------------------------------------------------ helpers
def _err(exc: Exception, code: int = 400):
    raise HTTPException(status_code=code, detail=str(exc))


def _fg(fn, *args):
    """Run an interactive request: the background ready-scanner pauses until it is done."""
    with priority.interactive():
        return fn(*args)


# ------------------------------------------------------------------ routes
@app.get("/")
def home(symbol: Optional[str] = None):
    """Home = the ready-to-trade list.  Links that carry ?symbol= (from the map and the other pages) open the chart."""
    return FileResponse(os.path.join(STATIC_DIR, "index.html" if symbol else "ready.html"))


@app.get("/chart")
def chart_page():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/movers")
def movers_page():
    return FileResponse(os.path.join(STATIC_DIR, "movers.html"))


@app.get("/login")
def login_page():
    return FileResponse(os.path.join(STATIC_DIR, "login.html"))


@app.get("/healthz")
def healthz():
    return {"ok": True}


class LoginRequest(BaseModel):
    password: str = Field(..., max_length=200)


@app.post("/api/login")
async def login(req: LoginRequest, request: Request):
    ip = (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "?")).split(",")[0].strip()
    if not auth.enabled():
        return {"ok": True}
    if auth.locked(ip):
        raise HTTPException(429, "Too many wrong passwords. Try again in 15 minutes.")
    if not auth.check(ip, req.password):
        await asyncio.sleep(1)
        raise HTTPException(401, "Wrong password")
    resp = JSONResponse({"ok": True})
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    resp.set_cookie(auth.COOKIE, auth.make_token(), max_age=auth.MAX_AGE, httponly=True, secure=secure, samesite="lax")
    return resp


@app.post("/api/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE)
    return resp


@app.get("/api/session")
def session():
    return {"auth": auth.enabled()}


# ------------------------------------------------------------------ ready to trade
class ReadyConfig(BaseModel):
    universe: Optional[str] = None
    interval: Optional[str] = None


@app.get("/api/ready")
async def ready_list():
    """Stocks that pass the full pipeline right now (verdict trade / wait), the near misses, and why the rest failed."""
    return await asyncio.to_thread(ready.view)


@app.put("/api/ready/config")
def ready_config(req: ReadyConfig):
    return ready.set_config(req.model_dump(exclude_none=True))


@app.get("/api/movers")
async def movers_list(target: float = Query(movers.DEFAULT_TARGET, ge=0.5, le=5)):
    """Stocks that regularly move `target` % within a session, with today's move and the scanner's call."""
    return await asyncio.to_thread(movers.view, target)


@app.get("/api/market")
def market_status():
    return tradingdays.status()


@app.post("/api/ready/rescan")
def ready_rescan():
    ready.rescan()
    return {"ok": True}


@app.get("/screener")
def screener_page():
    return FileResponse(os.path.join(STATIC_DIR, "screener.html"))


@app.get("/portfolio")
def portfolio_page():
    return FileResponse(os.path.join(STATIC_DIR, "portfolio.html"))


@app.get("/overextended")
def overextended_page():
    return FileResponse(os.path.join(STATIC_DIR, "overextended.html"))


@app.get("/profit")
def profit_page():
    return FileResponse(os.path.join(STATIC_DIR, "profit.html"))


# ------------------------------------------------------------------ independent profit model (report only)
@app.get("/api/profit")
def profit_report():
    """The profit model's predictions, per-stock report and live record (read from its own files)."""
    return profit_bridge.page()


@app.get("/api/profit/summary")
def profit_summary():
    return profit_bridge.summary()


@app.get("/api/internal/universe")
def internal_universe():
    """For the profit worker: the stocks the Ready scanner covers, its timeframe and the fee settings (read only)."""
    cfg = ready.get_config()
    st = trading.get_settings()
    now = datetime.now(timezone.utc)
    nb = ready.next_boundary(now, interval_seconds(cfg["interval"])) if ready.market_open(now) else None
    return {"interval": cfg["interval"], "symbols": sorted(ready.calls().keys()), "market_open": ready.market_open(now),
            "next_scan_in": (nb - now).total_seconds() + 150 if nb else 1800,
            "settings": {"capital": st["capital"], "leverage": st["leverage"], "fees": st["fees"]}}


@app.get("/api/internal/bars")
def internal_bars(symbol: str, interval: str):
    """For the profit worker: bars already in memory (never downloads)."""
    df = peek_ohlcv(symbol, interval)
    if df is None or not len(df):
        raise HTTPException(status_code=404, detail="not in memory")
    df = df[~df.index.duplicated(keep="last")].sort_index()
    return {"t": pd.DatetimeIndex(df.index).as_unit("s").asi8.tolist(), "o": df["open"].tolist(), "h": df["high"].tolist(), "l": df["low"].tolist(),
            "c": df["close"].tolist(), "v": df["volume"].fillna(0).tolist()}


# ------------------------------------------------------------------ paper trading
@app.get("/api/settings")
def settings_get():
    return {**trading.get_settings(), "brokers": trading.brokers()}


@app.put("/api/settings")
def settings_put(body: dict):
    try:
        return {**trading.save_settings(body), "brokers": trading.brokers()}
    except (ValueError, TypeError) as exc:
        _err(exc)


@app.post("/api/settings/reset")
def settings_reset():
    return {**trading.reset_settings(), "brokers": trading.brokers()}


@app.get("/api/portfolio")
async def portfolio():
    return await asyncio.to_thread(trading.portfolio)


@app.get("/api/trades")
def trades(status: Optional[str] = None, limit: int = 200):
    return db.list_trades(status, limit)


@app.post("/api/trades")
async def place_trade(req: TradeRequest):
    try:
        sym = normalize_symbol(req.symbol, req.exchange)
        return await asyncio.to_thread(trading.place_trade, sym, req.interval, req.plan, req.prediction_id, req.live_price)
    except DataError as exc:
        _err(exc)


@app.post("/api/trades/{tid}/close")
async def close_trade(tid: int, req: CloseRequest):
    try:
        return await asyncio.to_thread(trading.close_trade, tid, req.price)
    except DataError as exc:
        _err(exc)


@app.post("/api/trades/check")
async def check_trades():
    return await asyncio.to_thread(trading.check_trades)


def _live_price(sym: str, given: Optional[float]) -> Optional[float]:
    if given:
        return given
    t = hub.last_tick(sym)
    if t and time.time() * 1000 - t["time"] < 120_000:
        return float(t["price"])
    return None


@app.post("/api/orders/preview")
async def order_preview(req: OrderRequest):
    """What an order would do and cost (action, charges, margin, cash after, errors), without placing it."""
    try:
        sym = normalize_symbol(req.symbol, req.exchange)
        return await asyncio.to_thread(_fg, trading.preview_order, sym, req.side, req.product, req.order_type, req.qty, req.price, req.trigger,
                                       _live_price(sym, req.live_price), req.interval)
    except DataError as exc:
        _err(exc)


@app.post("/api/orders")
async def place_order(req: OrderRequest):
    """Place a paper order like a broker panel: BUY/SELL, intraday/delivery, market/limit/SL, optional stop and target."""
    try:
        sym = normalize_symbol(req.symbol, req.exchange)
        return await asyncio.to_thread(_fg, trading.place_order, sym, req.interval, req.side, req.product, req.order_type, req.qty, req.price,
                                       req.trigger, req.stop, req.target, _live_price(sym, req.live_price))
    except DataError as exc:
        _err(exc)


@app.get("/api/quote")
async def quote(symbol: str, exchange: str = ""):
    try:
        sym = normalize_symbol(symbol, exchange)
        t = hub.last_tick(sym)
        if t and time.time() * 1000 - t["time"] < 120_000:
            return {"symbol": sym, "price": t["price"], "time": t["time"], "source": "tick", "change_percent": t.get("change_percent")}
        df = await asyncio.to_thread(_fg, fetch_ohlcv, sym, "15m")
        return {"symbol": sym, "price": float(df["close"].iloc[-1]), "time": int(df.index[-1].timestamp() * 1000), "source": "bar"}
    except DataError as exc:
        _err(exc)


@app.get("/api/universes")
def universes():
    return [{"key": k, "name": v["name"], "count": len(v["symbols"])} for k, v in UNIVERSES.items()]


@app.get("/api/screener")
async def screener_route(universe: str = "nifty100", symbols: Optional[str] = None):
    """Movement metrics for every symbol in a universe (+ comma-separated extra symbols)."""
    extra = [s for s in (symbols or "").split(",") if s.strip()]
    try:
        return await asyncio.to_thread(screener.scan, universe, extra)
    except DataError as exc:
        _err(exc)
    except Exception as exc:
        log.exception("screener failed")
        _err(exc, 500)


@app.get("/api/overextended")
async def overextended_route(universe: str = "nifty100", symbols: Optional[str] = None,
                             min_score: int = Query(overextended.MIN_SCORE, ge=0, le=100)):
    """Stocks that have run too far, too fast: the overextension score (0-100) built from published
    overbought / exhaustion rules, the rules that fired, and what happened after the stock's previous
    episodes.  Sorted by score; rows below `min_score` are dropped."""
    extra = [s for s in (symbols or "").split(",") if s.strip()]
    try:
        return await asyncio.to_thread(overextended.scan, universe, extra, min_score)
    except DataError as exc:
        _err(exc)
    except Exception as exc:
        log.exception("overextended scan failed")
        _err(exc, 500)


@app.get("/api/overextended/intraday")
async def overextended_intraday_route(universe: str = "nifty100", symbols: Optional[str] = None,
                                      min_score: int = Query(intraday_ext.MIN_SCORE, ge=0, le=100),
                                      side: str = Query("up", pattern="^(up|down)$")):
    """Stocks that ran too far from TODAY's open (5-minute bars): the intraday score, whether the push is still
    running or already fading, and what happened by the close after earlier such sessions.  side=down: the
    mirror image, stocks that fell too far below the open.  Rows whose peak score today is below `min_score`
    are dropped."""
    extra = [s for s in (symbols or "").split(",") if s.strip()]
    try:
        return await asyncio.to_thread(intraday_ext.scan, universe, extra, min_score, side)
    except DataError as exc:
        _err(exc)
    except Exception as exc:
        log.exception("intraday overextended scan failed")
        _err(exc, 500)


@app.get("/api/config")
def config():
    return {
        "intervals": list(INTERVALS),
        "exchanges": list(EXCHANGE_SUFFIX),
        "aliases": ALIASES,
        "default_horizon": DEFAULT_HORIZON,
        "base_weights": BASE_WEIGHT,
    }


@app.get("/api/catalog")
def catalog():
    """Reference list of every strategy and model with its origin and rules."""
    rows = []
    for key, fn in STRATEGIES.items():
        rows.append({"key": key, "kind": "strategy", "doc": inspect.getdoc(fn) or ""})
    for key, fn in MODELS.items():
        rows.append({"key": key, "kind": "model", "doc": inspect.getdoc(fn) or (inspect.getdoc(fn.__wrapped__) if hasattr(fn, "__wrapped__") else "")})
    rows.append({"key": "hurst", "kind": "regime", "doc": inspect.getdoc(hurst_regime) or ""})
    rows.extend(learner.catalog())
    return rows


@app.get("/api/search")
def search(q: str = Query(..., min_length=1)):
    return [h.__dict__ for h in search_symbols(q)]


def _chart(symbol: str, interval: str, exchange: str, period: Optional[str], since: Optional[int]) -> dict:
    if interval not in INTERVALS:
        raise DataError(f"Unsupported interval {interval}")
    df = fetch_ohlcv(symbol, interval, period, exchange)
    payload = chart_payload(df, since=since)
    payload["symbol"] = normalize_symbol(symbol, exchange)
    payload["data_symbol"] = df.attrs.get("data_symbol", payload["symbol"])
    payload["interval"] = interval
    payload["bar_seconds"] = interval_seconds(interval)
    payload["last_bar_forming"] = bool(bar_is_forming(payload["symbol"], interval, df.index[-1]))
    payload["server_time"] = int(time.time())
    return payload


@app.get("/api/chart")
async def chart(symbol: str, interval: str = "1d", exchange: str = "", period: Optional[str] = None):
    """Full candle history plus indicator series (up to 600 bars)."""
    try:
        return await asyncio.to_thread(_fg, _chart, symbol, interval, exchange, period, None)
    except DataError as exc:
        _err(exc)


@app.get("/api/chart/tail")
async def chart_tail(symbol: str, since: int, interval: str = "1d", exchange: str = ""):
    """Bars at or after `since` (unix seconds) - the forming bar and anything newer.  The
    front-end polls this every few seconds to reconcile the tick-built candle with Yahoo's
    official bar and to refresh the indicator lines; it is a few hundred bytes."""
    try:
        return await asyncio.to_thread(_fg, _chart, symbol, interval, exchange, None, since)
    except DataError as exc:
        _err(exc)


@app.get("/api/live/status")
def live_status():
    return {"connected": hub.connected, "ticks": hub.ticks, "symbols": list(hub._clients)}


@app.websocket("/ws/ticks")
async def ticks(ws: WebSocket, symbol: str, exchange: str = ""):
    """Stream real-time trades for one symbol as JSON: {symbol, price, time(ms), day_volume, ...}."""
    if not auth.valid(ws.cookies.get(auth.COOKIE)):
        await ws.close(code=4401)
        return
    await ws.accept()
    try:
        sym = normalize_symbol(symbol, exchange)
    except DataError as exc:
        await ws.send_json({"error": str(exc)}); await ws.close(); return
    q = await hub.subscribe(sym)
    await ws.send_json({"subscribed": sym})

    async def pump():
        while True:
            tick = await q.get()
            # coalesce a burst: only the newest tick matters for the chart
            while not q.empty():
                tick = q.get_nowait()
            await ws.send_json(tick)

    async def drain():
        while True:
            await ws.receive_text()      # raises WebSocketDisconnect when the browser leaves

    tasks = [asyncio.create_task(pump()), asyncio.create_task(drain())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except WebSocketDisconnect:
        pass
    finally:
        for t in tasks:
            t.cancel()
        await hub.unsubscribe(sym, q)


@app.post("/api/analyze")
async def analyze_route(req: AnalyzeRequest):
    if req.interval not in INTERVALS:
        _err(DataError(f"Unsupported interval {req.interval}"))
    try:
        live = req.live_price
        if live is not None and req.live_symbol and req.live_symbol.upper() != normalize_symbol(req.symbol, req.exchange):
            live = None                  # the browser's tick is from the chart the user just left
        if live is None and not req.as_of:
            t = hub.last_tick(normalize_symbol(req.symbol, req.exchange))
            if t and time.time() * 1000 - t["time"] < 120_000:
                live = t["price"]
        result = await asyncio.to_thread(_fg, analyze, req.symbol, req.interval, req.horizon, req.exchange, None, req.as_of, live)
    except DataError as exc:
        _err(exc)
    except Exception as exc:
        log.exception("analysis failed")
        _err(exc, 500)
    if req.as_of:
        result["source"] = "asof"
        result["created_at"] = result["bar_time"]
    else:
        result["trade_plan"] = await asyncio.to_thread(_fg, trading.build_plan, result)
    if req.save:
        result["id"] = db.insert_prediction(result)
        if req.as_of:
            # the future is already known: grade it right away
            try:
                res = await asyncio.to_thread(evaluator.resolve_one, result["id"])
                result["evaluation"] = res
            except DataError as exc:
                result["evaluation"] = {"error": str(exc)}
    return result


@app.post("/api/backtest")
async def backtest_route(req: BacktestRequest):
    if req.interval not in INTERVALS:
        _err(DataError(f"Unsupported interval {req.interval}"))
    try:
        return await asyncio.to_thread(evaluator.backtest, req.symbol, req.interval, req.horizon, req.exchange,
                                       req.steps, req.step_bars, req.save)
    except DataError as exc:
        _err(exc)
    except Exception as exc:
        log.exception("backtest failed")
        _err(exc, 500)


@app.get("/api/predictions")
def predictions(symbol: Optional[str] = None, status: Optional[str] = None, limit: int = 100, offset: int = 0,
                source: Optional[str] = None):
    rows = db.list_predictions(symbol, status, limit, offset, source)
    for r in rows:
        r["final_outcome"] = db.final_outcome(r)
        r.pop("signals", None)  # keep list light; fetch one for details
    return rows


@app.get("/api/predictions/{pid}")
def prediction(pid: int):
    p = db.get_prediction(pid)
    if not p:
        raise HTTPException(404, "Prediction not found")
    p["final_outcome"] = db.final_outcome(p)
    p["feedback"] = db.list_feedback(pid)
    return p


@app.post("/api/predictions/{pid}/feedback")
def feedback(pid: int, req: FeedbackRequest):
    if not db.get_prediction(pid):
        raise HTTPException(404, "Prediction not found")
    p = db.add_feedback(pid, req.verdict, req.rating, req.note)
    p["final_outcome"] = db.final_outcome(p)
    return p


@app.delete("/api/predictions/{pid}")
def delete_prediction(pid: int):
    if not db.delete_prediction(pid):
        raise HTTPException(404, "Prediction not found")
    db.rebuild_stats()
    return {"deleted": pid}


@app.post("/api/resolve")
async def resolve():
    return await asyncio.to_thread(evaluator.resolve_pending)


@app.get("/api/stats")
def stats():
    st = db.strategy_stats()
    per = []
    for key, s in st.items():
        n = s["correct"] + s["incorrect"]
        per.append({**s, "evaluated": n, "accuracy": (s["correct"] / n) if n else None,
                    "adaptive_mult": round(adaptive_multiplier(s), 3)})
    per.sort(key=lambda r: (-(r["accuracy"] or 0), -r["evaluated"]))
    return {"overall": db.overall_stats(), "strategies": per, "recent_feedback": db.list_feedback(limit=20)}


@app.get("/api/model-scores")
async def model_scores():
    """Top-bar model meter: every learner's walk-forward accuracy across the trained charts, and the live record."""
    board = await asyncio.to_thread(learner.scoreboard)
    o = db.overall_stats()
    live = {"accuracy": o["accuracy"], "calls": o["evaluated"], "no_call": o["no_call"], "pending": o["pending"],
            "by_direction": {d: b for d, b in o["by_direction"].items() if d in ("UP", "DOWN")}}
    return {**board, "live": live}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
