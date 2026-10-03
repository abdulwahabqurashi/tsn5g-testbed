"""
The camera-facing interfaces, and which camera is behind each one.

Two GigE Vision cameras, one per NIC. Both fall back to link-local addressing
because there is no DHCP on those segments, and a link-local address is derived
from the MAC — so cameras from one batch land on adjacent addresses inside the
same /16. That is the problem this module exists to solve:

  A /16 on two interfaces is one subnet reached two ways, and the kernel has no
  basis for choosing. Host routes make it work but Spinnaker refuses outright —
  "Camera is on an adapter with conflicting IP and subnet address range" — so
  the fix has to be real separation, not a routing patch.

The separation is put on the UE side. Each interface takes a /24 that contains
exactly one camera, so the two ranges cannot overlap and neither camera has to
be reconfigured. `169.254.144.1/24` faces the camera at `.144.18`,
`169.254.143.1/24` faces the one at `.143.18`.

Addresses set by hand do not survive a reboot. On 30 Sep this rig came back with
both interfaces on their original overlapping addresses and one camera
unreachable, so this is configuration rather than a command someone remembers.

The serial check is the other half. `pathStream1` selects its camera by
`nicid`, an index into enumeration order, and enumeration order is not
guaranteed across reboots. An index that silently points at the other camera
would put the wrong stream in the protected lane and report nothing wrong, so
the serial actually behind each interface is verified rather than assumed.

A camera may live in its own network namespace (`netns:` in its entry) —
camera 2 does, because pathStream1 claims every camera it can enumerate and a
namespace is the only way to give each encoder exactly one. Its NIC and address
then do not exist in the root namespace at all, so every check here has to be
made from inside that namespace or it fails with EADDRNOTAVAIL and reports a
healthy camera as unreachable.
"""

import logging
import os
import socket
import struct
import threading

from .. import utils

logger = logging.getLogger("tsn5g-ue.net.cameras")

GVCP_PORT = 3956
#: GVCP DISCOVERY_CMD: magic 0x42, flags ack-required, command 0x0002.
_DISCOVERY = struct.pack(">BBHHH", 0x42, 0x01, 0x0002, 0x0000, 0x0001)


class CameraError(RuntimeError):
    pass


def _netns(entry):
    """The namespace this camera's NIC lives in, or None for the root one.

    Falls back to the root namespace when the configured one does not exist:
    `camera2-netns.sh down` returns the NIC there, and the camera should still
    be checkable rather than reported missing.
    """
    ns = entry.get("netns")
    if ns and os.path.exists(f"/run/netns/{ns}"):
        return ns
    return None


def _ip(entry):
    ns = _netns(entry)
    return ["ip", "-n", ns] if ns else ["ip"]


def _iface_exists(entry):
    iface = entry.get("interface")
    if not _netns(entry):
        return utils.iface_exists(iface)
    proc = utils.run(_ip(entry) + ["link", "show", iface], check=False, timeout=10)
    return proc.returncode == 0


def _socket(entry):
    """A UDP socket created inside the camera's namespace.

    A socket belongs to the namespace it was created in for its whole life, so
    only the creation has to happen there. setns() changes the namespace of the
    calling thread alone, so a throwaway thread does it and the daemon's own
    threads never leave the root namespace.
    """
    ns = _netns(entry)
    if not ns:
        return socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    box = {}

    def make():
        try:
            with open(f"/run/netns/{ns}") as fh:
                os.setns(fh.fileno(), os.CLONE_NEWNET)
            box["sock"] = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        except OSError as exc:
            box["err"] = exc

    t = threading.Thread(target=make, name=f"netns-{ns}")
    t.start()
    t.join()
    if "err" in box:
        raise box["err"]
    return box["sock"]


def _addrs(entry):
    iface = entry.get("interface") or ""
    proc = utils.run(_ip(entry) + ["-4", "-o", "addr", "show", iface],
                     check=False, timeout=10)
    out = []
    for line in (proc.stdout or "").splitlines():
        parts = line.split()
        if "inet" in parts:
            out.append(parts[parts.index("inet") + 1])
    return out


def apply_one(entry):
    """Put the configured address on one camera interface, idempotently.

    Any other IPv4 address on that interface is removed. That is deliberate
    rather than tidy-minded: a leftover address makes Spinnaker enumerate the
    same camera twice, once per address, and the duplicate reports as
    unreachable. `nicid` then indexes a list containing a camera that cannot be
    opened.
    """
    iface = entry.get("interface")
    want = entry.get("address")
    if not iface or not want:
        raise CameraError(f"camera '{entry.get('name')}' needs an interface "
                          f"and an address")
    if not _iface_exists(entry):
        where = f" in netns {_netns(entry)}" if _netns(entry) else ""
        raise CameraError(f"{iface} does not exist{where}")

    ip = _ip(entry)
    utils.run(ip + ["link", "set", iface, "up"], check=False)

    have = _addrs(entry)
    for addr in have:
        if addr != want:
            logger.info("%s: removing %s — a second address makes Spinnaker "
                        "enumerate the camera twice", iface, addr)
            utils.run(ip + ["addr", "del", addr, "dev", iface], check=False)
    if want not in have:
        proc = utils.run(ip + ["addr", "add", want, "dev", iface], check=False)
        if proc.returncode != 0 and "File exists" not in (proc.stderr or ""):
            raise CameraError(f"{iface}: could not set {want}: "
                              f"{(proc.stderr or '').strip()}")

    live = _addrs(entry)
    if want not in live:
        raise CameraError(f"{iface}: asked for {want}, kernel reports "
                          f"{live or 'no address'}")
    return {"interface": iface, "address": want, "changed": want not in have}


def probe(entry, timeout=1.2):
    """Ask the camera behind this interface who it is.

    Unicast GVCP rather than a broadcast sweep: we already know where it should
    be, and the question is whether the expected one is actually there.
    """
    cam_ip = entry.get("camera_ip")
    src = (entry.get("address") or "").split("/")[0]
    if not cam_ip or not src:
        return {"reachable": False, "reason": "no camera_ip or address configured"}
    try:
        s = _socket(entry)
    except OSError as exc:
        return {"reachable": False,
                "reason": f"cannot enter netns {entry.get('netns')}: {exc}"}
    try:
        s.bind((src, 0))
        s.settimeout(timeout)
        s.sendto(_DISCOVERY, (cam_ip, GVCP_PORT))
        data, _ = s.recvfrom(2048)
    except OSError as exc:
        return {"reachable": False, "reason": str(exc)}
    finally:
        s.close()
    mac = ":".join(f"{b:02x}" for b in data[0x12:0x18]) if len(data) > 0x18 else None
    return {"reachable": True, "mac": mac, "serial": _read_serial(entry, cam_ip, src)}


def _read_serial(entry, cam_ip, src, timeout=1.2):
    """Read the serial out of the camera's bootstrap registers.

    Not from the discovery reply: these Blackfly S cameras answer discovery
    with the vendor, model and serial fields blank, so trusting that reply
    returns None and the serial check then passes vacuously — a guard against
    the cameras being swapped that could never actually fire.

    READMEM against the bootstrap serial-number register answers properly.
    """
    try:
        s = _socket(entry)
    except OSError:
        return None
    try:
        s.bind((src, 0))
        s.settimeout(timeout)
        # READMEM_CMD: address (4 bytes), reserved (2), count (2).
        s.sendto(struct.pack(">BBHHHIHH", 0x42, 0x01, 0x0084, 8, 2, 0x00D8, 0, 16),
                 (cam_ip, GVCP_PORT))
        data, _ = s.recvfrom(1024)
    except OSError:
        return None
    finally:
        s.close()
    if len(data) < 12 or struct.unpack(">H", data[0:2])[0] != 0:
        return None
    # Payload is the echoed address followed by the bytes read.
    return (data[12:28].split(b"\0")[0].decode("ascii", "replace").strip()
            or None)


#: Bootstrap Control Channel Privilege register; GVCP ack status ACCESS_DENIED.
_CCP = 0x0A00
_ACCESS_DENIED = 0x8006


def control_free(entry, timeout=1.2):
    """Whether another application still holds this camera's control channel.

    An encoder that is killed rather than closed never releases control; the
    camera keeps it reserved until the heartbeat times out, and a start made
    before then fails with DeviceAccessStatus [-1005]. Reading CCP does not say
    who holds it, so this asks the definitive question instead: take exclusive
    control and give it straight back. ACCESS_DENIED means still held.

    True when free, False when held, None when the camera did not answer.
    """
    cam_ip = entry.get("camera_ip")
    src = (entry.get("address") or "").split("/")[0]
    try:
        s = _socket(entry)
    except OSError:
        return None
    try:
        s.bind((src, 0))
        s.settimeout(timeout)
        # WRITEREG_CMD: address, value. 0x2 = exclusive access.
        s.sendto(struct.pack(">BBHHHII", 0x42, 0x01, 0x0082, 8, 3, _CCP, 0x2),
                 (cam_ip, GVCP_PORT))
        data, _ = s.recvfrom(1024)
        status = struct.unpack(">H", data[0:2])[0]
        if status == 0:
            s.sendto(struct.pack(">BBHHHII", 0x42, 0x01, 0x0082, 8, 4, _CCP, 0),
                     (cam_ip, GVCP_PORT))
            s.recvfrom(1024)
            return True
        return False if status == _ACCESS_DENIED else None
    except OSError:
        return None
    finally:
        s.close()


def wait_control_free(entry, timeout=30.0, interval=1.0):
    """Block until the camera's control channel is free, or timeout."""
    import time
    deadline = time.monotonic() + timeout
    while True:
        state = control_free(entry)
        if state:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(interval)


def _serial_ok(want_serial, seen):
    """True only when the expected serial was actually read back.

    A serial that could not be read is a failed check, not a passed one —
    otherwise an unreachable camera reports serial_ok and the swap guard is
    vacuous again. None when no serial is configured: nothing to check.
    """
    if not want_serial:
        return None
    return seen.get("serial") == want_serial


def apply(entries):
    """Address every camera interface and confirm the right camera is behind it."""
    results = []
    for entry in entries or []:
        name = entry.get("name") or entry.get("interface")
        try:
            res = apply_one(entry)
        except CameraError as exc:
            logger.error("camera %s: %s", name, exc)
            results.append({"name": name, "ok": False, "error": str(exc)})
            continue
        seen = probe(entry)
        want_serial = str(entry.get("serial") or "")
        serial_ok = _serial_ok(want_serial, seen)
        mismatch = bool(want_serial and seen.get("serial")
                        and seen["serial"] != want_serial)
        if mismatch:
            # Loud, because everything downstream still works — the wrong
            # camera simply ends up in the protected lane.
            logger.error("camera %s on %s: expected serial %s, found %s — the "
                         "cameras may be cabled the other way round, which "
                         "would protect the wrong stream",
                         name, entry.get("interface"), want_serial, seen["serial"])
        results.append({"name": name, **res, **seen,
                        "expected_serial": want_serial or None,
                        "serial_ok": serial_ok,
                        "ok": seen.get("reachable", False)
                              and serial_ok is not False})
        logger.info("camera %s on %s: %s", name, entry.get("interface"),
                    "ready" if results[-1]["ok"] else "NOT ready")
    return results


def describe(entries):
    """Configured cameras against what is actually reachable, for status."""
    rows = []
    for entry in entries or []:
        seen = probe(entry)
        want_serial = str(entry.get("serial") or "")
        rows.append({
            "name": entry.get("name"), "interface": entry.get("interface"),
            "address": entry.get("address"), "camera_ip": entry.get("camera_ip"),
            "stream_port": entry.get("stream_port"),
            "netns": _netns(entry),
            "live_addresses": _addrs(entry),
            "expected_serial": want_serial or None, **seen,
            "serial_ok": _serial_ok(want_serial, seen),
        })
    return {"cameras": rows,
            "all_ready": all(r.get("reachable") and r.get("serial_ok") is not False
                             for r in rows) if rows else False}


def _main(argv=None):
    """`python3 -m tsn5g_ue.net.cameras wait-free CONFIG NAME...` for scripts.

    Exits 0 once every named camera's control channel is free, 1 on timeout.
    """
    import argparse
    import yaml
    ap = argparse.ArgumentParser(prog="tsn5g_ue.net.cameras")
    ap.add_argument("cmd", choices=["wait-free"])
    ap.add_argument("config")
    ap.add_argument("names", nargs="+")
    ap.add_argument("--timeout", type=float, default=30.0)
    args = ap.parse_args(argv)
    with open(args.config) as fh:
        entries = {e.get("name"): e for e in yaml.safe_load(fh).get("cameras", [])}
    rc = 0
    for name in args.names:
        entry = entries.get(name)
        if not entry:
            print(f"{name}: not in {args.config}")
            rc = 1
            continue
        ok = wait_control_free(entry, timeout=args.timeout)
        if ok:
            print(f"{name}: control free")
        else:
            # Two different failures: a camera still booting does not answer
            # at all, a camera reserved by a killed encoder answers "denied".
            last = control_free(entry)
            print(f"{name}: " + ("STILL HELD by another application"
                                 if last is False else "no answer — not up yet, "
                                 "or unreachable"))
        rc = rc or (0 if ok else 1)
    return rc


if __name__ == "__main__":
    raise SystemExit(_main())
