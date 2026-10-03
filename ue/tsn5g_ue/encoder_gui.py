"""
Press the encoders' Start button for the operator.

pathStream1 has no auto-start: streaming begins only when its Qt "Start"
button is clicked (Widget::cameraStart, a slot with no config key, no command
line flag and no source to change). The encoders run on the virtual screen
:99, which this host owns, so the daemon can click the button exactly as a
person would, through the X server's XTEST extension (the same one x11vnc
uses). No VNC session and no extra software needed.

The button is located from the window's own geometry rather than hard-coded
screen coordinates: in a 950x1040 window it sits ~78% across, 24 px above the
bottom edge, and the windows are placed with -geometry by cameras-start.sh.
Whether it worked is judged by the caller from the stream counters, not by
this module.
"""

import ctypes
import os
import logging
import re
import time

from . import utils

logger = logging.getLogger("tsn5g-ue.encoder_gui")

DISPLAY = os.environ.get("TSN5G_DISPLAY", ":99")   # set by rig.press_start from site.env
WINDOW_TITLE = "pathStream1"
START_X_FRAC = 0.785          # Start button centre, fraction of window width
START_Y_FROM_BOTTOM = 24      # px above the window's bottom edge


class GuiError(RuntimeError):
    pass


def encoder_windows(display=DISPLAY):
    """Top-level pathStream1 windows as [(x, y, w, h)] in screen coordinates."""
    proc = utils.run(["xwininfo", "-display", display, "-root", "-tree"], check=False, timeout=10)
    wins = []
    rx = re.compile(r'"%s": \("%s" "%s"\)\s+(\d+)x(\d+)\+-?\d+\+-?\d+\s+\+(-?\d+)\+(-?\d+)'
                    % ((WINDOW_TITLE,) * 3))
    for line in (proc.stdout or "").splitlines():
        m = rx.search(line)
        if m:
            w, h, x, y = map(int, m.groups())
            if w > 200 and h > 200:
                wins.append((x, y, w, h))
    return sorted(wins)


def _click(display, x, y):
    x11 = ctypes.CDLL("libX11.so.6")
    xtst = ctypes.CDLL("libXtst.so.6")
    x11.XOpenDisplay.restype = ctypes.c_void_p
    dpy = x11.XOpenDisplay(display.encode())
    if not dpy:
        raise GuiError(f"cannot open X display {display}")
    try:
        dpy_p = ctypes.c_void_p(dpy)
        xtst.XTestFakeMotionEvent(dpy_p, -1, int(x), int(y), 0)
        x11.XFlush(dpy_p)
        time.sleep(0.15)
        xtst.XTestFakeButtonEvent(dpy_p, 1, 1, 0)
        x11.XFlush(dpy_p)
        time.sleep(0.08)
        xtst.XTestFakeButtonEvent(dpy_p, 1, 0, 0)
        x11.XFlush(dpy_p)
    finally:
        x11.XCloseDisplay(ctypes.c_void_p(dpy))


def press_start(display=DISPLAY, expect=2, wait_s=40, log=None):
    """Wait for the encoder windows to appear, then click Start in each."""
    say = log or (lambda m: logger.info(m))
    deadline = time.monotonic() + wait_s
    wins = encoder_windows(display)
    while len(wins) < expect and time.monotonic() < deadline:
        time.sleep(1)
        wins = encoder_windows(display)
    if not wins:
        raise GuiError(f"no {WINDOW_TITLE} window on {display}")
    if len(wins) < expect:
        say(f"only {len(wins)} of {expect} encoder windows appeared; pressing Start in those")
    time.sleep(2)      # let each window finish opening its camera
    for (x, y, w, h) in wins:
        bx, by = x + int(w * START_X_FRAC), y + h - START_Y_FROM_BOTTOM
        _click(display, bx, by)
        say(f"pressed Start in the encoder window at {x},{y} (click {bx},{by})")
        time.sleep(0.5)
    return len(wins)


if __name__ == "__main__":
    # `python3 -m tsn5g_ue.encoder_gui [expected_windows]` — the daemon runs
    # this as the screen's owner (runuser -u amrc), since :99 belongs to amrc.
    import sys
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        n = press_start(expect=int(sys.argv[1]) if len(sys.argv) > 1 else 2,
                        log=lambda m: print(m, flush=True))
    except GuiError as exc:
        print(f"error: {exc}", flush=True)
        raise SystemExit(1)
    raise SystemExit(0 if n else 1)
