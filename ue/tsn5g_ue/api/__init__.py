"""
HTTP API and static server.

Split from a single 250-line module into:

  router.py   path matching, request wrapper, error mapping
  static.py   the web/ tree, with ETag revalidation
  sse.py      the /api/events stream
  server.py   the http.server glue and AppContext
  routes_*.py the route tables, one module per resource area

The route table in docs/api-contract.md is authoritative; GET /api/spec dumps
what this process actually serves, and scripts/check-endpoints.sh compares the
two.
"""

from .server import ApiServer, AppContext

__all__ = ["ApiServer", "AppContext"]
