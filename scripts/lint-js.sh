#!/bin/sh
# Deploy-time JavaScript check: run `node --check` over every UI script so a
# syntax error (e.g. a duplicate `const`) is caught before it reaches the browser
# and blanks the page. Requires nodejs on the box (used only as a parser).
#
#   sh scripts/lint-js.sh
set -eu
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
    echo "node not installed — cannot lint JS (apt-get install -y nodejs)" >&2
    exit 2
fi

fail=0
for f in web/js/*.js web/js/views/*.js; do
    [ -f "$f" ] || continue
    if node --check "$f" 2>/tmp/lintjs.err; then
        :
    else
        echo "FAIL  $f"
        sed 's/^/    /' /tmp/lintjs.err
        fail=1
    fi
done

if [ "$fail" -eq 0 ]; then
    echo "JS lint: all files parse OK"
else
    echo "JS lint: FAILURES above" >&2
fi
exit "$fail"
