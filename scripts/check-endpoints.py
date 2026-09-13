#!/usr/bin/env python3
"""
Contract check: does the running daemon serve everything the UI calls?

    ./scripts/check-endpoints.py [base-url]        # default http://127.0.0.1:8080

Extracts every "/api/..." literal from web/js/ and probes each against a live
box. 404 and 405 are failures; 400/409/428/500 all prove the route exists and
is validating its input. Also verifies /api/events really streams, and reports
routes the server advertises that the UI never calls.

This is the one command that catches drift between the backend and the UI while
they are being changed in parallel. Standard library only — it runs anywhere the
daemon does.
"""

import json
import os
import re
import socket
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_JS = os.path.join(HERE, "web", "js")

# Paths the UI fetches with something other than GET. Anything not listed here
# and not obviously a read is probed with POST.
POST_PATHS = {
    "/api/connect", "/api/disconnect", "/api/modem/check",
    "/api/transport/start", "/api/transport/stop",
    "/api/gptp/start", "/api/gptp/stop",
    "/api/tas/apply", "/api/tas/clear",
    "/api/speedtest/run",
    "/api/interfaces/config", "/api/wifi/connect",
    "/api/switch/apply", "/api/switch/disable",
}
GET_PATHS = {
    "/api/status", "/api/health", "/api/stats", "/api/discovery", "/api/config",
    "/api/version", "/api/spec", "/api/setup/state", "/api/interfaces",
    "/api/wifi/scan", "/api/switch/profiles", "/api/switch/status",
    "/api/tas/profiles", "/api/speedtest/result", "/api/logs", "/api/jobs",
    "/api/debug/commands", "/api/events",
}


def ui_paths():
    found = set()
    rx = re.compile(r'"(/api/[A-Za-z0-9/_.-]+)')
    for root, _dirs, files in os.walk(WEB_JS):
        for f in files:
            if not f.endswith(".js"):
                continue
            with open(os.path.join(root, f), encoding="utf-8", errors="replace") as fh:
                found.update(rx.findall(fh.read()))
    return sorted(found)


def verb(path):
    if path in POST_PATHS:
        return "POST"
    if path in GET_PATHS:
        return "GET"
    return "GET" if path.rstrip("/").split("/")[-1] in (
        "status", "health", "stats", "discovery", "profiles", "scan",
        "result", "state", "interfaces", "spec", "version") else "POST"


def probe(base, method, path, timeout=20):
    url = base.rstrip("/") + path
    data = b"{}" if method != "GET" else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, None
    except urllib.error.HTTPError as e:
        body = e.read(300).decode("utf-8", "replace")
        try:
            msg = json.loads(body).get("error")
        except ValueError:
            msg = body.strip()[:60]
        return e.code, msg
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        return 0, str(e)


def sse_ok(base, timeout=4.0):
    """A frame (or the opening comment) must arrive promptly."""
    url = base.rstrip("/") + "/api/events?topics=stats"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            if r.headers.get("Content-Type", "").split(";")[0] != "text/event-stream":
                return False, f"wrong content-type: {r.headers.get('Content-Type')}"
            if r.headers.get("Content-Length"):
                return False, "Content-Length present on a stream"
            chunk = r.read(64)
            return (bool(chunk), chunk.decode("utf-8", "replace").strip() or "no data")
    except Exception as exc:       # noqa: BLE001
        return False, str(exc)


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"

    status, _ = probe(base, "GET", "/api/status", timeout=5)
    if status != 200:
        print(f"ERROR: no daemon answering at {base}", file=sys.stderr)
        return 2

    paths = ui_paths()
    if not paths:
        print("WARNING: no /api/ literals found under web/js — has the UI moved?",
              file=sys.stderr)

    print(f"{'endpoint':<32} {'verb':<5} result")
    print("-" * 72)
    failures = []
    for p in paths:
        v = verb(p)
        code, msg = probe(base, v, p)
        if code in (404, 405) or code == 0:
            failures.append((v, p, code))
            note = f"MISSING ({code})"
        else:
            note = f"ok ({code})"
            if msg:
                note += f"  {msg[:32]}"
        print(f"{p:<32} {v:<5} {note}")

    print("-" * 72)
    ok, detail = sse_ok(base)
    print(f"{'/api/events':<32} {'SSE':<5} "
          f"{'ok  ' + detail[:40] if ok else 'FAILED  ' + detail[:50]}")
    if not ok:
        failures.append(("GET", "/api/events", "no stream"))

    # What the server offers that the UI has not adopted yet — not a failure,
    # but it is the Phase-by-Phase to-do list made visible.
    try:
        with urllib.request.urlopen(base.rstrip("/") + "/api/spec", timeout=5) as r:
            spec = json.load(r)
        served = {x["path"] for x in spec["routes"]}
        unused = sorted(served - set(paths))
        print(f"\n{len(spec['routes'])} routes served; "
              f"{len(paths)} called by the UI; {len(unused)} not yet used:")
        for u in unused:
            print(f"    {u}")
    except Exception:              # noqa: BLE001
        pass

    if failures:
        print(f"\nFAILED: {len(failures)} endpoint(s) the UI calls are not served",
              file=sys.stderr)
        for v, p, c in failures:
            print(f"   {v} {p} -> {c}", file=sys.stderr)
        return 1
    print("\nOK: every endpoint the UI calls is served")
    return 0


if __name__ == "__main__":
    sys.exit(main())
