#!/usr/bin/env python3
"""
Read or fix a GigE Vision camera's frame rate, from the UE, without vendor tools.

  sudo python3 tools/camera-framerate.py --iface enp8s0 --show
  sudo ip netns exec cam2 python3 tools/camera-framerate.py --iface enp7s0 --show
  sudo python3 tools/camera-framerate.py --iface enp8s0 --fps 20 --save      (encoder stopped)

Why: with no fixed frame rate, the cameras' rate follows auto-exposure, so it
changes with the light (about 18 fps on 4 Oct, 66 fps on 5 Oct: 4x the
uplink load). A fixed AcquisitionFrameRate makes the testbed's load repeatable.

How: the camera describes its own registers in a GenICam XML file stored in
its memory (bootstrap register 0x0200 says where). This reads that file over
GVCP, finds the features by name, and reads or writes their registers.
--save stores the setting in User Set 1 and makes that the power-up default.
--show only reads, and is safe while the camera streams.
"""

import argparse
import io
import re
import socket
import struct
import sys
import time
import xml.etree.ElementTree as ET
import zipfile

GVCP = 3956
_req = [0]


class Cam:
    def __init__(self, iface, ip):
        self.ip = ip
        self.s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.s.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, iface.encode())
        self.s.bind(("0.0.0.0", 0))
        self.s.settimeout(1.5)

    def _cmd(self, code, payload, tries=3):
        for _ in range(tries):
            _req[0] = (_req[0] % 65000) + 1
            self.s.sendto(struct.pack(">BBHHH", 0x42, 0x01, code, len(payload), _req[0]) + payload,
                          (self.ip, GVCP))
            try:
                data, _ = self.s.recvfrom(2048)
            except socket.timeout:
                continue
            st = struct.unpack(">H", data[:2])[0]
            if st != 0:
                raise RuntimeError(f"camera refused 0x{code:04x}: status 0x{st:04x}")
            return data[8:]
        raise RuntimeError(f"no answer from {self.ip}")

    def readmem(self, addr, n):
        out = b""
        while n > 0:
            c = min(512, n)
            c4 = (c + 3) & ~3
            out += self._cmd(0x0084, struct.pack(">IHH", addr, 0, c4))[4:4 + c]
            addr += c
            n -= c
        return out

    def writemem(self, addr, data):
        self._cmd(0x0086, struct.pack(">I", addr) + data)

    def readreg(self, addr):
        return struct.unpack(">I", self._cmd(0x0080, struct.pack(">I", addr))[:4])[0]

    def writereg(self, addr, v):
        self._cmd(0x0082, struct.pack(">II", addr, v))


def discover(iface):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, iface.encode())
    s.bind(("0.0.0.0", 0))
    s.settimeout(0.3)
    s.sendto(struct.pack(">BBHHH", 0x42, 0x11, 0x0002, 0, 1), ("255.255.255.255", GVCP))
    found, end = {}, time.monotonic() + 1.5
    while time.monotonic() < end:
        try:
            data, peer = s.recvfrom(1024)
        except socket.timeout:
            continue
        if len(data) >= 256:
            serial = data[8 + 216:8 + 232].split(b"\0")[0].decode(errors="replace").strip()
            found[peer[0]] = serial
    return found


# ---------------------------------------------------------------- formulas
# GenICam formula language: C-like operators, with = and <> for equality,
# ** for power, ?: and a few functions. Precedence, lowest first.
_BIN = [("||",), ("&&",), ("|",), ("^",), ("&",), ("=", "<>"), ("<", ">", "<=", ">="),
        ("<<", ">>"), ("+", "-"), ("*", "/", "%"), ("**",)]
_FUNCS = {"SGN": lambda x: (x > 0) - (x < 0), "NEG": lambda x: -x, "ABS": abs,
          "SQRT": lambda x: x ** 0.5, "TRUNC": lambda x: float(int(x)),
          "FLOOR": lambda x: float(int(x // 1)), "CEIL": lambda x: float(-int(-x // 1)),
          "ROUND": lambda x, p=0: round(x, int(p)), "EXP": lambda x: 2.718281828459045 ** x}
_TOK = re.compile(r"\s*(0x[0-9a-fA-F]+|\d+\.\d*(?:[eE][-+]?\d+)?|\d+(?:[eE][-+]?\d+)?|"
                  r"[A-Za-z_][A-Za-z0-9_.]*|\*\*|<<|>>|<=|>=|<>|&&|\|\||[-+*/%&|^~!?:(),=<>])")


def formula(expr, env, as_float=True):
    """Evaluate a GenICam formula. Converter/SwissKnife compute in floating
    point; IntConverter/IntSwissKnife in integers (as_float=False)."""
    if as_float:
        env = {k: float(v) for k, v in env.items()}
    toks = _TOK.findall(expr)
    pos = [0]

    def peek():
        return toks[pos[0]] if pos[0] < len(toks) else None

    def take():
        pos[0] += 1
        return toks[pos[0] - 1]

    def primary():
        t = take()
        if t == "(":
            v = ternary()
            take()
            return v
        if t in ("-", "~", "!"):
            v = unary_power()
            return -v if t == "-" else (~int(v) if t == "~" else float(not v))
        if t in _FUNCS and peek() == "(":
            take()
            args = [ternary()]
            while peek() == ",":
                take()
                args.append(ternary())
            take()
            return _FUNCS[t](*args)
        if t == "PI":
            return 3.141592653589793
        if re.match(r"0x", t):
            return int(t, 16)
        if re.match(r"\d", t):
            return float(t) if (as_float or any(c in t for c in ".eE")) else int(t)
        if t not in env:
            raise RuntimeError(f"formula uses unknown variable {t}")
        return env[t]

    def unary_power():
        v = primary()
        if peek() == "**":
            take()
            v = v ** unary_power()
        return v

    def binary(level):
        if level == len(_BIN):
            return unary_power()
        v = binary(level + 1)
        while peek() in _BIN[level]:
            op = take()
            r = binary(level + 1)
            v = {"||": lambda a, b: float(bool(a) or bool(b)), "&&": lambda a, b: float(bool(a) and bool(b)),
                 "|": lambda a, b: int(a) | int(b), "^": lambda a, b: int(a) ^ int(b),
                 "&": lambda a, b: int(a) & int(b), "=": lambda a, b: float(a == b),
                 "<>": lambda a, b: float(a != b), "<": lambda a, b: float(a < b),
                 ">": lambda a, b: float(a > b), "<=": lambda a, b: float(a <= b),
                 ">=": lambda a, b: float(a >= b), "<<": lambda a, b: int(a) << int(b),
                 ">>": lambda a, b: int(a) >> int(b), "+": lambda a, b: a + b,
                 "-": lambda a, b: a - b, "*": lambda a, b: a * b,
                 "/": lambda a, b: a / b if isinstance(a, float) or isinstance(b, float) else (a // b if b else 0),
                 "%": lambda a, b: a % b}[op](v, r)
        return v

    def ternary():
        c = binary(0)
        if peek() == "?":
            take()
            a = ternary()
            take()                                  # ':'
            b = ternary()
            return a if c else b
        return c

    return ternary()


# ---------------------------------------------------------------- GenICam XML
def fetch_xml(cam):
    url = cam.readmem(0x0200, 512).split(b"\0")[0].decode(errors="replace")
    m = re.match(r"(?i)local:(?:///)?([^;]+);([0-9a-f]+);([0-9a-f]+)", url)
    if not m:
        raise RuntimeError(f"unsupported XML location: {url!r}")
    name, addr, length = m.group(1), int(m.group(2), 16), int(m.group(3), 16)
    blob = cam.readmem(addr, length)
    if name.lower().endswith(".zip"):
        z = zipfile.ZipFile(io.BytesIO(blob))
        blob = z.read([n for n in z.namelist() if n.lower().endswith(".xml")][0])
    return name, blob


class GenICam:
    def __init__(self, cam, xml):
        self.cam = cam
        root = ET.fromstring(xml)
        for el in root.iter():                      # drop namespaces
            if "}" in el.tag:
                el.tag = el.tag.split("}", 1)[1]
        # Feature nodes are the root's children (plus StructEntry inside a StructReg).
        # EnumEntry and pVariable also carry Name attributes and must not
        # shadow a feature of the same name.
        self.nodes = {}
        for el in list(root):
            if el.get("Name"):
                self.nodes[el.get("Name")] = el
            if el.tag == "StructReg":
                for se in el.findall("StructEntry"):
                    self.nodes[se.get("Name")] = se
        self.parent = {c: p for p in root.iter() for c in p}

    def _t(self, el, tag):
        x = el.find(tag)
        return x.text.strip() if x is not None and x.text else None

    def _addr(self, el):
        a = sum(int(x.text.strip(), 0) for x in el.findall("Address"))
        for p in el.findall("pAddress"):
            a += int(self.get(p.text.strip()))
        return a

    def _reg(self, el):
        """(address, length, little-endian?) of a register-like node."""
        if el.tag == "StructEntry":
            el = self.parent[el]
        length = int(self._t(el, "Length") or "4", 0)
        little = (self._t(el, "Endianess") or "BigEndian") == "LittleEndian"
        return self._addr(el), length, little

    def _raw(self, el):
        addr, length, little = self._reg(el)
        b = self.cam.readmem(addr, length)
        return int.from_bytes(b, "little" if little else "big"), (addr, length, little)

    def kind(self, name):
        return self.nodes[name].tag

    def _vars(self, el, depth):
        env = {}
        for v in el.findall("pVariable"):
            env[v.get("Name")] = self.get(v.text.strip(), depth + 1)
        for c in el.findall("Constant"):
            env[c.get("Name")] = float(c.text) if "." in c.text else int(c.text, 0)
        return env

    def get(self, name, depth=0):
        el = self.nodes[name]
        if depth > 24:
            raise RuntimeError(f"{name}: node chain too deep")
        if el.tag in ("Converter", "IntConverter"):
            env = self._vars(el, depth)
            env["TO"] = self.get(self._t(el, "pValue"), depth + 1)
            return formula(self._t(el, "FormulaFrom"), env, as_float=el.tag == "Converter")
        if el.tag in ("SwissKnife", "IntSwissKnife"):
            return formula(self._t(el, "Formula"), self._vars(el, depth), as_float=el.tag == "SwissKnife")
        pv = self._t(el, "pValue")
        if el.tag in ("Integer", "Float", "Boolean", "Enumeration", "Command") and pv:
            v = self.get(pv, depth + 1)
            if el.tag == "Boolean":
                return v == int(self._t(el, "OnValue") or "1", 0)
            return v
        if el.tag in ("Integer", "Float") and self._t(el, "Value") is not None:
            return float(self._t(el, "Value")) if el.tag == "Float" else int(self._t(el, "Value"), 0)
        if el.tag in ("IntReg", "MaskedIntReg", "StructEntry"):
            v, _ = self._raw(el)
            lsb, msb, bit = self._t(el, "LSB"), self._t(el, "MSB"), self._t(el, "Bit")
            if bit is not None:
                return (v >> int(bit)) & 1
            if lsb is not None and msb is not None:
                lo, hi = sorted((int(lsb), int(msb)))
                return (v >> lo) & ((1 << (hi - lo + 1)) - 1)
            return v
        if el.tag == "FloatReg":
            addr, length, little = self._reg(el)
            b = self.cam.readmem(addr, length)
            return struct.unpack(("<" if little else ">") + ("f" if length == 4 else "d"), b)[0]
        raise RuntimeError(f"{name}: cannot read a {el.tag}")

    def set(self, name, value, depth=0):
        el = self.nodes[name]
        pv = self._t(el, "pValue")
        if el.tag in ("Converter", "IntConverter"):
            env = self._vars(el, depth)
            env["FROM"] = value
            raw = formula(self._t(el, "FormulaTo"), env, as_float=el.tag == "Converter")
            target = self.nodes[pv]
            if target.tag in ("IntReg", "MaskedIntReg", "StructEntry", "Integer", "IntConverter", "IntSwissKnife"):
                raw = int(round(raw))
            return self.set(pv, raw, depth + 1)
        if el.tag == "Boolean" and pv:
            on, off = int(self._t(el, "OnValue") or "1", 0), int(self._t(el, "OffValue") or "0", 0)
            return self.set(pv, on if value else off, depth + 1)
        if el.tag == "Enumeration" and pv:
            if isinstance(value, str):
                ent = [e for e in el.findall("EnumEntry") if e.get("Name") == value]
                if not ent:
                    raise RuntimeError(f"{name} has no entry {value}")
                value = int(self._t(ent[0], "Value"), 0)
            return self.set(pv, value, depth + 1)
        if el.tag == "Command" and pv:
            return self.set(pv, int(self._t(el, "CommandValue") or "1", 0), depth + 1)
        if el.tag in ("Integer", "Float") and pv:
            return self.set(pv, value, depth + 1)
        if el.tag == "FloatReg":
            addr, length, little = self._reg(el)
            self.cam.writemem(addr, struct.pack(("<" if little else ">") + ("f" if length == 4 else "d"), float(value)))
            return
        if el.tag in ("IntReg", "MaskedIntReg", "StructEntry"):
            cur, (addr, length, little) = self._raw(el)
            lsb, msb, bit = self._t(el, "LSB"), self._t(el, "MSB"), self._t(el, "Bit")
            if bit is not None:
                lo = hi = int(bit)
            elif lsb is not None and msb is not None:
                lo, hi = sorted((int(lsb), int(msb)))
            else:
                lo, hi = 0, length * 8 - 1
            mask = ((1 << (hi - lo + 1)) - 1) << lo
            new = (cur & ~mask) | ((int(value) << lo) & mask)
            self.cam.writemem(addr, new.to_bytes(length, "little" if little else "big"))
            return
        raise RuntimeError(f"{name}: cannot write a {el.tag}")

    def enum_name(self, name, v):
        for e in self.nodes[name].findall("EnumEntry"):
            if int(self._t(e, "Value") or "-1", 0) == v:
                return e.get("Name")
        return str(v)


FEATURES = ["AcquisitionFrameRateEnable", "AcquisitionFrameRate", "AcquisitionResultingFrameRate",
            "ExposureAuto", "ExposureTime", "Width", "Height", "PixelFormat"]


def show(g):
    for f in FEATURES:
        if f not in g.nodes:
            continue
        try:
            v = g.get(f)
            if g.kind(f) == "Enumeration":
                v = g.enum_name(f, v)
            print(f"  {f:<32}{v:.2f}" if isinstance(v, float) else f"  {f:<32}{v}")
        except Exception as exc:                  # noqa: BLE001
            print(f"  {f:<32}(unreadable: {exc})")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--iface", required=True)
    ap.add_argument("--serial", help="only this camera (when the NIC has several)")
    ap.add_argument("--show", action="store_true", help="read only")
    ap.add_argument("--fps", type=float, help="fix the frame rate to this value")
    ap.add_argument("--save", action="store_true", help="store in User Set 1 and load it at power-up")
    a = ap.parse_args()

    cams = discover(a.iface)
    if a.serial:
        cams = {ip: s for ip, s in cams.items() if s == a.serial}
    if len(cams) != 1:
        print(f"need exactly one camera on {a.iface}; found {cams or 'none'} (use --serial)")
        return 1
    ip, serial = next(iter(cams.items()))
    cam = Cam(a.iface, ip)
    fname, xml = fetch_xml(cam)
    g = GenICam(cam, xml)
    print(f"camera {serial} at {ip} ({fname}, {len(g.nodes)} nodes)")
    show(g)
    if a.show or a.fps is None:
        return 0

    # Writing needs exclusive control (fails while an encoder holds the camera).
    cam.writereg(0x0A00, 0x2)
    try:
        if "ExposureAuto" in g.nodes:
            pass                                     # left as is: exposure still adapts within the frame time
        g.set("AcquisitionFrameRateEnable", True)
        g.set("AcquisitionFrameRate", a.fps)
        if a.save:
            for n in ("UserSetSelector", "UserSetSave", "UserSetDefault"):
                if n not in g.nodes:
                    raise RuntimeError(f"camera has no {n}: cannot save")
            g.set("UserSetSelector", "UserSet1")
            g.set("UserSetSave", 1)
            time.sleep(1.0)
            default = "UserSetDefault" if g.kind("UserSetDefault") == "Enumeration" else None
            if default:
                g.set("UserSetDefault", "UserSet1")
    finally:
        try:
            cam.writereg(0x0A00, 0x0)
        except Exception:                            # noqa: BLE001
            pass
    print(f"\nset {a.fps} fps{' and saved as the power-up default (User Set 1)' if a.save else ' (until power-up)'}:")
    show(g)
    return 0


if __name__ == "__main__":
    sys.exit(main())
