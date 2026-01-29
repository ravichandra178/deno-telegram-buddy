# Welcome to your Lovable project

## Project info

**URL**:

# deno-telegram-buddy

Lightweight Deno-based AI chat backend that currently supports Telegram and
adds adapters for WhatsApp, Facebook Messenger and Instagram. It uses a
central GROQ LLM integration and Supabase for persistence (conversations and
per-chat prompts). Conversation memory is limited to the last 5 messages per
chat to keep LLM context small.

## Features

- Telegram webhook handler (existing)
- Supabase-backed conversation storage (conversations + chat_prompts)
- Per-chat prompts via `/setprompt` and `/getprompt`
- Persistent memory: last 5 messages per chat (Supabase)
- Central LLM core (reuses `llmService.deno.ts`) for all platforms
- New multi-platform adapters in `platformAdapters.deno.ts` for:
	- WhatsApp (Meta Cloud)
	- Facebook Messenger
	- Instagram Messaging
- Admin endpoint (`GET /admin`) reads authoritative stats from Supabase

## Important files

- `index.deno.ts` — main Deno server and routes
- `botController.deno.ts` — Telegram logic (commands, message flow)
- `db.supabase.ts` — Supabase integration (conversations, prompts, pruning)
- `llmService.deno.ts` — central LLM integration (GROQ)
- `platformAdapters.deno.ts` — new multi-platform webhook handlers and senders
- `kvStore.deno.ts` — (optional) Deno.KV wrapper and helpers (fallbacks)

## Environment variables

Set these in your deployment environment (do NOT hardcode values):

- `TELEGRAM_BOT_TOKEN` — Telegram bot token
- `TELEGRAM_WEBHOOK_SECRET` — optional Telegram webhook secret token
- `GROQ_API_KEY` — API key used by the LLM service
- `SUPABASE_URL` — Supabase URL
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key
- `WHATSAPP_PHONE_ID` — WhatsApp Cloud phone ID (for WhatsApp send)
- `WHATSAPP_ACCESS_TOKEN` — WhatsApp Cloud access token
- `FB_PAGE_ACCESS_TOKEN` — Facebook Page token (Messenger)
- `FB_VERIFY_TOKEN` — verification token for FB webhooks (Messenger & IG)
- `IG_PAGE_ID` — Instagram page id used for messaging
- `IG_ACCESS_TOKEN` — Instagram access token

Only set the platform envs for the platforms you plan to enable; the server
gracefully falls back (logs a warning and returns a harmless OK) if a webhook
is hit while its env vars are missing.

## Endpoints

- POST /api/telegram/webhook — Telegram updates
- POST /api/whatsapp/webhook — WhatsApp webhook (GET used for verification)
- POST /api/fb/webhook — Facebook Messenger webhook (GET verification)
- POST /api/ig/webhook — Instagram webhook (GET verification)
- GET /admin — Admin stats (Supabase)
- GET /health — Health check

Note: `platformAdapters.deno.ts` already implements the GET verification
behavior required by Meta webhooks.

## Message flow (shared)

1. Webhook receives message (Telegram / WhatsApp / Messenger / Instagram)
2. Handler extracts sender id, optional display name and text
3. The shared `processIncomingMessage()`:
	 - Loads the last 5 messages from Supabase
	 - Loads the persisted per-chat prompt from Supabase (if present)
	 - Builds a context in the format `User: ...\nAssistant: ...` and appends the
		 combined user prompt + user message
	 - Calls the central LLM (`generateResponse`) with the full context
	 - Sends reply back to the user via platform-specific API
	 - Persists the interaction into Supabase (so the last-5 window is maintained)

## Commands (Telegram)

- `/setprompt <text>` — saves a per-chat prompt to Supabase (used for future
	messages; does not trigger the LLM immediately)
- `/getprompt` — returns the current per-chat prompt (prefers Supabase)

## Run locally

You need Deno installed. To run locally with required capabilities:

```bash
# Allow env + network and unstable features for local testing
deno run -A --unstable index.deno.ts
```

Notes:
- When running locally without platform env vars, the server will accept
	webhook pings at platform endpoints and return a harmless OK while logging
	the missing config (this prevents webhook retries from the platform).
- When testing Telegram flows, set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`.

## Deploy

On Deno Deploy set the environment variables above and configure webhook
URLs in each platform to point at the corresponding `/api/*/webhook` path. On
Deploy, Deno KV is available if you want to use it directly; this project uses
Supabase as the primary persistence store for conversations and prompts.

## Debugging tips

- Check the server logs for any Supabase errors when saving prompts or
	conversations — the `/admin` endpoint reads Supabase and will show `null`
	prompts if the `chat_prompts` table wasn't updated successfully.
- You can call `/admin` to inspect current per-chat prompts and recent
	messages (Supabase is the source of truth).

## Extending or changing behavior

- The shared core is `processIncomingMessage()` in `platformAdapters.deno.ts`.
	If you need custom platform-specific preprocessing (attachments, images,
	buttons) modify the adapter to normalize inputs before calling the core.
- If you prefer to make Supabase *not* the source of truth for prompts, update
	the `/setprompt` flow in `botController.deno.ts` and the adapters accordingly.

## License

MIT
