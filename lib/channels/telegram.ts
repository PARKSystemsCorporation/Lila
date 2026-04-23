// Telegram bot messaging via Bot API (free, unlimited for sane volumes).
//
// Setup on mobile:
//   1. Open Telegram, search @BotFather → /newbot → follow prompts. Copy the
//      HTTP API token.
//   2. Create a Telegram channel (or chat), add the bot as an admin with
//      "Post Messages" permission.
//   3. Get the chat_id: send any message to the channel, then hit
//      https://api.telegram.org/bot<TOKEN>/getUpdates in a browser — the id
//      is under result[*].channel_post.chat.id (negative number for channels).
//
// Set on Railway:
//   TELEGRAM_BOT_TOKEN = 1234567890:AAF...
//   TELEGRAM_CHAT_ID   = -1001234567890   (or your personal chat id)

export function isConfigured(): boolean {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
}

// parseMode defaults to *none* now — callers opt-in to Markdown/HTML. This
// means arbitrary text (e.g. broadcast posts) can't trip Telegram's strict
// parser with stray underscores or asterisks.
export async function sendMessage(
  text: string,
  opts: { parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML' } = {},
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return { ok: false, error: 'Telegram not configured' }

  const body: Record<string, unknown> = {
    chat_id: chatId,
    // Cap at Telegram's 4096-char message limit, leave margin for safety.
    text: text.slice(0, 4000),
    disable_web_page_preview: true,
  }
  if (opts.parseMode) body.parse_mode = opts.parseMode

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const respBody = await res.text().catch(() => '')
      return { ok: false, error: `Telegram ${res.status}: ${respBody.slice(0, 300)}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `Telegram network: ${String(e)}` }
  }
}
