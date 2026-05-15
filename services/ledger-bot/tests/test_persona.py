"""Sanity-check the baked persona prompt carries the canonical facts.

A stray edit that drops the mint or pump.fun URL would let Ledger
hallucinate. Cheap test, big payoff.
"""
from src.persona import LDGR_MINT, LDGR_PUMP_URL, LEDGER_SYSTEM_PROMPT


def test_mint_address_present():
    assert LDGR_MINT == "7VCPGGaKqeVjtLEe4o4gJUb8Je3ZZm8UA3aB9S3dpump"
    assert LDGR_MINT in LEDGER_SYSTEM_PROMPT


def test_pump_url_present():
    assert LDGR_PUMP_URL == "https://join.pump.fun/HSag/krnfizbx"
    assert LDGR_PUMP_URL in LEDGER_SYSTEM_PROMPT


def test_identity_and_routing():
    p = LEDGER_SYSTEM_PROMPT.lower()
    assert "ledger" in p
    assert "park systems" in p
    assert "lila" in p  # sibling routing
    assert "parksystems.app" in p


def test_guardrails():
    p = LEDGER_SYSTEM_PROMPT.lower()
    assert "never invent prices" in p
    assert "never give financial advice" in p
    assert "refuse" in p  # never sends funds
