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
