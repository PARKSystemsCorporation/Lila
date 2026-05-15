# Ledger bot — Telegram voice for $LDGR

Python 3.11 + `aiohttp`. Long-polls the Telegram Bot API, hands every
inbound text message to DeepSeek with the Ledger persona prompt, and
posts the reply back. No DB, no on-chain access, no bridge to the Lila
Next.js app — this service is intentionally small.

## Required env

| var | description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather token for the @LedgerBot account |
| `DEEPSEEK_API_KEY` | reused from the main Lila env |
| `LEDGER_MODEL` | default `deepseek-chat` |
| `LEDGER_POLL_TIMEOUT_SEC` | long-poll timeout, default `25` |
| `LEDGER_MAX_HISTORY` | per-chat turns kept in memory, default `8` |
| `LEDGER_RATE_PER_MIN` | per-chat token-bucket rate + capacity, default `4` |
| `LEDGER_DAILY_USD_CAP` | hard daily DeepSeek spend cap, default `0.20` |
| `LEDGER_SPEND_FILE` | on-disk daily spend ledger, default `/tmp/ledger-spend.json` |
| `LEDGER_PRICE_IN_PER_M` | DeepSeek input price per 1M tokens, default `0.27` |
| `LEDGER_PRICE_OUT_PER_M` | DeepSeek output price per 1M tokens, default `1.10` |
| `LEDGER_SYSTEM_PROMPT_OVERRIDE` | optional override for the baked persona |

## Local run

```bash
cd services/ledger-bot
pip install -e .
TELEGRAM_BOT_TOKEN=... DEEPSEEK_API_KEY=... python -m src.main
```

Tests:

```bash
pip install -e .[dev]
python -m pytest
```

## Operational notes

- Privacy mode must be **disabled** in BotFather (`/setprivacy` → Disable)
  for the bot to see every message in groups.
- Chat history is in-memory only; restarting the container resets context.
- The daily spend file is at `/tmp/ledger-spend.json` by default and is
  lost on container restart. Point `LEDGER_SPEND_FILE` at a mounted volume
  if you want spend tracking to survive deploys.
- Two safety gates run before each DeepSeek call: a per-chat 4-msg/min
  token bucket (silent drop on overflow) and the daily USD cap (one-shot
  notice per chat, then silent until UTC rollover).
