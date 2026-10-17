import { describe, expect, it, beforeEach } from "vitest";
import { Hono } from "hono";
import { parseSlackEvent, verifySlackSignature, escapeMrkdwn, truncate, evidenceUrl, formatReply, react, unreact, swapEyesForResult, postReply, findPostedReply, REPLY_EVENT_TYPE, fetchTranscript, compareTs, slackTsToIso, mountSlackRoutes, fitTranscript, type SlackDeps } from "../src/slack.ts";
import { signCallback } from "../src/callback.ts";
import { ApiTranscript, type Reply, type StartQuestion } from "../src/types.ts";
import { createHmac } from "node:crypto";
import type { Evidence, FinalAnswer } from "../src/types.ts";
import config from "../config.ts";
import type { KnownBlock } from "@slack/types";
import { createFakeSlack } from "./fakes.ts";

const CH = "C0SUPPORT";

const BOT_USER = "UBOT";

function mention(overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: "T0001",
    event_id: "Ev123",
    event: { type: "app_mention", channel: "C0SUPPORT", ts: "1700000000.000001", user: "UHUMAN", text: "hello", ...overrides },
    authorizations: [{ user_id: BOT_USER, is_bot: true }],
  };
}

describe("parseSlackEvent", () => {
  it("parses a human app_mention", () => {
    const result = parseSlackEvent(mention());
    expect(result).toEqual({
      kind: "mention",
      eventId: "Ev123",
      teamId: "T0001",
      channel: "C0SUPPORT",
      ts: "1700000000.000001",
      threadTs: undefined,
      user: "UHUMAN",
      text: "hello",
    });
  });

  it("includes thread_ts when present", () => {
    const result = parseSlackEvent(mention({ thread_ts: "1700000000.000000" }));
    expect(result).toMatchObject({ kind: "mention", threadTs: "1700000000.000000" });
  });

  it("returns url_verification with challenge", () => {
    const result = parseSlackEvent({ type: "url_verification", challenge: "abc123" });
    expect(result).toEqual({ kind: "url_verification", challenge: "abc123" });
  });

  it("ignores non-event_callback payloads", () => {
    expect(parseSlackEvent({ type: "something_else" })).toEqual({ kind: "ignored" });
    expect(parseSlackEvent(null)).toEqual({ kind: "ignored" });
    expect(parseSlackEvent(42)).toEqual({ kind: "ignored" });
  });

  it("ignores non-app_mention events", () => {
    const body = { ...mention(), event: { type: "message", channel: "C0SUPPORT", ts: "1.0", text: "hi" } };
    expect(parseSlackEvent(body)).toEqual({ kind: "ignored" });
  });

  it("ignores bot messages (bot_id present)", () => {
    expect(parseSlackEvent(mention({ bot_id: "BOTHER" }))).toEqual({ kind: "ignored" });
  });

  it("ignores messages without a user", () => {
    expect(parseSlackEvent(mention({ user: undefined }))).toEqual({ kind: "ignored" });
  });

  it("ignores mentions from the bot itself (via authorizations)", () => {
    expect(parseSlackEvent(mention({ user: BOT_USER }))).toEqual({ kind: "ignored" });
  });
});

const secret = "8f742231b10e8888abcd99yyyzzz85a5";
const nowMs = 1_700_000_000_000;
const timestamp = String(nowMs / 1000);
const rawBody = JSON.stringify({ type: "event_callback", event_id: "Ev1" });
const sign = (body: string, ts = timestamp, key = secret) =>
  `v0=${createHmac("sha256", key).update(`v0:${ts}:${body}`).digest("hex")}`;

const verify = (overrides: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) =>
  verifySlackSignature({ signingSecret: secret, timestamp, signature: sign(rawBody), rawBody, nowMs, ...overrides });

describe("verifySlackSignature", () => {
  it("accepts a valid signature", () => {
    expect(verify()).toBe(true);
  });

  it("accepts timestamps within five minutes either way", () => {
    expect(verify({ nowMs: nowMs + 299_000 })).toBe(true);
    expect(verify({ nowMs: nowMs - 299_000 })).toBe(true);
  });

  it("rejects a bad signature", () => {
    expect(verify({ signature: sign(rawBody, timestamp, "other-secret") })).toBe(false);
    expect(verify({ signature: "v0=deadbeef" })).toBe(false);
    expect(verify({ signature: undefined })).toBe(false);
  });

  it("rejects stale or missing timestamps", () => {
    expect(verify({ nowMs: nowMs + 301_000 })).toBe(false);
    expect(verify({ nowMs: nowMs - 301_000 })).toBe(false);
    expect(verify({ timestamp: undefined })).toBe(false);
    expect(verify({ timestamp: "abc", signature: sign(rawBody, "abc") })).toBe(false);
  });

  it("rejects a tampered body or timestamp", () => {
    expect(verify({ rawBody: rawBody.replace("Ev1", "Ev2") })).toBe(false);
    const ts = String(Number(timestamp) + 1);
    expect(verify({ timestamp: ts })).toBe(false);
  });
});

const HEADINGS = [
  "Short answer",
  "Confidence",
  "Observed in code",
  "Inferred behavior",
  "Not established",
  "Evidence",
  config.labels.owner,
  config.labels.escalation,
];

const sha = "0123456789abcdef0123456789abcdef01234567";
const evidence = (overrides: Partial<Evidence> = {}): Evidence => ({
  repository: "render-oss/cli",
  commit: sha,
  path: "pkg/workspace/select.go",
  start_line: 10,
  end_line: 24,
  ...overrides,
});

const finalAnswer = (overrides: Partial<FinalAnswer> = {}): FinalAnswer => ({
  status: "final_answer",
  answer: "Yes, the CLI reuses the last selected workspace.",
  confidence: "medium",
  observed_in_code: ["The workspace ID is read from the config file."],
  inferred_behavior: ["A fresh install prompts for a workspace."],
  not_established: ["Whether the dashboard overrides it."],
  evidence: [evidence()],
  suggested_owner: "CLI team",
  escalation_question: "Does the API ever reject a stale workspace ID?",
  ...overrides,
});

const answerReply = (
  result: FinalAnswer = finalAnswer(),
  extra: { model?: string; manifestCreatedAt?: string } = {},
): Reply => ({
  kind: "answer",
  traceId: "abc123def0",
  result,
  model: "claude-sonnet-5",
  manifestCreatedAt: "2026-10-01T12:34:56.000Z",
  ...extra,
});

const sectionTexts = (blocks: KnownBlock[]) =>
  blocks.flatMap((b) => (b.type === "section" && b.text ? [b.text.text] : []));
const contextTexts = (blocks: KnownBlock[]) =>
  blocks.flatMap((b) => (b.type === "context" ? b.elements.map((e) => ("text" in e ? e.text : "")) : []));

function expectWithinLimits({ text, blocks }: { text: string; blocks: KnownBlock[] }) {
  expect(blocks.length).toBeLessThanOrEqual(50);
  expect(text.length).toBeLessThanOrEqual(3000);
  for (const t of [...sectionTexts(blocks), ...contextTexts(blocks)]) expect(t.length).toBeLessThanOrEqual(3000);
}

describe("formatReply: clarification", () => {
  it("asks the question and says why", () => {
    const msg = formatReply({
      kind: "clarification",
      traceId: "t1",
      result: { status: "needs_clarification", question: "Which region?", why_needed: "Routing differs by <region>." },
    });
    expect(sectionTexts(msg.blocks)).toEqual(["Which region?", "_Why I'm asking:_ Routing differs by &lt;region&gt;."]);
    expect(msg.text).toContain("Which region?");
    expect(msg.text).toContain("Why I'm asking:");
    expect(contextTexts(msg.blocks)).toEqual(["Trace `t1`"]);
  });
});

describe("formatReply: failure", () => {
  it("includes the reason and trace id", () => {
    const msg = formatReply({ kind: "failure", traceId: "t2", reason: "the investigation did not finish in time" });
    const expected =
      `I couldn't complete this investigation: the investigation did not finish in time. Trace \`t2\` — share it with ${config.labels.supportTeam} for debugging.`;
    expect(msg.text).toBe(expected);
    expect(sectionTexts(msg.blocks)).toEqual([expected]);
    expect(formatReply({ kind: "failure", traceId: "t2", reason: "sandbox lost." }).text).toContain("lost. Trace");
  });

  it("keeps the trace id when the reason is huge", () => {
    const msg = formatReply({ kind: "failure", traceId: "keepme", reason: "x".repeat(10_000) });
    expect(msg.text).toContain("Trace `keepme`");
    expectWithinLimits(msg);
  });
});

describe("formatReply: answer", () => {
  it("renders all eight sections in order", () => {
    const msg = formatReply(answerReply());
    const sections = sectionTexts(msg.blocks);
    expect(sections.map((s) => s.match(/^\*([^*]+)\*/)?.[1])).toEqual(HEADINGS);
    expect(sections[0]).toBe("*Short answer*\nYes, the CLI reuses the last selected workspace.");
    expect(sections[1]).toBe("*Confidence*\nMedium");
    expect(sections[2]).toBe("*Observed in code*\n• The workspace ID is read from the config file.");
    expect(sections[6]).toBe(`*${config.labels.owner}*\nCLI team`);
    expect(sections[7]).toBe(`*${config.labels.escalation}*\nDoes the API ever reject a stale workspace ID?`);
    expectWithinLimits(msg);
  });

  it("links evidence to the exact commit and line range", () => {
    const msg = formatReply(answerReply());
    const url = `https://github.com/render-oss/cli/blob/${sha}/pkg/workspace/select.go#L10-L24`;
    expect(evidenceUrl(evidence())).toBe(url);
    expect(sectionTexts(msg.blocks)[5]).toBe(
      `*Evidence*\n• <${url}|render-oss/cli pkg/workspace/select.go:10-24 @ 0123456>`,
    );
  });

  it("encodes evidence paths so they can't break the link", () => {
    const url = evidenceUrl(evidence({ path: "./docs/a b|c>.md", start_line: 3, end_line: 3 }));
    expect(url).toBe(`https://github.com/render-oss/cli/blob/${sha}/docs/a%20b%7Cc%3E.md#L3-L3`);
  });

  it("keeps every heading with a None marker when lists are empty", () => {
    const msg = formatReply(
      answerReply(finalAnswer({ observed_in_code: [], inferred_behavior: [], not_established: [], evidence: [] })),
    );
    const sections = sectionTexts(msg.blocks);
    expect(sections.map((s) => s.match(/^\*([^*]+)\*/)?.[1])).toEqual(HEADINGS);
    for (const i of [2, 3, 4, 5]) expect(sections[i]).toMatch(/\n_None_$/);
  });

  it("footer shows trace, model, and manifest time", () => {
    expect(contextTexts(formatReply(answerReply()).blocks)).toEqual([
      "Trace `abc123def0` · Model `claude-sonnet-5` · Repositories as of 2026-10-01 12:34 UTC",
    ]);
    const bare = formatReply(answerReply(finalAnswer(), { model: undefined, manifestCreatedAt: undefined }));
    expect(contextTexts(bare.blocks)).toEqual(["Trace `abc123def0`"]);
  });

  it("escapes model-provided text", () => {
    const msg = formatReply(
      answerReply(finalAnswer({ answer: "Use <!channel> & ping <@U123>", suggested_owner: "<team>", observed_in_code: ["a > b"] })),
    );
    const sections = sectionTexts(msg.blocks);
    expect(sections[0]).toBe("*Short answer*\nUse &lt;!channel&gt; &amp; ping &lt;@U123&gt;");
    expect(sections[2]).toBe("*Observed in code*\n• a &gt; b");
    expect(sections[6]).toBe(`*${config.labels.owner}*\n&lt;team&gt;`);
    expect(msg.text).not.toMatch(/<[!@]/);
  });

  it("truncates long text and collapses long lists within Slack limits", () => {
    const msg = formatReply(
      answerReply(
        finalAnswer({
          answer: "word ".repeat(2000),
          observed_in_code: Array.from({ length: 200 }, (_, i) => `finding ${i} `.repeat(20)),
          inferred_behavior: ["y".repeat(5000)],
          evidence: Array.from({ length: 100 }, (_, i) => evidence({ path: `src/file-${i}.ts` })),
        }),
      ),
    );
    expectWithinLimits(msg);
    const sections = sectionTexts(msg.blocks);
    expect(sections[0]!.endsWith("…")).toBe(true);
    expect(sections[2]).toMatch(/\n• _…and \d+ more_$/);
    expect(sections[3]!.length).toBeLessThan(1100);
    expect(sections[3]!.endsWith("…")).toBe(true);
    expect(sections[5]).toMatch(/\n• _…and \d+ more_$/);
    for (const line of sections[5]!.split("\n").slice(1, -1)) expect(line).toMatch(/^• <https:\/\/github\.com\/[^>]+\|[^>]+>$/);
    expect(msg.text.endsWith("…")).toBe(true);
  });
});

describe("mrkdwn helpers", () => {
  it("escapes &, <, >", () => {
    expect(escapeMrkdwn("a & <b> c")).toBe("a &amp; &lt;b&gt; c");
  });

  it("truncate leaves short strings alone and appends an ellipsis otherwise", () => {
    expect(truncate("hello", 5)).toBe("hello");
    expect(truncate("hello world", 6)).toBe("hello…");
  });

  it("truncate never splits an entity, a link, or a surrogate pair", () => {
    expect(truncate("ab &amp; cd", 6)).toBe("ab …");
    expect(truncate("see <https://example.com|link> now", 12)).toBe("see …");
    expect(truncate("ab😀cd", 4)).toBe("ab…");
  });
});

describe("react", () => {
  let slack: ReturnType<typeof createFakeSlack>;

  beforeEach(() => {
    slack = createFakeSlack();
  });

  it("adds a reaction to a message", async () => {
    const msg = slack.seed({ channel: CH, user: "UHUMAN", text: "hello" });
    await react(slack, CH, msg.ts, "eyes");
    expect(msg.reactions).toEqual([{ name: "eyes", user: "UBOT" }]);
  });

  it("treats already_reacted as success", async () => {
    const msg = slack.seed({ channel: CH, user: "UHUMAN", text: "hello" });
    await react(slack, CH, msg.ts, "eyes");
    await react(slack, CH, msg.ts, "eyes");
    expect(msg.reactions).toEqual([{ name: "eyes", user: "UBOT" }]);
  });
});

describe("unreact", () => {
  let slack: ReturnType<typeof createFakeSlack>;

  beforeEach(() => {
    slack = createFakeSlack();
  });

  it("removes a reaction", async () => {
    const msg = slack.seed({ channel: CH, user: "UHUMAN", text: "hello" });
    await react(slack, CH, msg.ts, "eyes");
    await unreact(slack, CH, msg.ts, "eyes");
    expect(msg.reactions).toEqual([]);
  });

  it("treats no_reaction as success", async () => {
    const msg = slack.seed({ channel: CH, user: "UHUMAN", text: "hello" });
    await unreact(slack, CH, msg.ts, "eyes");
    expect(msg.reactions ?? []).toEqual([]);
  });
});

describe("swapEyesForResult", () => {
  let slack: ReturnType<typeof createFakeSlack>;

  beforeEach(() => {
    slack = createFakeSlack();
  });

  it("swaps eyes for white_check_mark on success", async () => {
    const msg = slack.seed({ channel: CH, user: "UHUMAN", text: "hello" });
    await react(slack, CH, msg.ts, "eyes");
    await swapEyesForResult(slack, CH, msg.ts, "success");
    expect(msg.reactions).toEqual([{ name: "white_check_mark", user: "UBOT" }]);
  });

  it("swaps eyes for warning on failure", async () => {
    const msg = slack.seed({ channel: CH, user: "UHUMAN", text: "hello" });
    await react(slack, CH, msg.ts, "eyes");
    await swapEyesForResult(slack, CH, msg.ts, "failure");
    expect(msg.reactions).toEqual([{ name: "warning", user: "UBOT" }]);
  });

  it("works even if eyes was never added (no_reaction tolerated)", async () => {
    const msg = slack.seed({ channel: CH, user: "UHUMAN", text: "hello" });
    await swapEyesForResult(slack, CH, msg.ts, "success");
    expect(msg.reactions).toEqual([{ name: "white_check_mark", user: "UBOT" }]);
  });
});

describe("postReply idempotency", () => {
  let slack: ReturnType<typeof createFakeSlack>;

  beforeEach(() => {
    slack = createFakeSlack();
  });

  it("posts a message the first time", async () => {
    const parent = slack.seed({ channel: CH, user: "UHUMAN", text: "question" });
    const message = formatReply({ kind: "failure", traceId: "trace-1", reason: "timeout" });
    const ts = await postReply(slack, { channel: CH, threadTs: parent.ts, traceId: "trace-1" }, message);

    expect(ts).toBeTruthy();
    const posted = slack.messages.find((m) => m.ts === ts);
    expect(posted).toMatchObject({
      thread_ts: parent.ts,
      metadata: { event_type: REPLY_EVENT_TYPE, event_payload: { trace_id: "trace-1" } },
    });
  });

  it("returns existing ts on retry without posting again", async () => {
    const parent = slack.seed({ channel: CH, user: "UHUMAN", text: "question" });
    const message = formatReply({ kind: "failure", traceId: "trace-2", reason: "timeout" });

    const ts1 = await postReply(slack, { channel: CH, threadTs: parent.ts, traceId: "trace-2" }, message);
    const countBefore = slack.messages.length;
    const ts2 = await postReply(slack, { channel: CH, threadTs: parent.ts, traceId: "trace-2" }, message);

    expect(ts2).toBe(ts1);
    expect(slack.messages.length).toBe(countBefore);
  });

  it("different traceIds post separate messages", async () => {
    const parent = slack.seed({ channel: CH, user: "UHUMAN", text: "question" });
    const msg1 = formatReply({ kind: "failure", traceId: "trace-a", reason: "err" });
    const msg2 = formatReply({ kind: "failure", traceId: "trace-b", reason: "err" });

    const ts1 = await postReply(slack, { channel: CH, threadTs: parent.ts, traceId: "trace-a" }, msg1);
    const ts2 = await postReply(slack, { channel: CH, threadTs: parent.ts, traceId: "trace-b" }, msg2);

    expect(ts1).not.toBe(ts2);
  });
});

describe("findPostedReply", () => {
  let slack: ReturnType<typeof createFakeSlack>;

  beforeEach(() => {
    slack = createFakeSlack();
  });

  it("returns null when no reply with that traceId exists", async () => {
    const parent = slack.seed({ channel: CH, user: "UHUMAN", text: "q" });
    expect(await findPostedReply(slack, CH, parent.ts, "nonexistent")).toBeNull();
  });

  it("finds a reply by traceId in metadata", async () => {
    const parent = slack.seed({ channel: CH, user: "UHUMAN", text: "q" });
    const reply = slack.seed({
      channel: CH,
      thread_ts: parent.ts,
      user: "UBOT",
      bot_id: "BBOT",
      text: "answer",
      metadata: { event_type: REPLY_EVENT_TYPE, event_payload: { trace_id: "match-me" } },
    });
    expect(await findPostedReply(slack, CH, parent.ts, "match-me")).toBe(reply.ts);
  });
});

describe("fetchTranscript", () => {
  let slack: ReturnType<typeof createFakeSlack>;

  beforeEach(() => {
    slack = createFakeSlack();
  });

  it("builds a transcript ordered oldest-first with bot replies marked", async () => {
    const parent = slack.seed({ channel: CH, user: "UHUMAN", text: "<@UBOT> How do deploys work?" });
    slack.seed({ channel: CH, thread_ts: parent.ts, user: "UBOT", bot_id: "BBOT", text: "Deploys run via git push." });
    slack.seed({ channel: CH, thread_ts: parent.ts, user: "UHUMAN", text: "Thanks!" });

    const transcript = await fetchTranscript(slack, CH, parent.ts);
    expect(transcript).toHaveLength(3);
    expect(transcript[0]).toMatchObject({ user_id: "UHUMAN", is_agent: false, text: "How do deploys work?" });
    expect(transcript[1]).toMatchObject({ user_id: "UBOT", is_agent: true, text: "Deploys run via git push." });
    expect(transcript[2]).toMatchObject({ user_id: "UHUMAN", is_agent: false, text: "Thanks!" });
  });

  it("strips the bot mention from text", async () => {
    const parent = slack.seed({ channel: CH, user: "UHUMAN", text: "<@UBOT> what's up?" });
    const transcript = await fetchTranscript(slack, CH, parent.ts);
    expect(transcript[0]!.text).toBe("what's up?");
  });

  it("strips named bot mentions (<@UBOT|botname>)", async () => {
    const parent = slack.seed({ channel: CH, user: "UHUMAN", text: "<@UBOT|codebase-researcher> what's up?" });
    const transcript = await fetchTranscript(slack, CH, parent.ts);
    expect(transcript[0]!.text).toBe("what's up?");
  });

  it("fills 'at' from ts", async () => {
    const parent = slack.seed({ channel: CH, user: "UHUMAN", text: "hello", ts: "1700000000.000001" });
    const transcript = await fetchTranscript(slack, CH, parent.ts);
    expect(transcript[0]!.at).toBe("2023-11-14T22:13:20.000Z");
  });

  it("returns an empty transcript for an empty thread", async () => {
    const transcript = await fetchTranscript(slack, CH, "9999999999.000000");
    expect(transcript).toEqual([]);
  });
});

describe("compareTs", () => {
  it("sorts by seconds then micros", () => {
    expect(compareTs("1700000000.000001", "1700000000.000002")).toBeLessThan(0);
    expect(compareTs("1700000001.000000", "1700000000.999999")).toBeGreaterThan(0);
    expect(compareTs("1700000000.000001", "1700000000.000001")).toBe(0);
  });
});

describe("slackTsToIso", () => {
  it("converts a Slack ts to ISO", () => {
    expect(slackTsToIso("1700000000.000001")).toBe("2023-11-14T22:13:20.000Z");
  });

  it("returns undefined for invalid ts", () => {
    expect(slackTsToIso("abc")).toBeUndefined();
    expect(slackTsToIso("0.0")).toBeUndefined();
  });
});

// ── Slack adapter tests ─────────────────────────────────────────────────

const SLACK_SECRET = "e2e-signing-secret";
const CALLBACK_KEY = "slack-callback-key-long-enough";

function slackSign(body: string, secret = SLACK_SECRET, timestamp = String(Math.floor(Date.now() / 1000))) {
  const sig = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return { "x-slack-request-timestamp": timestamp, "x-slack-signature": sig, "content-type": "application/json" };
}

function slackHarness() {
  const started: Array<{ input: unknown; key?: string }> = [];
  const logs: string[] = [];
  const slack = createFakeSlack();

  const startQuestion: StartQuestion = async (input, opts) => {
    started.push({ input, key: opts.idempotencyKey });
    return { id: "run-slack-1" };
  };

  const app = new Hono();
  app.get("/healthz", (c) => c.text("ok"));

  const slackDeps: SlackDeps = {
    signingSecret: SLACK_SECRET,
    allowedChannels: new Set(["C0SUPPORT"]),
    callbackKey: CALLBACK_KEY,
    publicUrl: "http://localhost:3000",
    slack,
    log: (l) => logs.push(l),
  };

  mountSlackRoutes(app, slackDeps, { startQuestion, log: (l) => logs.push(l) });

  return { app, started, logs, slack, slackDeps };
}

function mentionBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "event_callback",
    team_id: "T0001",
    event_id: "Ev123ABC",
    event: { type: "app_mention", channel: "C0SUPPORT", ts: "1700000000.000001", user: "U1", text: "<@UBOT> hello", ...overrides },
    authorizations: [{ user_id: "UBOT", is_bot: true }],
  });
}

describe("Slack /slack/events", () => {
  it("returns 401 for bad signature", async () => {
    const { app } = slackHarness();
    const body = mentionBody();
    const res = await app.request("/slack/events", {
      method: "POST",
      headers: { ...slackSign(body, "wrong-secret"), "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("responds to url_verification", async () => {
    const { app } = slackHarness();
    const body = JSON.stringify({ type: "url_verification", challenge: "test-challenge-xyz" });
    const res = await app.request("/slack/events", { method: "POST", headers: slackSign(body), body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "test-challenge-xyz" });
  });

  it("starts a task for a valid mention", async () => {
    const { app, started, slack } = slackHarness();
    slack.seed({ channel: "C0SUPPORT", ts: "1700000000.000001", user: "U1", text: "<@UBOT> hello" });
    const body = mentionBody();
    const res = await app.request("/slack/events", { method: "POST", headers: slackSign(body), body });
    expect(res.status).toBe(200);
    expect(started).toHaveLength(1);
    expect(started[0]?.key).toBe("Ev123ABC");
    const input = started[0]!.input as { callback: { url: string }; metadata: Record<string, string> };
    expect(input.callback.url).toBe("http://localhost:3000/slack/deliver");
    expect(input.metadata.event_id).toBe("Ev123ABC");
  });

  it("fits a long thread into the question limits", async () => {
    const { app, started, slack } = slackHarness();
    const parent = slack.seed({ channel: "C0SUPPORT", ts: "1700000000.000001", user: "U1", text: "<@UBOT> why does this fail?" });
    slack.seed({ channel: "C0SUPPORT", thread_ts: parent.ts, user: "U1", text: "log ".repeat(5000) });
    for (let i = 0; i < 250; i++) slack.seed({ channel: "C0SUPPORT", thread_ts: parent.ts, user: "U2", text: `reply ${i}` });
    const body = mentionBody();
    const res = await app.request("/slack/events", { method: "POST", headers: slackSign(body), body });
    expect(res.status).toBe(200);
    const { transcript } = started[0]!.input as { transcript: ApiTranscript };
    expect(ApiTranscript.safeParse(transcript).success).toBe(true);
    expect(transcript[0]!.text).toBe("why does this fail?");
    expect(transcript[1]!.text).toBe("[52 earlier messages in this thread omitted]\n\nreply 51");
    expect(transcript.at(-1)!.text).toBe("reply 249");
  });

  it("cuts a message over the length limit and says how much was cut", () => {
    const [cut] = fitTranscript([{ text: "a".repeat(20_000) }]);
    expect(cut!.text.length).toBeLessThanOrEqual(8000);
    const omitted = Number(/\[truncated: (\d+) more characters\]$/.exec(cut!.text)?.[1]);
    expect(cut!.text.indexOf("\n\n[truncated") + omitted).toBe(20_000);
  });

  it("ignores mentions from disallowed channels", async () => {
    const { app, started } = slackHarness();
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev1",
      event: { type: "app_mention", channel: "C_OTHER", ts: "1.0", user: "U1", text: "hi" },
      authorizations: [],
    });
    const res = await app.request("/slack/events", { method: "POST", headers: slackSign(body), body });
    expect(res.status).toBe(200);
    expect(started).toEqual([]);
  });

  it("returns 500 when startQuestion fails", async () => {
    const h = slackHarness();
    const failStart: StartQuestion = async () => { throw new Error("boom"); };
    const app = new Hono();
    mountSlackRoutes(app, h.slackDeps, { startQuestion: failStart, log: () => {} });
    h.slack.seed({ channel: "C0SUPPORT", ts: "1700000000.000001", user: "U1", text: "<@UBOT> hello" });
    const body = mentionBody();
    const res = await app.request("/slack/events", { method: "POST", headers: slackSign(body), body });
    expect(res.status).toBe(500);
  });
});

describe("Slack /slack/deliver", () => {
  it("rejects a bad signature", async () => {
    const { app } = slackHarness();
    const body = JSON.stringify({
      id: "run-1",
      trace_id: "t1",
      reply: { kind: "failure", traceId: "t1", reason: "test" },
      metadata: { channel: "C0SUPPORT", thread_ts: "1.0", mention_ts: "1.0", event_id: "Ev123" },
    });
    const res = await app.request("/slack/deliver", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-researcher-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-researcher-signature": "v1=badbadbad",
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("posts and swaps reactions on valid delivery", async () => {
    const { app, slack } = slackHarness();
    const eventId = "EvDELIVER1";
    const parentTs = "1700000000.000001";
    const parent = slack.seed({ channel: "C0SUPPORT", ts: parentTs, user: "U1", text: "question" });
    // Simulate that the eyes reaction was added earlier
    parent.reactions = [{ name: "eyes", user: "UBOT" }];

    const payload = {
      id: "run-1",
      trace_id: "trace-deliver",
      reply: { kind: "failure" as const, traceId: "trace-deliver", reason: "test" },
      metadata: { channel: "C0SUPPORT", thread_ts: parentTs, mention_ts: parentTs, event_id: eventId },
    };
    const body = JSON.stringify(payload);

    // Compute the secret: HMAC-SHA256(CALLBACK_KEY, eventId)
    const secret = createHmac("sha256", CALLBACK_KEY).update(eventId).digest("hex");
    const { signature, timestamp } = signCallback(secret, body);

    const res = await app.request("/slack/deliver", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-researcher-timestamp": String(timestamp),
        "x-researcher-signature": signature,
      },
      body,
    });
    expect(res.status).toBe(200);

    // Check reply was posted
    const replies = slack.messages.filter((m) => m.thread_ts === parentTs && m.user === "UBOT");
    expect(replies).toHaveLength(1);

    // Check reaction was swapped
    expect(parent.reactions).toEqual([{ name: "warning", user: "UBOT" }]);
  });

  it("is idempotent (posting the same trace_id twice)", async () => {
    const { app, slack } = slackHarness();
    const eventId = "EvIDEM1";
    const parentTs = "1700000000.000002";
    slack.seed({ channel: "C0SUPPORT", ts: parentTs, user: "U1", text: "question" });

    const payload = {
      id: "run-2",
      trace_id: "trace-idem",
      reply: { kind: "failure" as const, traceId: "trace-idem", reason: "timeout" },
      metadata: { channel: "C0SUPPORT", thread_ts: parentTs, mention_ts: parentTs, event_id: eventId },
    };
    const body = JSON.stringify(payload);
    const secret = createHmac("sha256", CALLBACK_KEY).update(eventId).digest("hex");
    const { signature, timestamp } = signCallback(secret, body);
    const headers = {
      "content-type": "application/json",
      "x-researcher-timestamp": String(timestamp),
      "x-researcher-signature": signature,
    };

    await app.request("/slack/deliver", { method: "POST", headers, body });
    const countBefore = slack.messages.length;
    await app.request("/slack/deliver", { method: "POST", headers, body });
    expect(slack.messages.length).toBe(countBefore);
  });
});
