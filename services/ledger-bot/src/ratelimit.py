"""Per-chat token bucket.

Single async task touches the dict, so no lock is needed. The bucket
starts full so a fresh chat can fire `capacity` replies instantly, then
refills at `rate_per_min / 60` tokens per second up to `capacity`.

`time_fn` is injectable so tests can fast-forward without sleeping.
"""
from __future__ import annotations
import time as _time_mod
from typing import Callable


class ChatRateLimiter:
    def __init__(
        self,
        rate_per_min: float,
        capacity: float | None = None,
        time_fn: Callable[[], float] | None = None,
    ):
        self.rate_per_sec = rate_per_min / 60.0
        self.capacity = float(capacity if capacity is not None else rate_per_min)
        self._time = time_fn or _time_mod.monotonic
        self._state: dict[int, tuple[float, float]] = {}

    def take(self, chat_id: int) -> bool:
        now = self._time()
        tokens, last = self._state.get(chat_id, (self.capacity, now))
        tokens = min(self.capacity, tokens + (now - last) * self.rate_per_sec)
        if tokens >= 1.0:
            self._state[chat_id] = (tokens - 1.0, now)
            return True
        self._state[chat_id] = (tokens, now)
        return False
