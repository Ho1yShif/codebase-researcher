import type { InvestigationResult } from "../investigation.ts";
import { errorMessage } from "../util.ts";
import { RUNNER_EXIT, type RunnerEvent, type RunnerInput } from "./protocol.ts";
import { Agent, type AfterToolCallContext, type AgentEvent } from "@earendil-works/pi-agent-core";
import { isRetryableAssistantError, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import { type Emitter, outputPreview, toUsage } from "./events.ts";
import { type Model, PI_VERSION, THINKING_BUDGETS } from "./model.ts";
import { createInspectionTools } from "./tools.ts";
import { createSubmitTool, MAX_SUBMIT_ATTEMPTS, SUBMIT_TOOL } from "./submit.ts";
import CORE_PROMPT from "./core-prompt.md?raw";
import INSTANCE_PROMPT from "../../prompt.md?raw";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export const SYSTEM_PROMPT = INSTANCE_PROMPT + "\n\n" + CORE_PROMPT;
export const PROMPT_VERSION = createHash("sha256").update(SYSTEM_PROMPT).digest("hex").slice(0, 12);

export const SUBMIT_REMINDER =
  `You stopped without calling ${SUBMIT_TOOL}. Call it now, exactly once: a final_answer built from the evidence ` +
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
    `The question for this turn is the most recent human message. Investigate, then call ${SUBMIT_TOOL} exactly once.`,
  ].join("\n");
}

export const MAX_TURNS = 120;
export const SAFETY_MARGIN_MS = 10_000;
/** How long an abort may take to settle before the runner reports the timeout anyway. */
const ABORT_GRACE_MS = 5_000;
/** Retries of a model request that failed transiently (overloaded, rate limited, dropped stream). */
const MAX_MODEL_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2_000;

type Failure = { code: Extract<RunnerEvent, { type: "error" }>["code"]; message: string };

export interface SessionOptions {
  input: RunnerInput;
  models: Models;
  /** Passed with every request; undefined only for the faux provider. */
  apiKey: string | undefined;
  model: Model;
  emit: Emitter;
  /** Epoch ms the `timeout_ms` budget is measured from (process start). */
  startedAt: number;
}

/** Runs one investigation and emits `started` … then exactly one `result` or `error`. Returns the exit code. */
export async function runSession({ input, models, apiKey, model, emit, startedAt }: SessionOptions): Promise<number> {
  let submission: InvestigationResult | undefined;
  let failure: Failure | undefined;
  const checkouts = { manifest: input.manifest, repos_root: input.repos_root };
  const stopped = new AbortController();

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      thinkingLevel: input.thinking_level,
      tools: [
        ...createInspectionTools({ reposRoot: input.repos_root, scratchDir: input.scratch_dir }),
        createSubmitTool(checkouts, {
          onAccepted: (result) => (submission = result),
          onRejected: (attempts) => {
            if (attempts >= MAX_SUBMIT_ATTEMPTS) {
              failure ??= { code: "invalid_submission", message: `${SUBMIT_TOOL} was rejected ${attempts} times` };
            }
          },
        }),
      ],
    },
    streamFn: (m, context, options) => models.streamSimple(m, context, options),
    getApiKey: () => apiKey,
    thinkingBudgets: THINKING_BUDGETS,
    afterToolCall: async (ctx) => (endsBatch(ctx) || failure !== undefined ? { terminate: true } : undefined),
  });

  emit({ type: "started", pi_version: PI_VERSION, model: model.id, prompt_version: PROMPT_VERSION });

  const stop = (reason?: Failure) => {
    if (reason) failure ??= reason;
    stopped.abort();
    if (agent.state.isStreaming) agent.abort();
  };
  /** Sends `text`, then restarts the last turn while it fails with a transient model error. */
  const prompt = async (text: string) => {
    await agent.prompt(text);
    for (let attempt = 1; attempt <= MAX_MODEL_RETRIES && !stopped.signal.aborted; attempt++) {
      const last = lastAssistant(agent);
      if (last?.stopReason !== "error" || !isRetryableAssistantError(last)) return;
      agent.state.messages = agent.state.messages.slice(0, -1);
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), undefined, { signal: stopped.signal }).catch(() => {});
      if (stopped.signal.aborted) return;
      await agent.continue();
    }
  };
  let turns = 0;
  const unsubscribe = agent.subscribe((event) => {
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
    await prompt(renderUserPrompt(input));
    if (!submission && !failure && stoppedOnItsOwn(agent)) await prompt(SUBMIT_REMINDER);
  })();
  let thrown: unknown;
  await Promise.race([conversation.catch((err) => (thrown = err)), timedOut]);
  clearTimeout(deadline);
  clearTimeout(grace);
  unsubscribe();

  if (submission) {
    emit({ type: "result", result: submission });
    return RUNNER_EXIT.ok;
  }
  failure ??= diagnose(agent, thrown);
  emit({ type: "error", ...failure });
  return failure.code === "timeout" ? RUNNER_EXIT.timeout : RUNNER_EXIT.error;
}

function forward(event: AgentEvent, emit: Emitter) {
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
 * The loop ends only when every tool result in a batch sets `terminate`, so a submission batched with other
 * calls (e.g. `ls` + submit) would cost another LLM request. The submit tool terminates on acceptance;
 * this marks its siblings too. A rejected submission carries no `terminate`, so the model still gets to retry.
 */
function endsBatch({ toolCall, assistantMessage }: AfterToolCallContext): boolean {
  return toolCall.name !== SUBMIT_TOOL && assistantMessage.content.some((c) => c.type === "toolCall" && c.name === SUBMIT_TOOL);
}

function lastAssistant(agent: Agent): AssistantMessage | undefined {
  const last = agent.state.messages.findLast((m) => m.role === "assistant");
  return last?.role === "assistant" ? last : undefined;
}

/** The model ended its turn without being stopped or failing (so a reminder may help). */
function stoppedOnItsOwn(agent: Agent): boolean {
  const last = lastAssistant(agent);
  return last?.stopReason === "stop" || last?.stopReason === "length";
}

function diagnose(agent: Agent, thrown: unknown): Failure {
  if (thrown !== undefined) return { code: "agent_error", message: errorMessage(thrown) };
  const last = lastAssistant(agent);
  if (last?.stopReason === "error" || last?.stopReason === "aborted") {
    return { code: "agent_error", message: last.errorMessage ?? agent.state.errorMessage ?? `model request ${last.stopReason}` };
  }
  return { code: "no_submission", message: `the model stopped without calling ${SUBMIT_TOOL}, even after a reminder` };
}
