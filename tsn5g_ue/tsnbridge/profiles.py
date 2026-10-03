"""
Gate schedules, and the translation between two different ways of saying
"which queues may transmit now".

The FS TSN3220 expresses a gate state as eight bits, one per hardware queue:
0x80 is queue 7 alone, 0x10 is queue 4, 0xFF is everything open. `taprio`
expresses it as one bit per *traffic class*, and a traffic class is whatever
the `map` says it is — with two classes the same three states become 0x02,
0x01 and 0x03.

The slot layouts and names are deliberately identical to
docs/reference/configure_qbv.sh, including the shared TAI anchor, so a result
measured on the switch and a result measured here are talking about the same
schedule. Do not renumber them for convenience.
"""

import logging

from .. import constants as C

logger = logging.getLogger("tsn5g-ue.tsnbridge.profiles")

# Every profile starts its cycle from this instant, so two nodes that have
# never spoken still open their gates together. Changing it for one node and
# not the other puts them permanently out of phase.
BASE_SEC = C.QBV_COMMON_BASE_SEC
BASE_NS = C.QBV_COMMON_BASE_NS

# Switch queue bit -> the stream that rides it, from the reference script.
Q_CONTROL = 7      # 0x80
Q_HP_VIDEO = 4     # 0x10
Q_BE_VIDEO = 0     # 0x01

#: (gate_mask, interval_ns) as the switch expresses them, cycle in ns.
PROFILES = {
    "all-open":           {"cycle": 1_000_000, "slots": [(0xFF, 1_000_000)],
                           "guard": False,
                           "desc": "baseline — no temporal isolation"},
    "iso-motion-250us":   {"cycle":   250_000,
                           "slots": [(0x80, 50_000), (0x00, 20_000),
                                     (0x10, 80_000), (0xFF, 100_000)],
                           "guard": True,
                           "desc": "PROFINET IRT-style isochronous motion"},
    "short-500us":        {"cycle":   500_000,
                           "slots": [(0x80, 100_000), (0x00, 30_000),
                                     (0x10, 150_000), (0xFF, 220_000)],
                           "guard": True,
                           "desc": "aligned to the 5G NR 30 kHz slot boundary"},
    "urllc-5qi82":        {"cycle": 1_000_000,
                           "slots": [(0x80, 150_000), (0x00, 30_000),
                                     (0x10, 320_000), (0xFF, 500_000)],
                           "guard": True,
                           "desc": "5G-ACIA 5QI-82 Discrete Automation profile"},
    "default-3slot":      {"cycle": 1_000_000,
                           "slots": [(0x80, 200_000), (0x10, 300_000),
                                     (0xFF, 500_000)],
                           "guard": False,
                           "desc": "200us control, 300us HP, 500us everything"},
    "ctrl-priority":      {"cycle": 1_000_000,
                           "slots": [(0x80, 500_000), (0x7F, 500_000)],
                           "guard": True,
                           "desc": "50/50 — control alone, then everything else"},
    "ctrl-starvation":    {"cycle": 1_000_000,
                           "slots": [(0x80, 900_000), (0x7F, 100_000)],
                           "guard": True,
                           "desc": "stress: 900us control, 100us the rest"},
    # The only profile here sized for a *bearer* rather than for the switch.
    # Every other one was written against a 1 Gbit/s switch port, where a
    # 1400-byte frame serialises in 11 us and a 150 us window holds thirteen of
    # them. On this uplink — measured median 53 Mbit/s — the same frame takes
    # 211 us, so those windows cannot pass one. See feasibility().
    "bearer-2ms":         {"cycle": 2_000_000,
                           "slots": [(0x80, 700_000), (0x00, 250_000),
                                     (0xFF, 1_050_000)],
                           "guard": True,
                           "desc": "sized for the 5G uplink: 700us priority, "
                                   "250us guard, 1050us shared"},
    "cycle-2ms":          {"cycle": 2_000_000,
                           "slots": [(0x80, 300_000), (0x00, 30_000),
                                     (0x10, 600_000), (0xFF, 1_070_000)],
                           "guard": True,
                           "desc": "same window structure, 2 ms cycle"},
    "cycle-3ms":          {"cycle": 3_000_000,
                           "slots": [(0x80, 450_000), (0x00, 30_000),
                                     (0x10, 900_000), (0xFF, 1_620_000)],
                           "guard": True,
                           "desc": "video-heavy; 71.5% of the switch hardware ceiling"},

    # -- Video profiles, sized for the bearer -------------------------------
    #
    # Every profile above this line was written against a 1 Gbit/s switch port,
    # where a 1400-byte frame serialises in 11 us and a 150 us window holds
    # thirteen of them. There is no switch in this testbed any more: the
    # bottleneck is the uplink, where the same frame takes 211 us at the
    # measured median of 53 Mbit/s and 386 us at the measured floor of 29. The
    # windows did not change; the link under them did, and it made the three
    # shortest profiles unable to pass a single packet in their CONTROL window.
    #
    # Two things are fixed across all six, and both are consequences of the
    # bearer rather than preferences:
    #
    #   The guard is 400 us, not 30. A guard exists to absorb a frame that was
    #   already in flight when the gate shut, so it has to be at least one
    #   frame long — and taprio here is software-mode with no `flags`, so it is
    #   not length-aware and *will* start a frame it cannot finish. 400 us
    #   holds one full frame even at the 29 Mbit/s floor, which is when the
    #   guard actually matters. Sizing it for the median instead would make it
    #   a guard only while the radio is behaving.
    #
    #   The guard is an absolute, so it is a different fraction of every cycle
    #   (20% of 2 ms, 5% of 8 ms). That is not an inconsistency to tidy up: one
    #   packet is one packet regardless of how long the cycle around it is.
    #
    # The protected window carries CONTROL and HP_VIDEO together (0x90). On the
    # two-class UE bridge both fold to tc1, so a separate HP window would be a
    # distinction the gate cannot express — see switch_mask_to_tc().

    # Cycle sweep: protected share held at 39%, cycle the only variable. 39%
    # because it is the smallest share that still holds two frames at the
    # 29 Mbit/s floor in the tightest cycle (2 ms), and it covers a 20 Mbit/s
    # protected stream on a 53 Mbit/s link with headroom.
    "video-2ms":          {"cycle": 2_000_000,
                           "slots": [(0x90, 780_000), (0x00, 400_000),
                                     (0xFF, 820_000)],
                           "guard": True,
                           "desc": "video, 2 ms cycle — 39% protected; the "
                                   "shortest cycle this bearer can serialise"},
    "video-4ms":          {"cycle": 4_000_000,
                           "slots": [(0x90, 1_560_000), (0x00, 400_000),
                                     (0xFF, 2_040_000)],
                           "guard": True,
                           "desc": "video, 4 ms cycle — 39% protected"},
    "video-8ms":          {"cycle": 8_000_000,
                           "slots": [(0x90, 3_120_000), (0x00, 400_000),
                                     (0xFF, 4_480_000)],
                           "guard": True,
                           "desc": "video, 8 ms cycle — 39% protected"},

    # Share sweep: cycle held at 4 ms, the protected share the only variable.
    # This is the axis a video use case actually poses — how much of the uplink
    # Camera 1 reserves. At 20 Mbit/s on a 53 Mbit/s link the stream needs
    # ~38%, so p25 should starve it, p40 should just carry it and p55 should
    # have headroom. A sweep whose middle point is the predicted boundary.
    "video-4ms-p25":      {"cycle": 4_000_000,
                           "slots": [(0x90, 1_000_000), (0x00, 400_000),
                                     (0xFF, 2_600_000)],
                           "guard": True,
                           "desc": "video, 4 ms cycle — 25% protected "
                                   "(below a 20 Mbit/s stream's share)"},
    "video-4ms-p40":      {"cycle": 4_000_000,
                           "slots": [(0x90, 1_600_000), (0x00, 400_000),
                                     (0xFF, 2_000_000)],
                           "guard": True,
                           "desc": "video, 4 ms cycle — 40% protected "
                                   "(just above a 20 Mbit/s stream's share)"},
    "video-4ms-p55":      {"cycle": 4_000_000,
                           "slots": [(0x90, 2_200_000), (0x00, 400_000),
                                     (0xFF, 1_400_000)],
                           "guard": True,
                           "desc": "video, 4 ms cycle — 55% protected "
                                   "(headroom above a 20 Mbit/s stream)"},
}


class ProfileError(ValueError):
    pass


def names():
    return sorted(PROFILES)


def get(name):
    try:
        return PROFILES[name]
    except KeyError:
        raise ProfileError(
            f"unknown profile '{name}'. Known: {', '.join(names())}") from None


def switch_mask_to_tc(mask, queue_for_tc):
    """Re-express an 8-bit queue mask as a traffic-class mask.

    `queue_for_tc` maps traffic class index -> the switch queue it stands in
    for, so a two-class bridge passes [Q_BE_VIDEO, Q_CONTROL] and the switch's
    0x80 (queue 7 open) becomes 0x02 (tc 1 open).

    A profile that opens a queue no traffic class represents simply contributes
    nothing to that window, which is the honest answer: with two classes there
    is no HP_VIDEO, so its window belongs to whoever the profile says shares it.
    """
    out = 0
    for tc, queue in enumerate(queue_for_tc):
        if mask & (1 << queue):
            out |= (1 << tc)
    return out


#: What to do with a window that belonged to a class this bridge does not have.
#: Three classes became two, so every profile with an HP_VIDEO window has time
#: that now belongs to nobody. Leaving it shut is honest but throws away a third
#: of the cycle in urllc-5qi82; the alternatives say who inherits it. There is no
#: right answer, only a stated one — it changes what the profile means, so it is
#: a parameter rather than a default buried in the code.
FOLD_CLOSED = "closed"      # leave the window shut
FOLD_SHARED = "shared"      # everyone gets it
FOLD_PRIORITY = "priority"  # the highest class gets it

FOLD_CHOICES = (FOLD_CLOSED, FOLD_SHARED, FOLD_PRIORITY)


def to_taprio(name, queue_for_tc, fold=FOLD_SHARED):
    """Gate entries for `taprio`, given which switch queue each class stands for.

    Returns (cycle_ns, [(tc_mask, interval_ns), ...]).

    Intervals are untouched — the switch's 262136 ns per-node ceiling is a
    property of that hardware and does not apply here, so a window the script
    had to split across several control-list entries stays a single entry. The
    schedule is the same; only its expression differs.

    `fold` decides what happens to a window whose switch mask was open but whose
    traffic-class mask comes out empty, which happens whenever the bridge has
    fewer classes than the profile was written for. A window that was *already*
    shut on the switch is a deliberate guard band and is never folded.
    """
    if fold not in FOLD_CHOICES:
        raise ProfileError(
            f"unknown fold '{fold}'. Choose one of: {', '.join(FOLD_CHOICES)}")

    p = get(name)
    all_open = (1 << len(queue_for_tc)) - 1
    top = 1 << (len(queue_for_tc) - 1)

    entries = []
    orphaned_ns = 0
    for mask, interval in p["slots"]:
        tc_mask = switch_mask_to_tc(mask, queue_for_tc)
        if tc_mask == 0 and mask != 0:
            # A window for a class we do not have.
            orphaned_ns += interval
            if fold == FOLD_SHARED:
                tc_mask = all_open
            elif fold == FOLD_PRIORITY:
                tc_mask = top
            # FOLD_CLOSED leaves it at 0
        entries.append((tc_mask, interval))

    total = sum(i for _, i in entries)
    if total != p["cycle"]:
        raise ProfileError(
            f"profile '{name}' slots total {total} ns but the cycle is "
            f"{p['cycle']} ns — the schedule would drift")

    # Merge neighbours that now have the same mask, so a folded window does not
    # appear as two entries the hardware would treat as a gate change.
    merged = []
    for mask, interval in entries:
        if interval <= 0:
            continue
        if merged and merged[-1][0] == mask:
            merged[-1] = (mask, merged[-1][1] + interval)
        else:
            merged.append((mask, interval))

    if not any(m for m, _ in merged):
        raise ProfileError(
            f"profile '{name}' leaves every gate shut for the whole cycle with "
            f"this class mapping; nothing would ever transmit")
    return p["cycle"], merged, orphaned_ns


def describe(name, queue_for_tc, fold=FOLD_SHARED):
    """Profile plus its resolved gate list, for the UI and for dry runs."""
    p = get(name)
    cycle, entries, orphaned = to_taprio(name, queue_for_tc, fold=fold)
    return {
        "name": name,
        "description": p["desc"],
        "cycle_ns": cycle,
        "guard": p["guard"],
        "fold": fold,
        "orphaned_ns": orphaned,
        "switch_slots": [{"mask": m, "interval_ns": i} for m, i in p["slots"]],
        "taprio_entries": [{"gate_mask": m, "interval_ns": i} for m, i in entries],
        "base_sec": BASE_SEC,
        "base_ns": BASE_NS,
    }


#: Bytes of framing below IP on the bearer. wwan0 is raw-IP point-to-point, so
#: what goes on the air is the IP packet and nothing else — no Ethernet header
#: to account for.
BEARER_FRAMING_BYTES = 0


def serialisation_us(mtu, uplink_mbps):
    """Microseconds to push one MTU-sized packet onto a link of this rate.

    The number every gate window has to be compared against. A window shorter
    than this cannot pass a full packet, which makes the schedule a decoration:
    the gate opens, nothing fits, the gate closes.
    """
    if uplink_mbps <= 0:
        raise ProfileError("uplink rate must be positive")
    bits = (int(mtu) + BEARER_FRAMING_BYTES) * 8
    return bits / (float(uplink_mbps) * 1e6) * 1e6


def feasibility(name, uplink_mbps, mtu=1400, queue_for_tc=None,
                fold=FOLD_SHARED):
    """Can this profile actually pass traffic at this link rate?

    The failure this exists to prevent is silent. A window too short to hold a
    packet does not error — the gate opens and shuts on schedule, the class
    starves, and the result reads as "the gate did not help" rather than "the
    gate was never given time to". That is an expensive thing to discover after
    a measurement run.

    A window is judged on what it can carry:
      under 1 packet   infeasible, the class cannot transmit in it at all
      under 2 packets  marginal, one packet plus a partial is all it holds
      otherwise        fine

    Guard bands are exempt from the first two: their whole purpose is to be
    shut. They are reported separately because a guard shorter than one packet
    does not actually guard — a transmission started just before it overruns
    into the next window.
    """
    queue_for_tc = queue_for_tc or [Q_BE_VIDEO, Q_CONTROL]
    cycle_ns, entries, _ = to_taprio(name, queue_for_tc, fold=fold)
    ser_us = serialisation_us(mtu, uplink_mbps)

    rows, worst = [], "ok"
    for mask, interval_ns in entries:
        us = interval_ns / 1000.0
        packets = us / ser_us
        if mask == 0:
            verdict = "guard" if packets >= 1 else "guard-short"
        elif packets < 1:
            verdict = "infeasible"
        elif packets < 2:
            verdict = "marginal"
        else:
            verdict = "ok"
        if verdict == "infeasible":
            worst = "infeasible"
        elif verdict in ("marginal", "guard-short") and worst == "ok":
            worst = "marginal"
        rows.append({"gate_mask": mask, "interval_us": round(us, 1),
                     "packets": round(packets, 2), "verdict": verdict})

    return {
        "profile": name,
        "uplink_mbps": float(uplink_mbps),
        "mtu": int(mtu),
        "packet_us": round(ser_us, 1),
        "cycle_us": cycle_ns / 1000.0,
        "verdict": worst,
        "windows": rows,
        "reason": _feasibility_reason(worst, name, ser_us, rows),
    }


def _feasibility_reason(worst, name, ser_us, rows):
    if worst == "ok":
        return (f"every open window holds at least two {ser_us:.0f} us "
                f"packets")
    bad = [r for r in rows if r["verdict"] in ("infeasible", "marginal",
                                               "guard-short")]
    shortest = min(bad, key=lambda r: r["interval_us"])
    if worst == "infeasible":
        return (f"profile '{name}' has a {shortest['interval_us']:.0f} us "
                f"window but one packet takes {ser_us:.0f} us at this link "
                f"rate, so that class cannot transmit in it at all")
    return (f"profile '{name}' has a {shortest['interval_us']:.0f} us window "
            f"against a {ser_us:.0f} us packet — it holds "
            f"{shortest['packets']:.1f}, so the schedule is coarse")
