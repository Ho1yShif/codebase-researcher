import {
  AnswerQuestionInput,
  RUNNER_EXIT,
  RunnerInput,
  InvestigationResult,
  buildEvidenceUrl,
  toInternalTranscript,
  signCallback,
  type Callback,
  type Evidence,
  type Reply,
  type RepoManifest,
  type RunnerEvent,
  type Transcript,
  type Usage,
} from "./types.ts";
import {
  SnapshotUnavailableError,
  type InvestigationSandbox,
  type SandboxProvider,
  type RunInvestigationResult,
} from "./sandbox.ts";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Config } from "./workflow.ts";
import type { Log } from "./workflow.ts";

type Started = Extract<RunnerEvent, { type: "started" }>;
export type RunnerErrorCode = Extract<RunnerEvent, { type: "error" }>["code"];

/** Folds the runner's event stream into what the workflow records. */
export class RunCapture {
  started?: Started;
  result?: { value: InvestigationResult; at: string };
  error?: { code: RunnerErrorCode; message: string };
  usage?: Usage;

  add(event: RunnerEvent): void {
    switch (event.type) {
      case "started":
        this.started ??= event;
        break;
      case "usage":
        this.usage = addUsage(this.usage, event.usage);
        break;
      case "result": {
        const parsed = InvestigationResult.safeParse(event.result);
        if (parsed.success) this.result = { value: parsed.data, at: event.at };
        else this.error ??= { code: "invalid_submission", message: parsed.error.message };
        break;
      }
      case "error":
        this.error ??= { code: event.code, message: event.message };
        break;
    }
  }
}

function addUsage(total: Usage | undefined, next: Usage): Usage {
  const sum = (key: "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens") =>
    (total?.[key] ?? 0) + next[key];
  const noCost = total?.cost_usd === undefined && next.cost_usd === undefined;
  return {
    input_tokens: sum("input_tokens"),
    output_tokens: sum("output_tokens"),
    cache_read_tokens: sum("cache_read_tokens"),
    cache_write_tokens: sum("cache_write_tokens"),
    cost_usd: noCost ? undefined : (total?.cost_usd ?? 0) + (next.cost_usd ?? 0),
  };
}

export type FailureCode = RunnerErrorCode | "retries_exhausted" | "misconfigured" | "no_snapshot";

const KILLED_BY_TIMEOUT = 124;
const KILLED = 137;

export type RunVerdict =
  | { kind: "result"; value: InvestigationResult; at: string }
  | { kind: "failed"; code: FailureCode; message: string }
  | { kind: "infra"; message: string };

export function classifyRun(
  run: RunInvestigationResult,
  capture: RunCapture,
  opts: { elapsedMs: number; agentTimeoutMs: number },
): RunVerdict {
  if (capture.result) return { kind: "result", ...capture.result };
  if (capture.error) return { kind: "failed", ...capture.error };
  const stderr = run.stderrTail ? `: ${run.stderrTail}` : "";
  const lost: RunVerdict = { kind: "infra", message: `lost the runner's exec stream before it exited${stderr}` };
  const timeout: RunVerdict = { kind: "failed", code: "timeout", message: `runner killed after ${opts.agentTimeoutMs}ms` };
  if (run.streamLost) return lost;
  if (run.aborted) return timeout;
  const exit = run.exitCode;
  if (exit === null) return lost;
  if (exit === KILLED_BY_TIMEOUT || exit === RUNNER_EXIT.timeout) return timeout;
  if (exit === KILLED) {
    return opts.elapsedMs >= opts.agentTimeoutMs
      ? timeout
      : { kind: "infra", message: `runner was killed after ${opts.elapsedMs}ms (out of memory or killed by the sandbox)${stderr}` };
  }
  if (exit >= 128) return { kind: "infra", message: `runner died from signal ${exit - 128}${stderr}` };
  return { kind: "failed", code: "agent_error", message: `runner exited (${exit}) without a result${stderr}` };
}

export const verdictLabel = (v: RunVerdict) =>
  v.kind === "result" ? v.value.status : v.kind === "failed" ? v.code : "infra";

export function failureReason(code: string | null, agentTimeoutMs: number): string {
  switch (code) {
    case "timeout":
      return `the investigation hit the ${Math.round(agentTimeoutMs / 60_000)}-minute limit`;
    case "no_submission":
    case "invalid_submission":
    case "invalid_input":
    case "agent_error":
      return "the agent stopped without submitting an answer";
    case "retries_exhausted":
      return "the investigation kept failing on infrastructure errors";
    case "misconfigured":
      return "the investigation service is misconfigured (an operator needs to check the workflow's settings)";
    case "no_snapshot":
      return "the repository snapshot isn't ready yet (the first build takes about 5 minutes); try again shortly";
    default:
      return "the investigation could not be completed";
  }
}

export function filterEvidence(
  result: InvestigationResult,
  manifest: RepoManifest,
): { result: InvestigationResult; dropped: Evidence[] } {
  if (result.status !== "final_answer") return { result, dropped: [] };
  const kept: Evidence[] = [];
  const dropped: Evidence[] = [];
  for (const e of result.evidence) {
    const repo = manifest.repos.find(
      (r) => r.repository.toLowerCase() === e.repository.toLowerCase() && r.commit.startsWith(e.commit),
    );
    if (repo) {
      const browse = (repo as { browse?: string }).browse;
      const repoUrl = (repo as { url?: string }).url;
      kept.push({
        repository: repo.repository,
        commit: repo.commit,
        path: e.path,
        start_line: e.start_line,
        end_line: e.end_line,
        url: buildEvidenceUrl({ ...e, repository: repo.repository, commit: repo.commit }, browse, repoUrl),
      });
    } else {
      dropped.push(e);
    }
  }
  return { result: { ...result, evidence: kept }, dropped };
}

const MAX_STDERR_LOG = 2_048;
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export type InvestigateInput = { transcript: Transcript; trace_id: string };

export type InvestigateResult =
  | { kind: "result"; result: InvestigationResult; model: string; prompt_version: string; usage?: Usage; manifest_created_at: string; repos: Array<{ repository: string; commit: string }> }
  | { kind: "failed"; code: string; reason: string };

export type DeliverInput = {
  callback: Callback;
  body: string;
};

export type AnswerQuestionDeps = {
  config: Config;
  log: Log;
  runInvestigate: (input: InvestigateInput) => Promise<InvestigateResult>;
  runDeliver: (input: DeliverInput) => Promise<void>;
};

export type AnswerQuestionResult = {
  trace_id: string;
  outcome: string;
  reply: Reply;
};

export async function answerQuestion(
  deps: AnswerQuestionDeps,
  traceId: string,
  rawInput: unknown,
): Promise<AnswerQuestionResult> {
  const input = AnswerQuestionInput.parse(rawInput);
  const { config, log } = deps;
  const started = Date.now();

  const transcript = toInternalTranscript(input.transcript);

  let investigateResult: InvestigateResult;
  try {
    investigateResult = await deps.runInvestigate({ transcript, trace_id: traceId });
  } catch (err) {
    log.error("investigation failed", { trace_id: traceId, err });
    investigateResult = {
      kind: "failed",
      code: "retries_exhausted",
      reason: failureReason("retries_exhausted", config.agentTimeoutMs),
    };
  }

  let reply: Reply;
  if (investigateResult.kind === "result") {
    const r = investigateResult.result;
    reply = r.status === "needs_clarification"
      ? { kind: "clarification", traceId, result: r }
      : {
          kind: "answer",
          traceId,
          result: r,
          model: investigateResult.model,
          manifestCreatedAt: investigateResult.manifest_created_at,
        };
  } else {
    reply = { kind: "failure", traceId, reason: investigateResult.reason };
  }

  if (input.callback) {
    const body = JSON.stringify({
      trace_id: traceId,
      reply,
      metadata: input.metadata,
    });
    try {
      await deps.runDeliver({ callback: input.callback, body });
    } catch (err) {
      log.error("deliver failed", { event: "deliver_failed", trace_id: traceId, err });
    }
  }

  const outcome = reply.kind;
  const durationMs = Date.now() - started;
  log.info("turn finished", {
    event: "turn_finished",
    trace_id: traceId,
    outcome,
    model: investigateResult.kind === "result" ? investigateResult.model : undefined,
    usage: investigateResult.kind === "result" ? investigateResult.usage : undefined,
    cost_usd: investigateResult.kind === "result" ? investigateResult.usage?.cost_usd : undefined,
    duration_ms: durationMs,
  });

  return { trace_id: traceId, outcome, reply };
}

/** POST the callback body with a signed request. Throws on non-2xx or network error. */
export async function deliverCallback(input: DeliverInput): Promise<void> {
  const { signature, timestamp } = signCallback(input.callback.secret, input.body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(input.callback.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Triage-Timestamp": String(timestamp),
        "X-Triage-Signature": signature,
      },
      body: input.body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`deliver got ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

export type InvestigateDeps = {
  config: Config;
  snapshotName: string;
  log: Log;
  createProvider: (allowedDomain: string) => Promise<SandboxProvider>;
};

export async function investigateTask(
  deps: InvestigateDeps,
  input: InvestigateInput,
): Promise<InvestigateResult> {
  const { config, snapshotName, log } = deps;

  const record = getBuiltinModel(config.modelProvider as never, config.model as never);
  if (!record) {
    log.warn("unknown model", { event: "workflow_misconfigured", provider: config.modelProvider, model: config.model });
    return { kind: "failed", code: "misconfigured", reason: failureReason("misconfigured", config.agentTimeoutMs) };
  }
  const allowedDomain = new URL(record.baseUrl).hostname;

  let provider: SandboxProvider;
  try {
    provider = await deps.createProvider(allowedDomain);
  } catch (err) {
    log.warn("provider setup failed", { event: "workflow_misconfigured", err });
    return { kind: "failed", code: "misconfigured", reason: failureReason("misconfigured", config.agentTimeoutMs) };
  }

  let sandbox: InvestigationSandbox;
  try {
    sandbox = await provider.createInvestigationSandbox({ snapshotName });
  } catch (err) {
    if (err instanceof SnapshotUnavailableError) {
      return { kind: "failed", code: "no_snapshot", reason: failureReason("no_snapshot", config.agentTimeoutMs) };
    }
    throw err;
  }

  try {
    const redact = (text: string) => (config.modelApiKey ? text.replaceAll(config.modelApiKey, "[redacted]") : text);
    const runnerInput = RunnerInput.parse({
      trace_id: input.trace_id,
      transcript: input.transcript,
      manifest: sandbox.manifest,
      repos_root: sandbox.layout.reposRoot,
      scratch_dir: sandbox.layout.scratchDir,
      model_provider: config.modelProvider,
      model: config.model,
      thinking_level: config.thinkingLevel,
      timeout_ms: config.agentTimeoutMs,
    });

    const capture = new RunCapture();
    const startedAt = Date.now();
    const run = await provider.runInvestigation(sandbox, {
      input: runnerInput,
      modelApiKey: config.modelApiKey,
      timeoutMs: config.agentTimeoutMs,
      onEvent: (event: RunnerEvent) => { capture.add(event); },
      onStderr: (chunk: string) => {
        const text = redact(chunk);
        const truncated = Math.max(text.length - MAX_STDERR_LOG, 0);
        log.info("runner stderr", { chunk: text.slice(0, MAX_STDERR_LOG), ...(truncated && { truncated }) });
      },
    });
    const endedAt = Date.now();
    const verdict = classifyRun(
      { ...run, stderrTail: redact(run.stderrTail).slice(-MAX_STDERR_LOG) },
      capture,
      { elapsedMs: endedAt - startedAt, agentTimeoutMs: config.agentTimeoutMs },
    );

    switch (verdict.kind) {
      case "result": {
        const { result, dropped } = filterEvidence(verdict.value, runnerInput.manifest);
        if (dropped.length > 0) log.warn("dropped evidence not in the sandbox manifest", { dropped });
        const model = capture.started?.model ?? config.model;
        return {
          kind: "result",
          result,
          model,
          prompt_version: capture.started?.prompt_version ?? "unknown",
          usage: capture.usage,
          manifest_created_at: sandbox.manifest.created_at,
          repos: sandbox.manifest.repos.map((r) => ({ repository: r.repository, commit: r.commit })),
        };
      }
      case "failed":
        return { kind: "failed", code: verdict.code, reason: failureReason(verdict.code, config.agentTimeoutMs) };
      case "infra":
        throw new Error(verdict.message);
    }
  } finally {
    await provider.terminate(sandbox.id).catch((err: unknown) =>
      log.warn("could not terminate sandbox", { sandbox_id: sandbox.id, err }),
    );
  }
}
