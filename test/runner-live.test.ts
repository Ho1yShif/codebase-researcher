import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { InvestigationResult, PROVIDER_KEY_ENV, providerApiKey, RunnerEvent } from "../src/types.ts";
import { makeFixture, makeInput, parseEvents, RUNNER } from "./helpers.ts";

const provider = process.env.LIVE_MODEL_PROVIDER;

const hasKey = !!(provider && providerApiKey(provider, process.env));

describe.skipIf(!provider || !hasKey)(`live smoke test (${provider})`, { timeout: 300_000 }, () => {
  it("investigates the fixture repo and submits a valid result", () => {
    const fx = makeFixture();
    const input = {
      ...makeInput(fx, { timeout_ms: 240_000 }),
      model_provider: provider!,
      model: process.env.LIVE_MODEL ?? (provider === "anthropic" ? "claude-sonnet-4-5" : provider === "openai" ? "gpt-4.1" : "gemini-2.5-flash"),
      thinking_level: "off" as const,
    };
    const res = spawnSync(process.execPath, [RUNNER], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, [PROVIDER_KEY_ENV[provider!]![0]!]: providerApiKey(provider!, process.env) },
      timeout: 270_000,
    });
    const events = parseEvents(res.stdout);
    const last = events.at(-1);
    expect(last?.type, `runner stderr: ${res.stderr.slice(-500)}`).toBe("result");
    const result = (last as Extract<RunnerEvent, { type: "result" }>).result;
    expect(InvestigationResult.safeParse(result).success).toBe(true);
    expect(res.status, res.stderr).toBe(0);
  });
});
