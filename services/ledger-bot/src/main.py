"""Ledger Telegram bot entrypoint.

Long-polls Telegram, hands every inbound text message to DeepSeek with
the Ledger persona prompt, and posts the reply back. Two gates run
before each LLM call:

  1. per-chat token bucket (4 msg/min default) — silent drop on overflow
  2. daily USD spend cap ($0.20 default) — one-shot notice per chat, then
     silent until UTC rollover
"""
from __future__ import annotations
import asyncio
import signal
import sys

import structlog

from .budget import DailyBudget
from .config import BotConfig
from .conversation import ConversationStore
from .deepseek import DeepSeekClient, DeepSeekError
from .persona import LEDGER_SYSTEM_PROMPT
from .ratelimit import ChatRateLimiter
from .telegram import TelegramClient

log = structlog.get_logger("ledger-bot.main")

QUOTA_NOTICE = "i've hit my daily quota. back tomorrow."


class Ledger:
    def __init__(self, cfg: BotConfig):
        self.cfg = cfg
        self.tg = TelegramClient(cfg.telegram_token)
        self.ds = DeepSeekClient(cfg.deepseek_api_key, cfg.model)
        self.budget = DailyBudget(
            cap_usd=cfg.daily_usd_cap,
            path=cfg.spend_file,
            price_in_per_m=cfg.price_in_per_m,
            price_out_per_m=cfg.price_out_per_m,
        )
        self.rate = ChatRateLimiter(rate_per_min=cfg.rate_per_min)
        self.store = ConversationStore(max_turns=cfg.max_history)
        self.system_prompt = cfg.system_prompt_override or LEDGER_SYSTEM_PROMPT
        self._quota_notified: set[tuple[int, str]] = set()

    async def handle(self, update: dict) -> None:
        msg = update.get("message")
        if not isinstance(msg, dict):
            return
        text = msg.get("text")
        if not isinstance(text, str) or not text.strip():
            return
        chat = msg.get("chat") or {}
        chat_id = chat.get("id")
        if not isinstance(chat_id, int):
            return
        msg_id = msg.get("message_id") if isinstance(msg.get("message_id"), int) else None
        is_group = chat.get("type") in ("group", "supergroup")

        if not self.rate.take(chat_id):
            log.debug("rate_limited", chat_id=chat_id)
            return

        if not await self.budget.check():
            today_key = (chat_id, self._today())
            if today_key not in self._quota_notified:
                self._quota_notified.add(today_key)
                await self.tg.send_message(
                    chat_id, QUOTA_NOTICE,
                    reply_to_message_id=msg_id if is_group else None,
                )
            return

        self.store.append(chat_id, "user", text)
        messages = [{"role": "system", "content": self.system_prompt}] + self.store.history(chat_id)

        try:
            reply, p_tok, c_tok = await self.ds.chat(messages)
        except DeepSeekError as e:
            log.warning("deepseek_failed", chat_id=chat_id, err=str(e))
            return

        spent = await self.budget.charge(p_tok, c_tok)
        log.info(
            "reply_sent",
            chat_id=chat_id,
            p_tok=p_tok,
            c_tok=c_tok,
            spent_usd=round(spent, 6),
        )
        self.store.append(chat_id, "assistant", reply)
        await self.tg.send_message(
            chat_id, reply,
            reply_to_message_id=msg_id if is_group else None,
        )

    @staticmethod
    def _today() -> str:
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")


async def run() -> None:
    cfg = BotConfig.from_env()
    bot = Ledger(cfg)
    log.info(
        "boot_ok",
        model=cfg.model,
        daily_cap_usd=cfg.daily_usd_cap,
        rate_per_min=cfg.rate_per_min,
    )

    stop = asyncio.Event()

    def _sig(*_a):
        log.info("shutdown_signal")
        stop.set()

    for s in (signal.SIGINT, signal.SIGTERM):
        try:
            asyncio.get_running_loop().add_signal_handler(s, _sig)
        except NotImplementedError:
            signal.signal(s, lambda *_: _sig())

    async def loop() -> None:
        offset: int | None = None
        while not stop.is_set():
            try:
                updates = await bot.tg.get_updates(offset, cfg.poll_timeout_sec)
                for u in updates:
                    try:
                        await bot.handle(u)
                    except Exception as e:
                        log.warning("handle_failed", err=str(e))
                    uid = u.get("update_id")
                    if isinstance(uid, int):
                        offset = uid + 1
            except Exception as e:
                log.warning("loop_error", err=str(e))
                await asyncio.sleep(2)

    loop_task = asyncio.create_task(loop())
    await stop.wait()
    loop_task.cancel()
    try:
        await loop_task
    except asyncio.CancelledError:
        pass


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        sys.exit(0)
