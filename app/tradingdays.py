"""NSE trading calendar: which days the exchange is open, and whether it is open right now.

Everything that runs in the background (the ready scanner, the prediction resolver, the movers
statistics) asks this module first, so nothing downloads data on a weekend or an exchange holiday.

Holidays: NSE equity-segment trading holidays for 2026 (NSE circular, as listed by Zerodha / Upstox
holiday calendars).  Add next year's list when NSE publishes it; until then only weekends are skipped
for an unknown year (and the scanner's own "no bars today" check still catches a missed holiday).
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
OPEN, CLOSE = time(9, 15), time(15, 30)

NSE_HOLIDAYS = {
    2026: {
        date(2026, 1, 26): "Republic Day",
        date(2026, 3, 3): "Holi",
        date(2026, 3, 26): "Shri Ram Navami",
        date(2026, 3, 31): "Shri Mahavir Jayanti",
        date(2026, 4, 3): "Good Friday",
        date(2026, 4, 14): "Dr. Baba Saheb Ambedkar Jayanti",
        date(2026, 5, 1): "Maharashtra Day",
        date(2026, 5, 28): "Bakri Eid",
        date(2026, 6, 26): "Muharram",
        date(2026, 9, 14): "Ganesh Chaturthi",
        date(2026, 10, 2): "Mahatma Gandhi Jayanti",
        date(2026, 10, 20): "Dussehra",
        date(2026, 11, 10): "Diwali-Balipratipada",
        date(2026, 11, 24): "Guru Nanak Jayanti",
        date(2026, 12, 25): "Christmas",
    },
}


def ist_now() -> datetime:
    return datetime.now(IST)


def holiday_name(d: date) -> str | None:
    return NSE_HOLIDAYS.get(d.year, {}).get(d)


def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and holiday_name(d) is None


def is_open(now: datetime | None = None) -> bool:
    now = (now or ist_now()).astimezone(IST)
    return is_trading_day(now.date()) and OPEN <= now.time() < CLOSE


def next_open(now: datetime | None = None) -> datetime:
    """The next session open (aware IST) at or after `now`."""
    now = (now or ist_now()).astimezone(IST)
    d = now.date()
    if not (is_trading_day(d) and now.time() < OPEN):
        d += timedelta(days=1)
        while not is_trading_day(d):
            d += timedelta(days=1)
    return datetime.combine(d, OPEN, IST)


def previous_trading_day(d: date) -> date:
    d -= timedelta(days=1)
    while not is_trading_day(d):
        d -= timedelta(days=1)
    return d


def status(now: datetime | None = None) -> dict:
    """What the header shows: open / closed and why, and when the next session starts."""
    now = (now or ist_now()).astimezone(IST)
    d = now.date()
    if is_open(now):
        state, label = "open", "Market open"
    elif holiday_name(d):
        state, label = "holiday", f"Holiday · {holiday_name(d)}"
    elif d.weekday() >= 5:
        state, label = "weekend", "Weekend"
    elif now.time() < OPEN:
        state, label = "pre", "Opens 09:15"
    else:
        state, label = "closed", "Market closed"
    nxt = next_open(now)
    return {"state": state, "label": label, "next_open": nxt.isoformat(),
            "next_open_label": nxt.strftime("%a %d %b, %H:%M") + " IST"}
