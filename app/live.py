"""Real-time tick hub.

Keeps ONE connection to Yahoo Finance's streaming endpoint (the same feed the Yahoo Finance
web page uses; NSE / BSE trades arrive within a second or two) and fans every tick out to
the browsers that are watching that symbol.  The browser builds the forming candle from the
ticks, so the chart moves trade by trade instead of waiting for the next bar download.

Protocol: Yahoo sends base64-encoded protobuf `PricingData` messages; yfinance ships the
generated protobuf class, which we reuse for decoding.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time

from google.protobuf.json_format import MessageToDict
from websockets.asyncio.client import connect
from yfinance.pricing_pb2 import PricingData

log = logging.getLogger("tradebot.live")

STREAM_URL = "wss://streamer.finance.yahoo.com/?version=2"
HEARTBEAT_SECONDS = 15          # Yahoo drops silent subscriptions; re-send the list periodically
QUEUE_SIZE = 500                # per-client backlog before old ticks are dropped


def _decode(raw: str) -> dict | None:
    try:
        msg = json.loads(raw)
        pb = PricingData()
        pb.ParseFromString(base64.b64decode(msg.get("message", "")))
        d = MessageToDict(pb, preserving_proto_field_name=True)
    except Exception:
        return None
    if "id" not in d or "price" not in d:
        return None
    return {
        "symbol": d["id"], "price": float(d["price"]),
        "time": int(d.get("time", 0)) or int(time.time() * 1000),     # ms since epoch
        "day_volume": int(d["day_volume"]) if d.get("day_volume") else None,
        "last_size": int(d["last_size"]) if d.get("last_size") else None,
        "change": d.get("change"), "change_percent": d.get("change_percent"),
        "day_high": d.get("day_high"), "day_low": d.get("day_low"), "open": d.get("open_price"),
        "prev_close": d.get("previous_close"),
        "market_hours": d.get("market_hours", 1),
    }


class TickHub:
    def __init__(self) -> None:
        self._clients: dict[str, set[asyncio.Queue]] = {}
        self._watch: set[str] = set()          # symbols the server itself follows (the ready scanner's live prices)
        self._last: dict[str, dict] = {}
        self._ws = None
        self._task: asyncio.Task | None = None
        self._dirty = asyncio.Event()          # subscription list changed -> resend
        self.connected = False
        self.ticks = 0

    # ---------------------------------------------------------------- clients
    async def subscribe(self, symbol: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_SIZE)
        new = symbol not in self._clients
        self._clients.setdefault(symbol, set()).add(q)
        if symbol in self._last:
            q.put_nowait(self._last[symbol])
        if new:
            self._dirty.set()
        self._ensure_running()
        return q

    async def unsubscribe(self, symbol: str, q: asyncio.Queue) -> None:
        subs = self._clients.get(symbol)
        if not subs:
            return
        subs.discard(q)
        if not subs:
            del self._clients[symbol]
            self._dirty.set()

    def last_tick(self, symbol: str) -> dict | None:
        return self._last.get(symbol)

    def watch(self, symbols) -> None:
        """Follow these symbols with no browser attached; their ticks land in last_tick().  Replaces the set."""
        new = set(symbols)
        if new == self._watch:
            return
        self._watch = new
        self._dirty.set()
        if new:
            self._ensure_running()

    def _wanted(self) -> list[str]:
        return sorted(set(self._clients) | self._watch)

    # ---------------------------------------------------------------- upstream
    def _ensure_running(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="tick-hub")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    async def _run(self) -> None:
        backoff = 1.0
        while True:
            try:
                async with connect(STREAM_URL, ping_interval=20, ping_timeout=20, max_queue=1024) as ws:
                    self._ws = ws
                    self.connected = True
                    backoff = 1.0
                    log.info("tick stream connected")
                    await self._send_subscriptions(ws)
                    hb = asyncio.create_task(self._heartbeat(ws))
                    try:
                        async for raw in ws:
                            tick = _decode(raw)
                            if tick:
                                self._fanout(tick)
                    finally:
                        hb.cancel()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("tick stream dropped: %s (reconnecting in %.0fs)", exc, backoff)
            finally:
                self.connected = False
                self._ws = None
            if not self._wanted():
                log.info("tick stream idle; no watchers")
                return
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def _send_subscriptions(self, ws) -> None:
        self._dirty.clear()
        syms = self._wanted()
        if syms:
            await ws.send(json.dumps({"subscribe": syms}))

    async def _heartbeat(self, ws) -> None:
        while True:
            try:
                await asyncio.wait_for(self._dirty.wait(), timeout=HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                pass
            if not self._wanted():
                await ws.close()
                return
            await self._send_subscriptions(ws)

    def _fanout(self, tick: dict) -> None:
        self.ticks += 1
        self._last[tick["symbol"]] = tick
        for q in list(self._clients.get(tick["symbol"], ())):
            if q.full():
                try:
                    q.get_nowait()          # drop the oldest tick rather than block the feed
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(tick)


hub = TickHub()
