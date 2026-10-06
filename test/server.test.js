import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { ConversationStore } from "../src/history.js";
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
  const app = createApp({ secret: undefined, replyFn: async () => { throw new Error("boom"); } });
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

test("history trimming keeps a user turn first", () => {
  const store = new ConversationStore({ maxMessages: 3 });
  store.append("a", { role: "user", content: "1" }, { role: "assistant", content: "2" });
  store.append("a", { role: "user", content: "3" }, { role: "assistant", content: "4" });
  assert.equal(store.get("a")[0].role, "user");
});
