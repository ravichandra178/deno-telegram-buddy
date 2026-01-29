/**
 * Supabase Database Module for Telegram Bot
 * Handles all persistent storage using Supabase PostgreSQL
 * 
 * Environment variables required:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Types for database records
export interface ConversationRecord {
  id?: string;
  chat_id: number;
  user_id: number;
  username: string | null;
  user_message: string;
  bot_reply: string;
  created_at?: string;
}

export interface ChatPromptRecord {
  chat_id: number;
  prompt: string;
  updated_at?: string;
}

// Supabase client singleton
let supabase: SupabaseClient | null = null;

/**
 * Get or create Supabase client instance
 */
function getClient(): SupabaseClient {
  if (supabase) return supabase;

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }

  supabase = createClient(url, key, {
    auth: { persistSession: false },
  });

  return supabase;
}

/**
 * Initialize database tables if they don't exist
 * Called once on startup
 */
export async function initDatabase(): Promise<void> {
  const client = getClient();

  // Create conversations table
  const { error: convError } = await client.rpc("exec_sql", {
    sql: `
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        username TEXT,
        user_message TEXT NOT NULL,
        bot_reply TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_chat_id ON conversations(chat_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);
    `,
  });

  // If RPC doesn't exist, tables should be created via Supabase dashboard
  if (convError) {
    console.warn("Could not auto-create tables via RPC (expected if tables exist):", convError.message);
  }

  // Create chat_prompts table
  const { error: promptError } = await client.rpc("exec_sql", {
    sql: `
      CREATE TABLE IF NOT EXISTS chat_prompts (
        chat_id BIGINT PRIMARY KEY,
        prompt TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `,
  });

  if (promptError) {
    console.warn("Could not auto-create chat_prompts table via RPC:", promptError.message);
  }

  console.log("✅ Supabase database initialized");
}

/**
 * Save a conversation interaction to the database
 */
export async function saveConversation(
  chatId: number,
  userId: number,
  username: string | null,
  userMessage: string,
  botReply: string
): Promise<void> {
  const client = getClient();

  const record: ConversationRecord = {
    chat_id: chatId,
    user_id: userId,
    username,
    user_message: userMessage,
    bot_reply: botReply,
  };

  const { error } = await client.from("conversations").insert(record);

  if (error) {
    console.error("Failed to save conversation:", error.message);
    throw error;
  }

  // Prune old messages beyond the last 5 for this chat
  await pruneOldMessages(chatId, 5);
}

/**
 * Delete messages beyond the retention limit for a chat
 */
async function pruneOldMessages(chatId: number, keep: number): Promise<void> {
  const client = getClient();

  // Get IDs of messages to keep (last N)
  const { data: keepMessages, error: selectError } = await client
    .from("conversations")
    .select("id")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(keep);

  if (selectError || !keepMessages) {
    console.warn("Failed to fetch messages for pruning:", selectError?.message);
    return;
  }

  if (keepMessages.length < keep) {
    // Not enough messages to prune
    return;
  }

  const keepIds = keepMessages.map((m) => m.id);

  // Delete all messages for this chat that are NOT in the keep list
  const { error: deleteError } = await client
    .from("conversations")
    .delete()
    .eq("chat_id", chatId)
    .not("id", "in", `(${keepIds.join(",")})`);

  if (deleteError) {
    console.warn("Failed to prune old messages:", deleteError.message);
  }
}

/**
 * Get the last N messages for a chat, ordered oldest to newest
 */
export async function getLastMessages(
  chatId: number,
  limit: number = 5
): Promise<ConversationRecord[]> {
  const client = getClient();

  const { data, error } = await client
    .from("conversations")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("Failed to fetch messages:", error.message);
    return [];
  }

  // Reverse to get oldest -> newest order
  return (data ?? []).reverse();
}

/**
 * Build LLM context string from conversation history
 * Format: "User: <msg>\nAssistant: <reply>\n..."
 */
export async function buildLLMContext(chatId: number): Promise<string> {
  const messages = await getLastMessages(chatId, 5);

  if (messages.length === 0) return "";

  return messages
    .map((m) => `User: ${m.user_message}\nAssistant: ${m.bot_reply}`)
    .join("\n");
}

/**
 * Save or update the custom prompt for a chat
 */
export async function setPrompt(chatId: number, prompt: string): Promise<void> {
  const client = getClient();

  const { error } = await client.from("chat_prompts").upsert(
    {
      chat_id: chatId,
      prompt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "chat_id" }
  );

  if (error) {
    console.error("Failed to save prompt:", error.message);
    throw error;
  }
}

/**
 * Get the custom prompt for a chat
 */
export async function getPrompt(chatId: number): Promise<string | null> {
  const client = getClient();

  const { data, error } = await client
    .from("chat_prompts")
    .select("prompt")
    .eq("chat_id", chatId)
    .maybeSingle();

  if (error) {
    console.error("Failed to fetch prompt:", error.message);
    return null;
  }

  return data?.prompt ?? null;
}

/**
 * Clear the custom prompt for a chat
 */
export async function clearPrompt(chatId: number): Promise<void> {
  const client = getClient();

  const { error } = await client
    .from("chat_prompts")
    .delete()
    .eq("chat_id", chatId);

  if (error) {
    console.error("Failed to clear prompt:", error.message);
  }
}

/**
 * Get full admin stats from the database
 */
export async function getAdminStats(): Promise<{
  totalMessages: number;
  totalUsers: number;
  totalChats: number;
  chats: Record<
    string,
    {
      prompt: string | null;
      totalMessages: number;
      recentMessages: Array<{
        userId: number;
        username: string | null;
        text: string;
        response: string;
        timestamp: string;
      }>;
    }
  >;
}> {
  const client = getClient();

  // Get all conversations grouped by chat_id
  const { data: conversations, error: convError } = await client
    .from("conversations")
    .select("*")
    .order("created_at", { ascending: true });

  if (convError) {
    console.error("Failed to fetch conversations for admin:", convError.message);
    throw convError;
  }

  // Get all prompts
  const { data: prompts, error: promptError } = await client
    .from("chat_prompts")
    .select("*");

  if (promptError) {
    console.warn("Failed to fetch prompts for admin:", promptError.message);
  }

  // Build prompt map
  const promptMap = new Map<number, string>();
  for (const p of prompts ?? []) {
    promptMap.set(Number(p.chat_id), p.prompt);
  }

  // Group conversations by chat_id
  const chatGroups = new Map<number, ConversationRecord[]>();
  const userIds = new Set<number>();

  for (const conv of conversations ?? []) {
    const chatId = Number(conv.chat_id);
    const group = chatGroups.get(chatId) ?? [];
    group.push(conv);
    chatGroups.set(chatId, group);
    userIds.add(Number(conv.user_id));
  }

  // Build response
  const chats: Record<string, any> = {};

  for (const [chatId, msgs] of chatGroups.entries()) {
    // Take last 5 messages (already sorted oldest->newest)
    const recent = msgs.slice(-5);

    chats[String(chatId)] = {
      prompt: promptMap.get(chatId) ?? null,
      totalMessages: msgs.length,
      recentMessages: recent.map((m) => ({
        userId: Number(m.user_id),
        username: m.username,
        text: m.user_message,
        response: m.bot_reply,
        timestamp: m.created_at ?? new Date().toISOString(),
      })),
    };
  }

  return {
    totalMessages: conversations?.length ?? 0,
    totalUsers: userIds.size,
    totalChats: chatGroups.size,
    chats,
  };
}
