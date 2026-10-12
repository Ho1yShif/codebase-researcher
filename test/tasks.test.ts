import type { Evidence, InvestigationResult, RunnerEvent } from "../src/types.ts";
import { defineConfig } from "../src/types.ts";
import { createFakeSlack, FakeSandboxes } from "./fakes.ts";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/workflow.ts";
import { createLog } from "../src/log.ts";
import { answerQuestion, investigateTask, deliverCallback } from "../src/tasks.ts";
import type { AnswerQuestionDeps, InvestigateResult, InvestigateDeps, DeliverInput } from "../src/tasks.ts";
import { createServer } from "node:http";

const at = () => new Date().toISOString();

const events = {
  started: (): RunnerEvent => ({
    type: "started", at: at(), pi_version: "0.83.0", model: "claude-sonnet-4-5", prompt_version: "v1",
  }),
  result: (result: InvestigationResult): RunnerEvent => ({ type: "result", at: at(), result }),
  error: (code: Extract<RunnerEvent, { type: "error" }>["code"]): RunnerEvent => ({
    type: "error", at: at(), code, message: `runner said ${code}`,
  }),
};

const evidence: Evidence = {
  repository: "render-oss/cli",
  commit: "c".repeat(40),
  path: "cmd/deploy.go",
  start_line: 10,
  end_line: 24,
};

const answer: InvestigationResult = {
  status: "final_answer",
  answer: "Yes, up to three times.",
  confidence: "medium",
  observed_in_code: ["deploy retries on 5xx"],
  inferred_behavior: [],
  not_established: ["server-side retry policy"],
  evidence: [evidence],
  suggested_owner: "cli",
  escalation_question: "Does the API retry too?",
};

const clarification: InvestigationResult = {
  status: "needs_clarification",
  question: "Which CLI version?",
  why_needed: "Retry logic changed in v2.",
};

type Script = { events?: RunnerEvent[]; exitCode?: number; throws?: Error; streamLost?: boolean; aborted?: boolean; stderrTail?: string };

const success = (result: InvestigationResult = answer): Script => ({
  events: [events.started(), events.result(result)],
});

const TRANSCRIPT = [{ text: "Does render deploy retry?", author: "U1" }];

function harness(env: Record<string, string> = {}) {
  const sandboxes = new FakeSandboxes();
  const logs: Record<string, unknown>[] = [];
  const config = loadConfig(env);
  const log = createLog({}, (line: string) => void logs.push(JSON.parse(line)));
  const deliveries: DeliverInput[] = [];

  function invDeps(): InvestigateDeps {
    return {
      config,
      snapshotName: config.snapshotName,
      log,
      configureSandboxes: async () => sandboxes.open,
    };
  }

  const deps: AnswerQuestionDeps = {
    config,
    log,
    runInvestigate: (input) => investigateTask(invDeps(), input),
    runDeliver: async (input) => { deliveries.push(input); },
  };
  return { sandboxes, logs, deps, config, log, invDeps, deliveries };
}

describe("answerQuestion", () => {
  it("happy path: returns an answer reply", async () => {
    const h = harness();
    h.sandboxes.script(success());

    const result = await answerQuestion(h.deps, "trace-1", {
      transcript: TRANSCRIPT,
    });

    expect(result.outcome).toBe("answer");
    expect(result.reply.kind).toBe("answer");
    expect(result.reply.traceId).toBe("trace-1");
    expect(h.sandboxes.closed).toEqual(["sbx-1"]);
  });

  it("returns a clarification reply", async () => {
    const h = harness();
    h.sandboxes.script(success(clarification));

    const result = await answerQuestion(h.deps, "trace-2", {
      transcript: TRANSCRIPT,
    });

    expect(result.outcome).toBe("clarification");
    expect(result.reply.kind).toBe("clarification");
  });

  it("returns failure reply when investigate fails", async () => {
    const h = harness();
    h.sandboxes.script({ events: [events.started(), events.error("agent_error")] });

    const result = await answerQuestion(h.deps, "trace-3", {
      transcript: TRANSCRIPT,
    });

    expect(result.outcome).toBe("failure");
    expect(result.reply.kind).toBe("failure");
  });

  it("catches a thrown subtask (retries exhausted) and returns a failure reply", async () => {
    const h = harness();
    const deps: AnswerQuestionDeps = {
      ...h.deps,
      runInvestigate: async () => { throw new Error("subtask retries exhausted"); },
    };

    const result = await answerQuestion(deps, "trace-thrown", {
      transcript: TRANSCRIPT,
    });

    expect(result.outcome).toBe("failure");
    expect(result.reply.kind).toBe("failure");
    if (result.reply.kind === "failure") {
      expect(result.reply.reason).toContain("investigation kept failing");
    }
  });

  it("runs deliver when callback is present", async () => {
    const h = harness();
    h.sandboxes.script(success());

    const result = await answerQuestion(h.deps, "trace-cb", {
      transcript: TRANSCRIPT,
      callback: { url: "https://example.com/hook", secret: "a".repeat(32) },
      metadata: { channel: "C1", thread_ts: "1.0" },
    });

    expect(result.outcome).toBe("answer");
    expect(h.deliveries).toHaveLength(1);
    const delivery = h.deliveries[0]!;
    expect(delivery.callback.url).toBe("https://example.com/hook");
    const parsed = JSON.parse(delivery.body);
    expect(parsed.reply.kind).toBe("answer");
    expect(parsed.metadata).toEqual({ channel: "C1", thread_ts: "1.0" });
  });

  it("does not run deliver when no callback", async () => {
    const h = harness();
    h.sandboxes.script(success());

    await answerQuestion(h.deps, "trace-nocb", { transcript: TRANSCRIPT });
    expect(h.deliveries).toHaveLength(0);
  });

  it("deliver failure does not fail the task", async () => {
    const h = harness();
    h.sandboxes.script(success());
    const deps: AnswerQuestionDeps = {
      ...h.deps,
      runDeliver: async () => { throw new Error("deliver exploded"); },
    };

    const result = await answerQuestion(deps, "trace-df", {
      transcript: TRANSCRIPT,
      callback: { url: "https://example.com/hook", secret: "b".repeat(32) },
    });

    expect(result.outcome).toBe("answer");
    expect(h.logs.some((l) => l.event === "deliver_failed")).toBe(true);
  });
});

describe("deliverCallback", () => {
  it("signs correctly and throws on non-2xx", async () => {
    const received: { headers: Record<string, string>; body: string }[] = [];
    const server = createServer((req, res) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({ headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };
    try {
      await deliverCallback({
        callback: { url: `http://localhost:${addr.port}/hook`, secret: "test-secret-1234567890" },
        body: JSON.stringify({ id: "r1", reply: { kind: "failure", traceId: "t1", reason: "test" } }),
      });

      expect(received).toHaveLength(1);
      expect(received[0]!.headers["x-triage-timestamp"]).toMatch(/^\d+$/);
      expect(received[0]!.headers["x-triage-signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
      expect(received[0]!.headers["content-type"]).toBe("application/json");
    } finally {
      server.close();
    }
  });

  it("throws on non-2xx response", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500);
      res.end("fail");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };
    try {
      await expect(
        deliverCallback({
          callback: { url: `http://localhost:${addr.port}/hook`, secret: "test-secret-1234567890" },
          body: "{}",
        }),
      ).rejects.toThrow("deliver got 500");
    } finally {
      server.close();
    }
  });
});

describe("investigate", () => {
  it("returns failed for agent errors without throwing", async () => {
    const h = harness();
    h.sandboxes.script({ events: [events.started(), events.error("agent_error")] });

    const result = await investigateTask(h.invDeps(), { transcript: [], trace_id: "t1" });
    expect(result.kind).toBe("failed");
    expect(h.sandboxes.closed).toEqual(["sbx-1"]);
  });

  it("returns failed for missing snapshot without throwing", async () => {
    const h = harness();
    h.sandboxes.noSnapshot = true;

    const result = await investigateTask(h.invDeps(), { transcript: [], trace_id: "t2" });
    expect(result).toEqual({ kind: "failed", code: "no_snapshot" });

    const { reply } = await answerQuestion(h.deps, "t2", { transcript: TRANSCRIPT });
    expect(reply.kind === "failure" && reply.reason).toContain("repository snapshot isn't ready yet");
  });

  it("throws for infra errors so the subtask retries", async () => {
    const h = harness();
    h.sandboxes.script({ throws: new Error("sandbox exec reset") });

    await expect(
      investigateTask(h.invDeps(), { transcript: [], trace_id: "t3" }),
    ).rejects.toThrow("sandbox exec reset");
    expect(h.sandboxes.closed).toEqual(["sbx-1"]);
  });

  it("always terminates the sandbox", async () => {
    const h = harness();
    h.sandboxes.script(success());

    await investigateTask(h.invDeps(), { transcript: [], trace_id: "t4" });
    expect(h.sandboxes.closed).toEqual(["sbx-1"]);
  });

  it("returns failed with misconfigured for unknown model", async () => {
    const h = harness({ MODEL_PROVIDER: "fake-provider", MODEL: "fake-model" });

    const result = await investigateTask(h.invDeps(), { transcript: [], trace_id: "t5" });
    expect(result).toMatchObject({ kind: "failed", code: "misconfigured" });
  });

  it("returns failed with misconfigured when sandbox setup throws", async () => {
    const h = harness();
    const deps: InvestigateDeps = {
      ...h.invDeps(),
      configureSandboxes: async () => { throw new Error("RENDER_API_KEY is required"); },
    };

    const result = await investigateTask(deps, { transcript: [], trace_id: "t6" });
    expect(result).toMatchObject({ kind: "failed", code: "misconfigured" });
    expect(h.logs.some((l) => l.event === "workflow_misconfigured")).toBe(true);
  });
});

const base = {};

describe("loadConfig", () => {
  it("uses defaults", () => {
    const c = loadConfig(base);
    expect(c.modelProvider).toBe("anthropic");
    expect(c.model).toBe("claude-opus-5");
    expect(c.thinkingLevel).toBe("medium");
    expect(c.agentTimeoutMs).toBe(15 * 60_000);
    expect(c.sandboxProvisionTimeoutMs).toBe(5 * 60_000);
  });

  it("PI_MODEL falls back for MODEL", () => {
    const c = loadConfig({ ...base, PI_MODEL: "claude-sonnet-4-5" });
    expect(c.model).toBe("claude-sonnet-4-5");
  });

  it("MODEL wins over PI_MODEL", () => {
    const c = loadConfig({ ...base, MODEL: "claude-haiku-4-5", PI_MODEL: "claude-sonnet-4-5" });
    expect(c.model).toBe("claude-haiku-4-5");
  });

  it("MODEL_API_KEY wins over provider key var", () => {
    const c = loadConfig({ ...base, MODEL_API_KEY: "explicit-key", ANTHROPIC_API_KEY: "provider-key" });
    expect(c.modelApiKey).toBe("explicit-key");
  });

  it("reads the selected provider's own key var", () => {
    const c = loadConfig({ ...base, MODEL_PROVIDER: "groq", GROQ_API_KEY: "groq-key" });
    expect(c.modelApiKey).toBe("groq-key");
  });

  it("does not use another provider's key var", () => {
    const c = loadConfig({ ...base, MODEL_PROVIDER: "groq", ANTHROPIC_API_KEY: "ant-key" });
    expect(c.modelApiKey).toBeUndefined();
  });

  it("blank values count as unset", () => {
    const c = loadConfig({ ...base, MODEL_API_KEY: "", ANTHROPIC_API_KEY: "real" });
    expect(c.modelApiKey).toBe("real");
  });

});

describe("defineConfig", () => {
  const raw = { name: "Bot", repos: [{ repository: "acme/api" }], labels: { owner: "o", escalation: "e", supportTeam: "s" } };

  it("defaults the snapshot name and keeps the configured repos", () => {
    const c = defineConfig(raw, {});
    expect(c.snapshotName).toBe("codebase-researcher-corpus");
    expect(c.repos).toEqual([{ repository: "acme/api" }]);
  });

  it("applies SNAPSHOT_NAME and REPOS overrides", () => {
    const c = defineConfig(raw, { SNAPSHOT_NAME: "custom-snap", REPOS: "acme/cli, acme/sdk" });
    expect(c.snapshotName).toBe("custom-snap");
    expect(c.repos.map((r) => r.repository)).toEqual(["acme/cli", "acme/sdk"]);
  });
});
