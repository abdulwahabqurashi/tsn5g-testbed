# Sourced by the core scripts: loads site.env ($SITE_ENV, then /etc/tsn5g/site.env,
# then the checkout's site.env), so no script hard-codes an address or NIC.
for _f in "${SITE_ENV:-}" /etc/tsn5g/site.env \
          "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)/site.env"; do
    if [ -n "$_f" ] && [ -f "$_f" ]; then set -a; . "$_f"; set +a; break; fi
done
unset _f
