/**
 * Multi-platform adapters for WhatsApp, Facebook Messenger and Instagram.
 *
 * - Exports three Deno-compatible handlers you can mount in your HTTP server:
 *   - handleWhatsAppWebhook(request: Request): Promise<Response>
 *   - handleFBMessengerWebhook(request: Request): Promise<Response>
 *   - handleInstagramWebhook(request: Request): Promise<Response>
 *
 * - Reuses existing Supabase DB layer (`db.supabase.ts`) for conversation
 *   persistence and prompt storage. Reuses `llmService.deno.ts` for AI.
 *
 * Environment variables (do NOT hardcode):
 * - WHATSAPP_PHONE_ID
 * - WHATSAPP_ACCESS_TOKEN
 * - FB_PAGE_ACCESS_TOKEN
 * - FB_VERIFY_TOKEN
 * - IG_PAGE_ID
 * - IG_ACCESS_TOKEN
 *
 * Notes:
 * - These are minimal, self-contained handlers. Hook them into your
 *   server (e.g. in `index.deno.ts`) at the desired webhook paths.
 * - They follow the general flow: receive webhook -> extract sender + text ->
 *   call shared `processIncomingMessage` -> send reply via platform APIs.
 */

import {
  getLastMessages,
  saveConversation,
  getPrompt,
} from "./db.supabase.ts";
import { generateResponse } from "./llmService.deno.ts";

// ---------------------- Shared processor ----------------------

/**
 * Central processor used by all platforms. It builds the LLM context from
 * the last 5 messages (Supabase), prepends the persisted chat prompt (if any),
 * calls the LLM, and persists the new conversation.
 *
 * platform: short id for logging
 * senderId: platform-specific sender id (string). We cast to number for DB.
 * senderName: optional display name (if available)
 * messageText: incoming user text
 * sendReply: async function to deliver the reply back to the user
 */
export async function processIncomingMessage(
  platform: string,
  senderId: string,
  senderName: string | null,
  messageText: string,
  sendReply: (text: string) => Promise<boolean>,
) {
  // Convert sender id to number for Supabase storage. If the ID is too big for
  // Number precision, consider hashing/shortening it; for now we mirror existing
  // Telegram behavior which also uses numeric chat ids.
  const chatId = Number(senderId);

  try {
    // Load last 5 messages from Supabase (oldest -> newest)
    const history = await getLastMessages(chatId, 5);

    const contextParts: string[] = [];
    for (const item of history) {
      contextParts.push(`User: ${item.user_message}`);
      contextParts.push(`Assistant: ${item.bot_reply}`);
    }

    // Load persisted prompt for the chat (Supabase is the source of truth)
    const storedPrompt = await getPrompt(chatId);
    const combinedUserMessage = storedPrompt && storedPrompt.trim()
      ? `${storedPrompt}\n${messageText}`
      : messageText;

    contextParts.push(`User: ${combinedUserMessage}`);
    const contextString = contextParts.join("\n");

    // Call central LLM core (reuses existing llmService)
    const llmReply = await generateResponse(contextString, "");

    const safeReply = llmReply && llmReply.trim()
      ? llmReply.trim()
      : "Sorry, I'm having trouble right now. Please try again shortly.";

    // Send reply via platform-specific sender
    await sendReply(safeReply);

    // Persist the conversation in Supabase (keep last 5 messages there too)
    await saveConversation(chatId, chatId, senderName ?? null, messageText, safeReply);

    console.log(`[${platform}] processed message from ${senderId}`);
    return true;
  } catch (e) {
    console.error(`[${platform}] processing failed for ${senderId}:`, e);
    return false;
  }
}

// ---------------------- WhatsApp (Meta Cloud) ----------------------

/**
 * Send a WhatsApp message using the Meta WhatsApp Cloud API.
 * Requires WHATSAPP_PHONE_ID and WHATSAPP_ACCESS_TOKEN in env.
 */
export async function sendWhatsAppMessage(to: string, text: string) {
  const phoneId = Deno.env.get("WHATSAPP_PHONE_ID");
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  if (!phoneId || !token) throw new Error("WHATSAPP_PHONE_ID or WHATSAPP_ACCESS_TOKEN not configured");

  const url = `https://graph.facebook.com/v17.0/${phoneId}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error("WhatsApp send failed:", resp.status, txt);
    return false;
  }
  return true;
}

/** Deno-compatible WhatsApp webhook handler */
export async function handleWhatsAppWebhook(request: Request): Promise<Response> {
  // Verification (GET) for webhook setup
  if (request.method === "GET") {
    const url = new URL(request.url);
    const challenge = url.searchParams.get("hub.challenge");
    const mode = url.searchParams.get("hub.mode");
    const verifyToken = url.searchParams.get("hub.verify_token");
    const expected = Deno.env.get("FB_VERIFY_TOKEN");
    if (mode === "subscribe" && verifyToken && expected && verifyToken === expected) {
      return new Response(challenge ?? "", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // Handle incoming messages (POST)
  const payload = await request.json().catch(() => null);
  if (!payload) return new Response(null, { status: 400 });

  try {
    // Typical structure: entry[0].changes[0].value.messages[0]
    const msg = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const phoneNumberId = payload.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    if (!msg) return new Response(null, { status: 200 });

    const from = msg.from; // sender phone number
    const text = msg.text?.body ?? msg.body ?? null;
    if (!text) return new Response(null, { status: 200 });

    // Process and reply
    processIncomingMessage(
      "whatsapp",
      from,
      msg.profile?.name ?? null,
      text,
      async (replyText: string) => await sendWhatsAppMessage(from, replyText),
    ).catch((e) => console.error("WhatsApp processing error:", e));

    // Acknowledge quickly
    return new Response(null, { status: 200 });
  } catch (e) {
    console.error("WhatsApp webhook error:", e);
    return new Response(null, { status: 500 });
  }
}

// ---------------------- Facebook Messenger ----------------------

export async function sendFBMessengerMessage(psid: string, text: string) {
  const token = Deno.env.get("FB_PAGE_ACCESS_TOKEN");
  if (!token) throw new Error("FB_PAGE_ACCESS_TOKEN not configured");

  const url = `https://graph.facebook.com/v17.0/me/messages?access_token=${encodeURIComponent(token)}`;
  const body = {
    recipient: { id: psid },
    message: { text },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error("FB Messenger send failed:", resp.status, txt);
    return false;
  }
  return true;
}

export async function handleFBMessengerWebhook(request: Request): Promise<Response> {
  // Verification (GET)
  if (request.method === "GET") {
    const url = new URL(request.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const expected = Deno.env.get("FB_VERIFY_TOKEN");
    if (mode === "subscribe" && token && expected && token === expected) {
      return new Response(challenge ?? "", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // POST: messaging events
  const payload = await request.json().catch(() => null);
  if (!payload) return new Response(null, { status: 400 });

  try {
    for (const entry of payload.entry ?? []) {
      for (const msgEvent of entry.messaging ?? []) {
        const senderId = msgEvent.sender?.id;
        const text = msgEvent.message?.text;
        const senderName = msgEvent.sender?.name ?? null;
        if (!senderId || !text) continue;

        processIncomingMessage(
          "facebook",
          String(senderId),
          senderName,
          String(text),
          async (replyText: string) => await sendFBMessengerMessage(String(senderId), replyText),
        ).catch((e) => console.error("FB Messenger processing error:", e));
      }
    }

    // Per Messenger requirements, respond quickly
    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch (e) {
    console.error("FB Messenger webhook error:", e);
    return new Response(null, { status: 500 });
  }
}

// ---------------------- Instagram Messaging ----------------------

export async function sendInstagramMessage(recipientId: string, text: string) {
  const igId = Deno.env.get("IG_PAGE_ID");
  const token = Deno.env.get("IG_ACCESS_TOKEN");
  if (!igId || !token) throw new Error("IG_PAGE_ID or IG_ACCESS_TOKEN not configured");

  // Instagram Messaging uses the Graph API; this endpoint may vary by API version.
  const url = `https://graph.facebook.com/v17.0/${igId}/messages`;
  const body = {
    recipient: { id: recipientId },
    message: { text },
  };

  const resp = await fetch(`${url}?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error("Instagram send failed:", resp.status, txt);
    return false;
  }
  return true;
}

export async function handleInstagramWebhook(request: Request): Promise<Response> {
  // Verification (GET similar to Facebook)
  if (request.method === "GET") {
    const url = new URL(request.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const expected = Deno.env.get("FB_VERIFY_TOKEN");
    if (mode === "subscribe" && token && expected && token === expected) {
      return new Response(challenge ?? "", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  const payload = await request.json().catch(() => null);
  if (!payload) return new Response(null, { status: 400 });

  try {
    // Instagram messaging payloads resemble WhatsApp's structure in Graph API
    const msg = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0] ?? null;
    if (!msg) return new Response(null, { status: 200 });

    const from = msg.from ?? msg.sender ?? null;
    const text = msg.text?.body ?? msg.body ?? msg.message?.text ?? null;
    if (!from || !text) return new Response(null, { status: 200 });

    processIncomingMessage(
      "instagram",
      String(from),
      msg.profile?.name ?? null,
      String(text),
      async (replyText: string) => await sendInstagramMessage(String(from), replyText),
    ).catch((e) => console.error("Instagram processing error:", e));

    return new Response(null, { status: 200 });
  } catch (e) {
    console.error("Instagram webhook error:", e);
    return new Response(null, { status: 500 });
  }
}

// End of platformAdapters.deno.ts
