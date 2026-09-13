#!/usr/bin/env bash
#
# Static checks for the web UI. No bundler, no node_modules — node is used as a
# parser only, which is the boundary this project keeps.
#
#   ./scripts/lint-js.sh
#
# Three classes of check:
#   1. syntax          — a parse error used to present as a blank page
#   2. import paths    — with no bundler, a typo'd import is a 404 and a blank
#                        page, which is the failure mode ES modules introduce
#   3. house rules     — the invariants the architecture depends on
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$HERE/web"
fail=0

note() { printf '  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }

command -v node >/dev/null || { echo "node required (parser only)" >&2; exit 2; }

# ---------------------------------------------------------------- 1. syntax
echo "[1/3] syntax"
while IFS= read -r f; do
    rel="${f#"$WEB"/}"
    # ES modules must be checked as modules; `node --check <file>` assumes a
    # script and rejects `import`. Reading from stdin loses the filename from
    # the error, so print it ourselves.
    if ! err=$(node --check --input-type=module < "$f" 2>&1); then
        bad "$rel"
        printf '%s\n' "$err" | sed 's/^/        /'
    fi
done < <(find "$WEB/js" -name "*.js" -not -path "*/views/*" | sort)

# The legacy views are still classic scripts (IIFEs), not modules.
while IFS= read -r f; do
    rel="${f#"$WEB"/}"
    [ "$(basename "$f")" = "logs.js" ] && continue   # logs.js is a real module
    if ! err=$(node --check "$f" 2>&1); then
        bad "$rel"
        printf '%s\n' "$err" | sed 's/^/        /'
    fi
done < <(find "$WEB/js/views" "$WEB/js/qbveditor.js" -name "*.js" 2>/dev/null | sort)

if ! err=$(node --check --input-type=module < "$WEB/js/views/logs.js" 2>&1); then
    bad "js/views/logs.js"; printf '%s\n' "$err" | sed 's/^/        /'
fi

# ----------------------------------------------------------- 2. import paths
echo "[2/3] import resolution"
while IFS= read -r f; do
    dir="$(dirname "$f")"
    rel="${f#"$WEB"/}"
    grep -oE "(from|import\()\s*[\"'][^\"']+[\"']" "$f" 2>/dev/null \
    | grep -oE "[\"'][^\"']+[\"']" | tr -d "\"'" \
    | while IFS= read -r spec; do
        case "$spec" in
            ./*|../*) ;;
            *) continue ;;                       # bare specifiers are not used here
        esac
        if [ ! -f "$dir/$spec" ]; then
            bad "$rel imports '$spec' which does not exist"
        fi
      done
done < <(find "$WEB/js" -name "*.js" | sort)

# ------------------------------------------------------------ 3. house rules
echo "[3/3] house rules"

rule() {  # rule <description> <grep-args...>
    local desc="$1"; shift
    local hits
    # Skip matches inside comments — otherwise the doc-comment explaining why
    # a rule exists trips that very rule.
    hits=$(grep -rnE "$@" 2>/dev/null | grep -vE "^[^:]+:[0-9]+:[[:space:]]*(\*|//|/\*)" || true)
    if [ -n "$hits" ]; then
        bad "$desc"
        printf '%s\n' "$hits" | sed "s|$WEB/||" | sed 's/^/        /' | head -12
    fi
}

# innerHTML is the XSS vector the DOM helper closes. The compat shim is the one
# documented exception, for legacy icon markup, and disappears in Phase 7.
rule "innerHTML outside the compat shim" \
     "innerHTML|outerHTML|insertAdjacentHTML" \
     --include="*.js" "$WEB/js/core" "$WEB/js/ui" "$WEB/js/app" "$WEB/js/main.js"

# An empty catch turns a failure into an empty panel with no cause. There were
# eight of these; core/async.js is what replaced them.
rule "empty catch block (use asyncSection or surface the error)" \
     "catch\s*(\([^)]*\))?\s*\{\s*\}" \
     --include="*.js" "$WEB/js/core" "$WEB/js/ui" "$WEB/js/app" "$WEB/js/views/logs.js"

# Views must use view.interval(), which is torn down on navigation. A raw
# setInterval is how the speed-test poll leaked forever.
rule "setInterval outside js/core (use view.interval)" \
     "setInterval\(" \
     --include="*.js" "$WEB/js/app" "$WEB/js/ui" "$WEB/js/views/logs.js"

# Every endpoint path lives in core/api.js, which is what makes
# scripts/check-endpoints.py able to verify the UI against a running box.
rule "fetch() outside core/api.js" \
     "[^.a-zA-Z]fetch\(" \
     --include="*.js" "$WEB/js/app" "$WEB/js/ui" "$WEB/js/views/logs.js"

# Colour belongs in tokens.css or dark mode silently breaks.
hits=$(grep -rnE "#[0-9a-fA-F]{3,8}\b" "$WEB/js" --include="*.js" \
       | grep -vE "js/(views|qbveditor)" \
       | grep -vE "^[^:]+:[0-9]+:[[:space:]]*(\*|//|/\*)" || true)
if [ -n "$hits" ]; then
    bad "hex colour in JS (put it in css/tokens.css)"
    printf '%s\n' "$hits" | sed "s|$WEB/||" | sed 's/^/        /' | head -8
fi

# dev/ is unreachable from shipped code by construction, not by convention.
rule "shipped code importing from dev/" \
     "from\s+[\"'][^\"']*dev/" \
     --include="*.js" "$WEB/js"

echo
if [ "$fail" -gt 0 ]; then
    echo "FAILED: $fail problem(s)"
    exit 1
fi
echo "OK: $(find "$WEB/js" -name '*.js' | wc -l) files clean"
