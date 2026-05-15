"""File-backed daily DeepSeek spend cap.

State on disk: {"date": "YYYY-MM-DD", "spent_usd": float}
UTC day rollover resets the counter. Corrupt/missing file = fresh state.
I/O failures degrade to in-memory only — they never crash the bot.

`now_fn` is injectable so tests can fast-forward across day boundaries.
"""
from __future__ import annotations
import asyncio
import json
import os
import tempfile
from datetime import datetime, timezone
from typing import Callable

import structlog

log = structlog.get_logger("ledger-bot.budget")


def _utc_today(now_fn: Callable[[], datetime]) -> str:
    return now_fn().astimezone(timezone.utc).strftime("%Y-%m-%d")


class DailyBudget:
    def __init__(
        self,
        cap_usd: float,
        path: str,
        price_in_per_m: float,
        price_out_per_m: float,
        now_fn: Callable[[], datetime] | None = None,
    ):
        self.cap_usd = cap_usd
        self.path = path
        self.price_in_per_m = price_in_per_m
        self.price_out_per_m = price_out_per_m
        self._now = now_fn or (lambda: datetime.now(timezone.utc))
        self._lock = asyncio.Lock()
        self._date: str | None = None
        self._spent: float = 0.0
        self._loaded = False
        self._disk_ok = True

    def _load_if_needed(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self._date = str(data.get("date", ""))
            self._spent = float(data.get("spent_usd", 0.0))
        except (FileNotFoundError, json.JSONDecodeError, ValueError, OSError) as e:
            log.info("budget_fresh_state", reason=str(e))
            self._date = None
            self._spent = 0.0

    def _roll_if_new_day(self) -> None:
        today = _utc_today(self._now)
        if self._date != today:
            if self._date is not None:
                log.info("budget_rollover", prev_date=self._date, prev_spent=self._spent)
            self._date = today
            self._spent = 0.0

    def _persist(self) -> None:
        if not self._disk_ok:
            return
        try:
            d = os.path.dirname(self.path) or "."
            os.makedirs(d, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".ledger-spend-", dir=d)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"date": self._date, "spent_usd": self._spent}, f)
            os.replace(tmp, self.path)
        except OSError as e:
            log.warning("budget_persist_failed", err=str(e))
            self._disk_ok = False

    async def check(self) -> bool:
        async with self._lock:
            self._load_if_needed()
            self._roll_if_new_day()
            return self._spent < self.cap_usd

    async def charge(self, prompt_tokens: int, completion_tokens: int) -> float:
        cost = (
            prompt_tokens * self.price_in_per_m / 1_000_000.0
            + completion_tokens * self.price_out_per_m / 1_000_000.0
        )
        async with self._lock:
            self._load_if_needed()
            self._roll_if_new_day()
            self._spent += cost
            self._persist()
            return self._spent
