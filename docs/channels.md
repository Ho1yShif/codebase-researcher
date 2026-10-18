# Adding a channel

The investigation pipeline knows nothing about Slack. It answers a *question*: a transcript, an optional callback, and optional metadata. The Slack adapter ([`src/slack.ts`](../src/slack.ts)) is one translation between a chat platform and that question API, and any other channel (Discord, Microsoft Teams, a support desk, a CLI) follows the same four steps.

## The four steps

1. **Receive and acknowledge the platform's event.** Verify its signature, then respond within the platform's deadline (3 seconds for both Slack and Discord) before doing anything slow. The Slack adapter responds first and does the rest in `startMention`.
2. **Build a transcript.** An array of `{ text, author?, is_agent? }`, oldest first, with at most 200 messages of at most 8,000 characters each. Mark the bot's own earlier replies `is_agent: true` so follow-up questions read as a conversation. [`fitTranscript`](../src/slack.ts) trims a long thread to these limits; reuse it.
3. **Start a question with a callback.** Pass a callback URL that points back at your adapter, a callback secret, and `metadata` with whatever you need to route the reply (at most 16 string, number, or boolean values). Use the platform's event or interaction ID as the idempotency key, so a redelivered event doesn't start a second run.
4. **Receive the callback and render the reply.** Verify `X-Researcher-Signature` with [`verifyCallback`](../src/callback.ts), read your routing details back out of `metadata`, and render the `reply`: an `answer`, a `clarification`, or a `failure`.

Derive each callback secret from a key and the event ID (`HMAC-SHA256(key, event_id)`), as the Slack adapter does with `SLACK_CALLBACK_KEY`. The callback can then be verified without storing anything, and a leaked secret is good for one question only. Callback secrets travel in workflow task input, which is visible in the Render Dashboard.

## Where the adapter runs

- **Inside the API service**, like Slack: write a `mountXRoutes(app, deps, { startQuestion, log })` function and call it from the server block at the bottom of [`src/api.ts`](../src/api.ts) when its env vars are set. It calls `startQuestion` directly, with no extra hop or token.
- **As a separate service** that calls `POST /v1/questions` with `Authorization: Bearer <API_TOKEN>` and an `Idempotency-Key` header. Use this when the adapter is written in another language or owned by another team. The request and callback formats are in the [README](../README.md#using-the-api).

## Rendering replies safely

- Escape model-written text for the platform's markup. The model can write `@everyone` or a link as easily as an answer: `escapeMrkdwn` defuses Slack's `<!channel>` and `<@U…>`, and on Discord, send `allowed_mentions: { parse: [] }`.
- Use `evidence[].url` as given. Trusted code builds those links after validating each citation; the model can't set them.
- Respect the platform's message limits (Slack sections are 3,000 characters; a Discord message is 2,000). Shorten lists, not the short answer.
- `failure.reason` is safe to show users; it never contains stack traces or secrets.

## Sketch: a Discord slash command

This is a starting point, not a tested adapter. It handles a `/ask question:<text>` command through Discord's interactions endpoint. Register the command and set the app's Interactions Endpoint URL to `https://<your-api>/discord/interactions` in the Discord Developer Portal.

Two Discord details shape it:

- An interaction must be answered within 3 seconds, so it answers with a deferred response (type 5, shown as "thinking…") and edits that message when the callback arrives.
- An interaction token is valid for 15 minutes. With the default 15-minute agent timeout, a slow investigation can outlive it. For long investigations, post the answer to the channel with a bot token instead (`POST /channels/{channel_id}/messages`).

```typescript
import { createHmac, createPublicKey, verify } from "node:crypto";
import type { Hono } from "hono";
import { verifyCallback } from "./callback.ts";
import type { Reply, StartQuestion } from "./types.ts";

type DiscordDeps = { publicKey: string; appId: string; callbackKey: string; publicUrl: string; log: (line: string) => void };

/** Discord signs interactions with Ed25519 over timestamp + body, using the app's public key (hex). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function verifyDiscord(publicKeyHex: string, signature: string | undefined, timestamp: string | undefined, body: string): boolean {
  if (!signature || !timestamp) return false;
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
  return verify(null, Buffer.from(timestamp + body), key, Buffer.from(signature, "hex"));
}

const callbackSecret = (key: string, interactionId: string) => createHmac("sha256", key).update(interactionId).digest("hex");

function toDiscord(reply: Reply): string {
  const text =
    reply.kind === "answer"
      ? [reply.result.answer, ...reply.result.evidence.map((e) => `<${e.url}>`)].join("\n")
      : reply.kind === "clarification"
        ? reply.result.question
        : `I couldn't complete this investigation: ${reply.reason}. Trace ${reply.traceId}`;
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
}

export function mountDiscordRoutes(app: Hono, deps: DiscordDeps, api: { startQuestion: StartQuestion }) {
  app.post("/discord/interactions", async (c) => {
    const body = await c.req.text();
    if (!verifyDiscord(deps.publicKey, c.req.header("x-signature-ed25519"), c.req.header("x-signature-timestamp"), body)) {
      return c.text("invalid signature", 401);
    }
    const interaction = JSON.parse(body);
    if (interaction.type === 1) return c.json({ type: 1 }); // PING, sent when you save the endpoint URL

    const question = interaction.data?.options?.find((o: { name: string }) => o.name === "question")?.value;
    void api
      .startQuestion(
        {
          transcript: [{ text: String(question ?? "").slice(0, 8000), author: interaction.member?.user?.id ?? interaction.user?.id }],
          callback: { url: `${deps.publicUrl}/discord/deliver`, secret: callbackSecret(deps.callbackKey, interaction.id) },
          metadata: { interaction_id: interaction.id, token: interaction.token },
        },
        { idempotencyKey: interaction.id, signal: AbortSignal.timeout(10_000) },
      )
      .catch((err) => deps.log(JSON.stringify({ event: "task_start_failed", interaction_id: interaction.id, error: String(err) })));
    return c.json({ type: 5 }); // deferred: "thinking…" until the callback edits it
  });

  app.post("/discord/deliver", async (c) => {
    const raw = await c.req.text();
    const { reply, metadata } = JSON.parse(raw) as { reply: Reply; metadata?: { interaction_id?: string; token?: string } };
    if (!metadata?.interaction_id || !metadata.token) return c.text("missing metadata", 400);
    const ok = verifyCallback({
      secret: callbackSecret(deps.callbackKey, metadata.interaction_id),
      signature: c.req.header("x-researcher-signature"),
      timestamp: c.req.header("x-researcher-timestamp"),
      body: raw,
    });
    if (!ok) return c.text("unauthorized", 401);

    const res = await fetch(`https://discord.com/api/v10/webhooks/${deps.appId}/${metadata.token}/messages/@original`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: toDiscord(reply), allowed_mentions: { parse: [] } }),
    });
    // A non-2xx makes the workflow's deliver subtask retry (up to 8 times).
    return res.ok ? c.text("ok") : c.text(`discord answered ${res.status}`, 502);
  });
}
```

The interaction token in `metadata` is visible in the Dashboard with the rest of the task input. It only lets someone edit this one response, and only until it expires.

To finish it: render the full answer (observed, inferred, and not established), handle follow-ups by threading replies, add tests modeled on the Slack adapter's in [`test/slack.test.ts`](../test/slack.test.ts), and add its env vars to `render.yaml` and the README.
