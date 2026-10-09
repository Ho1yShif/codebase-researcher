/**
 * Seeds a human message into fake Slack and delivers a signed app_mention event to the endpoint.
 *
 *   tsx scripts/send-mention.ts --text "How does the CLI pick a workspace?" [--thread-ts 123.000001] [--duplicate]
 *
 * Prints {event_id, channel, thread_ts, ts} as JSON.
 */
import { createHmac, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    text: { type: "string" },
    "thread-ts": { type: "string" },
    channel: { type: "string", default: process.env.FAKE_SLACK_CHANNEL ?? "C0SUPPORT" },
    user: { type: "string", default: "UASKER" },
    team: { type: "string", default: process.env.FAKE_SLACK_TEAM_ID ?? "T0001" },
    endpoint: { type: "string", default: process.env.ENDPOINT_URL ?? "http://localhost:3000" },
    slack: { type: "string", default: process.env.FAKE_SLACK_URL ?? "http://localhost:4100" },
    duplicate: { type: "boolean", default: false },
  },
});

const secret = process.env.SLACK_SIGNING_SECRET;
if (!secret) throw new Error("SLACK_SIGNING_SECRET is required");
if (!values.text) throw new Error("--text is required");

const botUserId = process.env.FAKE_SLACK_BOT_USER_ID ?? "UBOT";
const text = `<@${botUserId}> ${values.text}`;

const seeded = await fetch(`${values.slack}/_seed`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ channel: values.channel, thread_ts: values["thread-ts"], user: values.user, text }),
}).then((r) => r.json() as Promise<{ message: { ts: string } }>);

const ts = seeded.message.ts;
const eventId = `Ev${randomBytes(6).toString("hex").toUpperCase()}`;
const envelope = {
  token: "unused",
  team_id: values.team,
  api_app_id: "A0DXTRIAGE",
  type: "event_callback",
  event_id: eventId,
  event_time: Math.floor(Date.now() / 1000),
  authorizations: [{ team_id: values.team, user_id: botUserId, is_bot: true }],
  event: {
    type: "app_mention",
    user: values.user,
    text,
    ts,
    event_ts: ts,
    channel: values.channel,
    ...(values["thread-ts"] ? { thread_ts: values["thread-ts"] } : {}),
  },
};

async function deliver(retryNum?: number) {
  const body = JSON.stringify(envelope);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret!).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  };
  if (retryNum !== undefined) {
    headers["x-slack-retry-num"] = String(retryNum);
    headers["x-slack-retry-reason"] = "http_timeout";
  }
  const started = Date.now();
  const res = await fetch(`${values.endpoint}/slack/events`, { method: "POST", headers, body });
  console.error(`[send-mention] ${res.status} in ${Date.now() - started}ms${retryNum ? ` (retry ${retryNum})` : ""}`);
}

await deliver();
if (values.duplicate) await deliver(1);

console.log(JSON.stringify({ event_id: eventId, channel: values.channel, thread_ts: values["thread-ts"] ?? ts, ts }));
