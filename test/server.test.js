import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { ConversationStore, RedisConversationStore, createStore } from "../src/history.js";
import { generateReply } from "../src/agent.js";

async function post(app, body, headers = {}) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/landbot/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test("rejects requests without the shared secret", async () => {
  const app = createApp({ secret: "s3cret", replyFn: async () => ({ reply: "hi", handoff: false, ok: true }) });
  const res = await post(app, { message: "hi", customer_id: "1" });
  assert.equal(res.status, 401);
});

test("returns the reply and remembers the conversation", async () => {
  const store = new ConversationStore();
  const seen = [];
  const replyFn = async (history, msg) => {
    seen.push(history.length);
    return { reply: `echo: ${msg}`, handoff: false, ok: true };
  };
  const app = createApp({ store, replyFn, secret: "s3cret" });
  const headers = { "x-webhook-secret": "s3cret" };

  const first = await post(app, { message: "hello", customer_id: "+1555" }, headers);
  assert.deepEqual(first.body, { reply: "echo: hello", handoff: false });
  await post(app, { message: "again", customer_id: "+1555" }, headers);
  assert.deepEqual(seen, [0, 2]);
});

test("falls back to a human handoff when Claude errors", async () => {
  const app = createApp({ secret: undefined, requireSecret: false, replyFn: async () => { throw new Error("boom"); } });
  const res = await post(app, { message: "hi", customer_id: "1" });
  assert.equal(res.status, 200);
  assert.equal(res.body.handoff, true);
});

test("generateReply strips the handoff token and handles refusals", async () => {
  const fakeClient = (response) => ({ beta: { messages: { create: async () => response } } });

  const handed = await generateReply([], "I want a refund", {
    client: fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "A team member will follow up.\n[HANDOFF]" }] }),
  });
  assert.deepEqual(handed, { reply: "A team member will follow up.", handoff: true, ok: true });

  const refused = await generateReply([], "x", { client: fakeClient({ stop_reason: "refusal", content: [] }) });
  assert.equal(refused.handoff, true);
  assert.equal(refused.ok, false);
});

test("history trimming keeps a user turn first", async () => {
  const store = new ConversationStore({ maxMessages: 3 });
  await store.append("a", { role: "user", content: "1" }, { role: "assistant", content: "2" });
  await store.append("a", { role: "user", content: "3" }, { role: "assistant", content: "4" });
  assert.equal((await store.get("a"))[0].role, "user");
});

test("on Vercel, refuses to run without a webhook secret", async () => {
  const app = createApp({ secret: undefined, requireSecret: true, replyFn: async () => ({ reply: "hi", handoff: false, ok: true }) });
  const res = await post(app, { message: "hi", customer_id: "1" });
  assert.equal(res.status, 500);
});

test("Redis store round-trips history through the client", async () => {
  const data = new Map();
  const fakeRedis = {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v, opts) => { assert.ok(opts.ex > 0); data.set(k, v); },
    del: async (k) => data.delete(k),
  };
  const store = new RedisConversationStore(fakeRedis);
  await store.append("+1", { role: "user", content: "hi" }, { role: "assistant", content: "hello" });
  assert.equal((await store.get("+1")).length, 2);
  await store.reset("+1");
  assert.deepEqual(await store.get("+1"), []);
});

test("createStore picks Redis when Vercel KV/Upstash env vars are set", () => {
  assert.ok(createStore({ KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" }) instanceof RedisConversationStore);
  assert.ok(createStore({}) instanceof ConversationStore);
});

test("the system prompt loads knowledge.md", async () => {
  let sent;
  const client = { beta: { messages: { create: async (req) => { sent = req; return { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }; } } } };
  await generateReply([], "hi", { client });
  assert.match(sent.system[0].text, /Princess Street/);
});
