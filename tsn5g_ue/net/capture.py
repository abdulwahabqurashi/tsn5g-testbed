"""
A short, bounded packet capture — the only way to see the fields nothing else
reports.

Two markings in this design are invisible to every counter on the box. The
802.1p PCP lives in the inner VLAN tag, which is inside the VXLAN payload, so
no qdisc or filter on any device can read it. The outer DSCP can be counted
(see dscpaudit) but counting does not show it sitting next to the PCP in the
same frame, which is what "the marking chain is intact" actually means.

So: tcpdump, deliberately small. Bounded by packet count and by a hard
timeout, never unbounded, because a capture left running on a shared box is a
way to fill a disk and a way to read traffic that is not ours to read. Output
is parsed into fields and the raw text kept alongside, so a claim about what
is on the wire can always be checked against what tcpdump actually said.

What this is not: a monitoring tool. It answers "is the marking there" once,
and then stops.
"""

import logging
import re

from .. import utils

logger = logging.getLogger("tsn5g-ue.net.capture")

MAX_PACKETS = 200
MAX_SECONDS = 20


class CaptureError(RuntimeError):
    pass


#: tcpdump prints the VLAN tag as "vlan 70, p 4" and the DS field as
#: "tos 0x88". Both only appear with -e -v, which is why those flags are not
#: optional below.
_TIMESTAMP = re.compile(r"^\d{2}:\d{2}:\d{2}\.\d+ ")
_VLAN = re.compile(r"vlan\s+(\d+),\s*p\s+(\d+)")
_TOS = re.compile(r"tos\s+(0x[0-9a-fA-F]+|\d+)")


def run(device, count=50, seconds=10, expression=None):
    """Capture up to `count` packets on `device` and report what was marked.

    Returns per-packet VLAN id, PCP and DSCP where present, plus the raw
    tcpdump lines. An empty capture is a result, not an error — it usually
    means nothing was sent while it ran.

    One trap worth naming, because it costs an afternoon: a BPF expression
    like `udp port 9999` does NOT match a VLAN-tagged frame. The tag shifts
    every later header by four bytes and the classic filters do not look past
    it. On a tagged device write `vlan and udp port 9999`, or leave the filter
    off. The devices in this package's chain are tagged from the VLAN device
    onward, which is exactly where the PCP is worth looking at.
    """
    count = max(1, min(int(count), MAX_PACKETS))
    seconds = max(1, min(int(seconds), MAX_SECONDS))

    # tcpdump has no duration flag: -c N blocks until N packets arrive, however
    # long that takes. On a quiet device that is forever, so `seconds` was a
    # promise nothing kept — the request hung until the RPC gave up and the
    # packets already captured were thrown away with the exception. `timeout`
    # sends SIGINT instead, which makes tcpdump flush what it has and exit, so
    # a capture that sees nothing returns an empty result rather than failing.
    argv = ["timeout", "-s", "INT", str(seconds),
            "tcpdump", "-i", device, "-c", str(count), "-n", "-e", "-v",
            "-Q", "out", "--immediate-mode"]
    if expression:
        # Passed as separate words, never through a shell, so a filter cannot
        # become a command.
        argv += expression.split()

    proc = utils.run(argv, check=False, timeout=seconds + 15)
    text = (proc.stdout or "") + (proc.stderr or "")
    # 124 is `timeout` doing its job: the window closed before `count` packets
    # arrived, which is an ordinary outcome and not a failure.
    if proc.returncode not in (0, 124) and "packets captured" not in text:
        raise CaptureError(
            f"tcpdump failed on {device}: {text.strip()[:300] or 'no output'}")

    # -v makes tcpdump print one packet across several lines, so lines are not
    # packets. A new packet is the one that starts with a timestamp;
    # everything after it belongs to that packet until the next timestamp.
    # Counting lines instead reported more packets than were asked for and
    # filled the summary with empty rows — the continuation lines, which
    # naturally carry neither a VLAN tag nor a ToS field.
    chunks = []
    for line in (proc.stdout or "").splitlines():
        if not line.strip():
            continue
        if _TIMESTAMP.match(line):
            chunks.append(line.strip())
        elif chunks:
            chunks[-1] += " " + line.strip()

    rows = []
    for chunk in chunks:
        vlan = _VLAN.search(chunk)
        tos = _TOS.search(chunk)
        rows.append({
            "vlan": int(vlan.group(1)) if vlan else None,
            "pcp": int(vlan.group(2)) if vlan else None,
            "dscp": int(tos.group(1), 0) >> 2 if tos else None,
            "line": chunk[:240],
        })

    marked = [r for r in rows if r["pcp"] is not None or r["dscp"]]
    logger.info("capture on %s: %d packets, %d carrying a marking",
                device, len(rows), len(marked))
    return {
        "device": device,
        "requested": count,
        "captured": len(rows),
        "packets": rows,
        "summary": _summarise(rows),
    }


def _summarise(rows):
    """How many packets carried each (vlan, pcp, dscp) combination.

    The combination is the point. A PCP that is right while the DSCP beside it
    is wrong is a broken chain, and two separate counters would each report
    themselves healthy.
    """
    seen = {}
    for r in rows:
        key = (r["vlan"], r["pcp"], r["dscp"])
        seen[key] = seen.get(key, 0) + 1
    return [{"vlan": v, "pcp": p, "dscp": d, "packets": n}
            for (v, p, d), n in sorted(seen.items(), key=lambda kv: -kv[1])]
