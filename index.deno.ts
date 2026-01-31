/**
import { getAdminStats, initDatabase, setPrompt as dbSetPrompt } from "./db.supabase.ts";
 * 
 * Endpoints:
 * - POST /api/telegram/webhook - Telegram webhook handler
 * - GET /admin - Admin dashboard data
 * - GET /health - Health check
 * 
 * Run: deno run -A index.deno.ts
 * Deploy: Compatible with Deno Deploy
 */

import { handleTelegramUpdate, validateWebhookSecret } from "./botController.deno.ts";
import { dataStore, type MessageRecord } from "./dataStore.deno.ts";
import { getAdminStats, initDatabase } from "./db.supabase.ts";
import {
  handleWhatsAppWebhook,
  handleFBMessengerWebhook,
  handleInstagramWebhook,
  processIncomingMessage,
  sendFBMessengerMessage,
} from "./platformAdapters.deno.ts";
// Use Web Crypto for HMAC-SHA256 to avoid external std imports that may break
// during builds. This runs in Deno and Deno Deploy.

async function verifyMetaSignature(appSecret: string, rawBody: string, signatureHeader: string): Promise<boolean> {
  try {
    if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
    const expectedHex = signatureHeader.slice("sha256=".length);
    const enc = new TextEncoder();
    const keyData = enc.encode(appSecret);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(rawBody));
    const sigBytes = new Uint8Array(signature);
    let hex = "";
    for (const b of sigBytes) hex += b.toString(16).padStart(2, "0");
    return hex === expectedHex;
  } catch (e) {
    console.error("verifyMetaSignature error:", e);
    return false;
  }
}

const PORT = parseInt(Deno.env.get("PORT") || "8000");

// Initialize Supabase schema helpers (safe no-op if RPC isn't available or tables already exist)
// NOTE: This should not block the server from starting.
initDatabase().catch((err) => {
  console.warn("Supabase initDatabase() failed (continuing anyway):", err);
});

// CORS headers for API calls
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Telegram-Bot-Api-Secret-Token",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/plain",
    },
  });
}

// Small helper to escape HTML in the admin UI
function escapeHtml(str: string) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Handle CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Health check endpoint
  if (path === "/health" && method === "GET") {
    return textResponse("OK");
  }

  // Admin endpoint - detailed stats from Supabase
  if (path === "/admin" && method === "GET") {
    try {
      // Use Supabase as the authoritative persistent store
      const adminData = await getAdminStats();
      return jsonResponse(adminData);
    } catch (err) {
      console.error("Admin stats error:", err);
      return jsonResponse({ error: "Failed to retrieve admin stats" }, 500);
    }
  }

  // Telegram webhook endpoint
  if (path === "/api/telegram/webhook" && method === "POST") {
    const webhookSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") || "";
    const requestSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");

    if (!validateWebhookSecret(requestSecret, webhookSecret)) {
      console.warn("Invalid webhook secret received");
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    try {
      const update = await request.json();
      const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
      const groqApiKey = Deno.env.get("GROQ_API_KEY"); // ONLY Groq now

      if (!botToken) {
        console.error("TELEGRAM_BOT_TOKEN not configured");
        return jsonResponse({ error: "Bot token not configured" }, 500);
      }

      if (!groqApiKey) {
        console.error("GROQ_API_KEY not configured");
        return jsonResponse({ error: "Groq API key not configured" }, 500);
      }

      // Process asynchronously - don't await to return quickly to Telegram
      handleTelegramUpdate(update, botToken, groqApiKey).catch((err) => {
        console.error("Error processing update:", err);
      });

      return jsonResponse({ ok: true });
    } catch (error) {
      console.error("Webhook error:", error);
      return jsonResponse({ error: "Invalid request body" }, 400);
    }
  }

  // WhatsApp webhook (Meta) - GET for verification, POST for messages
  if (path === "/api/whatsapp/webhook") {
    const required = ["WHATSAPP_PHONE_ID", "WHATSAPP_ACCESS_TOKEN", "FB_VERIFY_TOKEN"];
    const missing = required.filter((k) => !Deno.env.get(k));
    if (missing.length > 0) {
      // Fallback: log and return 200 so external webhook pings don't fail
      console.warn(`WhatsApp webhook hit but missing env vars: ${missing.join(", ")}`);
      return jsonResponse({ ok: true, warning: `WhatsApp not configured: missing ${missing.join(", ")}` }, 200);
    }
    return handleWhatsAppWebhook(request);
  }
  
  // Unified Meta webhook for Facebook Messenger + Instagram
  if (path === "/webhook/meta") {
    // GET: verification
    if (method === "GET") {
      const url = new URL(request.url);
      const mode = url.searchParams.get("hub.mode");
      const verifyToken = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
  const expected = Deno.env.get("FB_VERIFY_TOKEN");
      if (mode === "subscribe" && verifyToken && expected && verifyToken === expected) {
        console.log("Meta webhook verified successfully");
        return new Response(challenge ?? "", { status: 200 });
      }
      console.warn("Meta webhook verification failed");
      return new Response("Forbidden", { status: 403 });
    }

    // POST: event notifications
    if (method === "POST") {
      // Read raw body text for signature verification
      const rawBody = await request.text();

      // Signature header
      const signature = request.headers.get("x-hub-signature-256") || "";

      const appSecret = Deno.env.get("FB_APP_SECRET");
      if (!appSecret) {
        console.error("Meta app secret not configured (FB_APP_SECRET)");
        return jsonResponse({ error: "Server misconfiguration" }, 500);
      }

      // Verify signature: header format is "sha256=..."
      if (!signature.startsWith("sha256=")) {
        console.warn("Missing x-hub-signature-256 header");
        return new Response(null, { status: 403 });
      }

      try {
        const ok = await verifyMetaSignature(appSecret, rawBody, signature);
        if (!ok) {
          console.warn("Invalid Meta webhook signature");
          return new Response(null, { status: 403 });
        }
      } catch (e) {
        console.error("Meta signature verification error:", e);
        return new Response(null, { status: 403 });
      }

      // Parse JSON and respond quickly per platform requirement
      let body: any;
      try {
        body = JSON.parse(rawBody);
      } catch (e) {
        console.error("Invalid JSON payload from Meta webhook:", e);
        return new Response(null, { status: 400 });
      }

      // If not a page event, ignore
      if (body.object !== "page") {
        return new Response(null, { status: 404 });
      }

      // Acknowledge immediately
      (async () => {
        try {
          for (const entry of body.entry ?? []) {
            const pageId = entry.id ?? entry?.messaging?.[0]?.recipient?.id ?? null;
            for (const messagingEvent of entry.messaging ?? []) {
              const senderId = messagingEvent.sender?.id ?? messagingEvent.sender?.phone_number ?? null;
              const messageText = messagingEvent.message?.text ?? messagingEvent.message?.text?.body ?? null;
              if (!senderId || !messageText) continue;

              console.log("Meta webhook event: page=", pageId, "from=", senderId, "text=", messageText);

              // Forward to shared processor using Facebook messenger sender
              processIncomingMessage(
                "facebook",
                String(senderId),
                messagingEvent.sender?.name ?? null,
                String(messageText),
                async (replyText: string) => await sendFBMessengerMessage(String(senderId), replyText),
              ).catch((err) => console.error("Failed to process meta message:", err));
            }
          }
        } catch (e) {
          console.error("Error handling Meta events async:", e);
        }
      })();

      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    return new Response(null, { status: 405 });
  }
  // Facebook Messenger webhook
  if (path === "/api/fb/webhook") {
    const required = ["FB_PAGE_ACCESS_TOKEN", "FB_VERIFY_TOKEN"];
    const missing = required.filter((k) => !Deno.env.get(k));
    if (missing.length > 0) {
      console.warn(`FB webhook hit but missing env vars: ${missing.join(", ")}`);
      return jsonResponse({ ok: true, warning: `Facebook Messenger not configured: missing ${missing.join(", ")}` }, 200);
    }
    return handleFBMessengerWebhook(request);
  }

  // Instagram webhook
  if (path === "/api/ig/webhook") {
    const required = ["IG_PAGE_ID", "IG_ACCESS_TOKEN", "FB_VERIFY_TOKEN"];
    const missing = required.filter((k) => !Deno.env.get(k));
    if (missing.length > 0) {
      console.warn(`IG webhook hit but missing env vars: ${missing.join(", ")}`);
      return jsonResponse({ ok: true, warning: `Instagram not configured: missing ${missing.join(", ")}` }, 200);
    }
    return handleInstagramWebhook(request);
  }

  // 404 for unknown routes
  return jsonResponse({ error: "Not found" }, 404);
}

// Start server
console.log(`🚀 Telegram Bot Backend starting on port ${PORT}`);
console.log(`📍 Endpoints:`);
console.log(`   POST /api/telegram/webhook - Telegram updates`);
console.log(`   GET  /admin               - Admin dashboard`);
console.log(`   GET  /health              - Health check`);

Deno.serve({ port: PORT }, handleRequest);
