# Sourced by the rig scripts. Loads the site's settings so no script hard-codes
# an interface, address, user or path. Looks in, in order:
#   $SITE_ENV  →  /etc/tsn5g/site.env (installed)  →  <repo>/site.env (checkout)
for _f in "${SITE_ENV:-}" /etc/tsn5g/site.env \
          "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)/site.env"; do
    if [ -n "$_f" ] && [ -f "$_f" ]; then
        set -a; . "$_f"; set +a
        break
    fi
done
unset _f
