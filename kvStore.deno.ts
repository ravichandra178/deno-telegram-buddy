/**
 * Chat memory store using Deno KV when available, otherwise an in-memory fallback.
 * This implementation never throws on init; it logs warnings and falls back safely.
 */
export interface ChatMemoryRecord {
  chatId: number;
  userId: number;
  username: string | null;
  userMessage: string;
  botReply: string;
  timestamp: string; // ISO string
}

const CHAT_PREFIX = "chat";
const DEFAULT_KEEP = 5;

const DB_FILE = "./db.json";

async function loadDB(): Promise<any> {
  try {
    const txt = await Deno.readTextFile(DB_FILE);
    return JSON.parse(txt);
  } catch (_e) {
    return { chats: {} };
  }
}

async function saveDB(db: any) {
  try {
    await Deno.writeTextFile(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.warn("Failed to write db.json:", e);
  }
}

// Try to open Deno KV if available. Use globalThis to avoid TypeScript problems
// in environments where Deno types are not present. Do not throw if unavailable.
let kvClient: any = null;
try {
  if (typeof (globalThis as any).Deno?.openKv === "function") {
    kvClient = (globalThis as any).Deno.openKv();
  }
} catch (e) {
  // Some environments require flags; just log and continue with fallback
  console.warn("Deno.openKv() not available or failed to initialize:", e);
  kvClient = null;
}

// In-memory fallback: Map<chatId, ChatMemoryRecord[]>
const memoryFallback = new Map<number, ChatMemoryRecord[]>();
// Fallback storage for prompts when KV not available
const promptsFallback = new Map<number, string>();

function buildKey(chatId: number, timestamp: string, id: string) {
  return [CHAT_PREFIX, chatId, timestamp, id];
}

/** Save a new interaction and prune older ones beyond `keep` */
export async function saveInteraction(
  chatId: number,
  userId: number,
  username: string | null,
  userMessage: string,
  botReply: string,
  keep = DEFAULT_KEEP,
) {
  const timestamp = new Date().toISOString();
  const id = crypto.randomUUID();

  const record: ChatMemoryRecord = {
    chatId,
    userId,
    username,
    userMessage,
    botReply,
    timestamp,
  };
  // 1) Always persist to disk (single source of truth)
  try {
    const db = await loadDB();
    if (!db.chats) db.chats = {};
    if (!db.chats[chatId]) db.chats[chatId] = { prompt: null, messages: [] };
    db.chats[chatId].messages.push({
      id,
      userId,
      username,
      firstName: null,
      text: userMessage,
      response: botReply,
      timestamp,
    });
    await saveDB(db);
  } catch (e) {
    console.warn("Failed to persist message to db.json:", e);
  }

  // 2) Try to write to KV (fast cache). If KV fails, use in-memory fallback.
  if (kvClient) {
    try {
      await kvClient.set(buildKey(chatId, timestamp, id), record);
      // Prune older messages beyond `keep` in KV
      await pruneOldMessagesKV(chatId, keep);
      return;
    } catch (e) {
      console.warn("Deno KV operation failed, falling back to memory store:", e);
      kvClient = null; // disable further KV attempts this run
    }
  }

  // Fallback: in-memory store (acts as cache when KV unavailable)
  const arr = memoryFallback.get(chatId) ?? [];
  arr.push(record);
  // keep only last `keep` entries
  const start = Math.max(0, arr.length - keep);
  const sliced = arr.slice(start);
  memoryFallback.set(chatId, sliced);
}

/** Persist a per-chat prompt. If KV is available, store there; otherwise store in fallback. */
export async function setPrompt(chatId: number, prompt: string) {
  // Persist to disk first (single source of truth)
  try {
    const db = await loadDB();
    if (!db.chats) db.chats = {};
    if (!db.chats[chatId]) db.chats[chatId] = { prompt: null, messages: [] };
    db.chats[chatId].prompt = prompt;
    await saveDB(db);
  } catch (e) {
    console.warn("Failed to persist prompt to db.json:", e);
  }

  // Update KV if available; otherwise update fallback
  if (kvClient) {
    try {
      await kvClient.set(["prompt", chatId], prompt);
      return;
    } catch (e) {
      console.warn("Deno KV setPrompt failed, falling back to memory:", e);
      kvClient = null;
    }
  }
  promptsFallback.set(chatId, prompt);
}

export async function getPrompt(chatId: number): Promise<string | null> {
  // Try KV first
  if (kvClient) {
    try {
      const entry = await kvClient.get(["prompt", chatId]);
      if (entry?.value) return entry.value;
    } catch (e) {
      console.warn("Deno KV getPrompt failed, using fallback:", e);
      kvClient = null;
    }
  }

  // Fallback to disk-backed db.json
  try {
    const db = await loadDB();
    const prompt = db.chats?.[chatId]?.prompt ?? null;
    if (prompt) return prompt;
  } catch (e) {
    console.warn("Failed to read db.json for prompt:", e);
  }

  return promptsFallback.get(chatId) ?? null;
}

export async function clearPrompt(chatId: number) {
  // Clear from disk
  try {
    const db = await loadDB();
    if (db.chats?.[chatId]) db.chats[chatId].prompt = null;
    await saveDB(db);
  } catch (e) {
    console.warn("Failed to clear prompt in db.json:", e);
  }

  if (kvClient) {
    try {
      await kvClient.delete(["prompt", chatId]);
    } catch (e) {
      console.warn("Deno KV clearPrompt failed, using memory fallback:", e);
      kvClient = null;
    }
  }
  promptsFallback.delete(chatId);
}

export async function getFullDB(): Promise<any> {
  try {
    return await loadDB();
  } catch (_e) {
    return { chats: {} };
  }
}

/** Return last `limit` messages for a chat, ordered oldest -> newest */
export async function getLastMessages(chatId: number, limit = DEFAULT_KEEP): Promise<Array<ChatMemoryRecord>> {
  if (kvClient) {
    try {
      const iter = kvClient.list({ prefix: [CHAT_PREFIX, chatId] });
      const items: Array<ChatMemoryRecord> = [];
      for await (const entry of iter) {
        if (entry?.value) items.push(entry.value as ChatMemoryRecord);
      }
      // If KV has entries, return the most recent `limit` items
      if (items.length > 0) {
        // Sort by timestamp ascending
        items.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
        return items.slice(-limit);
      }

      // If KV is empty, fall back to disk DB to populate cache below
    } catch (e) {
      console.warn("Deno KV read failed, using memory fallback:", e);
      kvClient = null;
      // fall through to memory fallback
    }
  }

  // 1) Check in-memory fallback cache
  const arr = memoryFallback.get(chatId) ?? [];
  if (arr.length > 0) return arr.slice(Math.max(0, arr.length - limit));

  // 2) Fallback to db.json (single source of truth) and populate cache/KV
  try {
    const db = await loadDB();
    const history: any[] = db.chats?.[chatId]?.messages ?? [];
    const last = history.slice(-limit);

    // populate memory fallback and KV for future fast reads
    for (const msg of last) {
      const rec: ChatMemoryRecord = {
        chatId: Number(msg.userId) || Number(chatId),
        userId: Number(msg.userId) || Number(chatId),
        username: msg.username ?? null,
        userMessage: msg.text ?? msg.userMessage ?? "",
        botReply: msg.response ?? msg.botReply ?? "",
        timestamp: msg.timestamp,
      };
      const cur = memoryFallback.get(chatId) ?? [];
      cur.push(rec);
      memoryFallback.set(chatId, cur.slice(-DEFAULT_KEEP));

      if (kvClient) {
        try {
          await kvClient.set(buildKey(chatId, rec.timestamp, crypto.randomUUID()), rec);
        } catch (_e) {
          // ignore KV set failures here
        }
      }
    }

    return last.map((msg) => ({
      chatId: Number(msg.userId) || Number(chatId),
      userId: Number(msg.userId) || Number(chatId),
      username: msg.username ?? null,
      userMessage: String(msg.text ?? msg.userMessage ?? ""),
      botReply: String(msg.response ?? msg.botReply ?? ""),
      timestamp: String(msg.timestamp),
    }));
  } catch (e) {
    console.warn("Failed to read db.json for fallback:", e);
    return [];
  }
}

async function pruneOldMessagesKV(chatId: number, keep: number) {
  // Read all entries and delete older ones beyond `keep`.
  const iter = kvClient.list({ prefix: [CHAT_PREFIX, chatId] });
  const items: Array<{ key: unknown[]; value: ChatMemoryRecord }> = [];
  for await (const entry of iter) {
    items.push({ key: entry.key as unknown[], value: entry.value as ChatMemoryRecord });
  }

  if (items.length <= keep) return;

  // Sort newest -> oldest so we can delete items after the first `keep`
  items.sort((a, b) => (a.value.timestamp > b.value.timestamp ? -1 : a.value.timestamp < b.value.timestamp ? 1 : 0));

  const toDelete = items.slice(keep);
  await Promise.all(toDelete.map((entry) => kvClient.delete(entry.key)));
}


