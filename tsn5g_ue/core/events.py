"""
In-process publish/subscribe with replay, feeding the SSE endpoint.

One bus per daemon. Producers call :meth:`EventBus.publish` from any thread;
each HTTP client streaming ``/api/events`` holds a :class:`Subscriber` whose
bounded queue it drains.

Two rules shape the design:

* **A slow client must never block a producer.** The modem poller publishing a
  signal sample cannot afford to wait on a browser that has stopped reading its
  socket. Queues are bounded and overflow *drops the subscriber*, not the event.
* **A reconnect must not lose the tail.** ``EventSource`` resends its last seen
  id as ``Last-Event-ID``; the ring buffer lets us replay from there rather than
  making the client resync from scratch.
"""

import collections
import itertools
import logging
import threading
import time

logger = logging.getLogger("tsn5g-ue.events")

# Topic names. The UI subscribes to a subset; see docs/api-contract.md.
TOPIC_STATE = "state"
TOPIC_JOB = "job"
TOPIC_MODEM = "modem"
TOPIC_SIGNAL = "signal"
TOPIC_BEARER = "bearer"
TOPIC_STATS = "stats"
TOPIC_IPERF = "iperf"
TOPIC_LOG = "log"
TOPIC_AUDIT = "audit"
TOPIC_ALERT = "alert"

ALL_TOPICS = (TOPIC_STATE, TOPIC_JOB, TOPIC_MODEM, TOPIC_SIGNAL, TOPIC_BEARER,
              TOPIC_STATS, TOPIC_IPERF, TOPIC_LOG, TOPIC_AUDIT, TOPIC_ALERT)

# How many events the bus remembers for replay. At the busiest sane rate
# (signal at 0.5 Hz, stats at 1 Hz, plus job chatter) this is several minutes
# of history — far longer than any reconnect gap.
DEFAULT_CAPACITY = 2000

# Per-client backlog. A browser that stops reading gets dropped rather than
# being allowed to pin memory.
DEFAULT_QUEUE_SIZE = 256


class Subscriber:
    """One streaming client. Not thread-safe for concurrent draining."""

    __slots__ = ("topics", "_deque", "_cond", "_maxsize", "dropped", "created")

    def __init__(self, topics=None, maxsize=DEFAULT_QUEUE_SIZE):
        # None means "everything"; a set means "only these".
        self.topics = set(topics) if topics else None
        self._deque = collections.deque()
        self._cond = threading.Condition()
        self._maxsize = maxsize
        self.dropped = False
        self.created = time.time()

    def wants(self, topic):
        return self.topics is None or topic in self.topics

    def offer(self, event):
        """Non-blocking put. Returns False if this subscriber has overflowed.

        Called with the bus lock held, from the publishing thread — so it must
        not block, and must not raise.
        """
        with self._cond:
            if self.dropped:
                return False
            if len(self._deque) >= self._maxsize:
                # Don't slow the producer and don't silently skip events: mark
                # the client dead so the SSE handler can tell it to resync.
                self.dropped = True
                self._cond.notify_all()
                return False
            self._deque.append(event)
            self._cond.notify_all()
            return True

    def get(self, timeout=None):
        """Pop the next event, or None on timeout / after a drop."""
        with self._cond:
            if not self._deque:
                self._cond.wait(timeout)
            if self._deque:
                return self._deque.popleft()
            return None

    def drain(self, limit=64):
        """Pop up to `limit` queued events without waiting."""
        out = []
        with self._cond:
            while self._deque and len(out) < limit:
                out.append(self._deque.popleft())
        return out

    def close(self):
        with self._cond:
            self.dropped = True
            self._cond.notify_all()

    @property
    def backlog(self):
        with self._cond:
            return len(self._deque)


class EventBus:
    """Fan-out with a replay ring. Safe to publish from any thread."""

    def __init__(self, capacity=DEFAULT_CAPACITY):
        self._ring = collections.deque(maxlen=capacity)
        self._subs = set()
        self._ids = itertools.count(1)
        self._lock = threading.Lock()

    # -- producers ----------------------------------------------------------
    def publish(self, topic, data):
        """Append an event and fan it out. Returns the event id.

        Never raises and never blocks: a broken subscriber is dropped, not
        waited on.
        """
        event = {"id": None, "ts": time.time(), "topic": topic, "data": data}
        dead = []
        with self._lock:
            event["id"] = next(self._ids)
            self._ring.append(event)
            for sub in self._subs:
                if sub.wants(topic) and not sub.offer(event):
                    dead.append(sub)
            for sub in dead:
                self._subs.discard(sub)
        if dead:
            logger.warning("dropped %d slow event subscriber(s) on topic %s",
                           len(dead), topic)
        return event["id"]

    # -- consumers ----------------------------------------------------------
    def subscribe(self, topics=None, last_id=None, maxsize=DEFAULT_QUEUE_SIZE):
        """Register a client, optionally pre-loaded with missed events.

        `last_id` is the client's Last-Event-ID: everything newer is replayed
        into its queue before it sees anything live, so the sequence it
        observes has no hole.
        """
        sub = Subscriber(topics=topics, maxsize=maxsize)
        with self._lock:
            if last_id is not None:
                for event in self._ring:
                    if event["id"] > last_id and sub.wants(event["topic"]):
                        if not sub.offer(event):
                            break   # replay alone overflowed it; give up quietly
            self._subs.add(sub)
        return sub

    def unsubscribe(self, sub):
        with self._lock:
            self._subs.discard(sub)
        sub.close()

    def replay(self, last_id, topics=None):
        """Events newer than `last_id`, for a polling client."""
        want = set(topics) if topics else None
        with self._lock:
            return [e for e in self._ring
                    if e["id"] > last_id and (want is None or e["topic"] in want)]

    # -- introspection ------------------------------------------------------
    @property
    def subscriber_count(self):
        with self._lock:
            return len(self._subs)

    def stats(self):
        with self._lock:
            return {
                "subscribers": len(self._subs),
                "buffered": len(self._ring),
                "capacity": self._ring.maxlen,
                "last_id": self._ring[-1]["id"] if self._ring else 0,
            }
