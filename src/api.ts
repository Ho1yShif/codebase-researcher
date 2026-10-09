import {
  AnswerQuestionInput,
  ApiTranscript,
  ApiTranscriptMessage,
  Callback,
  QuestionMetadata,
  safeEqual,
  type Reply,
  type StartQuestion,
} from "./types.ts";
import { createSlack, mountSlackRoutes, type SlackDeps } from "./slack.ts";
import { Hono } from "hono";
import { z } from "zod";
import { createHmac } from "node:crypto";

// ── Types shared with tests ─────────────────────────────────────────────



export type GetTaskRun = (id: string) => Promise<{ status: string; results: unknown[]; error?: string }>;

export type AppDeps = {
  apiToken: string;
  taskSlug: string;
  startQuestion: StartQuestion;
  getTaskRun: GetTaskRun;
  isLocalDev: boolean;
  log: (line: string) => void;
};



// ── Helpers ─────────────────────────────────────────────────────────────

function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}

// ── Question ids ────────────────────────────────────────────────────────

/**
 * A question id is `<task run id>.<HMAC>`, so `GET` only reads runs this API started; the API token alone
 * can't be used to read other runs in the workspace. Rotating API_TOKEN invalidates outstanding ids.
 */
const questionIdMac = (apiToken: string, runId: string) =>
  createHmac("sha256", apiToken).update(`question-id:${runId}`).digest("base64url").slice(0, 22);

export const toQuestionId = (apiToken: string, runId: string) => `${runId}.${questionIdMac(apiToken, runId)}`;

export function fromQuestionId(apiToken: string, questionId: string): string | null {
  const dot = questionId.lastIndexOf(".");
  if (dot <= 0) return null;
  const runId = questionId.slice(0, dot);
  return safeEqual(questionId.slice(dot + 1), questionIdMac(apiToken, runId)) ? runId : null;
}

// ── App factory ─────────────────────────────────────────────────────────

const PostBody = z.object({
  transcript: ApiTranscript,
  callback: z.object({
    url: z.string(),
    secret: z.string().min(16).max(256),
  }).optional(),
  metadata: QuestionMetadata.optional(),
});

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get("/healthz", (c) => c.text("ok"));

  // ── Bearer auth for /v1/* ─────────────────────────────────────────
  app.use("/v1/*", async (c, next) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !safeEqual(token, deps.apiToken)) {
      return c.text("unauthorized", 401);
    }
    return next();
  });

  // ── POST /v1/questions ────────────────────────────────────────────
  app.post("/v1/questions", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    const parsed = PostBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    }

    const data = parsed.data;

    // Validate callback URL: must be https:// (allow http://localhost and http://127.0.0.1 in local dev)
    if (data.callback) {
      try {
        const url = new URL(data.callback.url);
        const isSecure = url.protocol === "https:";
        const isLocalDev = deps.isLocalDev && url.protocol === "http:" &&
          (url.hostname === "localhost" || url.hostname === "127.0.0.1");
        if (!isSecure && !isLocalDev) {
          return c.json({ error: "callback.url must be https:// (http://localhost allowed in local dev)" }, 400);
        }
      } catch {
        return c.json({ error: "callback.url is not a valid URL" }, 400);
      }
    }

    const idempotencyKey = c.req.header("idempotency-key") ?? undefined;

    try {
      const run = await deps.startQuestion(
        { transcript: data.transcript, callback: data.callback, metadata: data.metadata },
        { idempotencyKey, signal: AbortSignal.timeout(5000) },
      );
      deps.log(JSON.stringify({ event: "task_started", run_id: run.id }));
      return c.json({ id: toQuestionId(deps.apiToken, run.id) }, 202);
    } catch (err) {
      deps.log(
        JSON.stringify({
          event: "task_start_failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return c.text("internal error", 500);
    }
  });

  // ── GET /v1/questions/:id ─────────────────────────────────────────
  app.get("/v1/questions/:id", async (c) => {
    const id = c.req.param("id");
    const runId = fromQuestionId(deps.apiToken, id);
    if (!runId) return c.json({ error: "not found" }, 404);
    try {
      const run = await deps.getTaskRun(runId);

      const status = run.status;
      if (status === "pending" || status === "running" || status === "paused") {
        return c.json({ id, status: "running" });
      }
      if (status === "succeeded" || status === "completed") {
        const result = run.results?.[0] as { trace_id?: string; reply?: Reply } | undefined;
        return c.json({
          id,
          status: "completed",
          trace_id: result?.trace_id,
          reply: result?.reply,
        });
      }
      // failed or canceled
      return c.json({ id, status: "failed", error: run.error ?? "task failed" });
    } catch (err: unknown) {
      if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
        return c.json({ error: "not found" }, 404);
      }
      throw err;
    }
  });

  return app;
}

// ── Env parsing ─────────────────────────────────────────────────────────

const LOCAL_DEV_TRUTHY = new Set(["1", "t", "T", "true", "TRUE", "True"]);

const Env = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    API_TOKEN: z.string().min(1, "API_TOKEN is required"),
    RENDER_API_KEY: z.string().min(1).optional(),
    RENDER_USE_LOCAL_DEV: z.string().optional(),
    RENDER_LOCAL_DEV_URL: z.string().min(1).optional(),
    WORKFLOW_SLUG: z.string().optional(),
    WORKFLOW_TASK_SLUG: z.string().optional(),
    // Slack adapter (optional)
    SLACK_SIGNING_SECRET: z.string().min(1).optional(),
    SLACK_BOT_TOKEN: z.string().min(1).optional(),
    ALLOWED_CHANNEL_IDS: z.string().min(1).optional(),
    SLACK_CALLBACK_KEY: z.string().min(1).optional(),
    SLACK_API_URL: z.string().min(1).optional(),
    PUBLIC_URL: z.string().min(1).optional(),
    RENDER_EXTERNAL_URL: z.string().min(1).optional(),
  })
  .transform((e) => {
    const useLocalDev = !!(e.RENDER_LOCAL_DEV_URL || (e.RENDER_USE_LOCAL_DEV && LOCAL_DEV_TRUTHY.has(e.RENDER_USE_LOCAL_DEV)));
    const defaultSlug = "support-triage-bot-workflow";
    const taskSlug = e.WORKFLOW_TASK_SLUG ?? `${e.WORKFLOW_SLUG ?? defaultSlug}/answer_question`;
    const slackEnabled = !!(e.SLACK_SIGNING_SECRET && e.SLACK_BOT_TOKEN);
    const allowedChannels: Set<string> | "*" = e.ALLOWED_CHANNEL_IDS === "*"
      ? "*"
      : new Set((e.ALLOWED_CHANNEL_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    return {
      port: e.PORT,
      apiToken: e.API_TOKEN,
      renderApiKey: e.RENDER_API_KEY,
      useLocalDev,
      localDevUrl: e.RENDER_LOCAL_DEV_URL,
      taskSlug,
      slackEnabled,
      slackSigningSecret: e.SLACK_SIGNING_SECRET,
      slackBotToken: e.SLACK_BOT_TOKEN,
      allowedChannels,
      slackCallbackKey: e.SLACK_CALLBACK_KEY,
      slackApiUrl: e.SLACK_API_URL,
      publicUrl: e.PUBLIC_URL ?? e.RENDER_EXTERNAL_URL,
    };
  })
  .refine((c) => c.useLocalDev || c.renderApiKey, {
    message: "RENDER_API_KEY is required unless RENDER_USE_LOCAL_DEV or RENDER_LOCAL_DEV_URL is set",
  });

export type ApiConfig = z.output<typeof Env>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return Env.parse(env);
}

// ── Server (runs only when executed directly) ────────────────────────────

import { serve } from "@hono/node-server";
import { Render } from "@renderinc/sdk";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const env = loadEnv();

  const renderOpts: ConstructorParameters<typeof Render>[0] = env.useLocalDev
    ? { useLocalDev: true, ...(env.localDevUrl && { localDevUrl: env.localDevUrl }) }
    : { token: env.renderApiKey };

  const render = new Render(renderOpts);

  const startQuestion: StartQuestion = async (input, opts) => {
    const run = await render.workflows.startTask(
      env.taskSlug,
      [input],
      { idempotencyKey: opts.idempotencyKey, signal: opts.signal },
    );
    return { id: run.taskRunId };
  };

  const getTaskRun: GetTaskRun = async (id) => {
    return await render.workflows.getTaskRun(id);
  };

  const log = (line: string) => void process.stdout.write(`${line}\n`);

  const app = createApp({
    apiToken: env.apiToken,
    taskSlug: env.taskSlug,
    startQuestion,
    getTaskRun,
    isLocalDev: env.useLocalDev,
    log,
  });

  // Mount Slack routes only when Slack is configured
  if (env.slackEnabled && env.slackSigningSecret && env.slackBotToken) {
    const publicUrl = env.publicUrl;
    if (!publicUrl) {
      log(JSON.stringify({ event: "slack_disabled", reason: "PUBLIC_URL or RENDER_EXTERNAL_URL is required for Slack" }));
    } else {
      const slack = createSlack(env.slackBotToken, env.slackApiUrl);
      mountSlackRoutes(app, {
        signingSecret: env.slackSigningSecret,
        allowedChannels: env.allowedChannels,
        callbackKey: env.slackCallbackKey ?? env.apiToken,
        publicUrl: publicUrl.replace(/\/$/, ""),
        slack,
        log,
      }, { startQuestion, log });
      log(JSON.stringify({ event: "slack_enabled" }));
    }
  }

  const server = serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) => {
    log(JSON.stringify({ event: "listening", port: info.port }));
  });

  const shutdown = () => {
    log(JSON.stringify({ event: "shutting_down" }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGTERM", shutdown);
}
