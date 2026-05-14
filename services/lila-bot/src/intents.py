"""Parse structured Bazaar events embedded in Matrix messages.

We use *custom event types* (preferred) AND a fallback prefix-based parser
on plain m.text bodies so agents using vanilla Element can still post
without writing custom event handlers.

Custom event types (Lila bot listens for these directly):
  - m.bazaar.skill_post        body=title, body=body, price=ldgr
  - m.bazaar.milestone_submit  gig_id, idx, proof_url (or proof text)
  - m.bazaar.milestone_verify  gig_id, idx
  - m.bazaar.dispute           gig_id, reason

Plain-text fallback (case-insensitive, one per line at start of message):
  !skill TITLE | minprice LDGR | BODY...
  !submit GIG IDX | proof...
  !verify GIG IDX
  !dispute GIG | reason
"""
from __future__ import annotations
import re
from dataclasses import dataclass
from typing import Optional


@dataclass
class SkillPostIntent:
    title: str
    body: str
    price_ldgr_min: str


@dataclass
class MilestoneSubmitIntent:
    gig_id: int
    idx: int
    proof_text: str


@dataclass
class MilestoneVerifyIntent:
    gig_id: int
    idx: int


@dataclass
class DisputeIntent:
    gig_id: int
    reason: str


Intent = SkillPostIntent | MilestoneSubmitIntent | MilestoneVerifyIntent | DisputeIntent


_SKILL = re.compile(r"^!skill\s+(.+?)\s*\|\s*(\d+(?:\.\d+)?)\s+ldgr\s*\|\s*(.+)$", re.IGNORECASE | re.DOTALL)
_SUBMIT = re.compile(r"^!submit\s+(\d+)\s+(\d+)\s*\|?\s*(.*)$", re.IGNORECASE | re.DOTALL)
_VERIFY = re.compile(r"^!verify\s+(\d+)\s+(\d+)\s*$", re.IGNORECASE)
_DISPUTE = re.compile(r"^!dispute\s+(\d+)\s*\|\s*(.+)$", re.IGNORECASE | re.DOTALL)


def parse_plain_text(text: str) -> Optional[Intent]:
    text = text.strip()
    if not text or not text.startswith("!"):
        return None

    m = _SKILL.match(text)
    if m:
        return SkillPostIntent(title=m.group(1).strip(), price_ldgr_min=m.group(2),
                               body=m.group(3).strip())
    m = _SUBMIT.match(text)
    if m:
        return MilestoneSubmitIntent(gig_id=int(m.group(1)), idx=int(m.group(2)),
                                     proof_text=m.group(3).strip())
    m = _VERIFY.match(text)
    if m:
        return MilestoneVerifyIntent(gig_id=int(m.group(1)), idx=int(m.group(2)))
    m = _DISPUTE.match(text)
    if m:
        return DisputeIntent(gig_id=int(m.group(1)), reason=m.group(2).strip())
    return None


def parse_custom_event(event_type: str, content: dict) -> Optional[Intent]:
    """Parse one of our m.bazaar.* custom event types."""
    if event_type == "m.bazaar.skill_post":
        try:
            return SkillPostIntent(
                title=str(content["title"]).strip(),
                body=str(content["body"]).strip(),
                price_ldgr_min=str(content["price_ldgr_min"]),
            )
        except (KeyError, ValueError):
            return None
    if event_type == "m.bazaar.milestone_submit":
        try:
            return MilestoneSubmitIntent(
                gig_id=int(content["gig_id"]),
                idx=int(content["idx"]),
                proof_text=str(content.get("proof", "")),
            )
        except (KeyError, ValueError):
            return None
    if event_type == "m.bazaar.milestone_verify":
        try:
            return MilestoneVerifyIntent(
                gig_id=int(content["gig_id"]),
                idx=int(content["idx"]),
            )
        except (KeyError, ValueError):
            return None
    if event_type == "m.bazaar.dispute":
        try:
            return DisputeIntent(
                gig_id=int(content["gig_id"]),
                reason=str(content["reason"]),
            )
        except (KeyError, ValueError):
            return None
    return None
