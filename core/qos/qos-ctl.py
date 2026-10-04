#!/usr/bin/env python3
"""
QoS control for the testbed, on the core: profiles -> PCC rules -> live check.

  qos-ctl.py profiles                         the profile library (profiles.json)
  qos-ctl.py show                             rules in MongoDB, live flows at the SMF,
                                              gNB treatment per 5QI, side by side
  sudo qos-ctl.py apply PROFILE [PROFILE...]  write those PCC rules for the UE
       [--rebuild]                            ... and have the UE build a new session
  sudo qos-ctl.py apply --clear [--rebuild]   no PCC rules: everything on the default flow
  sudo qos-ctl.py verify [--seconds 10]       capture N3 and show which QoS flow (QFI)
                                              each UE source port actually used

Why on the core: the UE's modem (RM520N) does not report its QoS rules
(AT+C5GQOSRDP unsupported, +CGEQOSRDP/+CGTFTRDP empty, QMI "QoS not
supported"), while the core holds the rules, the live flows and, in every
uplink GTP-U packet, the QFI the radio carried it on.

The core reads QoS only when a PDU session is established, so a change is
live only after the UE builds a NEW session (--rebuild, or the UE console's
Connection -> Rebuild session). SIM keys and SQN are never touched; the
previous rules are saved under /var/lib/tsn5g/qos-backups/ before a change.

Values default from site.env (UE_IMSI, DNN, UE_IP, UE_LAN_IP, API_PORT);
override with --imsi etc.
"""

import argparse
import datetime
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROFILES = os.path.join(HERE, "profiles.json")
BACKUPS = "/var/lib/tsn5g/qos-backups"
SMF_INFO = "http://127.0.0.4:9090/pdu-info"
GNB_CONFIGS = ["/etc/tsn5g/gnb.yaml", os.path.expanduser("~tsn_server/tsntestbed/gnb_x410.yaml")]
UNIT_MBPS = 2                                   # Open5GS bit-rate unit: 2 = Mbit/s


# ------------------------------------------------------------------ settings
def site_env():
    vals = {}
    for p in (os.environ.get("SITE_ENV", ""), "/etc/tsn5g/site.env",
              os.path.join(HERE, "..", "..", "site.env")):
        if p and os.path.isfile(p):
            for line in open(p):
                m = re.match(r'\s*([A-Z][A-Z0-9_]*)=("([^"]*)"|\'([^\']*)\'|(\S*))', line)
                if m:
                    vals[m.group(1)] = next(g for g in m.group(3, 4, 5) if g is not None)
            break
    return vals


def load_profiles():
    with open(PROFILES) as f:
        return {k: v for k, v in json.load(f).items() if not k.startswith("_")}


# ------------------------------------------------------------------ MongoDB
def mongo(js):
    if not shutil.which("mongosh"):
        sys.exit("mongosh not found (it comes with MongoDB, install.sh core)")
    p = subprocess.run(["mongosh", "--quiet", "open5gs", "--eval", js],
                       capture_output=True, text=True, timeout=30)
    if p.returncode != 0:
        sys.exit("mongosh failed: " + (p.stderr or p.stdout).strip())
    return p.stdout.strip()


def subscriber(imsi):
    out = mongo("EJSON.stringify(db.subscribers.findOne({imsi: %s}, {security: 0}))"
                % json.dumps(imsi))
    if out in ("", "null"):
        sys.exit(f"no subscriber {imsi} in MongoDB (core/open5gs/provision.sh creates it)")
    return json.loads(out)


def session_index(sub, dnn):
    for si, sl in enumerate(sub.get("slice", [])):
        for ei, se in enumerate(sl.get("session", [])):
            if se.get("name") == dnn:
                return si, ei, se
    sys.exit(f"subscriber has no session for DNN {dnn}")


# ------------------------------------------------------------------ PCC rules
def rule_from_profile(name, p):
    def br(v):
        return {"downlink": {"value": v, "unit": UNIT_MBPS}, "uplink": {"value": v, "unit": UNIT_MBPS}}
    qos = {"index": p["5qi"],
           "arp": {"priority_level": p.get("arp", 8),
                   "pre_emption_capability": 1, "pre_emption_vulnerability": 1}}
    if p.get("gbr_mbps"):
        qos["gbr"] = br(p["gbr_mbps"])
        qos["mbr"] = br(p.get("mbr_mbps", p["gbr_mbps"]))
    flows = [{"direction": 3,
              "description": f"permit out {proto} from any 1-65535 to assigned {p['port']}"}
             for proto in p.get("protocols", ["udp"])]
    return {"qos": qos, "flow": flows}


def describe_rule(r):
    q = r.get("qos", {})
    gbr = q.get("gbr", {}).get("uplink", {}).get("value")
    mbr = q.get("mbr", {}).get("uplink", {}).get("value")
    ports = sorted({m.group(1) for f in r.get("flow", [])
                    for m in [re.search(r"assigned (\d+)", f.get("description", ""))] if m})
    rate = f"GBR {gbr} / MBR {mbr} Mbit/s" if gbr else "non-GBR"
    return f"5QI {q.get('index')}  {rate}  UE src port {','.join(ports) or '?'}"


def rule_port(r):
    for f in r.get("flow", []):
        m = re.search(r"assigned (\d+)", f.get("description", ""))
        if m:
            return int(m.group(1))
    return None


# ------------------------------------------------------------------ SMF / gNB
def smf_flows(imsi):
    try:
        data = json.load(urllib.request.urlopen(SMF_INFO, timeout=5))
    except Exception as exc:
        return None, f"SMF /pdu-info unreachable ({exc})"
    for it in data.get("items", []):
        if it.get("supi") == f"imsi-{imsi}":
            return it.get("pdu", []), None
    return [], None


def gnb_qos():
    """5QI -> RLC mode from the gNB config's qos: list, and which file it came from."""
    for path in GNB_CONFIGS:
        if os.path.isfile(path):
            text = open(path).read()
            out = {}
            for m in re.finditer(r"five_qi:\s*(\d+)(.*?)(?=\n\s*-\s*\n|\n\s*five_qi:|\Z)", text, re.S):
                mode = re.search(r"\bmode:\s*(\w[\w-]*)", m.group(2))
                out[int(m.group(1))] = mode.group(1) if mode else "?"
            return out, path
    return {}, None


# ------------------------------------------------------------------ commands
def cmd_profiles(a, env):
    for name, p in load_profiles().items():
        print(f"{name:<24}{describe_rule(rule_from_profile(name, p))}")
        print(f"{'':<24}{p.get('description', '')}")


def cmd_show(a, env):
    sub = subscriber(a.imsi)
    _, _, se = session_index(sub, a.dnn)
    gq, gpath = gnb_qos()
    default_5qi = se.get("qos", {}).get("index")
    print(f"subscriber {a.imsi}  DNN {a.dnn}  UE {se.get('ue', {}).get('ipv4', '?')}\n")
    print("configured (MongoDB)")
    print(f"  default flow  5QI {default_5qi}   gNB: {gq.get(default_5qi, 'srsRAN default')}")
    for r in se.get("pcc_rule", []) or []:
        q = r.get("qos", {}).get("index")
        warn = "" if q in gq else "   <- no qos entry for this 5QI in the gNB config"
        print(f"  PCC rule      {describe_rule(r)}   gNB: {gq.get(q, 'srsRAN default')}{warn}")
    if not se.get("pcc_rule"):
        print("  (no PCC rules: everything rides the default flow)")
    pdus, err = smf_flows(a.imsi)
    print("\nlive (SMF)")
    if err:
        print("  " + err)
    elif not pdus:
        print("  no PDU session for this UE")
    for pdu in pdus or []:
        flows = ", ".join(f"QFI {f['qfi']} = 5QI {f['5qi']}" for f in pdu.get("qos_flows", []))
        print(f"  session {pdu.get('psi')} {pdu.get('dnn')} {pdu.get('ipv4')}: {flows}")
    want = sorted([default_5qi] + [r.get("qos", {}).get("index") for r in se.get("pcc_rule", []) or []])
    have = sorted(f["5qi"] for p in pdus or [] if p.get("dnn") == a.dnn for f in p.get("qos_flows", []))
    if pdus and want != have:
        print(f"\n  MISMATCH: configured 5QIs {want}, live {have}. The rules change only with a new "
              f"session: qos-ctl.py apply ... --rebuild, or UE console -> Rebuild session.")
    elif pdus:
        print("\n  configured and live flows agree")
    print(f"\n(gNB config read from {gpath or 'nowhere: none found'})")


def backup(sub):
    os.makedirs(BACKUPS, exist_ok=True)
    path = os.path.join(BACKUPS, datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + f"-{sub['imsi']}.json")
    with open(path, "w") as f:
        json.dump(sub, f, indent=1)
    return path


def cmd_apply(a, env):
    if os.geteuid() != 0:
        sys.exit("apply needs root (it writes MongoDB and a backup): sudo " + " ".join(sys.argv))
    profiles = load_profiles()
    if a.clear:
        rules = []
    else:
        if not a.profiles:
            sys.exit("name one or more profiles (qos-ctl.py profiles), or --clear")
        unknown = [p for p in a.profiles if p not in profiles]
        if unknown:
            sys.exit(f"unknown profile(s): {', '.join(unknown)}")
        rules = [rule_from_profile(n, profiles[n]) for n in a.profiles]
        ports = [rule_port(r) for r in rules]
        if len(set(ports)) != len(ports):
            sys.exit("two profiles use the same UE source port; one packet can match only one flow")
    sub = subscriber(a.imsi)
    si, ei, _ = session_index(sub, a.dnn)
    saved = backup(sub)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(rules, f)
        tmp = f.name
    try:
        out = mongo(
            "const r = EJSON.parse(require('fs').readFileSync(%s, 'utf8'));"
            "const u = {}; u['slice.%d.session.%d.pcc_rule'] = r;"
            "print(db.subscribers.updateOne({imsi: %s}, {$set: u}).modifiedCount)"
            % (json.dumps(tmp), si, ei, json.dumps(a.imsi)))
    finally:
        os.unlink(tmp)
    print(f"previous subscriber record saved: {saved}")
    print(f"PCC rules now: {len(rules)}" + ("" if out.strip() == "1" else "  (unchanged: same as before)"))
    for r in rules:
        print("  " + describe_rule(r))
    gq, _ = gnb_qos()
    for r in rules:
        q = r["qos"]["index"]
        if q not in gq:
            print(f"  note: the gNB config has no qos entry for 5QI {q}; srsRAN's defaults apply "
                  f"(for 5QI 4 that was RLC UM, which lost camera frames: LESSONS.md)")
    if a.rebuild:
        rebuild(a)
    else:
        print("\nNot live yet: the UE must build a new PDU session "
              "(re-run with --rebuild, or UE console -> Connection -> Rebuild session).")


def rebuild(a):
    base = f"http://{a.ue}:{a.api_port}"
    print(f"\nasking the UE ({base}) to build a new PDU session ...")
    req = urllib.request.Request(base + "/api/bearer/rebuild", data=b'{"confirm": true}',
                                 method="POST", headers={"Content-Type": "application/json"})
    try:
        job = json.load(urllib.request.urlopen(req, timeout=10))
    except Exception as exc:
        sys.exit(f"could not reach the UE API at {base}: {exc}")
    jid = job.get("job_id")
    end = time.time() + 120
    state = None
    while jid and time.time() < end:
        time.sleep(2)
        try:
            j = json.load(urllib.request.urlopen(f"{base}/api/jobs/{jid}", timeout=10))
        except Exception:
            continue
        state = j.get("state") or j.get("status")
        if state in ("done", "succeeded", "success", "failed", "error", "cancelled"):
            break
    print(f"UE rebuild job {jid}: {state}")
    time.sleep(3)
    pdus, err = smf_flows(a.imsi)
    if pdus:
        for pdu in pdus:
            print("live now: " + ", ".join(f"QFI {f['qfi']} = 5QI {f['5qi']}" for f in pdu.get("qos_flows", [])))


def parse_n3(path, ue_ip):
    """Uplink GTP-U packets from the UE -> {(proto, src port, dst port, qfi): count}.

    Reads the QFI from the PDU Session Container extension header (type 0x85),
    which the gNB puts on every uplink packet: the QoS flow the radio actually
    carried it on.
    """
    ue = bytes(int(x) for x in ue_ip.split("."))
    out = {}
    with open(path, "rb") as fh:
        gh = fh.read(24)
        magic = struct.unpack("<I", gh[:4])[0]
        en = "<" if magic in (0xa1b2c3d4, 0xa1b23c4d) else ">"
        while True:
            ph = fh.read(16)
            if len(ph) < 16:
                break
            incl = struct.unpack(en + "IIII", ph)[2]
            p = fh.read(incl)[14:]                       # Ethernet on lo
            if len(p) < 28 or p[9] != 17:
                continue
            g = p[(p[0] & 15) * 4 + 8:]
            if len(g) < 8 or g[1] != 0xFF:               # G-PDU only
                continue
            hdr, qfi = 8, None
            if g[0] & 7 and len(g) >= 12:
                nxt, hdr = g[11], 12
                while nxt and len(g) > hdr:
                    ln = g[hdr] * 4
                    if ln == 0 or len(g) < hdr + ln:
                        break
                    if nxt == 0x85 and ln >= 4:
                        qfi = g[hdr + 2] & 0x3F
                    nxt = g[hdr + ln - 1]
                    hdr += ln
            i = g[hdr:]
            if len(i) < 28 or i[12:16] != ue:
                continue
            if struct.unpack(">H", i[6:8])[0] & 0x1FFF:  # not the first fragment
                continue
            ihl = (i[0] & 15) * 4
            proto = {17: "udp", 6: "tcp", 1: "icmp"}.get(i[9], str(i[9]))
            sp = dp = 0
            if i[9] in (6, 17) and len(i) >= ihl + 4:
                sp, dp = struct.unpack(">HH", i[ihl:ihl + 4])
            key = (proto, sp, dp, qfi)
            out[key] = out.get(key, 0) + 1
    return out


def cmd_verify(a, env):
    if os.geteuid() != 0:
        sys.exit("verify needs root (it captures N3): sudo " + " ".join(sys.argv))
    sub = subscriber(a.imsi)
    _, _, se = session_index(sub, a.dnn)
    port_to_5qi = {rule_port(r): r["qos"]["index"] for r in se.get("pcc_rule", []) or []}
    pdus, err = smf_flows(a.imsi)
    qfi_to_5qi = {f["qfi"]: f["5qi"] for p in pdus or [] if p.get("dnn") == a.dnn for f in p.get("qos_flows", [])}
    if not qfi_to_5qi:
        sys.exit(err or "no live PDU session for this UE: nothing to verify")
    pcap = tempfile.mktemp(suffix=".pcap", prefix="qos-verify-")
    print(f"capturing uplink N3 for {a.seconds} s (send traffic from the UE now: cameras, tools) ...")
    subprocess.run(["timeout", str(a.seconds), "tcpdump", "-i", "lo", "-n", "-s", "128",
                    "-w", pcap, "udp port 2152"], capture_output=True)
    counts = parse_n3(pcap, a.ue_ip)
    os.unlink(pcap)
    if not counts:
        print("no uplink packets from the UE in that window")
        return 1
    # group by UE source port (the PCC rules match on it)
    by_port = {}
    for (proto, sp, dp, qfi), n in counts.items():
        by_port.setdefault((proto, sp), {}).setdefault(qfi, [0, set()])
        by_port[(proto, sp)][qfi][0] += n
        by_port[(proto, sp)][qfi][1].add(dp)
    default_qfi = min(qfi_to_5qi)
    bad = 0
    print(f"\nlive flows: " + ", ".join(f"QFI {q} = 5QI {f}" for q, f in sorted(qfi_to_5qi.items())))
    print(f"\n{'UE source':<14}{'to port(s)':<16}{'packets':>9}  {'carried on':<20}{'expected':<20}")
    for (proto, sp), per in sorted(by_port.items(), key=lambda kv: -sum(v[0] for v in kv[1].values())):
        want_5qi = port_to_5qi.get(sp)
        want = (f"5QI {want_5qi} (PCC rule)" if want_5qi
                else f"5QI {qfi_to_5qi[default_qfi]} (default)")
        for qfi, (n, dps) in sorted(per.items(), key=lambda kv: -kv[1][0]):
            got5 = qfi_to_5qi.get(qfi)
            ok = (got5 == want_5qi) if want_5qi else (qfi == default_qfi)
            bad += 0 if ok else n
            dports = ",".join(str(d) for d in sorted(dps)[:3]) + ("…" if len(dps) > 3 else "")
            src = f"{proto} {sp}" if proto in ("udp", "tcp") else proto
            print(f"{src:<14}{dports:<16}{n:>9}  {'QFI %s = 5QI %s' % (qfi, got5):<20}{want:<20}{'ok' if ok else 'WRONG FLOW'}")
    for port, q in port_to_5qi.items():
        if not any(sp == port for (_, sp) in by_port):
            print(f"(no traffic from UE source port {port} in the window, so its 5QI {q} rule was not exercised)")
    print("\nPASS: every packet rode the flow its rule says" if not bad
          else f"\nFAIL: {bad} packet(s) on a different flow than their rule says")
    return 1 if bad else 0


def main():
    env = site_env()
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--imsi", default=env.get("UE_IMSI", "001020000000001"))
    ap.add_argument("--dnn", default=env.get("DNN", "usrptsn"))
    ap.add_argument("--ue-ip", default=env.get("UE_IP", "10.45.0.12"), help="the UE's address on the bearer")
    ap.add_argument("--ue", default=env.get("UE_LAN_IP", "10.5.4.111"), help="the UE's LAN address (its API)")
    ap.add_argument("--api-port", default=env.get("API_PORT", "8080"))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("profiles")
    sub.add_parser("show")
    pa = sub.add_parser("apply")
    pa.add_argument("profiles", nargs="*")
    pa.add_argument("--clear", action="store_true", help="remove all PCC rules")
    pa.add_argument("--rebuild", action="store_true", help="have the UE build a new session")
    pv = sub.add_parser("verify")
    pv.add_argument("--seconds", type=int, default=10)
    a = ap.parse_args()
    return {"profiles": cmd_profiles, "show": cmd_show, "apply": cmd_apply,
            "verify": cmd_verify}[a.cmd](a, env) or 0


if __name__ == "__main__":
    sys.exit(main())
