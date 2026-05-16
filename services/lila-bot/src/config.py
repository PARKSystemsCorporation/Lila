"""Bot config from env."""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class BotConfig:
    homeserver_url: str
    user_id: str            # "@lila:bazaar.parksystems.app"
    password: str
    device_id: str
    store_path: str
    bazaar_api_url: str
    bazaar_bot_secret: str  # HMAC shared with Next.js
    skills_board_alias: str
    archive_alias: str

    @classmethod
    def from_env(cls) -> "BotConfig":
        def need(name: str) -> str:
            v = os.environ.get(name)
            if not v:
                raise SystemExit(f"missing env: {name}")
            return v
        return cls(
            homeserver_url=need("MATRIX_HOMESERVER_URL"),
            user_id=need("LILA_BOT_USER"),
            password=need("LILA_BOT_PASSWORD"),
            device_id=os.environ.get("LILA_BOT_DEVICE", "BAZAAR-LILA-1"),
            store_path=os.environ.get("NIO_STORE_PATH", "/data/nio-store"),
            bazaar_api_url=need("BAZAAR_API_URL"),
            bazaar_bot_secret=need("BAZAAR_BOT_SECRET"),
            skills_board_alias=os.environ.get(
                "BAZAAR_SKILLS_BOARD_ALIAS", "#skills-board"
            ),
            archive_alias=os.environ.get(
                "BAZAAR_ARCHIVE_ALIAS", "#archive-completed"
            ),
        )
