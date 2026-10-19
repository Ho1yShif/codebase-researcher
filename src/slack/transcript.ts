import type { Transcript } from "../investigation.ts";
import { MESSAGE_MAX_CHARS, TRANSCRIPT_MAX_MESSAGES, type ApiTranscript } from "../question.ts";
import { fetchThread, type Slack, type ThreadMessage } from "./client.ts";

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

/** The thread oldest-first, with our bot's replies marked `is_agent` and mentions of it stripped. */
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

const omittedNote = (n: number) => `[${n} earlier ${n === 1 ? "message" : "messages"} in this thread omitted]`;
const truncatedNote = (n: number) => `\n\n[truncated: ${n} more characters]`;

function cutMessage(text: string): string {
  const keep = MESSAGE_MAX_CHARS - truncatedNote(text.length).length;
  const head = text.slice(0, keep).replace(/[\uD800-\uDBFF]$/, "");
  return head + truncatedNote(text.length - head.length);
}

/**
 * Fits a thread into the question API's limits instead of letting the run fail: keeps the opening message and
 * the most recent ones, and cuts long messages (pasted logs), saying so in the text the agent reads.
 */
export function fitTranscript(messages: ApiTranscript): ApiTranscript {
  let kept = messages;
  if (messages.length > TRANSCRIPT_MAX_MESSAGES) {
    const omitted = messages.length - TRANSCRIPT_MAX_MESSAGES;
    const [first, ...rest] = messages;
    const [next, ...recent] = rest.slice(omitted);
    kept = [first!, { ...next!, text: `${omittedNote(omitted)}\n\n${next!.text}` }, ...recent];
  }
  return kept.map((m) => (m.text.length > MESSAGE_MAX_CHARS ? { ...m, text: cutMessage(m.text) } : m));
}
