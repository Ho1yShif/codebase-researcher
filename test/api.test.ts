import { describe, expect, it } from "vitest";
import { createApp, loadEnv, toQuestionId, type AppDeps, type GetTaskRun } from "../src/api.ts";
import { signCallback, verifyCallback, type StartQuestion } from "../src/types.ts";

const TOKEN = "test-api-token-1234";

function harness(overrides: Partial<AppDeps> = {}) {
  const started: Array<{ input: unknown; key?: string }> = [];
  const logs: string[] = [];

  const startQuestion: StartQuestion = async (input, opts) => {
    started.push({ input, key: opts.idempotencyKey });
    return { id: "run-123" };
  };

  const getTaskRun: GetTaskRun = async () => ({ status: "running", results: [] });

  const deps: AppDeps = {
    apiToken: TOKEN,
    taskSlug: "support-triage-bot-workflow/answer_question",
    startQuestion,
    getTaskRun,
    isLocalDev: false,
    log: (l) => logs.push(l),
    ...overrides,
  };
  const app = createApp(deps);
  return { app, started, logs, deps };
}

const AUTH = { Authorization: `Bearer ${TOKEN}` };

const validBody = () => ({
  transcript: [{ text: "How does deploy retry?", author: "user1" }],
});

describe("API auth", () => {
  it("returns 401 for missing token", async () => {
    const { app } = harness();
    const res = await app.request("/v1/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong token", async () => {
    const { app } = harness();
    const res = await app.request("/v1/questions", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer wrong-token" },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);
  });

  it("allows requests with correct token", async () => {
    const { app } = harness();
    const res = await app.request("/v1/questions", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(202);
  });
});

describe("POST /v1/questions validation", () => {
  it("returns 400 for empty transcript", async () => {
    const { app } = harness();
    const res = await app.request("/v1/questions", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ transcript: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for transcript text too long", async () => {
    const { app } = harness();
    const res = await app.request("/v1/questions", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ transcript: [{ text: "x".repeat(8001) }] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for too many metadata keys", async () => {
    const { app } = harness();
    const metadata: Record<string, string> = {};
    for (let i = 0; i < 17; i++) metadata[`key${i}`] = "v";
    const res = await app.request("/v1/questions", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ ...validBody(), metadata }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for callback.secret too short", async () => {
    const { app } = harness();
    const res = await app.request("/v1/questions", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ ...validBody(), callback: { url: "https://example.com/hook", secret: "short" } }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for http callback URL in non-local mode", async () => {
    const { app } = harness();
    const res = await app.request("/v1/questions", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ ...validBody(), callback: { url: "http://example.com/hook", secret: "a".repeat(32) } }),
    });
    expect(res.status).toBe(400);
  });

  it("allows http://localhost callback in local dev mode", async () => {
    const { app } = harness({ isLocalDev: true });
    const res = await app.request("/v1/questions", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ ...validBody(), callback: { url: "http://localhost:4000/hook", secret: "a".repeat(32) } }),
    });
    expect(res.status).toBe(202);
  });
});

describe("POST /v1/questions", () => {
  it("passes the idempotency key", async () => {
    const { app, started } = harness();
    const res = await app.request("/v1/questions", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH, "Idempotency-Key": "idem-1" },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { id: string };
    expect(body).toEqual({ id: toQuestionId(TOKEN, "run-123") });
    expect(started[0]?.key).toBe("idem-1");
  });

  it("returns 500 when startQuestion throws", async () => {
    const failStart: StartQuestion = async () => { throw new Error("boom"); };
    const { app, logs } = harness({ startQuestion: failStart });
    const res = await app.request("/v1/questions", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(500);
    expect(logs.some((l) => l.includes("task_start_failed"))).toBe(true);
  });
});

describe("GET /v1/questions/:id", () => {
  const qid = (runId: string) => toQuestionId(TOKEN, runId);
  const run = (status: string, extra: Partial<Awaited<ReturnType<GetTaskRun>>> = {}) => async () => ({ status, results: [], ...extra });

  it("maps running status", async () => {
    const { app } = harness({ getTaskRun: run("running") });
    const res = await app.request(`/v1/questions/${qid("run-1")}`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: qid("run-1"), status: "running" });
  });

  it("maps succeeded status with results", async () => {
    const reply = { kind: "failure", traceId: "t1", reason: "test" };
    const { app } = harness({ getTaskRun: run("succeeded", { results: [{ trace_id: "t1", outcome: "failure", reply }] }) });
    const res = await app.request(`/v1/questions/${qid("run-2")}`, { headers: AUTH });
    expect(await res.json()).toEqual({ id: qid("run-2"), status: "completed", trace_id: "t1", reply });
  });

  it("maps failed status", async () => {
    const { app } = harness({ getTaskRun: run("failed", { error: "timeout" }) });
    const res = await app.request(`/v1/questions/${qid("run-3")}`, { headers: AUTH });
    expect(await res.json()).toEqual({ id: qid("run-3"), status: "failed", error: "timeout" });
  });

  it("only reads runs this API started: a raw, forged, or re-signed id is 404 and never reaches Render", async () => {
    const lookups: string[] = [];
    const { app } = harness({ getTaskRun: async (id) => (lookups.push(id), { status: "running", results: [] }) });
    for (const id of ["trn-other", "trn-other.AAAAAAAAAAAAAAAAAAAAAA", toQuestionId("a-different-api-token", "trn-other")]) {
      const res = await app.request(`/v1/questions/${id}`, { headers: AUTH });
      expect(res.status).toBe(404);
    }
    expect(lookups).toEqual([]);
  });

  it("passes the run id, not the question id, to Render", async () => {
    const lookups: string[] = [];
    const { app } = harness({ getTaskRun: async (id) => (lookups.push(id), { status: "running", results: [] }) });
    await app.request(`/v1/questions/${qid("trn-mine")}`, { headers: AUTH });
    expect(lookups).toEqual(["trn-mine"]);
  });

  it("returns 404 for unknown run IDs", async () => {
    const { app } = harness({
      getTaskRun: async () => { const err = new Error("not found"); (err as any).status = 404; throw err; },
    });
    const res = await app.request(`/v1/questions/${qid("missing")}`, { headers: AUTH });
    expect(res.status).toBe(404);
  });
});

describe("healthz", () => {
  it("returns 200", async () => {
    const { app } = harness();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

// ── Callback signing tests ──────────────────────────────────────────────

describe("signCallback and verifyCallback", () => {
  const secret = "test-callback-secret-1234567890";
  const body = '{"id":"r1","reply":{"kind":"failure"}}';

  it("sign produces a v1= hex signature", () => {
    const { signature, timestamp } = signCallback(secret, body, 1700000000);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(timestamp).toBe(1700000000);
  });

  it("verify accepts a correctly signed body", () => {
    const { signature, timestamp } = signCallback(secret, body);
    expect(verifyCallback({ secret, signature, timestamp, body })).toBe(true);
  });

  it("verify rejects a bad signature", () => {
    const { timestamp } = signCallback(secret, body);
    expect(verifyCallback({ secret, signature: "v1=deadbeef", timestamp, body })).toBe(false);
  });

  it("verify rejects stale timestamps", () => {
    const past = Math.floor(Date.now() / 1000) - 400;
    const { signature } = signCallback(secret, body, past);
    expect(verifyCallback({ secret, signature, timestamp: past, body })).toBe(false);
  });

  it("verify rejects missing signature or timestamp", () => {
    expect(verifyCallback({ secret, signature: undefined, timestamp: 123, body })).toBe(false);
    expect(verifyCallback({ secret, signature: "v1=aaa", timestamp: undefined, body })).toBe(false);
  });
});

describe("loadEnv", () => {
  const base = { API_TOKEN: "tok", RENDER_API_KEY: "rk" };

  it("requires API_TOKEN", () => {
    expect(() => loadEnv({ RENDER_API_KEY: "rk" })).toThrow();
  });

  it("derives taskSlug from WORKFLOW_SLUG", () => {
    const env = loadEnv(base);
    expect(env.taskSlug).toBe("support-triage-bot-workflow/answer_question");
  });

  it("RENDER_USE_LOCAL_DEV=true is local dev", () => {
    const env = loadEnv({ ...base, RENDER_USE_LOCAL_DEV: "true" });
    expect(env.useLocalDev).toBe(true);
  });

  it("RENDER_LOCAL_DEV_URL implies local dev", () => {
    const env = loadEnv({ API_TOKEN: "tok", RENDER_LOCAL_DEV_URL: "http://localhost:8120" });
    expect(env.useLocalDev).toBe(true);
  });

  it("requires RENDER_API_KEY when not local dev", () => {
    expect(() => loadEnv({ API_TOKEN: "tok" })).toThrow();
  });

  it("slackEnabled when both SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN are set", () => {
    const env = loadEnv({ ...base, SLACK_SIGNING_SECRET: "s", SLACK_BOT_TOKEN: "t" });
    expect(env.slackEnabled).toBe(true);
  });

  it("slackEnabled false when Slack vars are missing", () => {
    const env = loadEnv(base);
    expect(env.slackEnabled).toBe(false);
  });
});
