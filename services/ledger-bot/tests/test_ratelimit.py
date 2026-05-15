"""ChatRateLimiter behaviors:
  1. bucket starts full so the first `capacity` calls succeed instantly
  2. the (capacity+1)-th call within the same instant returns False
  3. with rate=4/min, advancing the clock 15s refills exactly 1 token
"""
from src.ratelimit import ChatRateLimiter


def test_bucket_starts_full():
    clock = {"t": 0.0}
    rl = ChatRateLimiter(rate_per_min=4, time_fn=lambda: clock["t"])
    assert all(rl.take(42) for _ in range(4))


def test_overflow_returns_false():
    clock = {"t": 0.0}
    rl = ChatRateLimiter(rate_per_min=4, time_fn=lambda: clock["t"])
    for _ in range(4):
        assert rl.take(7) is True
    assert rl.take(7) is False
    assert rl.take(7) is False


def test_refill_after_15s_at_rate_4_per_min():
    clock = {"t": 100.0}
    rl = ChatRateLimiter(rate_per_min=4, time_fn=lambda: clock["t"])
    for _ in range(4):
        assert rl.take(1) is True
    assert rl.take(1) is False
    clock["t"] += 15.0
    assert rl.take(1) is True
    assert rl.take(1) is False


def test_chats_are_independent():
    clock = {"t": 0.0}
    rl = ChatRateLimiter(rate_per_min=4, time_fn=lambda: clock["t"])
    for _ in range(4):
        assert rl.take(1) is True
    assert rl.take(1) is False
    # A different chat starts with its own full bucket.
    assert rl.take(2) is True
