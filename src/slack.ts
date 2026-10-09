import { createHmac } from "node:crypto";
import { LogLevel, WebClient } from "@slack/web-api";
import type { ConversationsRepliesResponse } from "@slack/web-api";
import type { KnownBlock, ContextBlock, SectionBlock } from "@slack/types";
import type { Hono } from "hono";
import { z } from "zod";
import type { Evidence, FinalAnswer, NeedsClarification, Transcript } from "./types.ts";
import { buildEvidenceUrl, safeEqual, verifyCallback, type ApiTranscript, type Reply, type StartQuestion } from "./types.ts";
import config from "../config.ts";

const MAX_SKEW_SECONDS = 5 * 60;

/** Slack request signing v0: https://docs.slack.dev/authentication/verifying-requests-from-slack */
export function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowMs?: number;
}): boolean {
  const { timestamp, signature } = input;
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false;

  const expected = `v0=${createHmac("sha256", input.signingSecret).update(`v0:${timestamp}:${input.rawBody}`).digest("hex")}`;
  return safeEqual(expected, signature);
}

const AppMention = z.looseObject({
  type: z.literal("app_mention"),
  channel: z.string().min(1),
  ts: z.string().min(1),
  thread_ts: z.string().min(1).optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  text: z.string().default(""),
});

const EventCallback = z.looseObject({
  type: z.literal("event_callback"),
  team_id: z.string().min(1),
  event_id: z.string().min(1),
  event: z.looseObject({ type: z.string() }),
  authorizations: z.array(z.looseObject({ user_id: z.string().optional(), is_bot: z.boolean().optional() })).optional(),
});

const UrlVerification = z.object({ type: z.literal("url_verification"), challenge: z.string() });

export type SlackMention = {
  kind: "mention";
  eventId: string;
  teamId: string;
  channel: string;
  ts: string;
  threadTs: string | undefined;
  user: string;
  text: string;
};

export type SlackUrlVerification = { kind: "url_verification"; challenge: string };

export type SlackEvent = SlackMention | SlackUrlVerification | { kind: "ignored" };

/** Bots (including us) never start turns; `authorizations` names our bot user without an API call. */
function isFromBot(
  envelope: z.infer<typeof EventCallback>,
  event: z.infer<typeof AppMention>,
): boolean {
  if (event.bot_id || !event.user) return true;
  return (envelope.authorizations ?? []).some((a) => a.is_bot && a.user_id === event.user);
}

/** Parses an Events API body into a url_verification, a human app_mention, or ignored. */
export function parseSlackEvent(payload: unknown): SlackEvent {
  const challenge = UrlVerification.safeParse(payload);
  if (challenge.success) return { kind: "url_verification", challenge: challenge.data.challenge };

  const envelope = EventCallback.safeParse(payload);
  if (!envelope.success) return { kind: "ignored" };

  const event = AppMention.safeParse(envelope.data.event);
  if (!event.success) return { kind: "ignored" };
  if (isFromBot(envelope.data, event.data)) return { kind: "ignored" };

  return {
    kind: "mention",
    eventId: envelope.data.event_id,
    teamId: envelope.data.team_id,
    channel: event.data.channel,
    ts: event.data.ts,
    threadTs: event.data.thread_ts,
    user: event.data.user!,
    text: event.data.text,
  };
}

export type BotIdentity = { userId: string; botId: string | null };

export type Slack = {
  web: WebClient;
  /** Our bot's identity from auth.test, cached after the first success. */
  identity(): Promise<BotIdentity>;
};

export function createSlack(token: string, apiUrl?: string): Slack {
  const web = new WebClient(token, {
    slackApiUrl: apiUrl,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: 10_000,
    logLevel: LogLevel.ERROR,
  });
  let cached: Promise<BotIdentity> | undefined;
  return {
    web,
    identity() {
      if (!cached) {
        cached = web.auth.test().then((r) => {
          if (!r.user_id) throw new Error("auth.test returned no user_id");
          return { userId: r.user_id, botId: r.bot_id ?? null };
        });
        cached.catch(() => (cached = undefined));
      }
      return cached;
    },
  };
}

/** Slack limits: https://docs.slack.dev/reference/block-kit/blocks/section-block */
export const SECTION_MAX = 3000;
export const TEXT_MAX = 3000;

/** Slack mrkdwn control characters; escaping also defuses `<@U…>` / `<!channel>` pings in model output. */
export const escapeMrkdwn = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Truncates to `max` UTF-16 units ending in "…". Operates on already-escaped mrkdwn, so it also drops a
 * dangling entity (`&am`), an unclosed link (`<https://…`), or half a surrogate pair at the cut.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s
    .slice(0, max - 1)
    .replace(/&[a-z]{0,3}$/, "")
    .replace(/<[^>]*$/, "")
    .replace(/[\uD800-\uDBFF]$/, "");
  return `${cut}…`;
}

export async function react(slack: Slack, channel: string, ts: string, name: string): Promise<void> {
  try {
    await slack.web.reactions.add({ channel, timestamp: ts, name });
  } catch (e: unknown) {
    if (isSlackError(e, "already_reacted")) return;
    throw e;
  }
}

export async function unreact(slack: Slack, channel: string, ts: string, name: string): Promise<void> {
  try {
    await slack.web.reactions.remove({ channel, timestamp: ts, name });
  } catch (e: unknown) {
    if (isSlackError(e, "no_reaction")) return;
    throw e;
  }
}

/** Swaps 👀 for ✅ (`white_check_mark`) or ⚠️ (`warning`). */
export async function swapEyesForResult(
  slack: Slack,
  channel: string,
  ts: string,
  outcome: "success" | "failure",
): Promise<void> {
  await unreact(slack, channel, ts, "eyes");
  await react(slack, channel, ts, outcome === "success" ? "white_check_mark" : "warning");
}

function isSlackError(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "data" in e && typeof (e as { data?: unknown }).data === "object" &&
    (e as { data: { error?: unknown } }).data?.error === code;
}

export type ThreadMessage = NonNullable<ConversationsRepliesResponse["messages"]>[number];

/** Every message in the thread (parent first), including app metadata. */
export async function fetchThread(slack: Slack, channel: string, threadTs: string): Promise<ThreadMessage[]> {
  const messages: ThreadMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await slack.web.conversations.replies({
      channel,
      ts: threadTs,
      cursor,
      limit: 200,
      include_all_metadata: true,
    });
    messages.push(...(page.messages ?? []));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return messages;
}

/** Slack ts values ("1700000000.000123") exceed float precision, so compare seconds and micros separately. */
export function compareTs(a: string, b: string): number {
  const [as = "", au = ""] = a.split(".");
  const [bs = "", bu = ""] = b.split(".");
  return Number(as) - Number(bs) || au.padEnd(6, "0").localeCompare(bu.padEnd(6, "0"));
}

/** Slack ts values are "<seconds>.<micros>". */
export const slackTsToIso = (ts: string): string | undefined => {
  const ms = Number(ts.split(".")[0]) * 1000;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
};

export async function fetchTranscript(slack: Slack, channel: string, threadTs: string): Promise<Transcript> {
  const [me, messages] = await Promise.all([slack.identity(), fetchThread(slack, channel, threadTs)]);
  const ourMention = new RegExp(`<@${me.userId}(?:\\|[^>]*)?>`, "g");
  return messages
    .filter((m): m is ThreadMessage & { ts: string } => !!m.ts)
    .sort((a, b) => compareTs(a.ts, b.ts))
    .map((m) => ({
      ts: m.ts,
      user_id: m.user ?? null,
      is_agent: (!!me.botId && m.bot_id === me.botId) || m.user === me.userId,
      text: (m.text ?? "").replace(ourMention, "").trim(),
      at: slackTsToIso(m.ts),
    }));
}

export type SlackMessage = { text: string; blocks: KnownBlock[] };

export const REPLY_EVENT_TYPE = "triage_reply";

const ITEM_MAX = 1000;
const MORE_RESERVE = 32;

type Confidence = FinalAnswer["confidence"];
const CONFIDENCE: Record<Confidence, string> = { high: "High", medium: "Medium", low: "Low" };

const section = (text: string): SectionBlock => ({
  type: "section",
  text: { type: "mrkdwn", text: truncate(text, SECTION_MAX) },
});

const context = (text: string): ContextBlock => ({
  type: "context",
  elements: [{ type: "mrkdwn", text: truncate(text, SECTION_MAX) }],
});

const traceLine = (traceId: string) => `Trace \`${escapeMrkdwn(traceId)}\``;
const heading = (title: string, body: string) => `*${title}*\n${body}`;

function listSection(title: string, items: string[]): string {
  if (!items.length) return heading(title, "_None_");
  const lines = [`*${title}*`];
  let used = lines[0]!.length;
  for (const [i, item] of items.entries()) {
    const line = `• ${item}`;
    const reserve = i < items.length - 1 ? MORE_RESERVE : 0;
    if (used + 1 + line.length + reserve > SECTION_MAX) {
      lines.push(`• _…and ${items.length - i} more_`);
      break;
    }
    lines.push(line);
    used += 1 + line.length;
  }
  return lines.join("\n");
}

export function evidenceUrl(e: Evidence): string {
  return e.url ?? buildEvidenceUrl(e);
}

const evidenceLink = (e: Evidence) =>
  `<${evidenceUrl(e)}|${escapeMrkdwn(`${e.repository} ${e.path}:${e.start_line}-${e.end_line} @ ${e.commit.slice(0, 7)}`)}>`;

const textItems = (items: string[]) => items.map((s) => truncate(escapeMrkdwn(s), ITEM_MAX));

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? escapeMrkdwn(iso) : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatAnswer(reply: Extract<Reply, { kind: "answer" }>): SlackMessage {
  const r = reply.result;
  const sections = [
    heading("Short answer", escapeMrkdwn(r.answer)),
    heading("Confidence", CONFIDENCE[r.confidence]),
    listSection("Observed in code", textItems(r.observed_in_code)),
    listSection("Inferred behavior", textItems(r.inferred_behavior)),
    listSection("Not established", textItems(r.not_established)),
    listSection("Evidence", r.evidence.map(evidenceLink)),
    heading(config.labels.owner, escapeMrkdwn(r.suggested_owner)),
    heading(config.labels.escalation, escapeMrkdwn(r.escalation_question)),
  ];
  const footer = [
    traceLine(reply.traceId),
    reply.model && `Model \`${escapeMrkdwn(reply.model)}\``,
    reply.manifestCreatedAt && `Repositories as of ${formatTimestamp(reply.manifestCreatedAt)}`,
  ].filter(Boolean);
  return {
    text: truncate(sections.join("\n\n"), TEXT_MAX),
    blocks: [...sections.map(section), { type: "divider" }, context(footer.join(" · "))],
  };
}

/** Renders a Reply as Block Kit plus the plain `text` Slack uses for notifications and transcripts. */
export function formatReply(reply: Reply): SlackMessage {
  switch (reply.kind) {
    case "clarification": {
      const question = escapeMrkdwn(reply.result.question);
      const why = `_Why I'm asking:_ ${escapeMrkdwn(reply.result.why_needed)}`;
      return {
        text: truncate(`${question}\n\n${why}`, TEXT_MAX),
        blocks: [section(question), section(why), context(traceLine(reply.traceId))],
      };
    }
    case "answer":
      return formatAnswer(reply);
    case "failure": {
      const reason = truncate(escapeMrkdwn(reply.reason.trim().replace(/\.+$/, "")), ITEM_MAX);
      const text = `I couldn't complete this investigation: ${reason}. ${traceLine(reply.traceId)} — share it with ${config.labels.supportTeam} for debugging.`;
      return { text, blocks: [section(text)] };
    }
  }
}

type ReplyTarget = { channel: string; threadTs: string; traceId: string };

/** Finds a bot message already posted for this traceId via message metadata. */
export async function findPostedReply(slack: Slack, channel: string, threadTs: string, traceId: string): Promise<string | null> {
  const hit = (await fetchThread(slack, channel, threadTs)).find(
    (m) =>
      m.metadata?.event_type === REPLY_EVENT_TYPE &&
      (m.metadata.event_payload as { trace_id?: unknown } | undefined)?.trace_id === traceId,
  );
  return hit?.ts ?? null;
}

/** Posts the reply with metadata tagging. Idempotent: if a message with this traceId exists, returns its ts. */
export async function postReply(slack: Slack, target: ReplyTarget, message: SlackMessage): Promise<string> {
  const existing = await findPostedReply(slack, target.channel, target.threadTs, target.traceId);
  if (existing) return existing;

  const res = await slack.web.chat.postMessage({
    channel: target.channel,
    thread_ts: target.threadTs,
    text: message.text,
    blocks: message.blocks,
    metadata: { event_type: REPLY_EVENT_TYPE, event_payload: { trace_id: target.traceId } },
    unfurl_links: false,
  });
  if (!res.ts) throw new Error("chat.postMessage returned no ts");
  return res.ts;
}

export type SlackDeps = {
  signingSecret: string;
  allowedChannels: Set<string> | "*";
  callbackKey: string;
  publicUrl: string;
  slack: Slack;
  log: (line: string) => void;
};

// ── Slack adapter routes ────────────────────────────────────────────────

export function mountSlackRoutes(
  app: Hono,
  slackDeps: SlackDeps,
  apiDeps: { startQuestion: StartQuestion; log: (line: string) => void },
) {
  const { slack } = slackDeps;

  app.post("/slack/events", async (c) => {
    const rawBody = await c.req.text();

    if (
      !verifySlackSignature({
        signingSecret: slackDeps.signingSecret,
        timestamp: c.req.header("x-slack-request-timestamp"),
        signature: c.req.header("x-slack-signature"),
        rawBody,
      })
    ) {
      return c.text("invalid signature", 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.text("invalid JSON", 400);
    }

    const event = parseSlackEvent(payload);

    if (event.kind === "url_verification") {
      return c.json({ challenge: event.challenge });
    }

    if (event.kind === "ignored") return c.text("ok", 200);

    if (slackDeps.allowedChannels !== "*" && !slackDeps.allowedChannels.has(event.channel)) {
      return c.text("ok", 200);
    }

    // Add 👀 reaction
    try {
      await react(slack, event.channel, event.ts, "eyes");
    } catch (err) {
      slackDeps.log(JSON.stringify({ event: "eyes_failed", error: err instanceof Error ? err.message : String(err) }));
    }

    // Read the thread into a transcript
    const threadTs = event.threadTs ?? event.ts;
    const transcript = await fetchTranscript(slack, event.channel, threadTs);
    const apiTranscript: ApiTranscript = transcript.map((m) => ({
      text: m.text,
      author: m.user_id ?? undefined,
      is_agent: m.is_agent,
    }));

    // Compute per-event callback secret: HMAC-SHA256(SLACK_CALLBACK_KEY, event_id)
    const callbackSecret = createHmac("sha256", slackDeps.callbackKey).update(event.eventId).digest("hex");

    const metadata = {
      channel: event.channel,
      thread_ts: threadTs,
      mention_ts: event.ts,
      event_id: event.eventId,
    };

    try {
      const run = await apiDeps.startQuestion(
        {
          transcript: apiTranscript,
          callback: {
            url: `${slackDeps.publicUrl}/slack/deliver`,
            secret: callbackSecret,
          },
          metadata,
        },
        { idempotencyKey: event.eventId, signal: AbortSignal.timeout(2500) },
      );
      apiDeps.log(JSON.stringify({ event: "task_started", channel: event.channel, event_id: event.eventId, run_id: run.id }));
      return c.text("ok", 200);
    } catch (err) {
      apiDeps.log(
        JSON.stringify({
          event: "task_start_failed",
          event_id: event.eventId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return c.text("internal error", 500);
    }
  });

  app.post("/slack/deliver", async (c) => {
    const rawBody = await c.req.text();

    let body: {
      id?: string;
      trace_id?: string;
      reply?: Reply;
      metadata?: { channel?: string; thread_ts?: string; mention_ts?: string; event_id?: string };
    };
    try {
      body = JSON.parse(rawBody);
    } catch {
      return c.text("invalid JSON", 400);
    }

    const eventId = body.metadata?.event_id;
    if (!eventId) return c.text("missing metadata.event_id", 400);

    // Recompute the secret from event_id and verify the signature
    const expectedSecret = createHmac("sha256", slackDeps.callbackKey).update(eventId).digest("hex");
    if (
      !verifyCallback({
        secret: expectedSecret,
        signature: c.req.header("x-triage-signature"),
        timestamp: c.req.header("x-triage-timestamp"),
        body: rawBody,
      })
    ) {
      return c.text("unauthorized", 401);
    }

    const { reply, metadata, trace_id: traceId } = body;
    if (!reply || !metadata?.channel || !metadata.thread_ts || !traceId) {
      return c.text("missing fields", 400);
    }

    // Post the Block Kit reply (idempotent by trace id)
    await postReply(
      slack,
      { channel: metadata.channel, threadTs: metadata.thread_ts, traceId },
      formatReply(reply),
    );

    // Swap 👀 for ✅ or ⚠️
    const outcome = reply.kind === "answer" || reply.kind === "clarification" ? "success" : "failure";
    if (metadata.mention_ts) {
      await swapEyesForResult(slack, metadata.channel, metadata.mention_ts, outcome);
    }

    return c.text("ok", 200);
  });
}
