"""Market data access (yfinance) with a two-tier in-memory cache.

Exchanges: yfinance symbol conventions are used. Indian markets are supported
through the NSE (.NS) and BSE (.BO) suffixes.  Yahoo's NSE/BSE feed is current
(bars close on time; the forming bar is included in every download).

Caching: the full history for a (symbol, interval) is downloaded at most every
HISTORY_TTL seconds.  Between those, `fetch_ohlcv` only downloads the most
recent session (a few hundred milliseconds) and merges it over the cached
history, so a chart refresh every few seconds is cheap and always current.
"""
from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import pandas as pd
import yfinance as yf

# interval -> (default period label, seconds per bar)
INTERVALS = {
    "1m": ("7d", 60),
    "5m": ("59d", 300),
    "15m": ("59d", 900),
    "30m": ("59d", 1800),
    "1h": ("2y", 3600),
    "1d": ("5y", 86400),
    "1wk": ("10y", 604800),
}
# Maximum history Yahoo serves per intraday interval (requested via start date).
INTRADAY_LOOKBACK_DAYS = {"1m": 7, "5m": 59, "15m": 59, "30m": 59, "1h": 729}

EXCHANGE_SUFFIX = {
    "NSE": ".NS",    # National Stock Exchange of India
    "BSE": ".BO",    # Bombay Stock Exchange
    "": ".NS",       # default to NSE when no exchange is given
}
INDIAN_EXCHANGE_CODES = {"NSI", "BSE"}  # yfinance exchange codes for NSE / BSE

# Friendly aliases for Indian indices.
ALIASES = {
    "NIFTY": "^NSEI", "NIFTY50": "^NSEI", "NIFTY 50": "^NSEI",
    "BANKNIFTY": "^NSEBANK", "NIFTYBANK": "^NSEBANK", "BANK NIFTY": "^NSEBANK",
    "SENSEX": "^BSESN", "FINNIFTY": "NIFTY_FIN_SERVICE.NS",
    "NIFTYIT": "^CNXIT", "NIFTY IT": "^CNXIT",
    "INDIAVIX": "^INDIAVIX", "INDIA VIX": "^INDIAVIX", "VIX": "^INDIAVIX",
    "USDINR": "USDINR=X",
}

# (symbol, interval, period) -> (fetched_at, full history)
_HISTORY: dict[tuple, tuple[float, pd.DataFrame]] = {}
# (symbol, interval, period) -> (merged_at, history + fresh tail)
_MERGED: dict[tuple, tuple[float, pd.DataFrame]] = {}
_LOCKS: dict[tuple, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()
HISTORY_TTL = 1800  # seconds between full-history downloads (the tail download keeps today's bars current in between)
TAIL_TTL = 2        # seconds a merged frame is reused before the latest session is re-downloaded
TAIL_FAIL_TTL = 60  # after a failed tail download (Yahoo hiccup, exchange holiday) serve the last frame this long before retrying
_TAIL_FAILED: dict[tuple, float] = {}
# period passed to Yahoo for the cheap "latest bars" download
TAIL_PERIOD = {"1m": "1d", "5m": "1d", "15m": "1d", "30m": "1d", "1h": "5d", "1d": "5d", "1wk": "1mo"}

# NSE / BSE cash session in UTC (09:15-15:30 IST).
INDIA_SESSION_UTC = ((3, 45), (10, 0))

# Yahoo throttles bursts: when a threaded batch download (screener) overlaps a single-ticker
# download (chart poll, evaluator) one of them comes back empty or backs off for minutes.  Every
# yfinance network call in the process therefore goes through this lock.
YF_LOCK = threading.RLock()

# Interactive requests (a chart load, an analysis, a quote) must not queue behind background work (a
# screener batch, the market-cap fetch loop): background callers wait until no interactive caller is
# waiting for the lock, so a chart never sits blank behind a hundred market-cap requests.
_FOREGROUND_WAITING = 0
_GATE = threading.Condition()


@contextmanager
def yahoo(background: bool = False):
    """Serialise a yfinance call.  `background=True` yields to any interactive caller first."""
    global _FOREGROUND_WAITING
    if background:
        with _GATE:
            while _FOREGROUND_WAITING > 0:
                _GATE.wait(timeout=2)
    else:
        with _GATE:
            _FOREGROUND_WAITING += 1
    try:
        with YF_LOCK:
            yield
    finally:
        if not background:
            with _GATE:
                _FOREGROUND_WAITING -= 1
                _GATE.notify_all()


class DataError(Exception):
    pass


def interval_seconds(interval: str) -> int:
    if interval not in INTERVALS:
        raise DataError(f"Unsupported interval '{interval}'. Use one of {list(INTERVALS)}")
    return INTERVALS[interval][1]


def normalize_symbol(symbol: str, exchange: str = "") -> str:
    """Map user input to a yfinance ticker. 'RELIANCE' + NSE -> 'RELIANCE.NS'."""
    s = symbol.strip().upper()
    if not s:
        raise DataError("Symbol is required")
    if s in ALIASES:
        return ALIASES[s]
    exchange = (exchange or "").strip().upper()
    if exchange not in EXCHANGE_SUFFIX:
        raise DataError(f"Unknown exchange '{exchange}'. Use one of {list(EXCHANGE_SUFFIX)}")
    suffix = EXCHANGE_SUFFIX[exchange]
    already_qualified = "." in s or s.startswith("^") or "=" in s or "-" in s
    if suffix and not already_qualified:
        return s + suffix
    return s


def _flatten(df: pd.DataFrame) -> pd.DataFrame:
    if isinstance(df.columns, pd.MultiIndex):
        df = df.copy()
        df.columns = [c[0] for c in df.columns]
    df = df.rename(columns={c: str(c).lower() for c in df.columns})
    keep = [c for c in ["open", "high", "low", "close", "volume"] if c in df.columns]
    df = df[keep].dropna(subset=["close"]).copy()
    if "volume" not in df.columns:
        df["volume"] = 0.0
    df["volume"] = df["volume"].fillna(0).astype(float)
    df.index = pd.to_datetime(df.index)
    if df.index.tz is not None:
        df.index = df.index.tz_convert("UTC").tz_localize(None)
    df.index.name = "time"
    return df


def _download(symbol: str, interval: str, period: str | None = None, days: int | None = None) -> pd.DataFrame:
    from .priority import is_background
    with yahoo(background=is_background()):
        return _download_unlocked(symbol, interval, period, days)


def _download_unlocked(symbol: str, interval: str, period: str | None = None, days: int | None = None) -> pd.DataFrame:
    try:
        if days:
            # Yahoo caps intraday history (7 days for 1m, 60 days for 5m-30m, 730 days for 1h);
            # request by explicit start date so we always get the maximum allowed.
            start = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
            raw = yf.download(symbol, start=start, interval=interval, progress=False,
                              auto_adjust=True, threads=False)
        else:
            raw = yf.download(symbol, period=period, interval=interval, progress=False,
                              auto_adjust=True, threads=False)
    except Exception as exc:  # network or yfinance failure
        raise DataError(f"Failed to download {symbol}: {exc}") from exc
    if raw is None or raw.empty:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    return _flatten(raw)


def _lock(key: tuple) -> threading.Lock:
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.Lock())


def _merge(history: pd.DataFrame, tail: pd.DataFrame) -> pd.DataFrame:
    """Overlay the fresh tail on the history: rows present in both take the fresh values
    (the forming bar's high/low/close/volume keep changing until it closes)."""
    if tail.empty:
        return history
    attrs = dict(history.attrs)
    out = pd.concat([history[history.index < tail.index[0]], tail])
    out = out[~out.index.duplicated(keep="last")].sort_index()
    out.attrs.update(attrs)
    return out


def _indian_closed_since(ts: float, now: float) -> bool:
    """True when the NSE / BSE session has been closed for the whole time between `ts` and `now`
    (both epoch seconds), so a tail downloaded at `ts` cannot have missed a bar."""
    (oh, om), (ch, cm) = INDIA_SESSION_UTC
    a = datetime.fromtimestamp(ts, timezone.utc)
    b = datetime.fromtimestamp(now, timezone.utc)
    d = a.replace(hour=0, minute=0, second=0, microsecond=0)
    while d <= b:
        if d.weekday() < 5:
            o = d.replace(hour=oh, minute=om)
            c = d.replace(hour=ch, minute=cm) + timedelta(minutes=5)     # Yahoo finalises the last bar a little late
            if a < c and b > o:
                return False
        d += timedelta(days=1)
    return True


def fetch_ohlcv(symbol: str, interval: str = "1d", period: str | None = None,
                exchange: str = "", fresh: bool = True, max_age: float = TAIL_TTL) -> pd.DataFrame:
    """Return OHLCV DataFrame indexed by naive-UTC timestamps, including the forming bar.

    `fresh=True` (default) tops the cached history up with the latest session so the last
    bars are at most TAIL_TTL seconds old.  `fresh=False` returns the cached history as is
    (used where a few minutes of staleness is fine, e.g. the auto-evaluator)."""
    symbol = normalize_symbol(symbol, exchange)
    if interval not in INTERVALS:
        raise DataError(f"Unsupported interval '{interval}'")
    period = period or INTERVALS[interval][0]
    key = (symbol, interval, period)
    with _lock(key):
        now = time.time()
        merged = _MERGED.get(key)
        if merged and now - merged[0] < max_age:
            return merged[1].copy()
        if merged and is_indian(symbol) and now - merged[0] < HISTORY_TTL and _indian_closed_since(merged[0], now):
            return merged[1].copy()                 # market closed since the last download: nothing new to fetch
        if merged and now - _TAIL_FAILED.get(key, 0) < TAIL_FAIL_TTL:
            return merged[1].copy()
        hist = _HISTORY.get(key)
        if not hist or now - hist[0] >= HISTORY_TTL:
            df = _download(symbol, interval, period, INTRADAY_LOOKBACK_DAYS.get(interval))
            if len(df) < 60 and symbol.endswith(".BO"):
                # Yahoo's BSE history is sparse for most stocks; the NSE listing of the same company
                # trades at practically the same price, so use it and flag the substitution.
                ns = symbol[:-3] + ".NS"
                try:
                    alt = fetch_ohlcv(ns, interval, period, fresh=fresh)
                except DataError:
                    alt = None
                if alt is not None and len(alt) >= 60:
                    alt.attrs["requested_symbol"] = symbol
                    alt.attrs["data_symbol"] = ns
                    alt.attrs["note"] = f"Yahoo has no usable BSE history for {symbol}; showing NSE data ({ns}), which tracks the BSE price closely."
                    _HISTORY[key] = (now, alt)
                    _MERGED[key] = (now, alt)
                    return alt.copy()
            if len(df) == 0:
                raise DataError(f"No data returned for '{symbol}' ({interval}, {period}). Check the symbol / exchange.")
            if len(df) < 60:
                raise DataError(f"Only {len(df)} bars available for {symbol}; need at least 60. Try a longer period or larger interval.")
            _HISTORY[key] = (now, df)
            _MERGED[key] = (now, df)
            return df.copy()
        df = hist[1]
        if not fresh or df.attrs.get("data_symbol"):
            return (merged[1] if merged else df).copy()
        try:
            tail = _download(symbol, interval, TAIL_PERIOD.get(interval, "5d"))
        except DataError as exc:
            # keep serving the last good frame rather than failing a live refresh
            _TAIL_FAILED[key] = now
            if merged:
                return merged[1].copy()
            raise exc
        df = _merge(df, tail)
        _MERGED[key] = (now, df)
        return df.copy()


def peek_ohlcv(symbol: str, interval: str) -> pd.DataFrame | None:
    """The bars of this chart that are already in memory, or None.  Never downloads, never waits on a
    lock: used by the independent profit-model worker so it adds no Yahoo traffic."""
    try:
        key = (normalize_symbol(symbol), interval, INTERVALS[interval][0])
    except (DataError, KeyError):
        return None
    hit = _MERGED.get(key) or _HISTORY.get(key)
    return hit[1].copy() if hit else None


def is_indian(symbol: str) -> bool:
    s = symbol.upper()
    return s.endswith(".NS") or s.endswith(".BO") or s in ("^NSEI", "^NSEBANK", "^BSESN", "^CNXIT", "^INDIAVIX")


def bar_is_forming(symbol: str, interval: str, last_bar: pd.Timestamp, now: datetime | None = None) -> bool:
    """True when the last bar in the frame has not closed yet.

    Intraday: the bar is open until `last_bar + interval`.  Daily / weekly: the bar is open
    until the session close of its last day (15:30 IST for NSE/BSE) - after the close the
    day's candle is final even though the calendar day is not over."""
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    sec = interval_seconds(interval)
    start = pd.Timestamp(last_bar).to_pydatetime()
    if sec < 86400:
        return now < start + timedelta(seconds=sec)
    weekly = sec >= 604800
    # Yahoo stamps weekly bars with their Monday; the bar's last session is Friday.
    last_day = start + timedelta(days=4 if weekly else 0)
    if is_indian(symbol):
        h, m = INDIA_SESSION_UTC[1]
        return now < last_day.replace(hour=h, minute=m, second=0, microsecond=0)
    return now < last_day + timedelta(days=1)


def latest_price(symbol: str) -> float:
    """Most recent traded price (uses 1-minute bars when available, else daily close)."""
    try:
        with yahoo():
            p = yf.Ticker(symbol).fast_info.last_price
        if p and p > 0:
            return float(p)
    except Exception:
        pass
    df = fetch_ohlcv(symbol, "1d")
    return float(df["close"].iloc[-1])


@dataclass
class SearchHit:
    symbol: str
    name: str
    exchange: str
    type: str


def search_symbols(query: str, limit: int = 10) -> list[SearchHit]:
    """Symbol lookup via yfinance search. Best effort; returns [] on failure."""
    q = query.strip()
    if not q:
        return []
    hits: list[SearchHit] = []
    if q.upper() in ALIASES:
        hits.append(SearchHit(ALIASES[q.upper()], q.upper(), "INDEX/ALIAS", "alias"))
    try:
        with yahoo():
            res = yf.Search(q, max_results=limit * 3).quotes
        for r in res:
            ex = str(r.get("exchange", ""))
            if ex not in INDIAN_EXCHANGE_CODES:
                continue
            hits.append(SearchHit(str(r.get("symbol", "")), str(r.get("shortname") or r.get("longname") or ""),
                                  "NSE" if ex == "NSI" else "BSE", str(r.get("quoteType", ""))))
    except Exception:
        pass
    return hits[:limit]
