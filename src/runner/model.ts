import type { RunnerInput } from "./protocol.ts";
import { type Api, InMemoryCredentialStore, type Model as PiModel, type MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import agentCorePackage from "@earendil-works/pi-agent-core/package.json" with { type: "json" };

export type Model = PiModel<Api>;
export type ThinkingLevel = RunnerInput["thinking_level"];

/** Reported in `started` and `--self-test`. */
export const PI_VERSION: string = agentCorePackage.version;

export const SUPPORTED_PROVIDERS = ["anthropic", "openai", "google"] as const;

const MAX_OUTPUT_TOKENS = 16_384;
/** Passed to the agent so the max_tokens cap below stays in step with Pi's thinking budget. */
export const THINKING_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16_384 } as const;

/** The built-in provider catalog with in-memory credentials: the key is passed per request, nothing is stored. */
export function createModels(): MutableModels {
  return builtinModels({ credentials: new InMemoryCredentialStore() });
}

/** Applies the Anthropic thinking token budget only for anthropic-messages models; others use effort levels. */
export function capMaxTokens(model: Model, level: ThinkingLevel): Model {
  if (model.api !== "anthropic-messages") return model;
  const thinking = level === "off" ? 0 : THINKING_BUDGETS[level];
  return { ...model, maxTokens: Math.min(model.maxTokens, MAX_OUTPUT_TOKENS + thinking) };
}
