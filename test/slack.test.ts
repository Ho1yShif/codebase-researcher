import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type { KnownBlock } from "@slack/types";
import { mountSlackRoutes, type SlackDeps } from "../src/slack/routes.ts";
import { fitTranscript } from "../src/slack/transcript.ts";
import { escapeMrkdwn, formatReply, type SlackMessage } from "../src/slack/format.ts";
import { signCallback } from "../src/callback.ts";
import { createLog } from "../src/log.ts";
import { ApiTranscript, type Callback, type QuestionMetadata, type Reply, type StartQuestion } from "../src/question.ts";
import type { Evidence, FinalAnswer } from "../src/investigation.ts";
import config from "../config.ts";
import { createFakeSlack } from "./fakes.ts";

const CH = "C0SUPPORT";
const SIGNING_SECRET = "e2e-signing-secret";
const EVENT_ID = "Ev123ABC";

type Started = { input: { transcript: ApiTranscript; callback?: Callback; metadata?: QuestionMetadata }; key?: string };
type LogLine = Record<string, unknown>;

function harness(opts: { start?: StartQuestion; allowedChannels?: SlackDeps["allowedChannels"] } = {}) {
  const slack = createFakeSlack();
  const started: Started[] = [];
  const logs: LogLine[] = [];
  const pending: Promise<void>[] = [];
  const startQuestion: StartQuestion = async (input, o) => {
    started.push({ input, key: o.idempotencyKey });
    return opts.start ? opts.start(input, o) : { id: `run-for-${o.idempotencyKey}` };
  };
  const app = new Hono();
  mountSlackRoutes(app, {
    signingSecret: SIGNING_SECRET,
    allowedChannels: opts.allowedChannels ?? new Set([CH]),
    callbackKey: "slack-callback-key-long-enough",
    publicUrl: "https://researcher.example.com",
    slack,
    background: (work) => void pending.push(work),
  }, { startQuestion, log: createLog({}, (line) => void logs.push(JSON.parse(line))) });

  const sendEvent = (body: string, headers: Record<string, string> = slackSign(body)) =>
    app.request("/slack/events", { method: "POST", headers, body });
  const deliver = (body: string, headers: Record<string, string>) =>
    app.request("/slack/deliver", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const botReplies = () => slack.messages.filter((m) => m.user === "UBOT");
  const settle = () => Promise.all(pending);

  /** Mentions the bot in a fresh thread and returns what a callback receiver needs to deliver the reply. */
  async function mentionAndStart() {
    const parent = slack.seed({ channel: CH, user: "U1", text: "<@UBOT> hello" });
    await sendEvent(mentionBody({ ts: parent.ts }));
    await settle();
    const { callback, metadata } = started.at(-1)!.input;
    return { parent, secret: callback!.secret, metadata: metadata! };
  }

  return { slack, started, logs, sendEvent, deliver, botReplies, settle, mentionAndStart };
}

function slackSign(body: string, secret = SIGNING_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return { "x-slack-request-timestamp": String(timestamp), "x-slack-signature": sig, "content-type": "application/json" };
}

function mentionBody(event: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "event_callback",
    team_id: "T0001",
    event_id: EVENT_ID,
    event: { type: "app_mention", channel: CH, ts: "1700000000.000001", user: "U1", text: "<@UBOT> hello", ...event },
    authorizations: [{ user_id: "UBOT", is_bot: true }],
    ...envelope,
  });
}

function signedDelivery(payload: unknown, secret: string, timestamp?: number) {
  const body = JSON.stringify(payload);
  const sig = signCallback(secret, body, timestamp);
  return { body, headers: { "x-researcher-signature": sig.signature, "x-researcher-timestamp": String(sig.timestamp) } };
}

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

const answer = (result = finalAnswer()): Reply => ({
  kind: "answer",
  traceId: "abc123def0",
  result,
  model: "claude-sonnet-5",
  manifestCreatedAt: "2026-10-01T12:34:56.000Z",
});

const clarification = (question = "Which region?", why = "Routing differs by region."): Reply => ({
  kind: "clarification",
  traceId: "t1",
  result: { status: "needs_clarification", question, why_needed: why },
});

const blockTexts = (blocks: KnownBlock[]) =>
  blocks.flatMap((b) =>
    b.type === "section" && b.text ? [b.text.text]
    : b.type === "context" ? b.elements.flatMap((e) => ("text" in e ? [e.text] : []))
    : []);

const shown = (msg: SlackMessage) => blockTexts(msg.blocks).join("\n");

function expectWithinSlackLimits(msg: SlackMessage) {
  expect(msg.blocks.length).toBeLessThanOrEqual(50);
  expect(msg.text.length).toBeLessThanOrEqual(3000);
  for (const t of blockTexts(msg.blocks)) expect(t.length).toBeLessThanOrEqual(3000);
}

describe("POST /slack/events", () => {
  it("rejects requests whose Slack signature is missing, wrong, or outside the 5-minute window", async () => {
    const { sendEvent, started, settle } = harness();
    const body = mentionBody();
    const now = Math.floor(Date.now() / 1000);
    const cases: Record<string, [string, Record<string, string>]> = {
      "no signature": [body, { "content-type": "application/json" }],
      "wrong secret": [body, slackSign(body, "wrong-secret")],
      "tampered body": [body.replace("hello", "goodbye"), slackSign(body)],
      "stale timestamp": [body, slackSign(body, SIGNING_SECRET, now - 600)],
      "future timestamp": [body, slackSign(body, SIGNING_SECRET, now + 600)],
    };
    for (const [name, [sent, headers]] of Object.entries(cases)) {
      expect((await sendEvent(sent, headers)).status, name).toBe(401);
    }
    await settle();
    expect(started).toEqual([]);
  });

  it("answers Slack's url_verification challenge", async () => {
    const res = await harness().sendEvent(JSON.stringify({ type: "url_verification", challenge: "test-challenge-xyz" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "test-challenge-xyz" });
  });

  it("ignores bot messages, its own messages, and non-mention events", async () => {
    const { sendEvent, started, slack, settle } = harness();
    const parent = slack.seed({ channel: CH, user: "U1", text: "hello" });
    const cases = {
      "another bot": mentionBody({ ts: parent.ts, bot_id: "BOTHER" }),
      "no user": mentionBody({ ts: parent.ts, user: undefined }),
      "this bot": mentionBody({ ts: parent.ts, user: "UBOT" }),
      "plain message": mentionBody({ ts: parent.ts, type: "message" }),
    };
    for (const [name, body] of Object.entries(cases)) {
      expect((await sendEvent(body)).status, name).toBe(200);
    }
    await settle();
    expect(started).toEqual([]);
    expect(parent.reactions).toBeUndefined();
  });

  it("only handles mentions in ALLOWED_CHANNEL_IDS, where * allows every channel", async () => {
    const restricted = harness();
    expect((await restricted.sendEvent(mentionBody({ channel: "C_OTHER" }))).status).toBe(200);
    await restricted.settle();
    expect(restricted.started).toEqual([]);
    expect(restricted.logs).toContainEqual(expect.objectContaining({ event: "mention_ignored", channel: "C_OTHER" }));

    const open = harness({ allowedChannels: "*" });
    await open.sendEvent(mentionBody({ channel: "C_OTHER" }));
    await open.settle();
    expect(open.started).toHaveLength(1);

    expect(harness({ allowedChannels: new Set() }).logs).toContainEqual(expect.objectContaining({ level: "warn", event: "slack_no_channels" }));
  });

  it("acknowledges a mention before the run starts, then reacts and starts one question keyed on the event id", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { sendEvent, started, slack, settle, logs } = harness({ start: async () => (await gate, { id: "run-1" }) });
    const parent = slack.seed({ channel: CH, user: "U1", text: "<@UBOT> hello" });

    expect((await sendEvent(mentionBody({ ts: parent.ts }))).status).toBe(200);

    release();
    await settle();
    expect(parent.reactions).toEqual([{ name: "eyes", user: "UBOT" }]);
    expect(started).toHaveLength(1);
    expect(started[0]!.key).toBe(EVENT_ID);
    expect(started[0]!.input.callback).toEqual({ url: "https://researcher.example.com/slack/deliver", secret: expect.any(String) });
    expect(started[0]!.input.metadata).toEqual({ channel: CH, thread_ts: parent.ts, mention_ts: parent.ts, event_id: EVENT_ID });
    expect(logs).toContainEqual(expect.objectContaining({ event: "task_started", event_id: EVENT_ID, run_id: "run-1" }));
  });

  it("handles a Slack retry like the original, so the event id dedupes the run", async () => {
    const { sendEvent, started, slack, settle, logs } = harness();
    const parent = slack.seed({ channel: CH, user: "U1", text: "<@UBOT> hello" });
    const body = mentionBody({ ts: parent.ts });
    await sendEvent(body);
    expect((await sendEvent(body, { ...slackSign(body), "x-slack-retry-num": "1" })).status).toBe(200);
    await settle();
    expect(started.map((s) => s.key)).toEqual([EVENT_ID, EVENT_ID]);
    expect(parent.reactions).toEqual([{ name: "eyes", user: "UBOT" }]);
    expect(logs).toContainEqual(expect.objectContaining({ event: "slack_retry", event_id: EVENT_ID, retry_num: 1 }));
  });

  it("sends the thread as the transcript, marking the bot's messages and stripping its mention", async () => {
    const { sendEvent, started, slack, settle } = harness();
    const parent = slack.seed({ channel: CH, user: "U1", text: "<@UBOT> How do deploys work?" });
    slack.seed({ channel: CH, thread_ts: parent.ts, user: "UBOT", bot_id: "BBOT", text: "Deploys run via git push." });
    const followUp = slack.seed({ channel: CH, thread_ts: parent.ts, user: "U2", text: "<@UBOT|codebase-researcher> ask <@U3> too?" });
    await sendEvent(mentionBody({ ts: followUp.ts, thread_ts: parent.ts }));
    await settle();
    expect(started[0]!.input.transcript).toEqual([
      { text: "How do deploys work?", author: "U1", is_agent: false },
      { text: "Deploys run via git push.", author: "UBOT", is_agent: true },
      { text: "ask <@U3> too?", author: "U2", is_agent: false },
    ]);
    expect(started[0]!.input.metadata).toMatchObject({ thread_ts: parent.ts, mention_ts: followUp.ts });
  });

  it("trims a long thread to the question API limits, keeping the opening and latest messages", async () => {
    const { sendEvent, started, slack, settle } = harness();
    const parent = slack.seed({ channel: CH, user: "U1", text: "<@UBOT> why does this fail?" });
    slack.seed({ channel: CH, thread_ts: parent.ts, user: "U1", text: "log ".repeat(5000) });
    for (let i = 0; i < 250; i++) slack.seed({ channel: CH, thread_ts: parent.ts, user: "U2", text: `reply ${i}` });
    await sendEvent(mentionBody({ ts: parent.ts }));
    await settle();
    const { transcript } = started[0]!.input;
    expect(ApiTranscript.safeParse(transcript).success).toBe(true);
    expect(transcript[0]!.text).toBe("why does this fail?");
    expect(transcript[1]!.text).toBe("[52 earlier messages in this thread omitted]\n\nreply 51");
    expect(transcript.at(-1)!.text).toBe("reply 249");
  });

  it("posts a failure reply and a warning reaction when the question can't be started", async () => {
    const { sendEvent, slack, botReplies, settle, logs } = harness({ start: async () => { throw new Error("boom"); } });
    const parent = slack.seed({ channel: CH, user: "U1", text: "<@UBOT> hello" });
    expect((await sendEvent(mentionBody({ ts: parent.ts }))).status).toBe(200);
    await settle();
    expect(botReplies()).toHaveLength(1);
    expect(botReplies()[0]).toMatchObject({ thread_ts: parent.ts });
    expect(botReplies()[0]!.text).toContain("didn't accept the question");
    expect(botReplies()[0]!.text).toContain(`Trace \`${EVENT_ID}\``);
    expect(parent.reactions).toEqual([{ name: "warning", user: "UBOT" }]);
    expect(logs).toContainEqual(expect.objectContaining({ level: "error", event: "task_start_failed", event_id: EVENT_ID, error: "boom" }));
  });
});

describe("fitTranscript", () => {
  it("leaves a short transcript alone and cuts an over-long message, saying how much was cut", () => {
    const short = [{ text: "hi", author: "U1" }, { text: "hello", is_agent: true }];
    expect(fitTranscript(short)).toEqual(short);

    const [cut] = fitTranscript([{ text: "a".repeat(20_000) }]);
    expect(cut!.text.length).toBeLessThanOrEqual(8000);
    const omitted = Number(/\[truncated: (\d+) more characters\]$/.exec(cut!.text)?.[1]);
    expect(cut!.text.indexOf("\n\n[truncated") + omitted).toBe(20_000);
  });
});

describe("POST /slack/deliver", () => {
  it.each([
    { kind: "answer", reply: answer(), reaction: "white_check_mark" },
    { kind: "clarification", reply: clarification(), reaction: "white_check_mark" },
    { kind: "failure", reply: { kind: "failure", traceId: "t9", reason: "timed out" } as Reply, reaction: "warning" },
  ])("posts a signed $kind reply in the thread and swaps eyes for $reaction", async ({ reply, reaction }) => {
    const { mentionAndStart, deliver, botReplies } = harness();
    const { parent, secret, metadata } = await mentionAndStart();
    const { body, headers } = signedDelivery({ id: "run-1", trace_id: reply.traceId, reply, metadata }, secret);
    expect((await deliver(body, headers)).status).toBe(200);
    expect(botReplies()).toHaveLength(1);
    expect(botReplies()[0]).toMatchObject({ thread_ts: parent.ts, text: formatReply(reply).text });
    expect(parent.reactions).toEqual([{ name: reaction, user: "UBOT" }]);
  });

  it("rejects deliveries not signed with that question's fresh callback secret", async () => {
    const { mentionAndStart, deliver, botReplies } = harness();
    const { parent, secret, metadata } = await mentionAndStart();
    const payload = { id: "run-1", trace_id: "t1", reply: clarification(), metadata };
    const valid = signedDelivery(payload, secret);
    const cases = {
      "no signature": { body: valid.body, headers: {} },
      "bad signature": { body: valid.body, headers: { ...valid.headers, "x-researcher-signature": "v1=badbadbad" } },
      "another secret": signedDelivery(payload, "some-other-secret-123456"),
      "stale timestamp": signedDelivery(payload, secret, Math.floor(Date.now() / 1000) - 600),
      "another event's id": signedDelivery({ ...payload, metadata: { ...metadata, event_id: "EvOTHER" } }, secret),
    };
    for (const [name, { body, headers }] of Object.entries(cases)) {
      expect((await deliver(body, headers)).status, name).toBe(401);
    }
    expect(botReplies()).toEqual([]);
    expect(parent.reactions).toEqual([{ name: "eyes", user: "UBOT" }]);
  });

  it("posts the reply only once when the same trace id is delivered twice", async () => {
    const { mentionAndStart, deliver, botReplies } = harness();
    const { parent, secret, metadata } = await mentionAndStart();
    const { body, headers } = signedDelivery({ id: "run-1", trace_id: "t1", reply: clarification(), metadata }, secret);
    expect((await deliver(body, headers)).status).toBe(200);
    expect((await deliver(body, headers)).status).toBe(200);
    expect(botReplies()).toHaveLength(1);
    expect(parent.reactions).toEqual([{ name: "white_check_mark", user: "UBOT" }]);
  });
});

describe("formatReply", () => {
  it("renders an answer with every section, evidence links to the exact lines, and a trace footer", () => {
    const text = shown(formatReply(answer()));
    const headings = [...text.matchAll(/^\*([^*]+)\*$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      "Short answer", "Confidence", "Observed in code", "Inferred behavior", "Not established", "Evidence",
      config.labels.owner, config.labels.escalation,
    ]);
    expect(text).toContain("Yes, the CLI reuses the last selected workspace.");
    expect(text).toContain("Medium");
    expect(text).toContain("• The workspace ID is read from the config file.");
    expect(text).toContain(
      `<https://github.com/render-oss/cli/blob/${sha}/pkg/workspace/select.go#L10-L24|render-oss/cli pkg/workspace/select.go:10-24 @ 0123456>`,
    );
    expect(text).toContain("Trace `abc123def0` · Model `claude-sonnet-5` · Repositories as of 2026-10-01 12:34 UTC");

    const empty = shown(formatReply(answer(finalAnswer({ observed_in_code: [], inferred_behavior: [], not_established: [], evidence: [] }))));
    expect(empty.match(/^_None_$/gm)).toHaveLength(4);
  });

  it("renders a clarification as the question, why it's needed, and the trace id", () => {
    const text = shown(formatReply(clarification()));
    expect(text).toContain("Which region?");
    expect(text).toContain("_Why I'm asking:_ Routing differs by region.");
    expect(text).toContain("Trace `t1`");
  });

  it("renders a failure with the reason and a trace id to share with support, even for a huge reason", () => {
    const msg = formatReply({ kind: "failure", traceId: "t2", reason: "the investigation did not finish in time." });
    expect(msg.text).toBe(
      `I couldn't complete this investigation: the investigation did not finish in time. Trace \`t2\` — share it with ${config.labels.supportTeam} for debugging.`,
    );
    const huge = formatReply({ kind: "failure", traceId: "keepme", reason: "x".repeat(10_000) });
    expect(huge.text).toContain("Trace `keepme`");
    expectWithinSlackLimits(huge);
  });

  it("escapes model text so it can't ping people or inject links", () => {
    expect(escapeMrkdwn("a & <b> c")).toBe("a &amp; &lt;b&gt; c");
    const hostile = "Use <!channel> & ping <@U123> at <https://evil.example|docs>";
    const replies: Reply[] = [
      answer(finalAnswer({ answer: hostile, observed_in_code: [hostile], suggested_owner: hostile, escalation_question: hostile })),
      clarification(hostile, hostile),
      { kind: "failure", traceId: "t3", reason: hostile },
    ];
    for (const reply of replies) {
      const msg = formatReply(reply);
      for (const text of [msg.text, shown(msg)]) {
        expect(text, reply.kind).not.toMatch(/<[!@]|<https:\/\/evil/);
        expect(text, reply.kind).toContain("&lt;!channel&gt; &amp; ping &lt;@U123&gt;");
      }
    }
  });

  it("stays within Slack limits, truncating long text and collapsing long lists", () => {
    const msg = formatReply(answer(finalAnswer({
      answer: "word ".repeat(2000),
      observed_in_code: Array.from({ length: 200 }, (_, i) => `finding ${i} `.repeat(20)),
      inferred_behavior: ["y".repeat(5000)],
      evidence: Array.from({ length: 100 }, (_, i) => evidence({ path: `src/file-${i}.ts` })),
    })));
    expectWithinSlackLimits(msg);
    const text = shown(msg);
    expect(text).toMatch(/^\*Short answer\*\n(word )+\S*…$/m);
    expect(text.match(/^• _…and \d+ more_$/gm)).toHaveLength(2);
    expect(text).toContain("Trace `abc123def0`");
    expectWithinSlackLimits(formatReply(clarification("q".repeat(5000), "w".repeat(5000))));
  });
});
