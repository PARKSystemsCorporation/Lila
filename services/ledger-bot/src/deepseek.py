"""Minimal DeepSeek chat-completions client."""
from __future__ import annotations
import aiohttp
import structlog

log = structlog.get_logger("ledger-bot.deepseek")

API_URL = "https://api.deepseek.com/v1/chat/completions"
MAX_REPLY_CHARS = 3500  # Telegram cap is 4096; leave headroom.


class DeepSeekError(RuntimeError):
    pass


class DeepSeekClient:
    def __init__(self, api_key: str, model: str):
        self.api_key = api_key
        self.model = model

    async def chat(self, messages: list[dict]) -> tuple[str, int, int]:
        """POST messages, return (reply_text, prompt_tokens, completion_tokens)."""
        payload = {"model": self.model, "messages": messages, "stream": False}
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "content-type": "application/json",
        }
        async with aiohttp.ClientSession() as s:
            async with s.post(
                API_URL,
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as r:
                text = await r.text()
                if r.status >= 400:
                    raise DeepSeekError(f"deepseek {r.status}: {text[:200]}")
                try:
                    data = await r.json(content_type=None)
                except Exception as e:
                    raise DeepSeekError(f"deepseek parse: {e}: {text[:200]}")
        try:
            reply = data["choices"][0]["message"]["content"] or ""
            usage = data.get("usage") or {}
            p_tok = int(usage.get("prompt_tokens", 0))
            c_tok = int(usage.get("completion_tokens", 0))
        except (KeyError, IndexError, TypeError) as e:
            raise DeepSeekError(f"deepseek shape: {e}: {str(data)[:200]}")
        reply = reply.strip()
        if len(reply) > MAX_REPLY_CHARS:
            reply = reply[:MAX_REPLY_CHARS].rstrip() + "…"
        return reply, p_tok, c_tok
