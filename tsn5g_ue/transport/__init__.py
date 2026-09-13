"""
Transport abstraction — the VXLAN-vs-Ethernet-PDU toggle.

Both concrete transports expose the same interface (see base.Transport) so the
Controller can switch between them purely from config:

    transport.mode: ethernet -> EthernetTransport (native L2 PDU + kernel bridge)
    transport.mode: vxlan    -> VxlanTransport   (Ethernet-in-VXLAN over IP PDU)
"""

from .. import constants as C
from .base import Transport
from .ethernet import EthernetTransport
from .vxlan import VxlanTransport

__all__ = ["Transport", "EthernetTransport", "VxlanTransport", "make_transport"]


def make_transport(mode, config, modem):
    """Factory: build the concrete transport for the requested mode."""
    if mode == C.TRANSPORT_ETHERNET:
        return EthernetTransport(config, modem)
    if mode == C.TRANSPORT_VXLAN:
        return VxlanTransport(config, modem)
    raise ValueError(f"unknown transport mode: {mode!r}")
