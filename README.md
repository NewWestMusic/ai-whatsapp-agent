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

Landbot must reach the server over public HTTPS, so deploy it (see
**Deploy to Vercel** below, or any Node host such as Render or Railway). For
quick local testing you can expose it with a tunnel such as `ngrok http 3000`.

Check it works:

```bash
curl -X POST http://localhost:3000/landbot/webhook \
  -H "content-type: application/json" -H "x-webhook-secret: YOUR_SECRET" \
  -d '{"message":"What instruments do you teach?","customer_id":"test-1","name":"Sam"}'
```

## Deploy to Vercel

The repo deploys to Vercel as-is: Vercel detects the Express app in
`src/server.js` and runs it as a serverless function.

1. **Check the production branch.** Vercel publishes the repo's default branch
   at your public URL. Other branches get preview links that sit behind a
   Vercel login, so Landbot can't call them. Make sure the code is on the
   default branch (GitHub → Settings → General → Default branch).
2. Go to https://vercel.com/new, choose **Import Git Repository**, and pick
   `NewWestMusic/ai-whatsapp-agent`. Leave the framework and build settings as detected.
3. Under **Environment Variables**, add:
   - `ANTHROPIC_API_KEY`: your key from https://console.anthropic.com
   - `WEBHOOK_SECRET`: a long random string (the webhook refuses all requests
     on Vercel until this is set)
4. Click **Deploy**.
5. **Add memory.** In the project, open **Storage** → **Create Database** →
   **Upstash for Redis** (free tier is plenty) and connect it to the project.
   This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically. Without
   it, the bot forgets the conversation between messages, because Vercel can
   run each request on a fresh instance.
6. **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables take effect.
7. Visit `https://YOUR-PROJECT.vercel.app/health`. It should show `{"ok":true}`.
   Your Landbot webhook URL is `https://YOUR-PROJECT.vercel.app/landbot/webhook`.

After this, every push to the default branch redeploys automatically, including edits to
`knowledge.md`.

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

- **Memory** keeps the last 20 messages per customer for 6 hours. It uses
  Upstash Redis when `KV_REST_API_URL`/`KV_REST_API_TOKEN` (or
  `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`) are set, and RAM otherwise
  (fine on a single always-on server, lost on restart).
- **Model**: `claude-opus-5-5` at low effort, which keeps replies quick. Change
  it with `CLAUDE_MODEL` in `.env`.
- **Security**: always set `WEBHOOK_SECRET`, otherwise anyone who finds the URL
  can spend your API credits.
- Run tests with `npm test`.
