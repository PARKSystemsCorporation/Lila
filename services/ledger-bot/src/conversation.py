"""In-memory per-chat conversation buffer."""
from __future__ import annotations
from collections import deque


class ConversationStore:
    def __init__(self, max_turns: int):
        self.max_turns = max_turns
        self._chats: dict[int, deque[dict]] = {}

    def history(self, chat_id: int) -> list[dict]:
        return list(self._chats.get(chat_id, ()))

    def append(self, chat_id: int, role: str, content: str) -> None:
        buf = self._chats.get(chat_id)
        if buf is None:
            buf = deque(maxlen=self.max_turns * 2)
            self._chats[chat_id] = buf
        buf.append({"role": role, "content": content})
