#!/usr/bin/env bash
#
# Build a release tarball. Writes only to dist/ — the working tree is not
# modified, and nothing here needs root.
#
#   ./scripts/package.sh [--version X.Y.Z]
#
# Produces dist/tsn5g-ue-<version>.tar.gz which unpacks to a directory holding
# everything the target needs and nothing it does not: no .git, no tests, no
# reference scripts, no iperf history.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

VERSION="$(python3 -c 'import re;print(re.search(r"__version__ = \"([^\"]+)\"", open("tsn5g_ue/__init__.py").read()).group(1))')"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --version) VERSION="${2:?--version needs a value}"; shift ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

NAME="tsn5g-ue-$VERSION"
OUT="$HERE/dist"
STAGE="$OUT/$NAME"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

say "Checking the tree before packaging"
./scripts/lint-js.sh >/dev/null || { echo "lint failed; not packaging" >&2; exit 1; }
python3 - <<'PY' || exit 1
import compileall, sys
if not compileall.compile_dir("tsn5g_ue", quiet=2, force=True):
    sys.exit("python compile check failed")
PY
python3 -c 'import yaml; yaml.safe_load(open("config/tsn5g-ue.example.yaml"))' \
    || { echo "the shipped config template does not parse" >&2; exit 1; }
echo "    js lint, python compile, config parse"

say "Staging $NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# The application itself.
cp -r tsn5g_ue web "$STAGE/"
find "$STAGE" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGE" -name '*.pyc' -delete 2>/dev/null || true
# dev/ holds mock fixtures reachable only with ?transport=mock. Shipping them
# invites a screenshot of fake data being mistaken for a working system.
rm -rf "$STAGE/web/dev"

mkdir -p "$STAGE/config" "$STAGE/systemd" "$STAGE/docs"
cp config/tsn5g-ue.example.yaml "$STAGE/config/"
cp systemd/tsn5g-ue.service "$STAGE/systemd/"
[[ -f systemd/tsn5g-ue-kiosk.service ]] && cp systemd/tsn5g-ue-kiosk.service "$STAGE/systemd/"
[[ -d desktop ]] && cp -r desktop "$STAGE/"

cp docs/USER_GUIDE.md "$STAGE/docs/" 2>/dev/null || true
cp docs/api-contract.md "$STAGE/docs/" 2>/dev/null || true
cp docs/tsn5g-ue.sudoers "$STAGE/docs/" 2>/dev/null || true

cp scripts/install.sh "$STAGE/install.sh"
cp scripts/uninstall.sh "$STAGE/uninstall.sh" 2>/dev/null || true
chmod +x "$STAGE/install.sh" "$STAGE/uninstall.sh" 2>/dev/null || true

# A README at the root of the tarball, because that is where someone looks.
cat > "$STAGE/README" <<EOF
TSN-5G UE Console $VERSION

Install (Ubuntu 22.04 / 24.04, x86_64 or arm64):

    sudo ./install.sh

That installs dependencies, masks ModemManager, writes a config to
/etc/tsn5g-ue/tsn5g-ue.yaml, starts the service, and waits until the UI
answers before reporting success. Then open http://<this-host>:8080/

Before you can bring a data call up, two values in
/etc/tsn5g-ue/tsn5g-ue.yaml must match your network:

    modem.dnn        your APN
    vxlan.core_ip    your 5G core / UPF address

docs/USER_GUIDE.md explains the whole UI and how to get connected.

To remove: sudo ./uninstall.sh
EOF

echo "$VERSION" > "$STAGE/VERSION"
git rev-parse --short HEAD > "$STAGE/COMMIT" 2>/dev/null || true

say "Building the tarball"
tar -C "$OUT" -czf "$OUT/$NAME.tar.gz" "$NAME"
( cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
rm -rf "$STAGE"

SIZE=$(du -h "$OUT/$NAME.tar.gz" | cut -f1)
cat <<EOF

  dist/$NAME.tar.gz  ($SIZE)
  dist/$NAME.tar.gz.sha256

  On the target machine:

      tar xzf $NAME.tar.gz
      cd $NAME
      sudo ./install.sh

EOF
