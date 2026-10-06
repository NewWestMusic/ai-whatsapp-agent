// Short per-customer conversation memory, kept in RAM.
// It resets when the server restarts, which is fine for a FAQ-style agent.
// Swap this for Redis or a database if you need memory to survive restarts.

export class ConversationStore {
  constructor({ maxMessages = 20, ttlMs = 6 * 60 * 60 * 1000 } = {}) {
    this.maxMessages = maxMessages;
    this.ttlMs = ttlMs;
    this.conversations = new Map();
  }

  get(customerId) {
    const convo = this.conversations.get(customerId);
    if (!convo) return [];
    if (Date.now() - convo.updatedAt > this.ttlMs) {
      this.conversations.delete(customerId);
      return [];
    }
    return convo.messages;
  }

  append(customerId, ...messages) {
    const existing = this.get(customerId);
    let updated = [...existing, ...messages];
    if (updated.length > this.maxMessages) {
      updated = updated.slice(updated.length - this.maxMessages);
      // The Messages API requires the history to start with a user turn.
      while (updated.length && updated[0].role !== "user") updated.shift();
    }
    this.conversations.set(customerId, { messages: updated, updatedAt: Date.now() });
  }

  reset(customerId) {
    this.conversations.delete(customerId);
  }
}
