import { type InvestigationResult, RUNNER_EXIT, type RunnerEvent, type RunnerInput } from "../types.ts";
import type { AgentSession, AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type Emitter, outputPreview, toUsage } from "./main.ts";
import { hermeticResourceLoader, type Model, type Pi, THINKING_BUDGETS } from "./main.ts";
import { createSafeBashTool } from "./tools.ts";
import { createSearchTools } from "./tools.ts";
import { createSubmitTool, MAX_SUBMIT_ATTEMPTS, SUBMIT_TOOL } from "./submit.ts";
import CORE_PROMPT from "./core-prompt.md?raw";
import INSTANCE_PROMPT from "../../prompt.md?raw";
import { createHash } from "node:crypto";

export const SYSTEM_PROMPT = INSTANCE_PROMPT + "\n\n" + CORE_PROMPT;
export const PROMPT_VERSION = createHash("sha256").update(SYSTEM_PROMPT).digest("hex").slice(0, 12);

export const SUBMIT_REMINDER =
  "You stopped without calling submit_investigation. Call it now, exactly once: a final_answer built from the evidence " +
  "you have (low confidence is acceptable), or needs_clarification if the question cannot be investigated without more context.";

export function renderUserPrompt(input: RunnerInput): string {
  const repos = input.manifest.repos.map((r) => `| ${r.repository} | ${r.branch} | ${r.commit} |`);
  const transcript = input.transcript.map((m) => {
    const who = m.is_agent ? "[agent]" : `[user ${m.user_id ?? "unknown"}]`;
    return `${who} (ts ${m.ts})\n${m.text}`;
  });
  return [
    `Repositories root: ${input.repos_root}`,
    `Each repository is a read-only checkout at ${input.repos_root}/<owner>/<name>.`,
    `Scratch directory (the only writable location): ${input.scratch_dir}`,
    "",
    `## Manifest (profile ${input.manifest.profile}, created ${input.manifest.created_at})`,
    "",
    "| repository | branch | commit |",
    "| --- | --- | --- |",
    ...repos,
    "",
    "## Conversation (oldest first)",
    "",
    transcript.join("\n\n"),
    "",
    "The question for this turn is the most recent human message. Investigate, then call submit_investigation exactly once.",
  ].join("\n");
}

export const MAX_TURNS = 120;
export const SAFETY_MARGIN_MS = 10_000;
/** How long an abort may take to settle before the runner reports the timeout anyway. */
const ABORT_GRACE_MS = 5_000;
const TOOLS = ["read", "grep", "find", "ls", "bash", SUBMIT_TOOL];

type Failure = { code: Extract<RunnerEvent, { type: "error" }>["code"]; message: string };

export interface SessionOptions {
  pi: Pi;
  input: RunnerInput;
  modelRuntime: ModelRuntime;
  model: Model;
  emit: Emitter;
  /** Epoch ms the `timeout_ms` budget is measured from (process start). */
  startedAt: number;
}

/** Runs one investigation and emits `started` … then exactly one `result` or `error`. Returns the exit code. */
export async function runSession({ pi, input, modelRuntime, model, emit, startedAt }: SessionOptions): Promise<number> {
  let submission: InvestigationResult | undefined;
  let failure: Failure | undefined;
  const checkouts = { manifest: input.manifest, repos_root: input.repos_root };

  const { session } = await pi.createAgentSession({
    cwd: input.repos_root,
    modelRuntime,
    model,
    thinkingLevel: input.thinking_level,
    resourceLoader: hermeticResourceLoader(pi, SYSTEM_PROMPT),
    sessionManager: pi.SessionManager.inMemory(input.repos_root),
    settingsManager: pi.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
      images: { blockImages: true },
      thinkingBudgets: THINKING_BUDGETS,
      enableInstallTelemetry: false,
      enableAnalytics: false,
    }),
    tools: TOOLS,
    customTools: [
      createSafeBashTool(pi, { reposRoot: input.repos_root, scratchDir: input.scratch_dir }),
      ...createSearchTools(pi, input.repos_root),
      createSubmitTool(pi, checkouts, {
        onAccepted: (result) => (submission = result),
        onRejected: (attempts) => {
          if (attempts >= MAX_SUBMIT_ATTEMPTS) {
            failure ??= { code: "invalid_submission", message: `${SUBMIT_TOOL} was rejected ${attempts} times` };
          }
        },
      }),
    ],
  });
  installBatchTermination(session, () => failure !== undefined);

  emit({ type: "started", pi_version: pi.VERSION, model: model.id, prompt_version: PROMPT_VERSION });

  const stop = (reason?: Failure) => {
    if (reason) failure ??= reason;
    if (session.isStreaming) void session.abort();
  };
  let turns = 0;
  const unsubscribe = session.subscribe((event) => {
    forward(event, emit);
    if (event.type !== "turn_end") return;
    turns++;
    // Backstop for batches that still continue after a submission (e.g. a sibling call failed validation).
    if (submission || failure) stop();
    else if (turns >= MAX_TURNS) stop({ code: "no_submission", message: `turn limit (${MAX_TURNS}) reached without a submission` });
  });

  const budgetMs = input.timeout_ms - SAFETY_MARGIN_MS;
  let deadline: NodeJS.Timeout | undefined;
  let grace: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>((resolve) => {
    deadline = setTimeout(() => {
      stop({ code: "timeout", message: `investigation exceeded its ${budgetMs} ms budget` });
      grace = setTimeout(resolve, ABORT_GRACE_MS);
    }, Math.max(0, startedAt + budgetMs - Date.now()));
  });

  const conversation = (async () => {
    await session.prompt(renderUserPrompt(input), { expandPromptTemplates: false });
    if (!submission && !failure && stoppedOnItsOwn(session)) {
      await session.prompt(SUBMIT_REMINDER, { expandPromptTemplates: false });
    }
  })();
  let thrown: unknown;
  await Promise.race([conversation.catch((err) => (thrown = err)), timedOut]);
  clearTimeout(deadline);
  clearTimeout(grace);
  unsubscribe();

  if (submission) {
    emit({ type: "result", result: submission });
  } else {
    failure ??= diagnose(session, thrown);
    emit({ type: "error", ...failure });
  }
  session.dispose();
  if (submission) return RUNNER_EXIT.ok;
  return failure?.code === "timeout" ? RUNNER_EXIT.timeout : RUNNER_EXIT.error;
}

function forward(event: AgentSessionEvent, emit: Emitter) {
  switch (event.type) {
    case "tool_execution_start":
      emit({ type: "tool_call", tool_call_id: event.toolCallId, tool: event.toolName, args: event.args });
      break;
    case "tool_execution_end":
      emit({
        type: "tool_result",
        tool_call_id: event.toolCallId,
        tool: event.toolName,
        is_error: event.isError,
        output_preview: outputPreview(event.result),
      });
      break;
    case "message_end": {
      const message = event.message;
      if (message.role !== "assistant") break;
      const text = message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n").trim();
      if (text) emit({ type: "assistant_text", text });
      const usage = toUsage(message.usage);
      if (usage) emit({ type: "usage", usage });
      break;
    }
  }
}

/**
 * Pi ends the loop only when every tool result in a batch sets `terminate`, so a submission batched with
 * other calls (e.g. `ls` + submit) would cost another LLM request. Mark the submission's siblings too (a
 * rejected submission carries no `terminate`, so the model still gets to retry), and every result once a
 * stop has been requested.
 */
function installBatchTermination(session: AgentSession, stopRequested: () => boolean) {
  const agent = session.agent;
  const previous = agent.afterToolCall;
  agent.afterToolCall = async (ctx, signal) => {
    const result = await previous?.(ctx, signal);
    const siblingOfSubmit =
      ctx.toolCall.name !== SUBMIT_TOOL && ctx.assistantMessage.content.some((c) => c.type === "toolCall" && c.name === SUBMIT_TOOL);
    return siblingOfSubmit || stopRequested() ? { ...result, terminate: true } : result;
  };
}

function lastAssistant(session: AgentSession) {
  return session.state.messages.findLast((m) => m.role === "assistant");
}

/** The model ended its turn without being stopped or failing (so a reminder may help). */
function stoppedOnItsOwn(session: AgentSession): boolean {
  const last = lastAssistant(session);
  return last?.role === "assistant" && (last.stopReason === "stop" || last.stopReason === "length");
}

function diagnose(session: AgentSession, thrown: unknown): Failure {
  if (thrown !== undefined) return { code: "agent_error", message: thrown instanceof Error ? thrown.message : String(thrown) };
  const last = lastAssistant(session);
  if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
    return { code: "agent_error", message: last.errorMessage ?? session.state.errorMessage ?? `model request ${last.stopReason}` };
  }
  return { code: "no_submission", message: `the model stopped without calling ${SUBMIT_TOOL}, even after a reminder` };
}
