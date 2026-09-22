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
    "cycle-2ms":          {"cycle": 2_000_000,
                           "slots": [(0x80, 300_000), (0x00, 30_000),
                                     (0x10, 600_000), (0xFF, 1_070_000)],
                           "guard": True,
                           "desc": "same window structure, 2 ms cycle"},
    "cycle-3ms":          {"cycle": 3_000_000,
                           "slots": [(0x80, 450_000), (0x00, 30_000),
                                     (0x10, 900_000), (0xFF, 1_620_000)],
                           "guard": True,
                           "desc": "video-heavy; 75% of the switch hardware ceiling"},
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
