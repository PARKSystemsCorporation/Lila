"""Thin async wrapper around the two Telegram Bot API methods we use."""
from __future__ import annotations
import aiohttp
import structlog

log = structlog.get_logger("ledger-bot.telegram")


class TelegramClient:
    def __init__(self, token: str):
        self.base = f"https://api.telegram.org/bot{token}"

    async def get_updates(self, offset: int | None, timeout: int) -> list[dict]:
        params: dict[str, str | int] = {
            "timeout": timeout,
            "allowed_updates": '["message"]',
        }
        if offset is not None:
            params["offset"] = offset
        # Outer aiohttp timeout = telegram timeout + 5s buffer for headers.
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(
                    f"{self.base}/getUpdates",
                    params=params,
                    timeout=aiohttp.ClientTimeout(total=timeout + 5),
                ) as r:
                    data = await r.json(content_type=None)
        except (aiohttp.ClientError, TimeoutError) as e:
            log.warning("get_updates_failed", err=str(e))
            return []
        if not data.get("ok"):
            log.warning("get_updates_not_ok", body=str(data)[:200])
            return []
        return list(data.get("result") or [])

    async def send_message(
        self,
        chat_id: int,
        text: str,
        reply_to_message_id: int | None = None,
    ) -> None:
        payload: dict[str, object] = {"chat_id": chat_id, "text": text}
        if reply_to_message_id is not None:
            payload["reply_to_message_id"] = reply_to_message_id
            payload["allow_sending_without_reply"] = True
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(
                    f"{self.base}/sendMessage",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as r:
                    if r.status >= 400:
                        body = await r.text()
                        log.warning("send_message_failed", status=r.status, body=body[:200])
        except (aiohttp.ClientError, TimeoutError) as e:
            log.warning("send_message_failed", err=str(e))
