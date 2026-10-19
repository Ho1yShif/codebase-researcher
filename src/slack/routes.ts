import { createHmac } from "node:crypto";
import type { Hono } from "hono";
import type { Reply, StartQuestion } from "../question.ts";
import { errorMessage } from "../util.ts";
import { verifyCallback } from "../callback.ts";
import type { Log } from "../log.ts";
import { parseSlackEvent, verifySlackSignature, type SlackMention } from "./events.ts";
import { postReply, react, swapEyesForResult, type Slack } from "./client.ts";
import { fetchTranscript, fitTranscript } from "./transcript.ts";
import { formatReply } from "./format.ts";

export type SlackDeps = {
  signingSecret: string;
  allowedChannels: Set<string> | "*";
  callbackKey: string;
  publicUrl: string;
  slack: Slack;
  /** Receives the work started after a mention is acknowledged (defaults to fire-and-forget; tests await it). */
  background?: (work: Promise<void>) => void;
};

/** Starting a run happens after Slack is acknowledged, so it isn't bound by Slack's 3-second deadline. */
const START_TIMEOUT_MS = 10_000;

/** Derived per event, so /slack/deliver can verify a callback without storing anything. */
const callbackSecret = (callbackKey: string, eventId: string) =>
  createHmac("sha256", callbackKey).update(eventId).digest("hex");

export function mountSlackRoutes(
  app: Hono,
  slackDeps: SlackDeps,
  apiDeps: { startQuestion: StartQuestion; log: Log },
) {
  const { slack } = slackDeps;
  const { log } = apiDeps;
  if (slackDeps.allowedChannels !== "*" && slackDeps.allowedChannels.size === 0) {
    log.warn(
      "ALLOWED_CHANNEL_IDS is empty, so the bot ignores every mention; list channel IDs, or * for all",
      { event: "slack_no_channels" },
    );
  }

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
      log.info("mention ignored", { event: "mention_ignored", reason: "channel_not_allowed", channel: event.channel });
      return c.text("ok", 200);
    }

    // Slack wants a 200 within 3 seconds and retries otherwise, so acknowledge now and start the question
    // after. A retry (X-Slack-Retry-Num) is handled like the original: the run is keyed on the event id.
    const retry = c.req.header("x-slack-retry-num");
    if (retry) log.info("slack retry", { event: "slack_retry", event_id: event.eventId, retry_num: Number(retry) });
    (slackDeps.background ?? ((work) => void work))(startMention(event));
    return c.text("ok", 200);
  });

  /** Reacts, reads the thread, and starts the question; on failure, says so in the thread. Never throws. */
  async function startMention(event: SlackMention): Promise<void> {
    const threadTs = event.threadTs ?? event.ts;
    try {
      await react(slack, event.channel, event.ts, "eyes");
    } catch (err) {
      log.warn("eyes reaction failed", { event: "eyes_failed", error: errorMessage(err) });
    }

    try {
      const transcript = await fetchTranscript(slack, event.channel, threadTs);
      const apiTranscript = fitTranscript(transcript.map((m) => ({
        text: m.text,
        author: m.user_id ?? undefined,
        is_agent: m.is_agent,
      })));

      const run = await apiDeps.startQuestion(
        {
          transcript: apiTranscript,
          callback: {
            url: `${slackDeps.publicUrl}/slack/deliver`,
            secret: callbackSecret(slackDeps.callbackKey, event.eventId),
          },
          metadata: { channel: event.channel, thread_ts: threadTs, mention_ts: event.ts, event_id: event.eventId },
        },
        { idempotencyKey: event.eventId, signal: AbortSignal.timeout(START_TIMEOUT_MS) },
      );
      log.info("task started", { event: "task_started", channel: event.channel, event_id: event.eventId, run_id: run.id });
    } catch (err) {
      log.error("task start failed", { event: "task_start_failed", event_id: event.eventId, error: errorMessage(err) });
      const reply: Reply = { kind: "failure", traceId: event.eventId, reason: "the investigation service didn't accept the question" };
      try {
        await postReply(slack, { channel: event.channel, threadTs, traceId: event.eventId }, formatReply(reply));
        await swapEyesForResult(slack, event.channel, event.ts, "failure");
      } catch (replyErr) {
        log.error("failure reply failed", { event: "failure_reply_failed", event_id: event.eventId, error: errorMessage(replyErr) });
      }
    }
  }

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

    if (
      !verifyCallback({
        secret: callbackSecret(slackDeps.callbackKey, eventId),
        signature: c.req.header("x-researcher-signature"),
        timestamp: c.req.header("x-researcher-timestamp"),
        body: rawBody,
      })
    ) {
      return c.text("unauthorized", 401);
    }

    const { reply, metadata, trace_id: traceId } = body;
    if (!reply || !metadata?.channel || !metadata.thread_ts || !traceId) {
      return c.text("missing fields", 400);
    }

    await postReply(
      slack,
      { channel: metadata.channel, threadTs: metadata.thread_ts, traceId },
      formatReply(reply),
    );

    const outcome = reply.kind === "answer" || reply.kind === "clarification" ? "success" : "failure";
    if (metadata.mention_ts) {
      await swapEyesForResult(slack, metadata.channel, metadata.mention_ts, outcome);
    }

    return c.text("ok", 200);
  });
}
