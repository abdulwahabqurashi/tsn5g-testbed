#!/usr/bin/env python3
"""Send AT commands to the modem non-interactively and print the replies.

Usage:  sudo ./at.py 'AT+CFUN?' 'AT+QENG="servingcell"' ...
        sudo ./at.py --diag          # the standard testbed diagnostic set

The AT port moves between boots; pass PORT=/dev/ttyUSBn to override the default.
ModemManager must be stopped or it will fight for the port.
"""
import os, sys, time, glob, serial

PORT = os.environ.get("PORT")
BAUD = int(os.environ.get("BAUD", "115200"))
WAIT = float(os.environ.get("WAIT", "5"))   # seconds to wait for OK/ERROR

DIAG = [
    'AT+CFUN?',                          # 1 = full functionality
    'AT+CPIN?',                          # SIM ready
    'AT+QCFG="usbnet"',                  # 0 = QMI
    'AT+QNWPREFCFG="mode_pref"',         # want NR5G
    'AT+QNWPREFCFG="nr5g_disable_mode"', # want 1 = SA only (NSA disabled)
    'AT+QNWPREFCFG="nr5g_band"',         # must include 78
    'AT+CGDCONT?',                       # cid 1 = "IP","usrptsn"
    'AT+COPS?',                          # current operator
    'AT+C5GREG?',                        # 5G registration state
    'AT+QENG="servingcell"',             # ground truth: am I camped?
    'AT+CSQ',                            # rssi
]

def find_port():
    if PORT:
        return PORT
    for p in sorted(glob.glob("/dev/ttyUSB*")):
        try:
            with serial.Serial(p, BAUD, timeout=0.4) as s:
                s.write(b"AT\r\n"); time.sleep(0.3)
                if b"OK" in s.read(256):
                    return p
        except Exception:
            pass
    sys.exit("no responsive AT port found among /dev/ttyUSB* "
             "(is ModemManager still running?)")

def main():
    cmds = sys.argv[1:]
    if not cmds or cmds[0] == "--diag":
        cmds = DIAG
    port = find_port()
    print(f"# AT port: {port} @ {BAUD}\n")
    with serial.Serial(port, BAUD, timeout=1) as s:
        s.write(b"ATE0\r\n"); time.sleep(0.3); s.reset_input_buffer()
        for c in cmds:
            s.reset_input_buffer()
            s.write(c.encode() + b"\r\n")
            # Read until the modem terminates the response, not on a fixed sleep:
            # a full network scan can take minutes.
            deadline, buf = time.time() + WAIT, ""
            while time.time() < deadline:
                chunk = s.read(4096).decode(errors="replace")
                if chunk:
                    buf += chunk
                    tail = buf.strip().splitlines()[-1].strip() if buf.strip() else ""
                    if tail in ("OK", "ERROR") or tail.startswith("+CME ERROR"):
                        break
                elif buf.strip():
                    break
            body = " | ".join(l.strip() for l in buf.splitlines() if l.strip())
            print(f"{c:38s} -> {body or '(no response within %ss)' % WAIT}")

if __name__ == "__main__":
    main()
