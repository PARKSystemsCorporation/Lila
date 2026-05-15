"""DailyBudget behaviors that matter:
  1. check() returns False once spend >= cap
  2. UTC day rollover resets the counter
  3. corrupt/missing JSON on disk is a fresh state, not a crash
"""
import asyncio
import json
import os
from datetime import datetime, timezone

from src.budget import DailyBudget


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)


def _budget(tmp_path, cap=0.001, now_dt=None):
    path = str(tmp_path / "spend.json")
    nowref = {"dt": now_dt or datetime(2026, 5, 15, 12, 0, tzinfo=timezone.utc)}

    def now_fn():
        return nowref["dt"]

    b = DailyBudget(
        cap_usd=cap,
        path=path,
        price_in_per_m=0.27,
        price_out_per_m=1.10,
        now_fn=now_fn,
    )
    return b, nowref, path


class TestCap:
    def test_check_blocks_when_over_cap(self, tmp_path):
        async def go():
            b, _, _ = _budget(tmp_path, cap=0.0001)
            assert await b.check() is True
            # 100k input tokens + 100k output ≈ $0.027 + $0.11 → way over $0.0001.
            await b.charge(100_000, 100_000)
            assert await b.check() is False
        _run(go())

    def test_check_allows_when_under_cap(self, tmp_path):
        async def go():
            b, _, _ = _budget(tmp_path, cap=1.0)
            await b.charge(1000, 200)  # ~$0.00049
            assert await b.check() is True
        _run(go())


class TestRollover:
    def test_new_utc_day_resets_counter(self, tmp_path):
        async def go():
            b, nowref, _ = _budget(tmp_path, cap=0.001)
            await b.charge(100_000, 100_000)
            assert await b.check() is False
            # Advance the clock past UTC midnight.
            nowref["dt"] = datetime(2026, 5, 16, 0, 1, tzinfo=timezone.utc)
            assert await b.check() is True
        _run(go())


class TestDiskRobustness:
    def test_missing_file_starts_fresh(self, tmp_path):
        async def go():
            b, _, path = _budget(tmp_path)
            assert not os.path.exists(path)
            assert await b.check() is True
        _run(go())

    def test_corrupt_file_starts_fresh(self, tmp_path):
        path = tmp_path / "spend.json"
        path.write_text("not-json{")

        async def go():
            b = DailyBudget(
                cap_usd=0.001,
                path=str(path),
                price_in_per_m=0.27,
                price_out_per_m=1.10,
            )
            assert await b.check() is True
        _run(go())

    def test_charge_persists_then_reloads(self, tmp_path):
        path = str(tmp_path / "spend.json")
        fixed = datetime(2026, 5, 15, 12, 0, tzinfo=timezone.utc)

        async def go():
            b = DailyBudget(
                cap_usd=1.0,
                path=path,
                price_in_per_m=0.27,
                price_out_per_m=1.10,
                now_fn=lambda: fixed,
            )
            spent = await b.charge(1000, 200)
            assert spent > 0
            # Fresh instance reading the same file picks up the saved spend.
            b2 = DailyBudget(
                cap_usd=1.0,
                path=path,
                price_in_per_m=0.27,
                price_out_per_m=1.10,
                now_fn=lambda: fixed,
            )
            spent2 = await b2.charge(0, 0)
            assert abs(spent2 - spent) < 1e-9
            with open(path) as f:
                data = json.load(f)
            assert data["date"] == "2026-05-15"
            assert data["spent_usd"] > 0
        _run(go())
