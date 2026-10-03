"""
Serves the web/ tree.

The UI is native ES modules with no bundler, so a page load is ~35 separate
file requests. That is only sane with revalidation: `no-cache` plus an ETag
means the browser still asks every time (so stale JS after an update remains
impossible, which was the original concern) but a match costs an empty 304
instead of re-sending every module.
"""

import logging
import os

logger = logging.getLogger("tsn5g-ue.api")

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "..", "web")
WEB_DIR = os.path.normpath(WEB_DIR)

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    # .mjs must be a JavaScript type or Chromium refuses to execute the module
    # and the page goes blank with no network error.
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".map": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
}


def resolve(path):
    """Map a URL path to a file inside WEB_DIR, or None if it escapes/misses."""
    rel = "index.html" if path in ("", "/") else path.lstrip("/")
    full = os.path.normpath(os.path.join(WEB_DIR, rel))
    if not full.startswith(WEB_DIR) or not os.path.isfile(full):
        return None
    return full


def etag_for(full):
    st = os.stat(full)
    return '"%x-%x"' % (int(st.st_mtime), st.st_size)


def serve(http, path):
    """Write a static response onto the handler. Returns True if handled."""
    full = resolve(path)
    if full is None:
        return False

    etag = etag_for(full)
    if http.headers.get("If-None-Match") == etag:
        http.send_response(304)
        http.send_header("ETag", etag)
        http.send_header("Cache-Control", "no-cache")
        http.send_header("Content-Length", "0")
        http.end_headers()
        return True

    with open(full, "rb") as fh:
        data = fh.read()
    ext = os.path.splitext(full)[1]
    http.send_response(200)
    http.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
    http.send_header("Content-Length", str(len(data)))
    http.send_header("ETag", etag)
    http.send_header("Cache-Control", "no-cache")
    http.end_headers()
    http.wfile.write(data)
    return True
