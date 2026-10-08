import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createApp } from "../src/server.js";
import { ConversationStore, RedisConversationStore, createStore } from "../src/history.js";
import { generateReply } from "../src/agent.js";
import { handleCustomerMessage } from "../src/conversation.js";
import { _toFieldsForTests as toFields } from "../src/leads.js";
import { extractMessages, verifySignature } from "../src/whatsapp.js";

const APP_SECRET = "app-secret";

async function request(app, method, path, { body, headers = {} } = {}) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: raw,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, text, body: json };
  } finally {
    server.close();
  }
}

const sign = (body) => "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(JSON.stringify(body)).digest("hex");

function waPayload(messages) {
  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: { contacts: [{ wa_id: "16045551234", profile: { name: "Sam" } }], messages } }] }],
  };
}

function fakeWhatsApp() {
  const sent = [];
  return { sent, sendText: async (to, text) => sent.push({ to, text }), markReadAndTyping: async () => {} };
}

function fakeLeads() {
  const calls = [];
  return {
    calls,
    enabled: true,
    upsert: async (existingId, lead) => { calls.push({ existingId, lead }); return existingId ?? "rec123"; },
  };
}

const fakeClient = (...responses) => {
  const requests = [];
  return {
    requests,
    beta: { messages: { create: async (req) => { requests.push(structuredClone(req)); return responses.shift(); } } },
  };
};

// ---- Landbot ------------------------------------------------------------

test("landbot: rejects requests without the shared secret", async () => {
  const app = createApp({ env: { WEBHOOK_SECRET: "s3cret" }, replyFn: async () => ({ reply: "hi", handoff: false, ok: true }) });
  const res = await request(app, "POST", "/landbot/webhook", { body: { message: "hi", customer_id: "1" } });
  assert.equal(res.status, 401);
});

test("landbot: on Vercel, refuses to run without a secret", async () => {
  const app = createApp({ env: {}, requireSecrets: true, replyFn: async () => ({ reply: "hi", handoff: false, ok: true }) });
  const res = await request(app, "POST", "/landbot/webhook", { body: { message: "hi", customer_id: "1" } });
  assert.equal(res.status, 500);
});

test("landbot: returns the reply and remembers the conversation", async () => {
  const seen = [];
  const replyFn = async (history, msg) => { seen.push(history.length); return { reply: `echo: ${msg}`, handoff: false, ok: true }; };
  const app = createApp({ store: new ConversationStore(), env: { WEBHOOK_SECRET: "s" }, replyFn });
  const headers = { "x-webhook-secret": "s" };
  const first = await request(app, "POST", "/landbot/webhook", { body: { message: "hello", customer_id: "+1555" }, headers });
  assert.deepEqual(first.body, { reply: "echo: hello", handoff: false });
  await request(app, "POST", "/landbot/webhook", { body: { message: "again", customer_id: "+1555" }, headers });
  assert.deepEqual(seen, [0, 2]);
});

test("landbot: falls back to a human handoff when Claude errors", async () => {
  const app = createApp({ env: {}, replyFn: async () => { throw new Error("boom"); } });
  const res = await request(app, "POST", "/landbot/webhook", { body: { message: "hi", customer_id: "1" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.handoff, true);
});

// ---- WhatsApp Cloud API ---------------------------------------------------

test("whatsapp: webhook verification echoes the challenge only with the right token", async () => {
  const app = createApp({ env: { WHATSAPP_VERIFY_TOKEN: "vt" } });
  const ok = await request(app, "GET", "/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42");
  assert.equal(ok.status, 200);
  assert.equal(ok.text, "42");
  const bad = await request(app, "GET", "/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42");
  assert.equal(bad.status, 403);
});

test("whatsapp: rejects payloads without a valid Meta signature", async () => {
  const app = createApp({ env: { WHATSAPP_APP_SECRET: APP_SECRET } });
  const body = waPayload([{ id: "m1", from: "16045551234", type: "text", text: { body: "hi" } }]);
  const res = await request(app, "POST", "/whatsapp/webhook", { body, headers: { "x-hub-signature-256": "sha256=00" } });
  assert.equal(res.status, 401);
});

test("whatsapp: replies to a text message once, even if Meta delivers it twice", async () => {
  const whatsapp = fakeWhatsApp();
  const pending = [];
  const replyFn = async (_history, msg) => ({ reply: `you said: ${msg}`, handoff: false, ok: true });
  const app = createApp({
    store: new ConversationStore(), whatsapp, replyFn,
    env: { WHATSAPP_APP_SECRET: APP_SECRET },
    background: (p) => pending.push(p),
  });
  const body = waPayload([{ id: "m1", from: "16045551234", type: "text", text: { body: "Do you teach drums?" } }]);
  for (let i = 0; i < 2; i++) {
    const res = await request(app, "POST", "/whatsapp/webhook", { body, headers: { "x-hub-signature-256": sign(body) } });
    assert.equal(res.status, 200);
    await Promise.all(pending);
  }
  assert.equal(whatsapp.sent.length, 1);
  assert.equal(whatsapp.sent[0].to, "16045551234");
  assert.match(whatsapp.sent[0].text, /Customer's WhatsApp name: Sam/);
});

test("whatsapp: asks for text when sent a voice note or image", async () => {
  const whatsapp = fakeWhatsApp();
  const pending = [];
  const app = createApp({ whatsapp, env: { WHATSAPP_APP_SECRET: APP_SECRET }, background: (p) => pending.push(p) });
  const body = waPayload([{ id: "m2", from: "16045551234", type: "audio", audio: { id: "x" } }]);
  await request(app, "POST", "/whatsapp/webhook", { body, headers: { "x-hub-signature-256": sign(body) } });
  await Promise.all(pending);
  assert.match(whatsapp.sent[0].text, /only read text/);
});

test("whatsapp: ignores delivery status updates", () => {
  const payload = { entry: [{ changes: [{ value: { statuses: [{ id: "s1", status: "read" }] } }] }] };
  assert.deepEqual(extractMessages(payload), []);
});

test("whatsapp: signature check", () => {
  const raw = Buffer.from('{"a":1}');
  const good = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
  assert.equal(verifySignature(raw, good, APP_SECRET), true);
  assert.equal(verifySignature(raw, good, "other"), false);
  assert.equal(verifySignature(raw, undefined, APP_SECRET), false);
});

// ---- Claude + tools -------------------------------------------------------

test("generateReply runs save_lead, then returns the final text", async () => {
  const client = fakeClient(
    {
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "tool_use", id: "tu1", name: "save_lead", input: { parent_name: "Ana", instruments: ["Piano"] } },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Here's Mariia's booking link." }] },
  );
  const saved = [];
  const result = await generateReply([], "Piano for my son", { client, actions: { saveLead: async (i) => { saved.push(i); return "Saved."; } } });
  assert.deepEqual(result, { reply: "Here's Mariia's booking link.", handoff: false, ok: true });
  assert.equal(saved[0].parent_name, "Ana");
  // The assistant turn (thinking included) is replayed unchanged, followed by the tool result.
  const second = client.requests[1].messages;
  assert.equal(second[1].content[0].type, "thinking");
  assert.deepEqual(second[2].content[0], { type: "tool_result", tool_use_id: "tu1", content: "Saved." });
  assert.match(client.requests[0].system[0].text, /Princess Street/);
  assert.deepEqual(client.requests[0].tools.map((t) => t.name), ["save_lead", "flag_for_team"]);
});

test("generateReply marks handoff when flag_for_team is used, and reports tool errors to Claude", async () => {
  const client = fakeClient(
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "flag_for_team", input: { reason: "Refund", summary: "Wants a refund" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "A team member will follow up." }] },
  );
  const result = await generateReply([], "I want a refund", { client, actions: { flagForTeam: async () => { throw new Error("Airtable down"); } } });
  assert.equal(result.handoff, true);
  assert.equal(client.requests[1].messages[2].content[0].is_error, true);
});

test("generateReply handles refusals", async () => {
  const result = await generateReply([], "x", { client: fakeClient({ stop_reason: "refusal", content: [] }) });
  assert.equal(result.handoff, true);
  assert.equal(result.ok, false);
});

// ---- Leads ----------------------------------------------------------------

test("leads: first save creates a New lead, later saves update the same record", async () => {
  const leads = fakeLeads();
  const store = new ConversationStore();
  let call = 0;
  const replyFn = async (_h, _m, { actions }) => {
    await actions.saveLead({ parent_name: "Ana", instruments: ["Piano"], ...(call++ ? { student_age: 6 } : {}) });
    return { reply: "ok", handoff: false, ok: true };
  };
  const args = { store, leads, replyFn, customerId: "wa:1604", phone: "+1604", name: "Ana", text: "hi" };
  await handleCustomerMessage(args);
  await handleCustomerMessage(args);
  assert.equal(leads.calls[0].existingId, null);
  assert.equal(leads.calls[0].lead.status, "New");
  assert.equal(leads.calls[0].lead.phone, "+1604");
  assert.equal(leads.calls[1].existingId, "rec123");
  assert.equal(leads.calls[1].lead.status, undefined);
});

test("leads: maps to WhatsApp Leads fields and drops unknown instruments", () => {
  const fields = toFields(
    { phone: "+1604", parent_name: "Ana", instruments: ["Piano", "Banjo"], student_age: 7, notes: null, follow_up_reason: "Billing: card" },
    { isNew: true, now: "2026-10-08T00:00:00.000Z" },
  );
  assert.deepEqual(fields, {
    fldT6D7rZcVDFowZ9: "2026-10-08T00:00:00.000Z",
    fld2urjOBzEjMBwFG: "2026-10-08T00:00:00.000Z",
    fldypKCZnQueKyjqB: "+1604",
    fldHxHn9LLjNjEdrm: "Ana",
    fld0xIHIUxOdVqMuI: 7,
    fldHwPelP83N0dktb: ["Piano"],
    fldzfBhN5xgcj6FTG: true,
    fldYe7r9FjEzPhPG4: "Billing: card",
  });
});

// ---- Storage ----------------------------------------------------------------

test("history trimming keeps a user turn first", async () => {
  const store = new ConversationStore({ maxMessages: 3 });
  await store.append("a", { role: "user", content: "1" }, { role: "assistant", content: "2" });
  await store.append("a", { role: "user", content: "3" }, { role: "assistant", content: "4" });
  assert.equal((await store.get("a"))[0].role, "user");
});

test("Redis store round-trips history, lead ids and message claims", async () => {
  const data = new Map();
  const fakeRedis = {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v, opts = {}) => {
      if (opts.nx && data.has(k)) return null;
      data.set(k, v);
      return "OK";
    },
    del: async (k) => data.delete(k),
  };
  const store = new RedisConversationStore(fakeRedis);
  await store.append("+1", { role: "user", content: "hi" }, { role: "assistant", content: "hello" });
  assert.equal((await store.get("+1")).length, 2);
  await store.reset("+1");
  assert.deepEqual(await store.get("+1"), []);
  await store.setLeadId("+1", "recX");
  assert.equal(await store.getLeadId("+1"), "recX");
  assert.equal(await store.claimMessage("m1"), true);
  assert.equal(await store.claimMessage("m1"), false);
});

test("createStore picks Redis when Vercel KV/Upstash env vars are set", () => {
  assert.ok(createStore({ KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" }) instanceof RedisConversationStore);
  assert.ok(createStore({}) instanceof ConversationStore);
});
