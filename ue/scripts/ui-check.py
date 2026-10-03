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
        # fired and painted without throwing. Assert on a value that must be
        # present rather than a character count — a count threshold failed the
        # moment the core went unreachable and latency rendered as a dash,
        # which says nothing about whether the view is wired.
        m.wait_for("document.querySelectorAll('#content .kpi-val').length > 3",
                   timeout=20, label="dashboard values to paint")
        painted = m.script("""
            return [...document.querySelectorAll('#content .kpi-val')]
                   .filter(e => e.textContent.trim()
                                && e.textContent.trim() !== '\u2014').length;
        """)
        check("dashboard subscriptions populated the cards", painted > 2,
              f"{painted} KPI values carried real data")
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
        # The address used to sit behind a "UE address" label among seven
        # others; it is the card's headline now, so assert the value.
        check("connection view shows bearer state",
              bool(m.script("return !!document.querySelector('.state-addr');")),
              "no address element in the bearer card")
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
        # Assert containment, not equality: "parked under Advanced" is the
        # property being tested, and pinning the exact list makes every new
        # TSN view a failure for no reason. It did, when the bridge arrived.
        expected = {"transport", "switch", "gptp", "bridge"}
        check("the TSN views are parked under an Advanced nav section",
              expected.issubset(set(under or [])),
              f"missing {sorted(expected - set(under or []))}; found {under}")

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

        # ---- advanced/bridge ----------------------------------------------
        # Every check here covers something that was API-only until the
        # operator asked whether the UI had kept up. It had not.
        print("=== advanced/bridge ===")
        m.script("window.location.hash = '#/bridge';")
        m.wait_for("window.__tsn.store.get().ui.route === 'bridge'",
                   timeout=15, label="bridge route")
        m.wait_for("document.getElementById('content').textContent.length > 200",
                   timeout=25, label="bridge content")
        text = m.script("return document.getElementById('content').textContent;")
        btns = m.script("return [...document.querySelectorAll('.btn')]"
                        ".map(b => b.textContent.trim());")
        sels = m.script("return [...document.querySelectorAll('select')]"
                        ".map(s => [...s.options].map(o => o.value));")
        flat = [v for group in sels for v in group]

        check("bridge view mounted", m.script(CARD_COUNT) >= 4,
              f"{m.script(CARD_COUNT)} cards")
        # The queue on the modem overrides the gate entirely when it is deep or
        # flow-fair, so its state belongs on screen and not in a log line.
        check("the modem's egress queue is shown", "Modem queue" in text)
        # Which 802.1p priority reaches which gate window. A wrong map applies
        # cleanly and separates nothing, and is invisible in every other field.
        check("the priority map is shown", "Priority map" in text)
        # Gate windows are judged against the rate the radio actually gives.
        check("the assumed uplink rate is shown", "Uplink assumed" in text)
        # Configuration claiming a DSCP is not evidence it reached the header;
        # the first implementation here wrote none at all.
        check("outer DSCP is surfaced on the wire",
              "Outer DSCP on the wire" in text)
        check("the DSCP audit can be started",
              any("count" in b.lower() for b in btns), f"buttons were {btns}")
        # Both class layouts are kept because the core/RAN answer decides which
        # is right; the operator has to be able to pick without editing YAML.
        check("both class layouts are selectable",
              "per-camera-tunnel" in flat and "shared-tunnel" in flat,
              f"select options were {flat}")
        # A window shorter than one packet cannot pass one. Saying so in the
        # picker costs nothing; discovering it after a run costs a day. Read the
        # option LABELS, not their values — the marker is deliberately only in
        # the text, so the value stays the plain profile name the API takes.
        labels = m.script("return [...document.querySelectorAll('select')]"
                          ".flatMap(s => [...s.options].map(o => o.textContent));")
        check("unusable gate profiles are marked in the picker",
              any("(unusable)" in x for x in labels),
              f"{sum('(unusable)' in x for x in labels)} of {len(labels)} "
              f"options marked unusable")
        # The layout bug this catches, reported from a screenshot: .kpis was a
        # fixed four-column grid, so in the narrower gate card each control got
        # a quarter of the width and clipped its own text — "hpvideo" rendered
        # as "hpvid", "all-open" as "all-op". Truncation is measurable without
        # looking: the content is wider than the box drawn for it.
        clipped = m.script(
            "return [...document.querySelectorAll('#content select')]"
            ".filter(s => s.scrollWidth > s.clientWidth + 2)"
            ".map(s => (s.options[s.selectedIndex]||{}).textContent);")
        check("no control clips its own text", not clipped,
              f"clipped: {clipped}" if clipped else "nothing truncated")
        # .fld had no CSS at all, so label, control and hint ran together
        # inline and wrapped wherever the column happened to end. Stacked, the
        # control sits below its label rather than beside it.
        stacked = m.script(
            "const f=document.querySelector('#content .fld');"
            "if(!f) return null;"
            "const c=f.querySelector('select,input');"
            "if(!c) return null;"
            "return c.getBoundingClientRect().top > f.getBoundingClientRect().top + 4;")
        check("a labelled control sits under its label, not beside it",
              stacked is True, f"stacked={stacked}")

        # The marker says which; the hint says why, in the arithmetic that
        # decides it. A verdict with no numbers reads as an opinion.
        check("the reason is given, not just the verdict",
              "one packet takes" in text or "holds at least two" in text
              or "against a" in text)

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

        # ---- nothing asserts what it has not measured ----------------------
        # Each of these rendered a confident value that came from a constant or
        # an untouched default rather than from the hardware.
        print("=== no invented values ===")

        m.script("window.location.hash = '#/registration';")
        m.wait_for("window.__tsn.store.get().ui.route === 'registration'",
                   timeout=15, label="registration route")
        m.wait_for("document.getElementById('content').textContent.length > 300",
                   timeout=25, label="registration content")
        # The lock form was hard-coded to this rig: 624000 / 78 / PCI 1.
        cell = m.script("""
            return fetch('/api/radio').then(r => r.json())
                   .then(s => JSON.stringify(s.cell || {}));
        """)
        cell = json.loads(cell)
        vals = m.script("""
            return [...document.querySelectorAll('#content input[type=number]')]
                   .map(i => i.value);
        """)
        check("cell-lock form prefills from the serving cell, not constants",
              cell.get("arfcn") is None or str(cell["arfcn"]) in vals,
              f"serving arfcn {cell.get('arfcn')}, form had {vals}")

        text = m.script("return document.getElementById('content').textContent;")
        fb = m.script("""
            return fetch('/api/radio/plmn/forbidden').then(r => r.json())
                   .then(d => JSON.stringify(d));
        """)
        fb = json.loads(fb)
        if fb.get("error"):
            check("an unreadable forbidden-PLMN list is not reported as empty",
                  "Could not read the list" in text,
                  "the firmware rejects AT+QFPLMNCFG and the UI claimed 'None'")
        else:
            check("forbidden-PLMN list read cleanly", True)

        print("=== modem reports measurements, not defaults ===")
        m.script("window.location.hash = '#/modem';")
        m.wait_for("window.__tsn.store.get().ui.route === 'modem'", timeout=15,
                   label="modem route")
        m.wait_for("document.getElementById('content').textContent.length > 200",
                   timeout=20, label="modem content")
        api_m = json.loads(m.script("""
            return fetch('/api/modem').then(r => r.json())
                   .then(d => JSON.stringify(d.modem || {}));
        """))
        bearer = json.loads(m.script("""
            return fetch('/api/bearer').then(r => r.json()).then(d => JSON.stringify(d));
        """))
        if bearer.get("state") == "up":
            check("a live bearer is not reported as pdu_active=false",
                  api_m.get("pdu_active") is True,
                  f"bearer up at {bearer.get('ipv4')} but pdu_active="
                  f"{api_m.get('pdu_active')}")
            check("the UE address reaches the modem view",
                  api_m.get("ipv4") == bearer.get("ipv4"),
                  f"{api_m.get('ipv4')} vs {bearer.get('ipv4')}")
        sig = json.loads(m.script("""
            return fetch('/api/signal').then(r => r.json()).then(d => JSON.stringify(d));
        """))
        if sig.get("rsrp") is not None and not sig.get("stale"):
            check("a camped UE is not reported as unregistered",
                  api_m.get("registered") is True,
                  f"serving cell reads RSRP {sig.get('rsrp')} but registered="
                  f"{api_m.get('registered')}")
        # Unmeasured must read as unknown, never as a confident "no".
        text = m.script("return document.getElementById('content').textContent;")
        if api_m.get("sim_ready") is None:
            check("an unmeasured SIM shows as unknown, not 'not ready'",
                  "unknown" in text and "not ready" not in text,
                  "sim_ready is null until a Check runs")

        print("=== bearer state is complete enough to tear down ===")
        if bearer.get("state") == "up":
            check("MTU comes from the kernel even with no QMI settings",
                  bearer.get("mtu") is not None, f"mtu={bearer.get('mtu')}")
            check("carrier is reported, not left as operstate 'unknown'",
                  bearer.get("carrier") in ("up", "down"),
                  f"carrier={bearer.get('carrier')}")
            check("a data handle is known, so the call can be stopped cleanly",
                  bearer.get("pdh") is not None,
                  "without it the interface is only flushed and the session "
                  "stays alive in the modem")

        print("=== gPTP can actually be started ===")
        m.script("window.location.hash = '#/gptp';")
        m.wait_for("window.__tsn.store.get().ui.route === 'gptp'", timeout=15,
                   label="gptp route")
        m.wait_for("document.getElementById('content').textContent.length > 150",
                   timeout=20, label="gptp content")
        gp = json.loads(m.script("""
            return fetch('/api/status').then(r => r.json())
                   .then(d => JSON.stringify(d.gptp || {}));
        """))
        disabled = m.script("""
            const b = [...document.querySelectorAll('.btn')]
                      .find(x => x.textContent.trim() === 'Start');
            return b ? b.disabled : null;
        """)
        check("gPTP offers the interfaces that support timestamping",
              len(gp.get("interfaces") or []) > 0,
              "config tsn_nics is empty; the hardware must be probed")
        check("Start is enabled when an interface is available",
              disabled is False or bool(gp.get("running")),
              f"Start disabled={disabled} with interfaces {gp.get('interfaces')}")

        print("=== switch reads its identity from config ===")
        m.script("window.location.hash = '#/switch';")
        m.wait_for("window.__tsn.store.get().ui.route === 'switch'", timeout=15,
                   label="switch route")
        m.wait_for("document.querySelectorAll('#content input').length >= 4",
                   timeout=20, label="switch form")
        cfg_sw = json.loads(m.script("""
            return fetch('/api/config').then(r => r.json())
                   .then(c => JSON.stringify(c.switch || {}));
        """))
        host_val = m.script("""
            return document.querySelector('#content input[type=text]').value;
        """)
        check("switch host comes from config, not a literal in the view",
              host_val == (cfg_sw.get("host") or ""),
              f"form {host_val!r} vs config {cfg_sw.get('host')!r}")

        # ---- throughput: both ends, and a verdict before the run ------------
        print("=== client and server are both specified ===")
        m.script("window.location.hash = '#/throughput';")
        m.wait_for("window.__tsn.store.get().ui.route === 'throughput'",
                   timeout=15, label="throughput route")
        m.wait_for("document.querySelectorAll('#content input').length >= 4",
                   timeout=25, label="test form")
        text = m.script("return document.getElementById('content').textContent;")
        check("the client address is a field, not a hidden constant",
              "Client" in text,
              "binding was forced to the bearer with no way to change it")
        check("the server is still named separately", "Server" in text)

        addrs = json.loads(m.script("""
            return fetch('/api/iperf/defaults').then(r => r.json())
                   .then(d => JSON.stringify(d.client_addresses || []));
        """))
        check("client addresses are offered from the host, not typed blind",
              len(addrs) > 0, f"{[a['address'] for a in addrs]}")

        # The failure this replaces was a 30s wait ending in a timeout message
        # that named a symptom. It should now be refused with a reason.
        bad = json.loads(m.script("""
            return fetch('/api/iperf/path', {method:'POST',
                headers:{'Content-Type':'application/json'},
                body: JSON.stringify({server:'10.5.1.19', bind:'10.45.0.6'})})
                .then(r => r.json()).then(d => JSON.stringify(d));
        """))
        if bad.get("owner") and bad.get("dev") and bad["owner"] != bad["dev"]:
            check("a client that cannot reach the server is refused up front",
                  bad.get("ok") is False, f"ok={bad.get('ok')}")
            check("the refusal explains why, not just that",
                  "belongs to" in (bad.get("reason") or ""),
                  bad.get("reason") or "no reason given")

        print("=== command output is evidence, not the display ===")
        # Leading with a terminal pane made reading a result an act of parsing.
        check("raw output sits behind a disclosure",
              m.script("return document.querySelectorAll"
                       "('#content details.raw-output').length;") >= 1,
              "the log pane should not be the primary display")

        print("=== background traffic actually stops ===")
        state = json.loads(m.script("""
            return fetch('/api/perf/dummy').then(r => r.json())
                   .then(d => JSON.stringify(d));
        """))
        check("the generator reports a real state", "running" in state,
              json.dumps(state)[:120])
        if not state.get("running"):
            check("nothing is loading the link during the checks", True)

        print("=== routing reads without parsing transcripts ===")
        m.script("window.location.hash = '#/routing';")
        m.wait_for("window.__tsn.store.get().ui.route === 'routing'",
                   timeout=15, label="routing route")
        m.wait_for("document.getElementById('content').textContent.length > 300",
                   timeout=25, label="routing content")
        text = m.script("return document.getElementById('content').textContent;")
        check("policy state is summarised before the raw output",
              "Policy rules" in text and "Marking rules" in text,
              "ip rule / iptables -S dumps were the whole panel")
        check("the raw transcripts are still available",
              m.script("return document.querySelectorAll"
                       "('#content details.raw-output').length;") >= 1)

        # ---- connection: the run is legible at a glance --------------------
        print("=== connection: bearer card and stepper ===")
        m.script("window.location.hash = '#/connection';")
        m.wait_for("window.__tsn.store.get().ui.route === 'connection'",
                   timeout=15, label="connection route")
        m.wait_for("!!document.querySelector('.state-hero')", timeout=25,
                   label="bearer state to paint")
        check("the bearer card leads with state and address",
              bool(m.script("return !!document.querySelector"
                            "('.state-hero .big-state');")),
              "eight equal-weight rows told you nothing first")
        check("the status dot reflects the bearer, not a fixed colour",
              m.script("return (document.querySelector('.state-dot')||{})"
                       ".className;") in ("state-dot ok", "state-dot idle"))

        # The step states the job reports and the classes the stylesheet knows
        # drifted apart once already (job: succeeded, CSS: .done), and the
        # symptom was every step rendering grey however it had gone.
        steps = m.script("""
            return [...document.querySelectorAll('.stepper .step')]
                   .map(s => s.className);
        """) or []
        if steps:
            known = ("done", "active", "err", "pending")
            unstyled = [c for c in steps
                        if not any(f" {k}" in f" {c}" for k in known)]
            check("every step carries a state class the stylesheet styles",
                  not unstyled, f"unstyled: {unstyled}")
            check("a finished run shows completed steps as done",
                  any("done" in c for c in steps) or any("err" in c for c in steps),
                  f"classes were {steps}")
            check("finished steps report how long they took",
                  m.script("return [...document.querySelectorAll"
                           "('.stepper .step.done .step-time')]"
                           ".some(e => e.textContent.trim().length > 0);"),
                  "the timings are in the job and were not shown")
            check("the run has a heading naming where it is",
                  bool(m.script("return !!document.querySelector('.run-state');")))
            check("and a progress bar",
                  bool(m.script("return !!document.querySelector('.run-bar > i');")))

        # ---- interface configuration actually configures --------------------
        # This reported {"ok": true} unconditionally while nmcli failed, because
        # it addressed the connection by interface name and swallowed the error.
        print("=== static IP is verified, not assumed ===")
        cfg = json.loads(m.script("""
            return fetch('/api/interfaces').then(r => r.json())
                   .then(d => JSON.stringify(d.interfaces || []));
        """))
        spare = [i for i in cfg
                 if not i.get("management") and i.get("name", "").startswith("enp")
                 and i.get("ipv4")]
        if spare:
            iface = spare[0]
            check("a configured interface reports its address back",
                  bool(iface.get("ipv4")),
                  f"{iface['name']} = {iface.get('ipv4')}")
            # The contract: the API returns what the kernel holds, not the request.
            live = m.script(f"""
                return fetch('/api/interfaces').then(r => r.json())
                  .then(d => (d.interfaces.find(x => x.name === '{iface["name"]}')||{{}}).ipv4);
            """)
            check("the reported address matches the kernel",
                  live == iface.get("ipv4"), f"{live} vs {iface.get('ipv4')}")

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
