"""Start TradeBot on any computer (Windows, macOS, Linux):

    python run.py                    start it (first run installs the packages), open http://127.0.0.1:8003
    python run.py --share            also reachable from your phone / other devices (asks for a password once)
    python run.py --local            back to this computer only
    python run.py --password         change the saved password
    python run.py --dev              reload automatically when the code in app/ changes (for development)
    python run.py --port 8010        use another port (remembered)

It runs while this window is open and stops when you close it or press Ctrl+C.

Settings (share, password, port) are saved in .tradebot.json next to this file (not in git).
Only the standard library is used until the packages are known to be installed.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import shutil
import socket
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(ROOT, ".tradebot.json")
VENV = os.path.join(ROOT, ".venv")
NEEDED = ("fastapi", "uvicorn", "pandas", "numpy", "yfinance", "sklearn", "pydantic")


def say(msg: str) -> None:
    print(f"==> {msg}", flush=True)


# ---------------------------------------------------------------- settings file
def load_config() -> dict:
    try:
        with open(CONFIG, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    with open(CONFIG, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)
    if os.name != "nt":
        os.chmod(CONFIG, 0o600)                 # it holds the password: readable by you only


def ask_password() -> str:
    while True:
        p1 = getpass.getpass("Choose a login password (you type it on your phone): ")
        p2 = getpass.getpass("Type it again: ")
        if not p1:
            print("The password cannot be empty.")
        elif p1 != p2:
            print("They did not match, try again.")
        else:
            return p1


# ---------------------------------------------------------------- packages
def _venv_python() -> str:
    return os.path.join(VENV, "Scripts", "python.exe") if os.name == "nt" else os.path.join(VENV, "bin", "python")


def _missing() -> list[str]:
    import importlib.util
    return [m for m in NEEDED if importlib.util.find_spec(m) is None]


def ensure_packages() -> None:
    """Run inside a Python that has the packages: this one, the project's .venv, or a new .venv."""
    if sys.version_info < (3, 11):
        sys.exit(f"Python 3.11 or newer is needed (this is {sys.version.split()[0]}). Get it from https://www.python.org/downloads/")
    missing = _missing()
    if not missing:
        return
    in_venv = sys.prefix != sys.base_prefix
    vpy = _venv_python()
    if not in_venv and os.path.exists(vpy):
        say("Using the project's .venv")
        sys.exit(subprocess.call([vpy, *sys.argv]))
    if not in_venv:
        say(f"First run: creating {VENV} (missing: {', '.join(missing)})")
        subprocess.check_call([sys.executable, "-m", "venv", VENV])
        target = vpy
    else:
        target = sys.executable
    say("Installing packages (a few minutes the first time)")
    subprocess.check_call([target, "-m", "pip", "install", "--quiet", "--upgrade", "pip"])
    subprocess.check_call([target, "-m", "pip", "install", "--quiet", "-r", os.path.join(ROOT, "requirements.txt"), "certifi"])
    if target != sys.executable:
        sys.exit(subprocess.call([target, *sys.argv]))


def fix_certificates() -> None:
    """python.org builds on macOS ship without CA certificates: point SSL at certifi's bundle (Yahoo is HTTPS)."""
    if sys.platform == "darwin" and not os.environ.get("SSL_CERT_FILE"):
        try:
            import certifi
            os.environ["SSL_CERT_FILE"] = os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()
        except ImportError:
            pass


# ---------------------------------------------------------------- addresses
def lan_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))     # no packet is sent: this only picks the outgoing interface
            ip = s.getsockname()[0]
            return None if ip.startswith("127.") else ip
    except OSError:
        return None


def tailscale_ip() -> str | None:
    for exe in ("tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", r"C:\Program Files\Tailscale\tailscale.exe"):
        path = shutil.which(exe) or (exe if os.path.exists(exe) else None)
        if path:
            try:
                out = subprocess.run([path, "ip", "-4"], capture_output=True, text=True, timeout=5).stdout.strip()
                return out.splitlines()[0] if out else None
            except Exception:
                return None
    return None


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


def show_addresses(port: int, share: bool) -> None:
    print()
    print(f"  On this computer:      http://127.0.0.1:{port}")
    if share:
        ip, ts = lan_ip(), tailscale_ip()
        if ip:
            print(f"  On the same Wi-Fi:     http://{ip}:{port}")
        if ts:
            print(f"  Anywhere (Tailscale):  http://{ts}:{port}")
        else:
            print("  Anywhere: install Tailscale on this computer and your phone (same account), then restart.")
        print("  Log in with your password.")
    else:
        print("  Only this computer can open it. For your phone:  python run.py --share")
    print("  Stop with Ctrl+C.")
    print(flush=True)


# ---------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser(description="Start TradeBot", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("--share", action="store_true", help="reachable from other devices (password protected); remembered")
    ap.add_argument("--local", action="store_true", help="this computer only; remembered")
    ap.add_argument("--password", action="store_true", help="change the saved password")
    ap.add_argument("--dev", action="store_true", help="auto-reload when app/ changes")
    ap.add_argument("--port", type=int, help="port (remembered)")
    args = ap.parse_args()

    ensure_packages()
    cfg = load_config()
    interactive = sys.stdin is not None and sys.stdin.isatty()
    if args.port:
        cfg["port"] = args.port
    if args.local:
        cfg["share"] = False
    if args.share:
        cfg["share"] = True
    if args.password or (cfg.get("share") and not cfg.get("password") and interactive):
        cfg["password"] = ask_password()
    save_config(cfg)

    port = int(cfg.get("port") or 8003)
    share = bool(cfg.get("share"))
    if share and not cfg.get("password"):
        print("Sharing needs a password: run  python run.py --password  once. Starting for this computer only.")
        share = False
    if port_in_use(port):
        print(f"Something is already running on port {port} - TradeBot is probably open already: http://127.0.0.1:{port}")
        sys.exit(0)

    os.environ["TRADEBOT_PORT"] = str(port)                 # the profit-model worker calls back on this port
    if share:
        os.environ["TRADEBOT_PASSWORD"] = cfg["password"]   # every page and API call then needs the login
    fix_certificates()
    show_addresses(port, share)

    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0" if share else "127.0.0.1", port=port,
                reload=args.dev, reload_dirs=["app"] if args.dev else None)


if __name__ == "__main__":
    main()
