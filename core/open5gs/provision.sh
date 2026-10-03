#!/bin/bash
# Write the UE's subscriber record into Open5GS's MongoDB (idempotent upsert).
#
#   sudo core/open5gs/provision.sh              uses site.env + secrets.env
#   core/open5gs/provision.sh --dry-run         prints the record, keys masked
#
# The record is the first rig's: static IP ${UE_IP}, default session 5QI
# ${DEFAULT_5QI}, and one PCC rule putting traffic from source port
# ${GBR_SOURCE_PORT} on a GBR flow (5QI ${GBR_5QI}, GBR/MBR from site.env).
# The rule is written "to assigned <port>" — downlink form; Open5GS swaps it
# for uplink, so it matches the UE's SOURCE port (LESSONS.md).
#
# An existing record's SQN is kept, so re-running never forces a resync.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/../../lib/render.sh"
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
load_site "${SITE_ENV:-$( [ -f "$REPO_ROOT/site.env" ] && echo "$REPO_ROOT/site.env" || echo /etc/tsn5g/site.env)}"
SECRETS=${SECRETS_ENV:-$REPO_ROOT/secrets.env}
[ -f "$SECRETS" ] || SECRETS=/etc/tsn5g/secrets.env
[ -f "$SECRETS" ] || die "no secrets.env — copy secrets.env.example, fill in the SIM's K and OPc"
set -a; . "$SECRETS"; set +a
SITE_VARS="$SITE_VARS UE_K UE_OPC UE_AMF UE_IMEISV"
require UE_IMSI UE_K UE_OPC UE_AMF DNN UE_IP DEFAULT_5QI GBR_5QI GBR_UL_MBPS MBR_UL_MBPS GBR_SOURCE_PORT UE_AMBR_UL_MBPS
[[ $UE_K =~ ^[0-9a-fA-F]{32}$ && $UE_OPC =~ ^[0-9a-fA-F]{32}$ ]] || die "UE_K and UE_OPC must be 32 hex characters"

umask 077
doc=$(mktemp); trap 'rm -f "$doc"' EXIT
list=$(for v in $SITE_VARS; do printf '${%s} ' "$v"; done)
envsubst "$list" < "$REPO_ROOT/core/open5gs/subscriber.json.in" > "$doc"
python3 -m json.tool "$doc" >/dev/null || die "rendered subscriber is not valid JSON"

if [ "$DRY_RUN" = 1 ]; then
    say "subscriber $UE_IMSI (dry run, keys masked):"
    sed -E 's/("(k|opc)": ")[0-9a-fA-F]{28}/\1****************************/' "$doc"
    exit 0
fi

command -v mongosh >/dev/null || die "mongosh not found (install.sh core installs it)"
mongosh --quiet open5gs --eval "
  const d = EJSON.parse(require('fs').readFileSync('$doc', 'utf8'));
  if (!d.imeisv) d.imeisv = [];
  const old = db.subscribers.findOne({imsi: d.imsi});
  if (old && old.security && old.security.sqn !== undefined) d.security.sqn = old.security.sqn;
  const r = db.subscribers.replaceOne({imsi: d.imsi}, d, {upsert: true});
  print((r.upsertedCount ? 'created' : 'updated') + ' subscriber ' + d.imsi);
"
