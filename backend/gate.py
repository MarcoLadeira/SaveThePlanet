"""Server-wide admission control for expensive model replays (review P1.5).

The hosted GridToEv service handles window replays essentially one at a time: a 24 h replay
takes ~13 s alone but ~39 s each when two overlap. Every replay from any page or viewer
(Forecast day replay, Impact day replay, issue-time verification) therefore goes through one
ReplayGate:

- one replay runs upstream at a time (`slots`);
- identical requests share a single upstream call (single-flight), across clients;
- foreground work (what a viewer is looking at) is admitted before background prefetches;
- a newer foreground request from the same client supersedes that client's older queued
  work, which is dropped instead of delaying the new request;
- waiting is bounded: after `timeout` seconds the caller gets Busy (HTTP 503 + Retry-After)
  and retries with backoff.

Work already running upstream cannot be cancelled; its result is still cached for reuse.
"""
import itertools
import threading
import time

FOREGROUND, PREFETCH = 0, 1


class Busy(Exception):
    """No replay slot became free within the bounded wait."""
    retry_after = 5


class Superseded(Exception):
    """A newer request from the same client replaced this queued one."""


class ReplayGate:
    def __init__(self, slots=1, timeout=45.0):
        self.slots, self.timeout = slots, timeout
        self._cond = threading.Condition()
        self._running = 0
        self._queue = []  # [priority, arrival, client, seq]
        self._arrivals = itertools.count()
        self._latest = {}  # client -> newest foreground seq seen
        self._inflight = {}  # key -> {'done': Event, 'result': ..., 'error': ...}

    def _superseded(self, client, seq):
        return client is not None and seq is not None and seq < self._latest.get(client, seq)

    def run(self, key, fn, priority=FOREGROUND, client=None, seq=None, timeout=None):
        """Run fn() once per key under admission control and return its result."""
        timeout = self.timeout if timeout is None else timeout
        deadline = time.monotonic() + timeout
        with self._cond:
            if client is not None and seq is not None and priority == FOREGROUND:
                if seq > self._latest.get(client, -1):
                    self._latest[client] = seq
                    self._cond.notify_all()  # let this client's older waiters leave
            shared = self._inflight.get(key)
            if shared is None:
                shared = self._inflight[key] = {'done': threading.Event(), 'result': None, 'error': None}
                owner = True
            else:
                owner = False
        if not owner:  # the same replay is already queued or running: wait for its result
            if not shared['done'].wait(max(0.0, deadline - time.monotonic())):
                raise Busy()
            if isinstance(shared['error'], Superseded):
                # The owner's own client moved on; this caller still wants the result, so run it itself.
                return self.run(key, fn, priority, client, seq, max(0.0, deadline - time.monotonic()))
            if shared['error'] is not None:
                raise shared['error']
            return shared['result']
        entry = [priority, next(self._arrivals), client, seq]
        try:
            with self._cond:
                self._queue.append(entry)
                while True:
                    if self._superseded(client, seq):
                        raise Superseded()
                    first = min(self._queue)
                    if self._running < self.slots and first is entry:
                        break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise Busy()
                    self._cond.wait(remaining)
                self._queue.remove(entry)
                self._running += 1
            try:
                shared['result'] = fn()
                return shared['result']
            finally:
                with self._cond:
                    self._running -= 1
                    self._cond.notify_all()
        except BaseException as error:
            shared['error'] = error
            raise
        finally:
            with self._cond:
                if entry in self._queue:
                    self._queue.remove(entry)
                self._inflight.pop(key, None)
                self._cond.notify_all()
            shared['done'].set()


gate = ReplayGate()
