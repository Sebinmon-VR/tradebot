"""Password login for the hosted app.

Enabled only when the TRADEBOT_PASSWORD environment variable is set (an Azure App Setting), so the app
on your own PC keeps working without a login.  A successful login sets a signed, HttpOnly cookie valid
for 30 days; pages without it are redirected to /login and API calls get 401.  Repeated wrong passwords
from one address are locked out for 15 minutes.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time

COOKIE = "tb_auth"
MAX_AGE = 30 * 86400
OPEN_PATHS = {"/login", "/api/login", "/api/logout", "/healthz", "/static/style.css", "/static/login.js", "/static/theme.js", "/favicon.ico"}
MAX_FAILS, LOCKOUT = 8, 900

_FAILS: dict[str, list[float]] = {}


def password() -> str | None:
    return os.environ.get("TRADEBOT_PASSWORD") or None


def enabled() -> bool:
    return password() is not None


def _secret() -> bytes:
    s = os.environ.get("TRADEBOT_SECRET")
    if s:
        return s.encode()
    # derived from the password: changing the password signs everyone out
    return hashlib.sha256(("tradebot:" + (password() or "")).encode()).digest()


def make_token() -> str:
    exp = str(int(time.time()) + MAX_AGE)
    sig = hmac.new(_secret(), exp.encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def valid(token: str | None) -> bool:
    if not enabled():
        return True
    if not token or "." not in token:
        return False
    exp, sig = token.split(".", 1)
    good = hmac.new(_secret(), exp.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, good) and exp.isdigit() and int(exp) > time.time()


def locked(ip: str) -> bool:
    now = time.time()
    fails = [t for t in _FAILS.get(ip, []) if now - t < LOCKOUT]
    _FAILS[ip] = fails
    return len(fails) >= MAX_FAILS


def check(ip: str, given: str) -> bool:
    ok = enabled() and secrets.compare_digest(given.encode(), (password() or "").encode())
    if not ok:
        _FAILS.setdefault(ip, []).append(time.time())
    else:
        _FAILS.pop(ip, None)
    return ok


def is_open_path(path: str) -> bool:
    return path in OPEN_PATHS
