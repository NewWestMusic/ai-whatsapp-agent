# AI WhatsApp agent (Landbot + Claude)

Landbot runs your WhatsApp number and the conversation flow. When a customer
asks something your flow can't answer, a Landbot **Webhook block** sends the
message to this small server. The server asks Claude for a reply using your
business information in `knowledge.md`, and Landbot sends that reply on WhatsApp.

```
Customer on WhatsApp ──▶ Landbot flow ──▶ Webhook block ──▶ this server ──▶ Claude
                                ▲                                   │
                                └──────────── { reply, handoff } ◀──┘
```

## 1. Fill in your business information

Edit `knowledge.md`. The agent only answers from what's in this file, so add
your rates, policies, hours, booking link and common questions. If it doesn't
know an answer, it says so and hands the chat to your team rather than guessing.

## 2. Run the server

You need Node.js 22+ and an Anthropic API key (https://console.anthropic.com).

```bash
npm install
cp .env.example .env      # then put your API key and a random WEBHOOK_SECRET in .env
npm start
```

Landbot must reach the server over public HTTPS, so deploy it to any Node
host (Render, Railway, Fly.io, a VPS…). Set the same environment variables
there. For quick local testing you can expose it with a tunnel such as
`ngrok http 3000`.

Check it works:

```bash
curl -X POST http://localhost:3000/landbot/webhook \
  -H "content-type: application/json" -H "x-webhook-secret: YOUR_SECRET" \
  -d '{"message":"What instruments do you teach?","customer_id":"test-1","name":"Sam"}'
```

## 3. Set up Landbot

1. **Connect WhatsApp.** Create a WhatsApp bot in Landbot and connect your
   WhatsApp Business number (Landbot walks you through this under the WhatsApp channel setup).
2. **Capture the message.** Add a *Question* block (text type) and save the
   answer to a variable, e.g. `@user_message`.
3. **Add a Webhook block** after it:
   - Method: `POST`
   - URL: `https://YOUR-SERVER/landbot/webhook`
   - Headers: `x-webhook-secret` = the `WEBHOOK_SECRET` from your `.env`
   - Body (customize body):
     ```json
     {
       "message": "@user_message",
       "customer_id": "@phone",
       "name": "@name"
     }
     ```
   - Save responses: map `reply` → `@ai_reply` and `handoff` → `@ai_handoff`.
4. **Send the reply.** Add a *Send a message* block with the text `@ai_reply`.
5. **Branch on handoff.** Add a *Conditions* block: if `@ai_handoff` is `true`,
   route to your human-takeover / notify-team step; otherwise loop back to the
   Question block so the customer can keep chatting.

Landbot's WhatsApp variable names can differ slightly between accounts. Use
whichever variable holds the customer's phone number as `customer_id`: it's
how the server keeps each person's conversation separate.

## API

`POST /landbot/webhook`

| Field         | Required | Meaning                                      |
|---------------|----------|----------------------------------------------|
| `message`     | yes      | What the customer wrote                      |
| `customer_id` | yes      | Stable id per customer (their phone number)  |
| `name`        | no       | Customer's name, used for a friendlier reply |

Response: `{ "reply": "...", "handoff": false }`. `handoff` is `true` when the
agent thinks a person should take over (payments, complaints, unknown answers,
or an API error).

The customer can type `reset` to clear their conversation memory.

## Notes

- **Memory** is kept in RAM for 6 hours and the last 20 messages per customer.
  It resets on restart. Swap `src/history.js` for Redis/a database if you need more.
- **Model**: `claude-opus-5-5` at low effort, which keeps replies quick. Change
  it with `CLAUDE_MODEL` in `.env`.
- **Security**: always set `WEBHOOK_SECRET`, otherwise anyone who finds the URL
  can spend your API credits.
- Run tests with `npm test`.
