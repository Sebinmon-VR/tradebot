"""Foreground / background priority inside the server process.

The ready-to-trade scanner analyses stocks continuously in a background thread.  An interactive
request (a chart load, an analysis you asked for, a quote) must never wait behind it, so:

* interactive routes wrap their work in `interactive()`, which counts them while they run;
* the scanner thread marks itself with `background()`; its Yahoo downloads then yield to any
  interactive download (data.yahoo), and its long loops call `yield_if_busy()`, which pauses the
  thread while an interactive request is in flight (Python threads share one core under the GIL,
  so a busy scanner would otherwise roughly halve the speed of whatever you clicked).
"""
from __future__ import annotations

import threading
import time
from contextlib import contextmanager

_TL = threading.local()
_ACTIVE = 0
_COND = threading.Condition()
MAX_PAUSE = 90          # seconds a background thread waits for interactive work before carrying on anyway


def is_background() -> bool:
    return bool(getattr(_TL, "background", False))


@contextmanager
def background():
    prev = is_background()
    _TL.background = True
    try:
        yield
    finally:
        _TL.background = prev


@contextmanager
def interactive():
    global _ACTIVE
    with _COND:
        _ACTIVE += 1
    try:
        yield
    finally:
        with _COND:
            _ACTIVE -= 1
            _COND.notify_all()


def busy() -> bool:
    return _ACTIVE > 0


def yield_if_busy() -> None:
    """Called from background loops: block while an interactive request is running."""
    if not is_background() or _ACTIVE == 0:
        return
    end = time.time() + MAX_PAUSE
    with _COND:
        while _ACTIVE > 0 and time.time() < end:
            _COND.wait(timeout=1)
