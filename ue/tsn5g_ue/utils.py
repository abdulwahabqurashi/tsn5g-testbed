"""
Small shared helpers: subprocess wrappers and platform guards.

The daemon shells out to iproute2 / linuxptp / qmicli in a few places where a
pure-Python (pyroute2) path is not yet wired up. Everything goes through
``run()`` so it is logged uniformly and easy to stub in tests.
"""

import logging
import platform
import shutil
import subprocess

logger = logging.getLogger("tsn5g-ue.utils")


class CommandError(RuntimeError):
    """Raised when a shelled-out command exits non-zero."""

    def __init__(self, cmd, returncode, stdout, stderr):
        self.cmd = cmd
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        super().__init__(
            f"command failed ({returncode}): {' '.join(cmd)}\n{stderr.strip()}"
        )


def is_linux():
    """The data-plane actions only work on Linux; used to guard dev on other OSes."""
    return platform.system() == "Linux"


def have(binary):
    """True if an executable is on PATH."""
    return shutil.which(binary) is not None


def run(cmd, check=True, timeout=30, input_text=None):
    """
    Run a command and return CompletedProcess. Logs the invocation.

    Args:
        cmd: list[str] argv.
        check: raise CommandError on non-zero exit.
        timeout: seconds.
        input_text: optional stdin text.
    """
    logger.debug("run: %s", " ".join(cmd))
    proc = subprocess.run(
        cmd,
        input=input_text,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if check and proc.returncode != 0:
        raise CommandError(cmd, proc.returncode, proc.stdout, proc.stderr)
    return proc


def ip(*args, check=True):
    """Shorthand for `ip ...` (iproute2)."""
    return run(["ip", *args], check=check)


def bridge(*args, check=True):
    """Shorthand for `bridge ...` (iproute2 bridge tool)."""
    return run(["bridge", *args], check=check)


def tc(*args, check=True):
    """Shorthand for `tc ...` (traffic control)."""
    return run(["tc", *args], check=check)


def iface_exists(name):
    """True if a network interface exists (sysfs)."""
    import os
    return bool(name) and os.path.exists(f"/sys/class/net/{name}")


def read_sysfs(path, default=None):
    """Read a trimmed sysfs value, or default on error."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return default
