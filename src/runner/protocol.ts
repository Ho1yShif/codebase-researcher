import { z } from "zod";
import { InvestigationResult, Transcript } from "../investigation.ts";
import { RepoManifest } from "../manifest.ts";

export const RunnerInput = z.object({
  trace_id: z.string().min(1),
  transcript: Transcript,
  manifest: RepoManifest,
  repos_root: z.string().min(1),
  scratch_dir: z.string().min(1),
  model_provider: z.string().min(1).default("anthropic"),
  model: z.string().min(1),
  thinking_level: z.enum(["off", "minimal", "low", "medium", "high"]).default("medium"),
  timeout_ms: z.number().int().positive(),
});
export type RunnerInput = z.infer<typeof RunnerInput>;

export const Usage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative().default(0),
  cache_write_tokens: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const RunnerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    at: z.iso.datetime(),
    pi_version: z.string(),
    model: z.string(),
    prompt_version: z.string(),
  }),
  z.object({
    type: z.literal("tool_call"),
    at: z.iso.datetime(),
    tool_call_id: z.string(),
    tool: z.string(),
    args: z.unknown(),
  }),
  z.object({
    type: z.literal("tool_result"),
    at: z.iso.datetime(),
    tool_call_id: z.string(),
    tool: z.string(),
    is_error: z.boolean(),
    output_preview: z.string(),
  }),
  z.object({
    type: z.literal("assistant_text"),
    at: z.iso.datetime(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("usage"),
    at: z.iso.datetime(),
    usage: Usage,
  }),
  z.object({
    type: z.literal("result"),
    at: z.iso.datetime(),
    result: InvestigationResult,
  }),
  z.object({
    type: z.literal("error"),
    at: z.iso.datetime(),
    code: z.enum(["timeout", "no_submission", "invalid_input", "agent_error", "invalid_submission"]),
    message: z.string(),
  }),
]);
export type RunnerEvent = z.infer<typeof RunnerEvent>;

export const RUNNER_EXIT = {
  ok: 0,
  error: 1,
  invalid_input: 2,
  timeout: 3,
} as const;
