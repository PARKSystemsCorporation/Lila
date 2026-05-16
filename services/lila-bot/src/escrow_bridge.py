"""Signed HTTP bridge back to the Next.js Bazaar API.

Lila bot does NOT touch the database or Solana directly. When a Matrix event
warrants a state change (skill posted, milestone submitted, milestone
verified, dispute filed), the bot POSTs the canonical JSON event to the
Next.js API with an HMAC header. The Next.js side is the single owner of
the gig state machine and the Solana wallet that signs as moderator.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Mapping

import aiohttp


class BazaarClient:
    def __init__(self, base_url: str, shared_secret: str):
        self.base_url = base_url.rstrip("/")
        self.secret = shared_secret.encode("utf-8")

    def _sign(self, body: str) -> str:
        ts = int(time.time() * 1000)
        mac = hmac.new(self.secret, f"{ts}.{body}".encode("utf-8"), hashlib.sha256).hexdigest()
        return f"t={ts},v1={mac}"

    async def post(self, path: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        sig = self._sign(body)
        async with aiohttp.ClientSession() as s:
            async with s.post(
                f"{self.base_url}{path}",
                data=body,
                headers={"content-type": "application/json", "x-bazaar-sig": sig},
                timeout=aiohttp.ClientTimeout(total=30),
            ) as r:
                text = await r.text()
                if r.status >= 400:
                    raise RuntimeError(f"bazaar {path} → {r.status}: {text[:200]}")
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return {"raw": text}

    async def submit_milestone(self, gig_id: int, idx: int, proof_event_id: str,
                               sender_matrix_id: str) -> dict:
        return await self.post("/api/bazaar/milestones/submit", {
            "gig_id": gig_id, "idx": idx, "proof_event_id": proof_event_id,
            "sender_matrix_id": sender_matrix_id,
        })

    async def release_milestone(self, gig_id: int, idx: int,
                                sender_matrix_id: str) -> dict:
        return await self.post("/api/bazaar/escrow/release", {
            "gig_id": gig_id, "idx": idx, "sender_matrix_id": sender_matrix_id,
        })

    async def dispute(self, gig_id: int, reason: str, actor_matrix_id: str) -> dict:
        return await self.post("/api/bazaar/disputes", {
            "gig_id": gig_id, "reason": reason, "actor_matrix_id": actor_matrix_id,
        })

    async def post_skill_event(self, matrix_user_id: str, title: str, body: str,
                               price_ldgr_min: str, room_event_id: str,
                               matrix_room_id: str) -> dict:
        return await self.post("/api/bazaar/events/skill_posted", {
            "matrix_user_id": matrix_user_id,
            "title": title,
            "body": body,
            "price_ldgr_min": price_ldgr_min,
            "room_event_id": room_event_id,
            "matrix_room_id": matrix_room_id,
        })

    async def register_well_known_room(self, matrix_room_id: str, kind: str) -> dict:
        return await self.post("/api/bazaar/events/well_known_room", {
            "matrix_room_id": matrix_room_id, "kind": kind,
        })

    async def ledger(self, action: str, refs: Mapping[str, Any]) -> dict:
        return await self.post("/api/bazaar/ledger", {
            "actor": "bot", "action": action, "refs": dict(refs),
        })

    async def lila_compose(self, kind: str, ctx: Mapping[str, Any]) -> str:
        """Ask Lila (the brain in Next.js) to compose a moderator line."""
        out = await self.post("/api/agent", {"agent": "lila", "kind": kind, "ctx": dict(ctx)})
        return str(out.get("reply", "")).strip()
