"""
Cross-cutting plumbing: events, jobs, log buffering, persistence, safety.

Nothing in here knows about modems, bearers or switches. These are the
primitives every feature module is built on, kept separate so they can be
tested without hardware.
"""
