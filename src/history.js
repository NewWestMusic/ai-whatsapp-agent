import { Redis } from "@upstash/redis";

// Short per-customer conversation memory.
// - With Upstash Redis configured (needed on Vercel, where each request may run
//   on a fresh instance), memory is shared and survives restarts.
// - Otherwise it's kept in RAM, which is fine for a single long-running server.

const DEFAULTS = { maxMessages: 20, ttlMs: 6 * 60 * 60 * 1000 };

function trim(messages, maxMessages) {
  if (messages.length <= maxMessages) return messages;
  const trimmed = messages.slice(messages.length - maxMessages);
  // The Messages API requires the history to start with a user turn.
  while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
  return trimmed;
}

export class ConversationStore {
  constructor({ maxMessages = DEFAULTS.maxMessages, ttlMs = DEFAULTS.ttlMs } = {}) {
    this.maxMessages = maxMessages;
    this.ttlMs = ttlMs;
    this.conversations = new Map();
  }

  async get(customerId) {
    const convo = this.conversations.get(customerId);
    if (!convo) return [];
    if (Date.now() - convo.updatedAt > this.ttlMs) {
      this.conversations.delete(customerId);
      return [];
    }
    return convo.messages;
  }

  async append(customerId, ...messages) {
    const updated = trim([...(await this.get(customerId)), ...messages], this.maxMessages);
    this.conversations.set(customerId, { messages: updated, updatedAt: Date.now() });
  }

  async reset(customerId) {
    this.conversations.delete(customerId);
  }
}

export class RedisConversationStore {
  constructor(redis, { maxMessages = DEFAULTS.maxMessages, ttlMs = DEFAULTS.ttlMs } = {}) {
    this.redis = redis;
    this.maxMessages = maxMessages;
    this.ttlSeconds = Math.ceil(ttlMs / 1000);
  }

  key(customerId) {
    return `whatsapp-agent:convo:${customerId}`;
  }

  async get(customerId) {
    return (await this.redis.get(this.key(customerId))) ?? [];
  }

  async append(customerId, ...messages) {
    const updated = trim([...(await this.get(customerId)), ...messages], this.maxMessages);
    await this.redis.set(this.key(customerId), updated, { ex: this.ttlSeconds });
  }

  async reset(customerId) {
    await this.redis.del(this.key(customerId));
  }
}

// Picks Redis when its credentials are set. Vercel's Upstash integration
// provides KV_REST_API_*; a direct Upstash setup provides UPSTASH_REDIS_REST_*.
export function createStore(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return new RedisConversationStore(new Redis({ url, token }));
  if (env.VERCEL) {
    console.warn("No Redis configured: conversation memory will be lost between requests on Vercel.");
  }
  return new ConversationStore();
}
