"""
Entry point: ``python -m tsn5g_ue -c /etc/tsn5g-ue/tsn5g-ue.yaml``.
"""

import argparse
import sys

from . import __app_name__, __version__
from .daemon import Daemon


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="tsn5g-ue",
        description=f"{__app_name__} v{__version__}",
    )
    parser.add_argument(
        "-c", "--config",
        default="/etc/tsn5g-ue/tsn5g-ue.yaml",
        help="path to the YAML config file",
    )
    parser.add_argument(
        "-l", "--log-level",
        default=None,
        choices=["debug", "info", "warning", "error"],
        help="override log level from config",
    )
    parser.add_argument(
        "--version", action="version",
        version=f"{__app_name__} {__version__}",
    )
    args = parser.parse_args(argv)

    daemon = Daemon(config_path=args.config, log_level_override=args.log_level)
    return daemon.run()


if __name__ == "__main__":
    sys.exit(main())
