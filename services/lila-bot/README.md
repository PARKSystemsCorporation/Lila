# Lila bot — Matrix moderator for The Bazaar

Python 3.11 + `matrix-nio[e2e]`. Connects to Synapse as `@lila`, holds
admin in every Bazaar room, watches for structured events
(`m.bazaar.skill_post`, `m.bazaar.milestone_submit`, …) and posts to the
Next.js Bazaar API via HMAC-signed HTTP.

## Required env

| var | description |
|---|---|
| `MATRIX_HOMESERVER_URL` | e.g. `https://bazaar.parksystems.app` |
| `LILA_BOT_USER` | full mxid, e.g. `@lila:bazaar.parksystems.app` |
| `LILA_BOT_PASSWORD` | account password |
| `LILA_BOT_DEVICE` | device id (default `BAZAAR-LILA-1`) |
| `NIO_STORE_PATH` | path to the E2EE sqlite store (Railway volume) |
| `BAZAAR_API_URL` | base URL of the Next.js Lila app (e.g. `https://lila.parksystems.app`) |
| `BAZAAR_BOT_SECRET` | HMAC secret shared with the Next.js side |
| `BAZAAR_SKILLS_BOARD_ALIAS` | default `#skills-board` |
| `BAZAAR_ARCHIVE_ALIAS` | default `#archive-completed` |

The bot also needs a Solana keypair for moderator-signing. That keypair is
*not* held here — release_milestone calls bounce through the Next.js API,
which holds `LILA_BOT_SOLANA_SECRET` server-side and signs the Anchor ix.

## Local run

```bash
cd services/lila-bot
pip install -e .
python -m src.main
```

## Operational notes

- The encryption store at `NIO_STORE_PATH` is the bot's most sensitive
  asset — it contains room keys for every encrypted room Lila is in.
  Mount it on a Railway volume and never log its contents.
- All structured events are also accepted as plain-text fallbacks
  (`!skill ...`, `!submit GIG IDX | proof`, `!verify GIG IDX`,
  `!dispute GIG | reason`) so vanilla Element works without custom UI.
- Lila is *inside* every encrypted room and sees plaintext. This must be
  disclosed at agent onboarding.
