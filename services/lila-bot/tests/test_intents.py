"""Unit tests for services/lila-bot/src/intents.py.

Run with:
  cd services/lila-bot
  python -m pytest tests/

Or from repo root:
  PYTHONPATH=services/lila-bot python -m pytest services/lila-bot/tests/
"""
from src.intents import (
    DisputeIntent,
    MilestoneSubmitIntent,
    MilestoneVerifyIntent,
    SkillPostIntent,
    parse_custom_event,
    parse_plain_text,
)

# ── plain-text fallback ─────────────────────────────────────────────────────

class TestPlainText:
    def test_skill_basic(self):
        i = parse_plain_text("!skill rust audit | 250 ldgr | full audit of an SPL token program")
        assert isinstance(i, SkillPostIntent)
        assert i.title == "rust audit"
        assert i.price_ldgr_min == "250"
        assert i.body.startswith("full audit")

    def test_skill_decimal_price(self):
        i = parse_plain_text("!skill quick fix | 12.5 ldgr | tiny help")
        assert isinstance(i, SkillPostIntent)
        assert i.price_ldgr_min == "12.5"

    def test_skill_multiline_body(self):
        i = parse_plain_text("!skill big job | 500 ldgr | line1\nline2\nline3")
        assert isinstance(i, SkillPostIntent)
        assert "line1" in i.body and "line3" in i.body

    def test_skill_case_insensitive(self):
        i = parse_plain_text("!SKILL Foo | 1 LDGR | bar")
        assert isinstance(i, SkillPostIntent)
        assert i.title == "Foo"

    def test_submit_basic(self):
        i = parse_plain_text("!submit 42 0 | here is the artifact link")
        assert isinstance(i, MilestoneSubmitIntent)
        assert i.gig_id == 42 and i.idx == 0
        assert "artifact" in i.proof_text

    def test_submit_no_proof(self):
        i = parse_plain_text("!submit 9 3")
        assert isinstance(i, MilestoneSubmitIntent)
        assert i.gig_id == 9 and i.idx == 3 and i.proof_text == ""

    def test_verify_basic(self):
        i = parse_plain_text("!verify 17 2")
        assert isinstance(i, MilestoneVerifyIntent)
        assert i.gig_id == 17 and i.idx == 2

    def test_verify_rejects_extra_payload(self):
        # !verify takes only two ints — extra body must not match so we
        # don't accidentally release on a comment like "!verify 1 0 not yet"
        i = parse_plain_text("!verify 1 0 not yet")
        assert i is None

    def test_dispute_basic(self):
        i = parse_plain_text("!dispute 5 | hirer ghosted after milestone 1")
        assert isinstance(i, DisputeIntent)
        assert i.gig_id == 5
        assert "ghosted" in i.reason

    def test_dispute_requires_reason(self):
        # The pipe is mandatory — `!dispute 5` should not match.
        i = parse_plain_text("!dispute 5")
        assert i is None

    def test_no_command_returns_none(self):
        assert parse_plain_text("hello, how are you?") is None
        assert parse_plain_text("") is None
        assert parse_plain_text("   ") is None

    def test_non_prefix_returns_none(self):
        # Bang must be at the start. Embedded bangs are not commands.
        assert parse_plain_text("said !skill foo | 1 ldgr | bar") is None

    def test_whitespace_tolerant(self):
        i = parse_plain_text("  !verify 3 1  ")
        assert isinstance(i, MilestoneVerifyIntent)


# ── custom-event parser ─────────────────────────────────────────────────────

class TestCustomEvents:
    def test_skill_post_event(self):
        i = parse_custom_event("m.bazaar.skill_post", {
            "title": "audit", "body": "audit body", "price_ldgr_min": "100",
        })
        assert isinstance(i, SkillPostIntent)
        assert i.price_ldgr_min == "100"

    def test_skill_post_missing_field_returns_none(self):
        i = parse_custom_event("m.bazaar.skill_post", {"title": "audit"})
        assert i is None

    def test_milestone_submit_event(self):
        i = parse_custom_event("m.bazaar.milestone_submit", {
            "gig_id": 7, "idx": 1, "proof": "https://drive/..."
        })
        assert isinstance(i, MilestoneSubmitIntent)
        assert i.gig_id == 7 and i.idx == 1
        assert "drive" in i.proof_text

    def test_milestone_submit_proof_defaults_empty(self):
        i = parse_custom_event("m.bazaar.milestone_submit", {"gig_id": 7, "idx": 1})
        assert isinstance(i, MilestoneSubmitIntent)
        assert i.proof_text == ""

    def test_milestone_verify_event(self):
        i = parse_custom_event("m.bazaar.milestone_verify", {"gig_id": 7, "idx": 1})
        assert isinstance(i, MilestoneVerifyIntent)

    def test_dispute_event(self):
        i = parse_custom_event("m.bazaar.dispute", {"gig_id": 7, "reason": "broken"})
        assert isinstance(i, DisputeIntent)
        assert i.reason == "broken"

    def test_unknown_event_type(self):
        assert parse_custom_event("m.room.message", {"body": "hi"}) is None
        assert parse_custom_event("m.bazaar.unknown", {}) is None

    def test_malformed_payload(self):
        # int() on a non-numeric should be caught and return None, not raise.
        assert parse_custom_event("m.bazaar.milestone_submit",
                                  {"gig_id": "not-a-number", "idx": 0}) is None
