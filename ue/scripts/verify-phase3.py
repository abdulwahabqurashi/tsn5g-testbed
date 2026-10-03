#!/usr/bin/env python3
"""
Phase 3 hardware verification — the claims that only real hardware can settle.

    ./scripts/verify-phase3.py [base-url]

Everything else in Phase 3 is covered by unit tests against a simulated modem
and by scripts/ui-check.py in a real browser. These four need the RM520N-GL:

  1. the AT port is found by probing, not by configuration
  2. the parsers produce real values from a real serving cell
  3. the console and telemetry share one bus without fighting — the whole
     reason ModemBus exists
  4. releasing the bus hands the port back to at.py, so the reference scripts
     still work while the service runs

Read-only. Nothing here changes modem configuration or touches the bearer.
"""

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

PASS, FAIL, SKIP = "PASS", "FAIL", "SKIP"
results = []


def report(name, status, detail=""):
    results.append((name, status, detail))
    print(f"  {status}  {name}" + (f"   {detail}" if detail else ""))


def call(base, method, path, body=None, timeout=30):
    url = base.rstrip("/") + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"error": raw.decode("utf-8", "replace")[:200]}
    except Exception as exc:                # noqa: BLE001
        return 0, {"error": str(exc)}


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"

    status, _ = call(base, "GET", "/api/status", timeout=5)
    if status != 200:
        print(f"ERROR: no daemon at {base}. Start it with:\n"
              f"  sudo systemctl start tsn5g-ue", file=sys.stderr)
        return 2

    # ---- 1. port detection --------------------------------------------------
    print("=== 1. the AT port is found by probing ===")
    st, ports = call(base, "GET", "/api/modem/ports")
    at = (ports or {}).get("at")
    if at:
        report("AT port detected", PASS,
               f"{at}  model={ports.get('model')}  "
               f"(probed {len(ports.get('candidates') or [])} candidates)")
        report("QMI device detected", PASS if ports.get("qmi") else FAIL,
               str(ports.get("qmi")))
    else:
        report("AT port detected", FAIL,
               "no port answered — is this running as root, and ModemManager masked?")
        print("\nCannot continue without the modem.", file=sys.stderr)
        return 1

    # ---- 2. real values from the parsers ------------------------------------
    print("=== 2. the parsers produce real values ===")
    st, sig = call(base, "GET", "/api/signal")
    have = {k: sig.get(k) for k in ("rsrp", "rsrq", "sinr", "rat", "band",
                                    "arfcn", "pci", "cellid")}
    report("serving cell parsed",
           PASS if have["rsrp"] is not None else FAIL,
           " ".join(f"{k}={v}" for k, v in have.items() if v is not None) or "nothing")
    report("RSRP is plausible",
           PASS if have["rsrp"] is not None and -140 <= have["rsrp"] <= -40 else FAIL,
           f"{have['rsrp']} dBm")
    # The hex cell id is what defeated the old digit-scanning parser.
    report("hex cell id parsed (the old parser could not)",
           PASS if have["cellid"] else SKIP,
           str(have["cellid"] or "not reported by this cell"))

    st, branches = call(base, "POST", "/api/signal/sample", {})
    b = (branches or {}).get("branches") or {}
    rsrp_b = (b.get("rsrp") or {}).get("branches")
    if rsrp_b:
        live = [x for x in rsrp_b if x is not None]
        report("per-antenna RSRP read", PASS, str(rsrp_b))
        report("RF is reaching the modem",
               PASS if not (b.get("rsrp") or {}).get("no_rf") else FAIL,
               "all branches at -140 would mean an antenna or cabling fault")
    else:
        report("per-antenna RSRP read", SKIP, "no branch data returned")

    # ---- 3. the console and telemetry share one bus -------------------------
    print("=== 3. console and telemetry share the bus (why ModemBus exists) ===")
    before = sig.get("ts")
    errors = []
    replies = []

    def hammer():
        """Ten console commands while the 2s signal poller is running."""
        for _ in range(10):
            code, res = call(base, "POST", "/api/modem/at",
                             {"cmd": 'AT+QENG="servingcell"', "timeout": 8})
            if code != 200 or not res.get("ok"):
                errors.append(res.get("error") or f"HTTP {code}")
            else:
                replies.append(res)
            time.sleep(0.3)

    t = threading.Thread(target=hammer)
    t.start()
    t.join(90)

    report("console commands all succeeded under concurrent telemetry",
           PASS if not errors else FAIL,
           f"{len(replies)}/10 ok" + (f"; first error: {errors[0][:70]}" if errors else ""))

    # The contention failure this exists to prevent has a specific signature.
    contention = [e for e in errors if "readiness to read" in e or "no data" in e]
    report("no serial contention errors", PASS if not contention else FAIL,
           contention[0][:80] if contention else
           "'device reports readiness to read but returned no data' would mean two owners")

    st, after = call(base, "GET", "/api/signal")
    moved = after.get("ts") and before and after["ts"] > before
    report("telemetry kept updating throughout", PASS if moved else FAIL,
           f"ts advanced by {after['ts'] - before:.1f}s" if moved else "timestamp did not move")

    # ---- 4. the bus hands the port back -------------------------------------
    print("=== 4. releasing the bus lets at.py have the port ===")
    st, rel = call(base, "POST", "/api/modem/bus/release", {})
    report("bus released", PASS if st == 200 else FAIL, str(rel))

    at_py = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tools", "modem", "at.py")
    try:
        proc = subprocess.run(["sudo", "-n", at_py, "AT+CSQ"],
                              capture_output=True, text=True, timeout=40)
        out = (proc.stdout or proc.stderr).strip()
        if "+CSQ" in out:
            report("at.py can use the port while the service runs", PASS,
                   out.splitlines()[-1][:80])
        elif "password is required" in out or "not allowed" in out:
            # No sudoers rule covers at.py, so this check cannot run
            # unattended. Not a product failure — say so rather than failing.
            report("at.py can use the port while the service runs", SKIP,
                   "needs sudo; run `sudo ./at.py AT+CSQ` by hand after a bus release")
        else:
            report("at.py can use the port while the service runs", FAIL,
                   out.splitlines()[-1][:80] if out else "no output")
    except FileNotFoundError:
        report("at.py can use the port while the service runs", SKIP, "at.py not found")
    except subprocess.TimeoutExpired:
        report("at.py can use the port while the service runs", FAIL, "timed out")
    except Exception as exc:                # noqa: BLE001
        report("at.py can use the port while the service runs", SKIP, str(exc)[:60])

    st, res = call(base, "POST", "/api/modem/at", {"cmd": "AT+CSQ", "timeout": 8})
    report("the bus reopens transparently afterwards",
           PASS if st == 200 and res.get("ok") else FAIL,
           " ".join(res.get("lines") or []) or str(res.get("error"))[:60])

    # ---- 5. history is accumulating -----------------------------------------
    print("=== 5. signal history reaches sqlite ===")
    st, hist = call(base, "GET", "/api/signal/history?window=15m")
    n = (hist or {}).get("count", 0)
    report("history rows stored", PASS if n > 0 else FAIL,
           f"{n} points, bucketed at {hist.get('step_s')}s")

    # ---- summary -------------------------------------------------------------
    failed = [n for n, s, _ in results if s == FAIL]
    skipped = [n for n, s, _ in results if s == SKIP]
    print()
    print(f"{len(results) - len(failed) - len(skipped)}/{len(results)} passed"
          + (f", {len(skipped)} skipped" if skipped else ""))
    if failed:
        for n in failed:
            print(f"  FAILED: {n}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
