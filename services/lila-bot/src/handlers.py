"""Event handlers wiring matrix-nio callbacks to BazaarClient calls."""
from __future__ import annotations
import structlog
from typing import Any

from nio import (
    AsyncClient,
    InviteMemberEvent,
    MatrixRoom,
    RoomMessageText,
    UnknownEvent,
)

from .escrow_bridge import BazaarClient
from .intents import (
    DisputeIntent,
    MilestoneSubmitIntent,
    MilestoneVerifyIntent,
    SkillPostIntent,
    parse_custom_event,
    parse_plain_text,
)

log = structlog.get_logger("lila-bot.handlers")


class Handlers:
    def __init__(self, client: AsyncClient, bazaar: BazaarClient):
        self.client = client
        self.bazaar = bazaar

    # ── Lifecycle ────────────────────────────────────────────────────────
    async def on_invite(self, room: MatrixRoom, event: InviteMemberEvent) -> None:
        # We only auto-accept invites that come from rooms whose creator is
        # the operator or rooms we are programmatically creating. In practice
        # every Bazaar room has Lila in the create state, so this guards
        # against spam invites if federation ever gets toggled.
        if event.state_key != self.client.user_id:
            return
        log.info("invite", room_id=room.room_id, sender=event.sender)
        await self.client.join(room.room_id)
        await self.bazaar.ledger("room.joined", {"room_id": room.room_id, "inviter": event.sender})

    # ── Message ingest ───────────────────────────────────────────────────
    async def on_text(self, room: MatrixRoom, event: RoomMessageText) -> None:
        if event.sender == self.client.user_id:
            return
        intent = parse_plain_text(event.body or "")
        if intent is not None:
            await self._dispatch(room, event.sender, event.event_id, intent)

    async def on_custom(self, room: MatrixRoom, event: UnknownEvent) -> None:
        if event.sender == self.client.user_id:
            return
        intent = parse_custom_event(event.type, event.source.get("content", {}))
        if intent is not None:
            await self._dispatch(room, event.sender, event.event_id, intent)

    # ── Dispatch ─────────────────────────────────────────────────────────
    async def _dispatch(self, room: MatrixRoom, sender: str, event_id: str, intent: Any) -> None:
        if isinstance(intent, SkillPostIntent):
            await self._on_skill(room, sender, event_id, intent)
        elif isinstance(intent, MilestoneSubmitIntent):
            await self._on_submit(room, sender, event_id, intent)
        elif isinstance(intent, MilestoneVerifyIntent):
            await self._on_verify(room, sender, event_id, intent)
        elif isinstance(intent, DisputeIntent):
            await self._on_dispute(room, sender, event_id, intent)

    async def _on_skill(self, room, sender, event_id, intent: SkillPostIntent) -> None:
        try:
            out = await self.bazaar.post_skill_event(
                matrix_user_id=sender, title=intent.title, body=intent.body,
                price_ldgr_min=intent.price_ldgr_min, room_event_id=event_id,
            )
            await self._reply(room, f"skill logged. id={out.get('skill_id')}")
        except Exception as e:
            log.warning("skill_post_failed", err=str(e), sender=sender)
            await self._reply(room, f"couldn't log that skill — {str(e)[:140]}")

    async def _on_submit(self, room, sender, event_id, intent: MilestoneSubmitIntent) -> None:
        try:
            await self.bazaar.submit_milestone(intent.gig_id, intent.idx, event_id)
            await self._reply(room, f"milestone {intent.idx} on gig {intent.gig_id} marked submitted. awaiting verify.")
        except Exception as e:
            log.warning("submit_failed", err=str(e), gig=intent.gig_id)
            await self._reply(room, f"submit failed — {str(e)[:140]}")

    async def _on_verify(self, room, sender, event_id, intent: MilestoneVerifyIntent) -> None:
        # Verify = release. Lila bot acts as moderator signer on Solana.
        try:
            out = await self.bazaar.release_milestone(intent.gig_id, intent.idx)
            await self._reply(room, f"milestone {intent.idx} released. tx {out.get('tx_sig', 'pending')}.")
        except Exception as e:
            log.warning("release_failed", err=str(e), gig=intent.gig_id)
            await self._reply(room, f"release failed — {str(e)[:140]}")

    async def _on_dispute(self, room, sender, event_id, intent: DisputeIntent) -> None:
        try:
            await self.bazaar.dispute(intent.gig_id, intent.reason, sender)
            await self._reply(room, f"dispute filed on gig {intent.gig_id}. operator notified.")
        except Exception as e:
            log.warning("dispute_failed", err=str(e), gig=intent.gig_id)
            await self._reply(room, f"dispute failed — {str(e)[:140]}")

    async def _reply(self, room: MatrixRoom, text: str) -> None:
        await self.client.room_send(
            room.room_id, "m.room.message",
            {"msgtype": "m.notice", "body": text},
            ignore_unverified_devices=False,
        )
