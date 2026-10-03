#!/bin/bash
# Shared helpers for install.sh: load site.env, render *.in templates, checks.
#
# Templates use ${VAR} for site.env values and nothing else; rendering
# substitutes ONLY variables defined in site.env (and secrets.env when asked),
# so shell code inside a template ($1, $(...), $PATH) is left alone.

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DRY_RUN=${DRY_RUN:-0}

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# load_site [file] — source site.env, export every assignment it makes
load_site() {
    local f=${1:-$REPO_ROOT/site.env}
    [ -f "$f" ] || die "no $f — copy site.env.example to site.env and fill it in"
    set -a; # shellcheck disable=SC1090
    . "$f"; set +a
    SITE_VARS=$(grep -oE '^[A-Z][A-Z0-9_]*=' "$f" | tr -d '=' | sort -u | tr '\n' ' ')
    export SITE_FILE=$f
}

# load_secrets — optional secrets.env (SIM keys); adds its names to the render set
load_secrets() {
    local f=$REPO_ROOT/secrets.env
    if [ -f "$f" ]; then
        set -a; # shellcheck disable=SC1090
        . "$f"; set +a
        SITE_VARS="$SITE_VARS $(grep -oE '^[A-Z][A-Z0-9_]*=' "$f" | tr -d '=' | tr '\n' ' ')"
    else
        warn "no secrets.env — subscriber keys will not be provisioned (see secrets.env.example)"
    fi
}

# require VAR... — fail early with the variable's name, not a broken config later
require() {
    local v missing=()
    for v in "$@"; do [ -n "${!v:-}" ] || missing+=("$v"); done
    [ ${#missing[@]} -eq 0 ] || die "site.env is missing: ${missing[*]}"
}

# render TEMPLATE OUTPUT [mode] — substitute site variables, refuse leftovers
render() {
    local in=$1 out=$2 mode=${3:-0644} list v tmp
    [ -f "$in" ] || die "template $in not found"
    list=$(for v in $SITE_VARS; do printf '${%s} ' "$v"; done)
    tmp=$(mktemp)
    envsubst "$list" < "$in" > "$tmp"
    if grep -qE '\$\{[A-Z][A-Z0-9_]*\}' "$tmp"; then
        local left; left=$(grep -oE '\$\{[A-Z][A-Z0-9_]*\}' "$tmp" | sort -u | tr '\n' ' ')
        rm -f "$tmp"; die "$in still has unset variables after rendering: $left"
    fi
    if [ "$DRY_RUN" = 1 ]; then
        mkdir -p "$REPO_ROOT/rendered/$(dirname "${out#/}")"
        mv "$tmp" "$REPO_ROOT/rendered/${out#/}"
        echo "   rendered  $out  (dry run: rendered/${out#/})"
    else
        install -D -m "$mode" "$tmp" "$out"; rm -f "$tmp"
        echo "   installed $out"
    fi
}

# run CMD... — execute, or just print it on a dry run
run() {
    if [ "$DRY_RUN" = 1 ]; then echo "   would run: $*"; else "$@"; fi
}

need_root() { [ "$DRY_RUN" = 1 ] || [ "$(id -u)" -eq 0 ] || die "run with sudo (or --dry-run)"; }

# apt_install PKG... — install only what is missing
apt_install() {
    local missing=() p
    for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
    [ ${#missing[@]} -eq 0 ] && { echo "   packages present: $*"; return; }
    run apt-get update -q
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${missing[@]}"
}

# backup_if_changed FILE — keep FILE.bak-<date> before a render replaces it
backup_if_changed() {
    [ -f "$1" ] || return 0
    run cp -p "$1" "$1.bak-$(date +%Y%m%d-%H%M%S)"
}

# install_sudoers TEMPLATE DEST — render, validate with visudo, then install
install_sudoers() {
    local tmp; tmp=$(mktemp)
    local list v; list=$(for v in $SITE_VARS; do printf '${%s} ' "$v"; done)
    envsubst "$list" < "$1" > "$tmp"
    if ! visudo -c -q -f "$tmp" >/dev/null; then
        rm -f "$tmp"; warn "$1 renders to an invalid sudoers file — not installed"; return 0
    fi
    rm -f "$tmp"
    render "$1" "$2" 0440
}

# install_bundle NAME DESTDIR — unpack $VENDOR_DIR/NAME.tar.gz into DESTDIR/NAME
# after checking its sha256 against video/MANIFEST. Returns 1 if the bundle is
# missing (the caller carries on without it).
install_bundle() {
    local name=$1 dest=$2 tarball=$VENDOR_DIR/$1.tar.gz want got
    want=$(awk -v f="$name.tar.gz" '$2 == f {print $1}' "$REPO_ROOT/video/MANIFEST")
    [ -n "$want" ] || die "$name.tar.gz is not listed in video/MANIFEST"
    if [ ! -f "$tarball" ]; then
        warn "$tarball not found — copy the vendor bundle there (video/README.md) and re-run"
        return 1
    fi
    got=$(sha256sum "$tarball" | cut -d' ' -f1)
    [ "$got" = "$want" ] || die "$tarball has sha256 $got, MANIFEST says $want — wrong or corrupt bundle"
    if [ -d "$dest/$name" ] && [ "$(cat "$dest/.$name.sha256" 2>/dev/null)" = "$want" ]; then
        echo "   $name already unpacked (sha256 matches)"
        return 0
    fi
    run mkdir -p "$dest"
    run rm -rf "$dest/$name.new"
    run mkdir -p "$dest/$name.new"
    run tar -xzf "$tarball" -C "$dest/$name.new" --strip-components=1
    run rm -rf "$dest/$name"
    run mv "$dest/$name.new" "$dest/$name"
    if [ "$DRY_RUN" = 1 ]; then echo "   would record $want in $dest/.$name.sha256"
    else echo "$want" > "$dest/.$name.sha256"; fi
    echo "   unpacked $name -> $dest/$name"
}

# wait_health URL UNIT — wait up to 45 s for URL to answer; show the unit's log if not
wait_health() {
    [ "$DRY_RUN" = 1 ] && { echo "   would wait for $1"; return 0; }
    local i
    for i in $(seq 45); do
        curl -sf -o /dev/null --max-time 3 "$1" && { echo "   $2 answers at $1"; return 0; }
        sleep 1
    done
    warn "$2 did not answer at $1 within 45 s"
    systemctl --no-pager --lines=20 status "$2" >&2 || true
    return 1
}

# Runtime libraries the vendor Qt bundles (encoder, viewer) need from the system
QT_RUNTIME_PKGS="libxcb-cursor0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 \
libxcb-render-util0 libxcb-shape0 libxcb-xfixes0 libxcb-xkb1 libxkbcommon-x11-0 libgl1 \
libegl1 libopengl0 libfontconfig1 libdbus-1-3 libgomp1"
