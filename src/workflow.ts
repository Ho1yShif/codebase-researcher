import { providerApiKey, RunnerInput } from "./types.ts";
import config from "../config.ts";
import { createProvider } from "./sandbox.ts";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { z } from "zod";
import { answerQuestion, deliverCallback, investigateTask, type InvestigateInput, type InvestigateResult, type DeliverInput } from "./investigate.ts";

export type Fields = Record<string, unknown>;

export type Log = {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Log;
};

const serialize = (_key: string, value: unknown) =>
  value instanceof Error ? { name: value.name, message: value.message } : value;

/** One JSON object per line; Render captures task stdout. */
export function createLog(base: Fields = {}, write = (line: string) => void process.stdout.write(`${line}\n`)): Log {
  const emit = (level: string) => (msg: string, fields?: Fields) =>
    write(JSON.stringify({ level, msg, ...base, ...fields }, serialize));
  return {
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: (fields) => createLog({ ...base, ...fields }, write),
  };
}

const MINUTE = 60_000;

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const INVESTIGATE_MAX_RETRIES = 2;
export const INVESTIGATE_WAIT_MS = 5_000;
export const INVESTIGATE_BACKOFF = 2;
export const INVESTIGATE_MARGIN_MS = 5 * MINUTE;

export const DELIVER_MAX_RETRIES = 8;
export const DELIVER_WAIT_MS = 2_000;
export const DELIVER_BACKOFF = 2;
export const DELIVER_TIMEOUT_S = 120;

const timeouts = {
  AGENT_TIMEOUT_MS: positiveInt(15 * MINUTE),
  SANDBOX_PROVISION_TIMEOUT_MS: positiveInt(5 * MINUTE),
};

/** Sandbox provision + agent run + margin for termination and delivery. */
export const investigateTimeoutMs = (t: { AGENT_TIMEOUT_MS: number; SANDBOX_PROVISION_TIMEOUT_MS: number }) =>
  t.SANDBOX_PROVISION_TIMEOUT_MS + t.AGENT_TIMEOUT_MS + INVESTIGATE_MARGIN_MS;

/** Needs only the timeout vars, so it's safe at module load, where tasks are registered. */
export function investigateTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return Math.ceil(investigateTimeoutMs(z.object(timeouts).parse(present(env))) / 1000);
}

/** Sum of geometric wait durations (backoff scaling). */
function totalRetryWaitMs(retries: number, waitMs: number, backoff: number): number {
  let total = 0;
  let w = waitMs;
  for (let i = 0; i < retries; i++) { total += w; w *= backoff; }
  return total;
}

/**
 * Parent task timeout: covers the worst case where both subtasks use all their retries.
 * investigate timeout × (retries + 1) + its retry waits
 * + post_reply timeout × (retries + 1) + its retry waits
 * + a 1-minute margin
 */
export function parentTimeoutMs(t: { AGENT_TIMEOUT_MS: number; SANDBOX_PROVISION_TIMEOUT_MS: number }): number {
  const invTimeout = investigateTimeoutMs(t);
  const invTotal = invTimeout * (INVESTIGATE_MAX_RETRIES + 1) + totalRetryWaitMs(INVESTIGATE_MAX_RETRIES, INVESTIGATE_WAIT_MS, INVESTIGATE_BACKOFF);
  const dlvTotal = DELIVER_TIMEOUT_S * 1000 * (DELIVER_MAX_RETRIES + 1) + totalRetryWaitMs(DELIVER_MAX_RETRIES, DELIVER_WAIT_MS, DELIVER_BACKOFF);
  return invTotal + dlvTotal + MINUTE;
}

export function parentTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return Math.ceil(parentTimeoutMs(z.object(timeouts).parse(present(env))) / 1000);
}

const Env = z
  .looseObject({
    MODEL_PROVIDER: z.string().min(1).default("anthropic"),
    MODEL: z.string().min(1).optional(),
    PI_MODEL: z.string().min(1).optional(),
    PI_THINKING_LEVEL: RunnerInput.shape.thinking_level,
    MODEL_API_KEY: z.string().min(1).optional(),
    ...timeouts,
  })
  .transform((e) => {
    const env = e as Record<string, string | undefined>;
    const modelProvider = e.MODEL_PROVIDER;
    const model = e.MODEL ?? e.PI_MODEL ?? "claude-opus-5";
    const modelApiKey = e.MODEL_API_KEY ?? providerApiKey(modelProvider, env);
    return {
      snapshotName: config.snapshotName,
      modelProvider,
      model,
      thinkingLevel: e.PI_THINKING_LEVEL,
      modelApiKey,
      agentTimeoutMs: e.AGENT_TIMEOUT_MS,
      sandboxProvisionTimeoutMs: e.SANDBOX_PROVISION_TIMEOUT_MS,
    };
  });
export type Config = z.output<typeof Env>;

const present = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([, v]) => v));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(present(env));
}

// ── Workflow index (task registrations) ─────────────────────────────────

const investigateSubtask = task(
  {
    name: "investigate",
    timeoutSeconds: investigateTimeoutSeconds(),
    retry: { maxRetries: INVESTIGATE_MAX_RETRIES, waitDurationMs: INVESTIGATE_WAIT_MS, backoffScaling: INVESTIGATE_BACKOFF },
  },
  async (_ctx: TaskContext, input: InvestigateInput): Promise<InvestigateResult> => {
    const config = loadConfig();
    const log = createLog({ task: "investigate" });
    return investigateTask({
      config,
      snapshotName: config.snapshotName,
      log,
      createProvider: (allowedDomain) => createProvider(process.env, allowedDomain),
    }, input);
  },
);

const deliverSubtask = task(
  {
    name: "deliver",
    timeoutSeconds: DELIVER_TIMEOUT_S,
    retry: { maxRetries: DELIVER_MAX_RETRIES, waitDurationMs: DELIVER_WAIT_MS, backoffScaling: DELIVER_BACKOFF },
  },
  async (_ctx: TaskContext, input: DeliverInput): Promise<void> => {
    return deliverCallback(input);
  },
);

export const answerQuestionTask = task(
  {
    name: "answer_question",
    timeoutSeconds: parentTimeoutSeconds(),
    retry: { maxRetries: 0, waitDurationMs: 0 },
  },
  async (ctx: TaskContext, input: unknown) => {
    const config = loadConfig();
    const log = createLog({ task: "answer_question" });

    const traceId = ctx.metadata.taskRunId ?? `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return answerQuestion(
      {
        config,
        log,
        runInvestigate: (inv) => ctx.run(investigateSubtask, inv),
        runDeliver: (dlv) => ctx.run(deliverSubtask, dlv),
      },
      traceId,
      input,
    );
  },
);
