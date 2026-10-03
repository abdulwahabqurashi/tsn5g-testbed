"""
Modem control.

    bus.py       ModemBus — the sole owner of the AT serial port
    qmi.py       QmiClient — qmicli wrapper that can actually stop a session
    parse.py     pure parsers for every AT response shape
    power.py     CFUN, reset, ModemManager masking
    manager.py   the facade the controller talks to

Everything that touches /dev/ttyUSB* goes through ModemBus. That is not a
style preference: at.py, the sixteen reference scripts and iperf5g.sh's radio
sampling all open the port exclusively with no locking, and two owners produce
"device reports readiness to read but returned no data" — which is exactly the
error this rig hit when a connect and a modem check overlapped.
"""

from .manager import ModemError, ModemManager, detect_modem_ports

__all__ = ["ModemError", "ModemManager", "detect_modem_ports"]
