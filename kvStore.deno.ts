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

  if (kvClient) {
    try {
      await kvClient.set(buildKey(chatId, timestamp, id), record);

      // Prune older messages beyond `keep`
      await pruneOldMessagesKV(chatId, keep);
      return;
    } catch (e) {
      console.warn("Deno KV operation failed, falling back to memory store:", e);
      kvClient = null; // disable further KV attempts this run
    }
  }

  // Fallback: in-memory store
  const arr = memoryFallback.get(chatId) ?? [];
  arr.push(record);
  // keep only last `keep` entries
  const start = Math.max(0, arr.length - keep);
  const sliced = arr.slice(start);
  memoryFallback.set(chatId, sliced);
}

/** Persist a per-chat prompt. If KV is available, store there; otherwise store in fallback. */
export async function setPrompt(chatId: number, prompt: string) {
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
  if (kvClient) {
    try {
      const entry = await kvClient.get(["prompt", chatId]);
      return entry?.value ?? null;
    } catch (e) {
      console.warn("Deno KV getPrompt failed, using memory fallback:", e);
      kvClient = null;
    }
  }
  return promptsFallback.get(chatId) ?? null;
}

export async function clearPrompt(chatId: number) {
  if (kvClient) {
    try {
      await kvClient.delete(["prompt", chatId]);
      return;
    } catch (e) {
      console.warn("Deno KV clearPrompt failed, using memory fallback:", e);
      kvClient = null;
    }
  }
  promptsFallback.delete(chatId);
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

      if (items.length === 0) return [];

      // Sort by timestamp ascending
      items.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

      return items.slice(-limit);
    } catch (e) {
      console.warn("Deno KV read failed, using memory fallback:", e);
      kvClient = null;
      // fall through to memory fallback
    }
  }

  const arr = memoryFallback.get(chatId) ?? [];
  // already oldest -> newest, so return last `limit` entries
  return arr.slice(Math.max(0, arr.length - limit));
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

/**
 * Build a full DB view from KV. Returns null if KV not available so callers
 * can fallback to in-memory dataStore.
 */
export async function getFullDB() {
  if (!kvClient) return null;

  try {
    const iter = kvClient.list({ prefix: [CHAT_PREFIX] });
    const chatsMap = new Map<number, ChatMemoryRecord[]>();

    for await (const entry of iter) {
      if (!entry?.value) continue;
      const rec = entry.value as ChatMemoryRecord;
      const cid = Number(rec.chatId);
      const arr = chatsMap.get(cid) ?? [];
      arr.push(rec);
      chatsMap.set(cid, arr);
    }

    // load prompts
    const prompts = new Map<number, string>();
    try {
      const piter = kvClient.list({ prefix: ["prompt"] });
      for await (const p of piter) {
        if (!p?.value) continue;
        const key = p.key as unknown[];
        const cid = Number(key[1]);
        prompts.set(cid, String(p.value));
      }
    } catch (_e) {
      // ignore prompt read failures
    }

    const chats: Record<string, any> = {};
    let totalMessages = 0;
    const users = new Set<number>();

    for (const [cid, msgs] of chatsMap.entries()) {
      // sort oldest -> newest
      msgs.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
      totalMessages += msgs.length;
      msgs.forEach((m) => users.add(Number(m.userId)));

      chats[String(cid)] = {
        prompt: prompts.get(cid) ?? null,
        totalMessages: msgs.length,
        recentMessages: msgs.slice(-10).map((m) => ({
          userId: m.userId,
          username: m.username,
          text: m.userMessage,
          response: m.botReply,
          timestamp: m.timestamp,
        })),
      };
    }

    return {
      totalMessages,
      totalUsers: users.size,
      totalChats: chatsMap.size,
      chats,
    };
  } catch (e) {
    console.warn("getFullDB KV read failed:", e);
    return null;
  }
}


