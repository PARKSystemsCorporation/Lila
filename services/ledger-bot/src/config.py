"""Bot config from env."""
from __future__ import annotations
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class BotConfig:
    telegram_token: str
    deepseek_api_key: str
    model: str
    poll_timeout_sec: int
    max_history: int
    rate_per_min: int
    daily_usd_cap: float
    spend_file: str
    price_in_per_m: float
    price_out_per_m: float
    system_prompt_override: str | None

    @classmethod
    def from_env(cls) -> "BotConfig":
        def need(name: str) -> str:
            v = os.environ.get(name)
            if not v:
                raise SystemExit(f"missing env: {name}")
            return v

        return cls(
            telegram_token=need("TELEGRAM_BOT_TOKEN"),
            deepseek_api_key=need("DEEPSEEK_API_KEY"),
            model=os.environ.get("LEDGER_MODEL", "deepseek-chat"),
            poll_timeout_sec=int(os.environ.get("LEDGER_POLL_TIMEOUT_SEC", "25")),
            max_history=int(os.environ.get("LEDGER_MAX_HISTORY", "8")),
            rate_per_min=int(os.environ.get("LEDGER_RATE_PER_MIN", "4")),
            daily_usd_cap=float(os.environ.get("LEDGER_DAILY_USD_CAP", "0.20")),
            spend_file=os.environ.get("LEDGER_SPEND_FILE", "/tmp/ledger-spend.json"),
            price_in_per_m=float(os.environ.get("LEDGER_PRICE_IN_PER_M", "0.27")),
            price_out_per_m=float(os.environ.get("LEDGER_PRICE_OUT_PER_M", "1.10")),
            system_prompt_override=os.environ.get("LEDGER_SYSTEM_PROMPT_OVERRIDE") or None,
        )
