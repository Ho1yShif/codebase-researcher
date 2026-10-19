import { createHmac } from "node:crypto";
import { z } from "zod";
import { safeEqual } from "../callback.ts";

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
