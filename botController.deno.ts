/**
 * Telegram Bot Controller - handles updates and commands
 * Compatible with Groq-only LLM service
 */

import { dataStore, type MessageRecord } from "./dataStore.deno.ts";
import { generateResponse } from "./llmService.deno.ts";
import { getLastMessages, saveInteraction } from "./kvStore.deno.ts";

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: {
    id: number;
    type: string;
  };
  date: number;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";

/* ---------------- Send message to Telegram ---------------- */
async function sendTelegramMessage(
  botToken: string,
  chatId: number,
  text: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `${TELEGRAM_API_BASE}${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Telegram API error:", response.status, errorText);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
    return false;
  }
}

/* ---------------- Handle incoming Telegram updates ---------------- */
export async function handleTelegramUpdate(
  update: TelegramUpdate,
  botToken: string,
  llmApiKey: string
): Promise<void> {
  const message = update.message;

  if (!message || !message.text) {
    console.log("Received update without text message, skipping");
    return;
  }

  const userId = message.from?.id ?? 0;
  const username = message.from?.username ?? null;
  const firstName = message.from?.first_name ?? null;
  const chatId = message.chat.id;
  const userText = message.text.trim();

  console.log(`Processing message from ${username || userId}: ${userText}`);

  // ---------------- Handle /start command ----------------
  if (userText === "/start") {
    const welcomeMessage = `👋 Hello${firstName ? ` ${firstName}` : ""}! I'm an AI-powered bot. Send me any message and I'll respond using advanced language models.`;
    await sendTelegramMessage(botToken, chatId, welcomeMessage);

    const record: MessageRecord = {
      id: dataStore.generateId(),
      userId,
      username,
      firstName,
      text: userText,
      response: welcomeMessage,
      timestamp: new Date().toISOString(),
    };
    dataStore.addMessage(record);
    // Persist the /start interaction into KV memory as well
    // This helps keep a consistent conversation history per chatId.
    await saveInteraction(chatId, userId, username, userText, welcomeMessage);
    return;
  }

  // ---------------- Handle /help command ----------------
  if (userText === "/help") {
    const helpMessage = `🤖 *Bot Commands*\n\n/start - Start the bot\n/help - Show this help message\n\nJust send me any text and I'll respond using AI!`;
    await sendTelegramMessage(botToken, chatId, helpMessage);

    const record: MessageRecord = {
      id: dataStore.generateId(),
      userId,
      username,
      firstName,
      text: userText,
      response: helpMessage,
      timestamp: new Date().toISOString(),
    };
    dataStore.addMessage(record);
    // Persist the /help interaction into KV memory as well
    await saveInteraction(chatId, userId, username, userText, helpMessage);
    return;
  }

  // ---------------- Generate LLM response ----------------
  let llmResult: string;

  try {
    // Load last 5 messages for this chat to build the LLM context
    const history = await getLastMessages(chatId, 5);

    // Build context in the required exact format: "User: ...\nAssistant: ..."
    // Maintain chronological order (oldest -> newest)
    let contextParts: string[] = [];
    for (const item of history) {
      // Each stored record becomes two lines in the context
      contextParts.push(`User: ${item.userMessage}`);
      contextParts.push(`Assistant: ${item.botReply}`);
    }

    // Append the new user message at the end per requirements
    contextParts.push(`User: ${userText}`);

    const contextString = contextParts.join("\n");

    // Send the composed context to the LLM service. llmService now expects a single
    // context string containing the history + new user message.
    llmResult = await generateResponse(contextString);
  } catch (err) {
    console.error("❌ LLM generation failed:", err);
    llmResult = "Sorry, I'm having trouble right now. Please try again shortly.";
  }

  // Ensure the message is never empty
  const safeMessage = llmResult && llmResult.trim()
    ? llmResult.trim()
    : "Sorry, I'm having trouble right now. Please try again shortly.";

  // Send the response to Telegram
  await sendTelegramMessage(botToken, chatId, safeMessage);

  // Store the interaction
  const record: MessageRecord = {
    id: dataStore.generateId(),
    userId,
    username,
    firstName,
    text: userText,
    response: safeMessage,
    timestamp: new Date().toISOString(),
  };
  dataStore.addMessage(record);

  // Persist the interaction into Deno KV memory (keeps last 5 messages per chat)
  // This runs in parallel but we `await` to ensure pruning happens before next message.
  await saveInteraction(chatId, userId, username, userText, safeMessage);

  console.log(`Processed message for ${username || userId}, success: true`);
}

/* ---------------- Validate webhook secret ---------------- */
export function validateWebhookSecret(
  requestSecret: string | null,
  expectedSecret: string
): boolean {
  if (!expectedSecret) {
    console.warn("TELEGRAM_WEBHOOK_SECRET not configured, skipping validation");
    return true;
  }

  return requestSecret === expectedSecret;
}
