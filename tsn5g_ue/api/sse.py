"""
Server-sent events over http.server.

SSE rather than WebSocket because the channel is 100% server-to-client:
WebSocket on the stdlib server would mean hand-writing RFC 6455 framing,
masking and ping/pong — several hundred lines of security-relevant code — to
carry events that `EventSource` already handles natively, including reconnect
with Last-Event-ID.

Each stream holds a handler thread for its lifetime. That is affordable here
(a kiosk browser plus maybe an engineer's laptop) but it is why MAX_CLIENTS
exists, why the socket carries a write timeout, and why ApiServer sets
block_on_close = False — otherwise one open stream turns every restart into a
hang.
"""

import errno
import json
import logging
import select
import socket
import time

logger = logging.getLogger("tsn5g-ue.api")

# A browser allows ~6 connections per origin on HTTP/1.1, so the UI opens
# exactly one stream and multiplexes topics over it. This cap is the backstop
# against a reload loop leaking threads.
MAX_CLIENTS = 8

PING_INTERVAL = 15.0      # the client watchdog treats 25s of silence as dead
WRITE_TIMEOUT = 10.0      # don't let a wedged peer pin a thread for the RTO

# How long the loop blocks waiting for an event before re-checking whether the
# client is still there. This is the reaping latency, so it bounds how fast a
# reload storm can burn through MAX_CLIENTS: at 1s a page reloading every 120ms
# filled the cap before the first slot came back.
POLL_INTERVAL = 0.25


def _peer_gone(conn):
    """True once the client has closed its end.

    Writing is not a reliable detector: the first write to a peer-closed socket
    lands in the kernel buffer and succeeds, and only the *second* fails with
    EPIPE. Relying on that meant a closed browser tab held its slot for two
    ping intervals, so a handful of reloads exhausted the cap.

    An SSE client never sends anything after its request, so the socket
    becoming readable can only mean EOF. MSG_PEEK leaves the buffer alone.
    """
    try:
        r, _, _ = select.select([conn], [], [], 0)
        if not r:
            return False
        return conn.recv(1, socket.MSG_PEEK) == b""
    except (BlockingIOError, InterruptedError):
        return False
    except OSError as exc:
        return exc.errno not in (errno.EAGAIN, errno.EWOULDBLOCK)


class SseRegistry:
    """Counts live streams so the server can refuse the ninth."""

    def __init__(self, max_clients=MAX_CLIENTS):
        self.max_clients = max_clients
        self._n = 0

    def acquire(self):
        if self._n >= self.max_clients:
            return False
        self._n += 1
        return True

    def release(self):
        self._n = max(0, self._n - 1)

    @property
    def count(self):
        return self._n


def _frame(event):
    """One SSE frame. Blank line terminates; every line of data needs `data:`."""
    payload = json.dumps(event["data"], default=str)
    out = [f"id: {event['id']}", f"event: {event['topic']}"]
    for line in payload.split("\n"):
        out.append(f"data: {line}")
    out.append("")
    out.append("")
    return "\n".join(out).encode("utf-8")


def stream(http, bus, registry, topics=None, last_id=None):
    """Hold the connection open, writing events until the client goes away."""
    if not registry.acquire():
        body = json.dumps({"error": "too many event streams",
                           "max": registry.max_clients}).encode()
        http.send_response(503)
        http.send_header("Content-Type", "application/json")
        http.send_header("Retry-After", "5")
        http.send_header("Content-Length", str(len(body)))
        http.end_headers()
        http.wfile.write(body)
        return

    sub = bus.subscribe(topics=topics, last_id=last_id)
    try:
        http.send_response(200)
        http.send_header("Content-Type", "text/event-stream; charset=utf-8")
        http.send_header("Cache-Control", "no-cache")
        # Deliberately NO Content-Length: this response never ends.
        http.send_header("Connection", "close")
        # Tells nginx and friends not to buffer, if one is ever put in front.
        http.send_header("X-Accel-Buffering", "no")
        http.end_headers()

        try:
            http.connection.settimeout(WRITE_TIMEOUT)
        except OSError:
            pass

        # An initial comment flushes headers immediately, so EventSource fires
        # `onopen` now rather than when the first real event happens to arrive.
        http.wfile.write(b": connected\n\n")
        http.wfile.flush()

        last_ping = time.monotonic()
        while True:
            if sub.dropped:
                # The client fell behind and we discarded its backlog. Say so
                # and close: it must resync from /api/status, not silently
                # carry on with a hole in the sequence.
                http.wfile.write(b"event: overflow\ndata: {\"resync\": true}\n\n")
                http.wfile.flush()
                logger.warning("SSE client overflowed; closing stream")
                return

            if _peer_gone(http.connection):
                logger.debug("SSE client closed the connection")
                return

            event = sub.get(timeout=POLL_INTERVAL)
            if event is not None:
                http.wfile.write(_frame(event))
                http.wfile.flush()

            now = time.monotonic()
            if now - last_ping >= PING_INTERVAL:
                http.wfile.write(b": ping\n\n")
                http.wfile.flush()
                last_ping = now

    except (BrokenPipeError, ConnectionResetError, socket.timeout, OSError) as exc:
        logger.debug("SSE client disconnected: %s", exc)
    finally:
        bus.unsubscribe(sub)
        registry.release()
