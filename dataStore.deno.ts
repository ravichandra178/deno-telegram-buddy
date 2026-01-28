/**
 * In-memory data store for Telegram bot messages, users, and chat prompts
 */

export interface MessageRecord {
  id: string;
  userId: number;
  username: string | null;
  firstName: string | null;
  text: string;
  response: string;
  timestamp: string;
}

export interface Stats {
  totalMessages: number;
  totalUsers: number;
  messages: MessageRecord[];
}

class DataStore {
  private messages: MessageRecord[] = [];
  private users: Set<number> = new Set();

  // Custom prompt per chat
  private chatPrompts: Map<number, string> = new Map();

  // Messages per chatId for history
  private chatHistory: Map<number, MessageRecord[]> = new Map();

  /* ===================== MESSAGES ===================== */

  addMessage(record: MessageRecord): void {
    this.messages.push(record);
    this.users.add(record.userId);

    if (!this.chatHistory.has(record.userId)) {
      this.chatHistory.set(record.userId, []);
    }
    this.chatHistory.get(record.userId)!.push(record);
  }

  getStats(): Stats {
    return {
      totalMessages: this.messages.length,
      totalUsers: this.users.size,
      messages: [...this.messages].reverse(),
    };
  }

  generateId(): string {
    return crypto.randomUUID();
  }

  /* ===================== PROMPTS ===================== */

  setPrompt(chatId: number, prompt: string): void {
    this.chatPrompts.set(chatId, prompt);
    console.log(`Saved custom prompt for chat ${chatId}: "${prompt}"`);
  }

  getPrompt(chatId: number): string | null {
    return this.chatPrompts.get(chatId) ?? null;
  }

  clearPrompt(chatId: number): void {
    this.chatPrompts.delete(chatId);
    console.log(`Cleared prompt for chat ${chatId}`);
  }

  /* ===================== CHAT HISTORY ===================== */

  /**
   * Get message history for a chat
   */
  getChatHistory(chatId: number, limit = 10): MessageRecord[] {
    const history = this.chatHistory.get(chatId) ?? [];
    return history.slice(-limit); // last N messages
  }

  /**
   * Clear chat history for a chat
   */
  clearChatHistory(chatId: number): void {
    this.chatHistory.delete(chatId);
    console.log(`Cleared chat history for chat ${chatId}`);
  }
}

// Singleton instance
export const dataStore = new DataStore();
