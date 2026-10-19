import type { KnownBlock, ContextBlock, SectionBlock } from "@slack/types";
import { buildEvidenceUrl, type Evidence, type FinalAnswer } from "../investigation.ts";
import type { Reply } from "../question.ts";
import config from "../../config.ts";

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

export type SlackMessage = { text: string; blocks: KnownBlock[] };

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
