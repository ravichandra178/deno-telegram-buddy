/**
 * Telegram Bot Backend - Main Deno Server
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
import { dataStore } from "./dataStore.deno.ts";

const PORT = parseInt(Deno.env.get("PORT") || "8000");

// CORS headers for API calls
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Telegram-Bot-Api-Secret-Token",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
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

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Handle CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // Health check endpoint
  if (path === "/health" && method === "GET") {
    return textResponse("OK");
  }

  // Admin endpoint
  if (path === "/admin" && method === "GET") {
    const stats = dataStore.getStats();
    return jsonResponse(stats);
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
      const llmApiKey = Deno.env.get("LLM_API_KEY");

      if (!botToken) {
        console.error("TELEGRAM_BOT_TOKEN not configured");
        return jsonResponse({ error: "Bot token not configured" }, 500);
      }

      // Process asynchronously - don't await to return quickly to Telegram
      handleTelegramUpdate(update, botToken, llmApiKey || "").catch((err) => {
        console.error("Error processing update:", err);
      });

      // Return 200 OK immediately to Telegram
      return jsonResponse({ ok: true });
    } catch (error) {
      console.error("Webhook error:", error);
      return jsonResponse({ error: "Invalid request body" }, 400);
    }
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
