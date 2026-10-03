#!/usr/bin/env bash
#
# Capture fixtures for the dev mock transport from a running box.
#
#   ./web/dev/capture.sh [base-url]        # default http://127.0.0.1:8080
#
# Fixtures are CAPTURED, never authored. That is the whole point: a hand-written
# fixture drifts from the API the moment the API changes, and you find out when
# a view breaks against real hardware. These cannot drift, because they came
# from the real thing.
#
# Only GETs are captured. The mock acknowledges writes without performing them.
set -uo pipefail

BASE="${1:-http://127.0.0.1:8080}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/fixtures"

mkdir -p "$OUT"

# path -> filename, matching MAP in mock-transport.js
PATHS="
/api/status|status.json
/api/health|health.json
/api/stats|stats.json
/api/discovery|discovery.json
/api/config|config.json
/api/version|version.json
/api/spec|spec.json
/api/interfaces|interfaces.json
/api/logs?limit=200|logs.json
/api/logs/level|logs-level.json
/api/jobs|jobs.json
/api/switch/profiles|switch-profiles.json
/api/tas/profiles|tas-profiles.json
/api/setup/state|setup-state.json
/api/speedtest/result|speedtest-result.json
/api/debug/commands?limit=100|debug-commands.json
"

ok=0
fail=0
echo "capturing from $BASE"
while IFS='|' read -r path file; do
    [ -z "$path" ] && continue
    if python3 - "$BASE$path" "$OUT/$file" <<'PY'
import json, sys, urllib.request
url, dest = sys.argv[1], sys.argv[2]
try:
    with urllib.request.urlopen(url, timeout=15) as r:
        body = json.load(r)
except Exception as exc:                       # noqa: BLE001
    print(f"  {exc}", file=sys.stderr)
    sys.exit(1)
with open(dest, "w", encoding="utf-8") as fh:
    json.dump(body, fh, indent=2)
PY
    then
        printf '  %-32s -> %s\n' "$path" "$file"; ok=$((ok + 1))
    else
        printf '  %-32s FAILED\n' "$path"; fail=$((fail + 1))
    fi
done <<< "$PATHS"

echo
echo "$ok captured, $fail failed -> $OUT"
echo "use with:  http://<host>:8080/?transport=mock"
