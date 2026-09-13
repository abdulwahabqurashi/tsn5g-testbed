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

        # ---- data actually reached the view --------------------------------
        print("=== dashboard receives live data ===")
        check("store has a controller snapshot",
              bool(m.script("return !!window.__tsn.store.get().status;")))
        # Headings come from mount(); values only appear if the subscriptions
        # fired and painted without throwing.
        txt = m.wait_for(
            "document.getElementById('content').textContent.length > 300",
            timeout=20, label="dashboard painted")
        check("dashboard subscriptions populated the cards", bool(txt),
              f"{m.script('return document.getElementById(\'content\').textContent.length;')} chars")
        # The rewrite's reason: an index-based chart drew a dropped sample as a
        # fast one. Time-based means a gap is a gap.
        check("throughput chart is time-based",
              m.script("return !!document.querySelector('#content svg');"))

        # ---- no demo mode, and no compat layer -------------------------------
        print("=== demo mode and the compat shim are gone ===")
        check("no demo toggle in the DOM",
              m.script("return document.querySelectorAll('.switch').length;") == 0)
        # Phase 7's release gate. The shim exported window.TSN for the legacy
        # view bodies; nothing should define it now.
        check("the legacy window.TSN global is gone",
              m.script("return typeof window.TSN;") == "undefined",
              "compat/legacy-view.js should be deleted")
        check("no view is compat-wrapped",
              m.script("return !!window.__tsn.store.get().ui.route;"))

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

        # ---- Phase 5: registration ----------------------------------------
        print("=== registration view ===")
        m.script("window.location.hash = '#/registration';")
        m.wait_for("window.__tsn.store.get().ui.route === 'registration'",
                   timeout=15, label="registration route")
        m.wait_for("document.getElementById('content').textContent.length > 300",
                   timeout=25, label="registration content")
        text = m.script("return document.getElementById('content').textContent;")
        check("registration view mounted", m.script(CARD_COUNT) >= 5,
              f"{m.script(CARD_COUNT)} cards")
        check("serving cell shown", "ARFCN" in text)
        # The derived flag rather than a numeric field is the whole point: it
        # is the setting most likely to strand the rig and it looks harmless.
        check("SA-only is a derived state, not a numeric field",
              "SA only" in text and "disable_mode" in text)
        check("cell lock controls present", "Lock to cell" in text or "Clear lock" in text)
        check("survey controls present",
              "Scan cells" in text and "Diagnose RF" in text)

        # ---- Phase 6: throughput ------------------------------------------
        print("=== throughput view ===")
        m.script("window.location.hash = '#/throughput';")
        m.wait_for("window.__tsn.store.get().ui.route === 'throughput'",
                   timeout=15, label="throughput route")
        m.wait_for("document.getElementById('content').textContent.length > 300",
                   timeout=25, label="throughput content")
        text = m.script("return document.getElementById('content').textContent;")
        check("throughput view mounted", m.script(CARD_COUNT) >= 3,
              f"{m.script(CARD_COUNT)} cards")
        # The bind address is what decides whether a number means anything.
        check("bind address is shown",
              "bound to" in text or "no address" in text)
        check("both directions offered", "up (UE" in text and "down (core" in text)
        check("continuous loop offered", "Continuous loop" in text)
        check("both generators offered",
              "Link load" in text or "Camera-like" in text)

        # ---- Phase 7: advanced section ------------------------------------
        print("=== advanced section ===")
        # The nav is flat: a .nav-cap label followed by its .nav-item buttons.
        # Walk from the Advanced cap to the next cap and collect what is under it.
        under = m.script("""
            const kids = [...document.getElementById('nav').children];
            const i = kids.findIndex(e => e.classList.contains('nav-cap')
                                       && e.textContent.trim() === 'Advanced');
            if (i < 0) return null;
            const out = [];
            for (let j = i + 1; j < kids.length; j++) {
                if (kids[j].classList.contains('nav-cap')) break;
                out.push(kids[j].dataset.route);
            }
            return out;
        """)
        check("the TSN views are parked under an Advanced nav section",
              under == ["transport", "switch", "gptp"],
              f"found {under}")

        print("=== advanced/transport ===")
        m.script("window.location.hash = '#/transport';")
        m.wait_for("window.__tsn.store.get().ui.route === 'transport'",
                   timeout=15, label="transport route")
        m.wait_for("document.getElementById('content').textContent.length > 200",
                   timeout=25, label="transport content")
        text = m.script("return document.getElementById('content').textContent;")
        btns = m.script("return [...document.querySelectorAll('.btn')]"
                        ".map(b => b.textContent.trim());")
        check("transport view mounted", m.script(CARD_COUNT) >= 2,
              f"{m.script(CARD_COUNT)} cards")
        # /api/transport/stop shipped with no caller at all until this phase.
        check("Stop is wired to /api/transport/stop", "Stop" in btns,
              f"buttons were {btns}")
        check("Start is offered too", "Start" in btns)
        check("the traffic-class map came from the backend",
              "VLAN" in text or "No traffic classes" in text,
              "the map used to be a raw JSON textarea")

        print("=== advanced/switch ===")
        m.script("window.location.hash = '#/switch';")
        m.wait_for("window.__tsn.store.get().ui.route === 'switch'",
                   timeout=15, label="switch route")
        m.wait_for("document.getElementById('content').textContent.length > 200",
                   timeout=25, label="switch content")
        text = m.script("return document.getElementById('content').textContent;")
        btns = m.script("return [...document.querySelectorAll('.btn')]"
                        ".map(b => b.textContent.trim());")
        check("switch view mounted", m.script(CARD_COUNT) >= 3,
              f"{m.script(CARD_COUNT)} cards")
        # The status panel was `T.demo ? mock() : null`, so on real hardware it
        # rendered an empty div and /api/switch/status was never called.
        check("the live-status panel has a real control",
              "Read from switch" in btns, f"buttons were {btns}")
        check("status panel is not silently empty",
              "Read from switch" in text or "Reachable" in text)
        check("profiles came from the backend, not a duplicated array",
              m.script("return document.querySelectorAll('select').length;") >= 1)
        check("gate timeline previews before applying",
              "Preview CLI" in btns and "Apply" in btns)
        check("password is marked session-only", "session only" in text,
              "credentials must never be persisted")

        print("=== advanced/gptp ===")
        m.script("window.location.hash = '#/gptp';")
        m.wait_for("window.__tsn.store.get().ui.route === 'gptp'",
                   timeout=15, label="gptp route")
        m.wait_for("document.getElementById('content').textContent.length > 150",
                   timeout=25, label="gptp content")
        text = m.script("return document.getElementById('content').textContent;")
        btns = m.script("return [...document.querySelectorAll('.btn')]"
                        ".map(b => b.textContent.trim());")
        check("gptp view mounted", m.script(CARD_COUNT) >= 2,
              f"{m.script(CARD_COUNT)} cards")
        # This view had zero controls, even though the endpoints always existed
        # — restarting ptp4l meant going through the setup wizard.
        check("Start/Stop are wired to /api/gptp/*",
              "Start" in btns and "Stop" in btns, f"buttons were {btns}")
        check("servo state is shown", "Servo" in text)
        check("the hardware-timestamping requirement is explained",
              "hardware timestamping" in text)

        # ---- Phase 7: diagnostics (the diag.sh successor) ------------------
        print("=== diagnostics ===")
        m.script("window.location.hash = '#/diagnostics';")
        m.wait_for("window.__tsn.store.get().ui.route === 'diagnostics'",
                   timeout=15, label="diagnostics route")
        # The static card prose alone clears any textContent threshold, so wait
        # on the shell panes — they only exist once the snapshot has painted.
        m.wait_for("document.querySelectorAll('#content pre.log').length > 0",
                   timeout=45, label="snapshot to arrive and paint")
        text = m.script("return document.getElementById('content').textContent;")
        check("diagnostics view mounted", m.script(CARD_COUNT) >= 3,
              f"{m.script(CARD_COUNT)} cards")
        check("the snapshot endpoint answered, not a 404",
              "not found" not in text.lower() and "404" not in text,
              text[:160])
        check("it reports the shell commands diag.sh used to run",
              "ip " in text or "qmicli" in text or "systemctl" in text)
        check("a copyable snapshot is offered",
              "Copy" in m.script("return [...document.querySelectorAll('.btn')]"
                                 ".map(b => b.textContent.trim()).join(' ');")
              or "Download" in text or "Refresh" in text)

        # ---- Phase 7: config overlay ---------------------------------------
        print("=== settings overlay ===")
        srcmap = m.script("""
            return fetch('/api/config').then(r => r.json())
                   .then(c => JSON.stringify(c._source || null));
        """)
        check("GET /api/config reports where each section came from",
              srcmap and srcmap != "null", f"_source = {srcmap}")

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
