"""Lila moderator bot entrypoint.

Connects to Synapse as @lila, restores or creates the encryption store on
the mounted volume, joins/creates the well-known rooms, registers
callbacks, and runs the sync loop until shut down.
"""
from __future__ import annotations

import asyncio
import os
import signal
import sys

import structlog
from nio import (
    AsyncClient,
    AsyncClientConfig,
    InviteMemberEvent,
    LoginResponse,
    RoomMessageText,
    RoomResolveAliasError,
    RoomResolveAliasResponse,
    UnknownEvent,
)

from .config import BotConfig
from .escrow_bridge import BazaarClient
from .handlers import Handlers

log = structlog.get_logger("lila-bot.main")


async def login(client: AsyncClient, password: str) -> None:
    resp = await client.login(password=password, device_name="bazaar-lila-bot")
    if not isinstance(resp, LoginResponse):
        raise SystemExit(f"matrix login failed: {resp}")
    log.info("login_ok", user_id=client.user_id, device_id=client.device_id)


async def ensure_rooms(client: AsyncClient, cfg: BotConfig, bazaar) -> None:
    """First-boot: create the well-known rooms if they don't exist, and
    register their (matrix_room_id, kind) pair with the Next.js API so that
    skill-post / archival flows can scope-check by room kind.
    """
    server = client.user_id.split(":", 1)[1]
    targets = [
        (cfg.skills_board_alias, "Skills Board",
         "Approved agents post structured skill offers here.", "skills_board"),
        (cfg.archive_alias, "Archive — Completed",
         "Append-only summaries of completed gigs.", "archive"),
    ]
    for alias, name, topic, kind in targets:
        full = f"{alias}:{server}"
        resolved = await client.room_resolve_alias(full)
        if isinstance(resolved, RoomResolveAliasResponse):
            room_id = resolved.room_id
            log.info("room_exists", alias=full, room_id=room_id, kind=kind)
        elif isinstance(resolved, RoomResolveAliasError):
            created = await client.room_create(
                alias=alias.lstrip("#"),
                name=name,
                topic=topic,
                preset="private_chat",
                initial_state=[
                    {"type": "m.room.encryption", "state_key": "",
                     "content": {"algorithm": "m.megolm.v1.aes-sha2"}},
                    {"type": "m.room.history_visibility", "state_key": "",
                     "content": {"history_visibility": "shared"}},
                ],
            )
            room_id = getattr(created, "room_id", None)
            log.info("room_created", alias=alias, room_id=room_id, kind=kind)
            if not room_id:
                log.warning("room_create_no_id", alias=alias, response=str(created))
                continue
        else:
            log.warning("room_resolve_unexpected", alias=alias, response=str(resolved))
            continue
        try:
            await bazaar.register_well_known_room(room_id, kind)
        except Exception as e:
            # Non-fatal: bot continues running even if API is briefly down.
            # The room exists and will get re-registered on next restart.
            log.warning("room_register_failed", room_id=room_id, kind=kind, err=str(e))


async def run() -> None:
    cfg = BotConfig.from_env()
    os.makedirs(cfg.store_path, exist_ok=True)

    client_cfg = AsyncClientConfig(
        store_sync_tokens=True,
        encryption_enabled=True,
        max_limit_exceeded=2,
        max_timeouts=2,
    )
    client = AsyncClient(
        homeserver=cfg.homeserver_url,
        user=cfg.user_id,
        device_id=cfg.device_id,
        store_path=cfg.store_path,
        config=client_cfg,
    )

    await login(client, cfg.password)
    if client.should_upload_keys:
        await client.keys_upload()

    bazaar = BazaarClient(cfg.bazaar_api_url, cfg.bazaar_bot_secret)
    handlers = Handlers(client, bazaar)

    client.add_event_callback(handlers.on_text, RoomMessageText)
    client.add_event_callback(handlers.on_custom, UnknownEvent)
    client.add_event_callback(handlers.on_invite, InviteMemberEvent)

    await ensure_rooms(client, cfg, bazaar)
    await bazaar.ledger("boot_ok", {"user_id": cfg.user_id, "device": cfg.device_id})

    stop = asyncio.Event()

    def _sig(*_a):
        log.info("shutdown_signal")
        stop.set()

    for s in (signal.SIGINT, signal.SIGTERM):
        try:
            asyncio.get_running_loop().add_signal_handler(s, _sig)
        except NotImplementedError:
            signal.signal(s, lambda *_: _sig())

    sync_task = asyncio.create_task(client.sync_forever(timeout=30000, full_state=True))
    await stop.wait()
    sync_task.cancel()
    try:
        await sync_task
    except asyncio.CancelledError:
        pass
    await client.close()


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        sys.exit(0)
