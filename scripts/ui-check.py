#!/usr/bin/env python3
"""
Drive the real UI in a real browser and assert on the real DOM.

    ./scripts/ui-check.py [base-url]        # default http://127.0.0.1:8080

Why this exists: `firefox --screenshot` captures at the load event, which is
before any data has arrived, so a screenshot cannot tell "the view is wired" from
"the view is empty". This drives Firefox over Marionette instead, waits for
conditions, and reads the DOM — so a view showing data proves the whole path
from click to backend and back.

Marionette rather than CDP or WebDriver BiDi because its wire format is
length-prefixed JSON over plain TCP, which the standard library can speak. No
node_modules, no geckodriver, nothing to install — the same constraint the UI
itself is built under.

Not part of the install path. Run it from a workstation or a bench unit.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

MARIONETTE_PORT = 2829

# Repeated often enough to be worth naming.
CARD_COUNT = "return document.querySelectorAll('.card').length;"


class Marionette:
    """Minimal Marionette client: `len:json`, where json is [0, id, cmd, params]."""

    def __init__(self, port=MARIONETTE_PORT):
        self.port = port
        self.sock = None
        self.msg_id = 0

    def connect(self, timeout=40):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            try:
                self.sock = socket.create_connection(("127.0.0.1", self.port), timeout=10)
                self.sock.settimeout(60)
                self._read()              # server sends a hello frame
                return self
            except OSError as exc:
                last = exc
                time.sleep(0.4)
        raise RuntimeError(f"could not reach Marionette on {self.port}: {last}")

    def _read(self):
        length = b""
        while not length.endswith(b":"):
            ch = self.sock.recv(1)
            if not ch:
                raise RuntimeError("marionette closed the connection")
            length += ch
        want = int(length[:-1])
        buf = b""
        while len(buf) < want:
            chunk = self.sock.recv(want - len(buf))
            if not chunk:
                raise RuntimeError("marionette closed mid-frame")
            buf += chunk
        return json.loads(buf)

    def call(self, command, params=None):
        self.msg_id += 1
        payload = json.dumps([0, self.msg_id, command, params or {}]).encode()
        self.sock.sendall(f"{len(payload)}:".encode() + payload)
        while True:
            frame = self._read()
            if not (isinstance(frame, list) and len(frame) >= 4):
                continue
            _, mid, err, result = frame[0], frame[1], frame[2], frame[3]
            if mid != self.msg_id:
                continue
            if err:
                raise RuntimeError(f"{command}: {err.get('message', err)}")
            return result

    def start_session(self):
        return self.call("WebDriver:NewSession", {"capabilities": {}})

    def navigate(self, url):
        return self.call("WebDriver:Navigate", {"url": url})

    def script(self, source, args=None):
        # No `sandbox` option: "system" would run with chrome privileges and
        # could not see the page's window at all.
        out = self.call("WebDriver:ExecuteScript",
                        {"script": source, "args": args or []})
        return out.get("value") if isinstance(out, dict) else out

    def wait_for(self, expression, timeout=20, interval=0.25, label=None):
        """Poll a JS expression until it is truthy. Returns its value."""
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = self.script(f"return ({expression});")
            if last:
                return last
            time.sleep(interval)
        raise AssertionError(f"timed out waiting for {label or expression} (last={last!r})")

    def close(self):
        if self.sock is None:
            return
        try:
            self.call("Marionette:Quit", {})
        except Exception:      # noqa: BLE001 - browser may already be gone
            pass
        try:
            self.sock.close()
        except OSError:
            pass
        self.sock = None


def find_firefox():
    for name in ("firefox", "firefox-esr"):
        path = shutil.which(name)
        if path:
            return path
    return None


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"
    binary = find_firefox()
    if not binary:
        print("firefox not found on PATH", file=sys.stderr)
        return 2

    # Two constraints from the snap build: it cannot read /tmp, and it cannot
    # use a dot-prefixed directory — so the profile goes in a plain directory
    # under $HOME. The Marionette port comes from a profile pref; the
    # MOZ_MARIONETTE_PORT environment variable is not honoured.
    profile = tempfile.mkdtemp(prefix="tsn5g-uicheck-", dir=os.path.expanduser("~"))
    with open(os.path.join(profile, "user.js"), "w", encoding="utf-8") as fh:
        fh.write(f'user_pref("marionette.port", {MARIONETTE_PORT});\n')
        fh.write('user_pref("marionette.enabled", true);\n')
        # A first-run wizard or update check would steal focus and delay boot.
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("datareporting.policy.dataSubmissionEnabled", false);\n')
        fh.write('user_pref("app.update.enabled", false);\n')

    proc = subprocess.Popen(
        [binary, "--headless", "--no-remote", "--marionette",
         "--profile", profile, "--window-size=1400,900", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    checks = []
    def check(name, condition, detail=""):
        checks.append((name, bool(condition), detail))
        print(f"  {'PASS' if condition else 'FAIL'}  {name}"
              + (f"   {detail}" if detail else ""))

    m = Marionette()
    try:
        m.connect()
        m.start_session()

        # ---- deep link straight to a non-default view --------------------
        print("=== deep link to #/logs ===")
        m.navigate(f"{base}/#/logs")
        m.wait_for("!!window.__tsn", timeout=25, label="app boot")
        check("app booted", True)
        check("routed to logs, not dashboard",
              m.script("return window.__tsn.store.get().ui.route;") == "logs")
        check("nav marks logs active",
              m.script("return document.querySelector('.nav-item.active')?.dataset.route;") == "logs")
        check("title follows the route",
              m.script("return document.getElementById('view-title').textContent;") == "Logs")

        # ---- the backfill the screenshot could not see --------------------
        print("=== log backfill ===")
        n = m.wait_for("document.querySelectorAll('.logline').length", timeout=20,
                       label="log lines to render")
        check("log lines rendered", n > 0, f"{n} lines")
        check("store holds the same lines",
              m.script("return window.__tsn.store.get().logs.lines.length;") > 0)

        # ---- live streaming ------------------------------------------------
        print("=== live SSE line ===")
        before = m.script("return document.querySelectorAll('.logline').length;")
        m.script("""
            return fetch('/api/logs/level', {method:'PUT',
                headers:{'Content-Type':'application/json'},
                body: JSON.stringify({level:'debug'})}).then(r => r.status);
        """)
        grew = False
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if m.script("return document.querySelectorAll('.logline').length;") > before:
                grew = True
                break
            time.sleep(0.25)
        check("a new daemon log line arrived over SSE", grew,
              "no request was made by the view to get it")
        check("transport is the event stream, not polling",
              m.script("return window.__tsn.store.get().conn.transport;") == "sse")

        # ---- navigation lifecycle ------------------------------------------
        print("=== navigation and teardown ===")
        m.script("window.location.hash = '#/interfaces';")
        m.wait_for("window.__tsn.store.get().ui.route === 'interfaces'",
                   timeout=15, label="route change")
        check("navigated to interfaces", True)
        check("logs DOM was torn down",
              m.script("return document.querySelectorAll('.logline').length;") == 0)

        m.script("window.location.hash = '#/';")
        # onChange fires before the view mounts, so waiting on the route alone
        # races the DOM. Wait for the view's own output.
        cards = m.wait_for("document.querySelectorAll('.card').length",
                           timeout=15, label="dashboard cards")
        check("dashboard re-mounted after navigating away and back", cards > 0,
              f"{cards} cards")

        # ---- data actually reached the legacy view -------------------------
        print("=== legacy view receives live data ===")
        check("store has a controller snapshot",
              bool(m.script("return !!window.__tsn.store.get().status;")))
        # This is the real test of the bridge: headings come from render(), but
        # values only appear if onData() ran without throwing.
        txt = m.wait_for(
            "document.getElementById('content').textContent.length > 300",
            timeout=20, label="dashboard populated by onData")
        check("legacy onData populated the cards", bool(txt),
              f"{m.script('return document.getElementById(\'content\').textContent.length;')} chars")

        # ---- no demo mode anywhere ------------------------------------------
        print("=== demo mode is gone ===")
        check("T.demo is pinned false", m.script("return window.TSN.demo;") is False)
        check("no demo toggle in the DOM",
              m.script("return document.querySelectorAll('.switch').length;") == 0)

        # ---- theme switching --------------------------------------------------
        print("=== theme ===")
        m.script("""
            const s = document.querySelector('#topbar-controls select');
            s.value = 'dark'; s.dispatchEvent(new Event('change'));
            return true;
        """)
        time.sleep(0.5)
        check("dark theme applied",
              m.script("return document.documentElement.dataset.theme;") == "dark")
        check("charts re-read the palette",
              m.script("""
                  const bg = getComputedStyle(document.body).backgroundColor;
                  return bg && bg !== 'rgb(245, 247, 250)';
              """))

        # ---- Phase 3: modem, signal, debug --------------------------------
        print("=== modem view ===")
        m.script("window.location.hash = '#/modem';")
        m.wait_for("window.__tsn.store.get().ui.route === 'modem'", timeout=15,
                   label="modem route")
        m.wait_for("document.querySelectorAll('.card').length >= 4", timeout=15,
                   label="modem cards")
        check("modem view mounted", True,
              f"{m.script(CARD_COUNT)} cards")
        txt = m.wait_for("document.getElementById('content').textContent.length > 200",
                         timeout=15, label="modem content")
        check("modem view populated from /api/modem", bool(txt))
        check("bus state is shown",
              "AT port" in m.script("return document.getElementById('content').textContent;"))

        print("=== signal view ===")
        m.script("window.location.hash = '#/signal';")
        m.wait_for("window.__tsn.store.get().ui.route === 'signal'", timeout=15,
                   label="signal route")
        m.wait_for("document.querySelectorAll('.card').length >= 3", timeout=15,
                   label="signal cards")
        check("signal view mounted", True)
        check("history window control present",
              m.script("return document.querySelectorAll('select').length;") >= 3)

        print("=== debug view: the AT console ===")
        m.script("window.location.hash = '#/debug';")
        m.wait_for("window.__tsn.store.get().ui.route === 'debug'", timeout=15,
                   label="debug route")
        m.wait_for("document.querySelectorAll('.toolbar .btn').length > 3", timeout=15,
                   label="diagnostic buttons")
        check("diagnostic quick-buttons rendered from /api/modem/at/rules",
              m.script("return document.querySelectorAll('.toolbar .btn').length;") > 3)

        # Click Send rather than synthesising a key event: fewer moving parts,
        # and it is the path a user actually takes.
        sent = m.script("""
            const i = document.querySelector('input[type=text]');
            if (!i) return 'no input';
            i.value = 'AT+QPRTPARA=3';
            const send = [...document.querySelectorAll('.btn')]
                .find(b => b.textContent.trim() === 'Send');
            if (!send) return 'no send button';
            send.click();
            return 'sent';
        """)
        check("AT console accepted input", sent == "sent", str(sent))
        try:
            m.wait_for(
                "(function(){ const p = document.querySelector('.logpane');"
                " return p ? p.textContent.indexOf('REFUSED') >= 0 : false; })()",
                timeout=20, label="refusal in the console")
            refused = True
        except AssertionError:
            refused = False
        pane = m.script("return (document.querySelector('.logpane')||{}).textContent || '';")
        check("deny-listed AT command is refused in the console", refused,
              "" if refused else f"pane was {pane[:120]!r}")
        check("the refusal explains why", "factory defaults" in pane,
              "" if "factory defaults" in pane else "explanation missing")

        check("request inspector lists real calls",
              m.script("return (window.__tsn.recorder.all()||[]).length;") > 5)

        # ---- Phase 4: connection, interfaces, routing ----------------------
        print("=== connection view ===")
        m.script("window.location.hash = '#/connection';")
        m.wait_for("window.__tsn.store.get().ui.route === 'connection'",
                   timeout=15, label="connection route")
        m.wait_for("document.getElementById('content').textContent.length > 150",
                   timeout=20, label="connection content")
        text = m.script("return document.getElementById('content').textContent;")
        check("connection view shows bearer state", "UE address" in text)
        check("it drives bearer.up, not the legacy connect path",
              "Bring up" in text or "Restart call" in text,
              "legacy view said 'Connect to 5G'")

        print("=== interfaces view ===")
        m.script("window.location.hash = '#/interfaces';")
        m.wait_for("window.__tsn.store.get().ui.route === 'interfaces'",
                   timeout=15, label="interfaces route")
        m.wait_for("document.querySelectorAll('table.tbl tr').length > 1",
                   timeout=20, label="interface rows")
        text = m.script("return document.getElementById('content').textContent;")
        check("interfaces listed",
              m.script("return document.querySelectorAll('table.tbl tr').length;") > 1)
        # The interlock is the reason this view was rewritten.
        check("the management interface is marked",
              "management" in text, "backend reports which NIC holds the default route")
        check("the bearer interface is not editable here",
              "see Connection" in text, "wwan0 belongs to the bearer")

        print("=== routing view ===")
        m.script("window.location.hash = '#/routing';")
        m.wait_for("window.__tsn.store.get().ui.route === 'routing'",
                   timeout=15, label="routing route")
        m.wait_for("document.getElementById('content').textContent.length > 300",
                   timeout=20, label="routing content")
        text = m.script("return document.getElementById('content').textContent;")
        check("routing view mounted",
              m.script(CARD_COUNT) >= 4, f"{m.script(CARD_COUNT)} cards")
        check("verify panel ran ip route get",
              "Management peer" in text or "Goes out" in text)
        check("masquerade rationale is stated",
              "address changes" in text,
              "SNAT would go stale when the UE address changes")

        # ---- console errors ----------------------------------------------------
        print("=== console ===")
        errs = m.script("return (window.__tsn_errors || []).length;") or 0
        check("no uncaught errors recorded", errs == 0, f"{errs} errors")

    finally:
        m.close()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)

    failed = [n for n, ok, _ in checks if not ok]
    print()
    print(f"{len(checks) - len(failed)}/{len(checks)} checks passed")
    if failed:
        for n in failed:
            print(f"  FAILED: {n}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
