"""Entry point for `python -m ds_tt`."""

import argparse
import sys

from .daemon import DsTtDaemon


def main():
    parser = argparse.ArgumentParser(
        description="DS-TT: Device-Side TSN Translator for 5G-TSN Integration"
    )
    parser.add_argument(
        "-c", "--config", required=True,
        help="Path to DS-TT YAML configuration file"
    )
    parser.add_argument(
        "-l", "--log-level", default=None,
        choices=["debug", "info", "warning", "error"],
        help="Override log level from config"
    )
    args = parser.parse_args()

    daemon = DsTtDaemon(args.config, log_level_override=args.log_level)
    try:
        daemon.run()
    except KeyboardInterrupt:
        daemon.shutdown()
        sys.exit(0)


if __name__ == "__main__":
    main()
