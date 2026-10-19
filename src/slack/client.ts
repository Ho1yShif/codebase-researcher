import { LogLevel, WebClient } from "@slack/web-api";
import type { ConversationsRepliesResponse } from "@slack/web-api";
import type { SlackMessage } from "./format.ts";

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

function isSlackError(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "data" in e && typeof (e as { data?: unknown }).data === "object" &&
    (e as { data: { error?: unknown } }).data?.error === code;
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

export const REPLY_EVENT_TYPE = "researcher_reply";

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
