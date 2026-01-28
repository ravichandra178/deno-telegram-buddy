/**
 * In-memory data store for Telegram bot messages and users
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

  addMessage(record: MessageRecord): void {
    this.messages.push(record);
    this.users.add(record.userId);
  }

  getStats(): Stats {
    return {
      totalMessages: this.messages.length,
      totalUsers: this.users.size,
      messages: [...this.messages].reverse(), // Most recent first
    };
  }

  generateId(): string {
    return crypto.randomUUID();
  }
}

// Singleton instance
export const dataStore = new DataStore();
