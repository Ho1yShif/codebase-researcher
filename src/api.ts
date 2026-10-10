import {
  ApiTranscript,
  QuestionMetadata,
  type Reply,
  type StartQuestion,
} from "./types.ts";
import { safeEqual } from "./callback.ts";
import { createSlack, mountSlackRoutes } from "./slack.ts";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import { ClientError } from "@renderinc/sdk";
import { z } from "zod";
import { createHmac } from "node:crypto";

// ── Types shared with tests ─────────────────────────────────────────────

export type GetTaskRun = (id: string) => Promise<{ status: string; results: unknown[]; error?: string }>;

export type AppDeps = {
  apiToken: string;
  startQuestion: StartQuestion;
  getTaskRun: GetTaskRun;
  isLocalDev: boolean;
  log: (line: string) => void;
};



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

const postBody = (isLocalDev: boolean) =>
  z.object({
    transcript: ApiTranscript,
    callback: z.object({
      url: z.url().refine((raw) => {
        const url = new URL(raw);
        if (url.protocol === "https:") return true;
        return isLocalDev && url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
      }, "must be https:// (http://localhost allowed in local dev)"),
      secret: z.string().min(16).max(256),
    }).optional(),
    metadata: QuestionMetadata.optional(),
  });

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const PostBody = postBody(deps.isLocalDev);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    deps.log(JSON.stringify({
      event: "request_failed",
      method: c.req.method,
      path: c.req.path,
      error: err.message,
    }));
    return c.text("internal error", 500);
  });

  app.get("/healthz", (c) => c.text("ok"));

  // ── Bearer auth for /v1/* ─────────────────────────────────────────
  app.use("/v1/*", bearerAuth({ token: deps.apiToken }));

  // ── POST /v1/questions ────────────────────────────────────────────
  app.post(
    "/v1/questions",
    validator("json", (value, c) => {
      const parsed = PostBody.safeParse(value);
      return parsed.success ? parsed.data : c.json({ error: z.prettifyError(parsed.error) }, 400);
    }),
    async (c) => {
      const run = await deps.startQuestion(c.req.valid("json"), {
        idempotencyKey: c.req.header("idempotency-key"),
        signal: AbortSignal.timeout(5000),
      });
      deps.log(JSON.stringify({ event: "task_started", run_id: run.id }));
      return c.json({ id: toQuestionId(deps.apiToken, run.id) }, 202);
    },
  );

  // ── GET /v1/questions/:id ─────────────────────────────────────────
  app.get("/v1/questions/:id", async (c) => {
    const id = c.req.param("id");
    const runId = fromQuestionId(deps.apiToken, id);
    if (!runId) return c.json({ error: "not found" }, 404);

    let run: Awaited<ReturnType<GetTaskRun>>;
    try {
      run = await deps.getTaskRun(runId);
    } catch (err) {
      if (err instanceof ClientError && err.statusCode === 404) return c.json({ error: "not found" }, 404);
      throw err;
    }

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
  });

  return app;
}

// ── Env parsing ─────────────────────────────────────────────────────────

const Env = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    API_TOKEN: z.string().min(1, "API_TOKEN is required"),
    RENDER_API_KEY: z.string().min(1).optional(),
    RENDER_USE_LOCAL_DEV: z.stringbool().default(false),
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
    const useLocalDev = !!e.RENDER_LOCAL_DEV_URL || e.RENDER_USE_LOCAL_DEV;
    const defaultSlug = "code-investigator-workflow";
    const taskSlug = e.WORKFLOW_TASK_SLUG ?? `${e.WORKFLOW_SLUG ?? defaultSlug}/answer_question`;
    const slackCredentials = e.SLACK_SIGNING_SECRET && e.SLACK_BOT_TOKEN
      ? { signingSecret: e.SLACK_SIGNING_SECRET, botToken: e.SLACK_BOT_TOKEN }
      : undefined;
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
      slackCredentials,
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

  const getTaskRun: GetTaskRun = (id) => render.workflows.getTaskRun(id);

  const log = (line: string) => void process.stdout.write(`${line}\n`);

  const app = createApp({
    apiToken: env.apiToken,
    startQuestion,
    getTaskRun,
    isLocalDev: env.useLocalDev,
    log,
  });

  // Mount Slack routes only when Slack is configured
  if (env.slackCredentials) {
    const publicUrl = env.publicUrl;
    if (!publicUrl) {
      log(JSON.stringify({ event: "slack_disabled", reason: "PUBLIC_URL or RENDER_EXTERNAL_URL is required for Slack" }));
    } else {
      const slack = createSlack(env.slackCredentials.botToken, env.slackApiUrl);
      mountSlackRoutes(app, {
        signingSecret: env.slackCredentials.signingSecret,
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
