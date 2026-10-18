import { mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { RUNNER_EXIT, RunnerInput, ALL_PROVIDER_KEY_ENV, errorMessage, providerApiKey } from "../types.ts";
import type { RunnerEvent, Usage } from "../types.ts";
import { defaultFauxScript, registerFauxModel } from "./faux.ts";
import type { FauxScript } from "./faux.ts";
import { runSession, PROMPT_VERSION } from "./session.ts";
import { type Api, InMemoryCredentialStore, type Model as PiModel, type MutableModels, type Usage as PiUsage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import agentCorePackage from "@earendil-works/pi-agent-core/package.json" with { type: "json" };

export type Credentials = {
  fileKey?: string;
  /** Provider key vars that were set in `env` before they were removed (local dev without a key file). */
  envKeys: Record<string, string>;
};

/**
 * Reads the key file and removes every trace of model credentials from the filesystem and `env`, so none
 * reach the agent's tool subprocesses. The key file is deleted even if reading it fails. Every provider's
 * vars are removed, not just the selected one: ANTHROPIC_OAUTH_TOKEN, for one, would take precedence inside Pi.
 */
export function takeCredentials(keyFile: string | undefined, env: NodeJS.ProcessEnv): Credentials {
  const envKeys: Record<string, string> = {};
  let fileKey: string | undefined;
  try {
    if (keyFile) fileKey = readFileSync(keyFile, "utf8").trim() || undefined;
  } finally {
    if (keyFile) rmSync(keyFile, { force: true });
    for (const name of ALL_PROVIDER_KEY_ENV) {
      const value = env[name];
      if (value) envKeys[name] = value;
      delete env[name];
    }
  }
  return { fileKey, envKeys };
}

/** The key file wins; otherwise only the selected provider's own key var, never another provider's. */
export const apiKeyFor = (creds: Credentials, provider: string): string | undefined =>
  creds.fileKey ?? providerApiKey(provider, creds.envKeys);

export const secretsIn = (creds: Credentials): string[] =>
  [creds.fileKey, ...Object.values(creds.envKeys)].filter((s): s is string => !!s);

export type Model = PiModel<Api>;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

/** Reported in `started` and `--self-test`. */
export const PI_VERSION: string = agentCorePackage.version;

export const SUPPORTED_PROVIDERS = ["anthropic", "openai", "google"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

const MAX_OUTPUT_TOKENS = 16_384;
/** Passed to the agent so the max_tokens cap below stays in step with Pi's thinking budget. */
export const THINKING_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16_384 } as const;

/** Scratch is the only writable location; the bash tool spills oversized output to os.tmpdir(). */
export function useScratch(scratchDir: string): void {
  mkdirSync(scratchDir, { recursive: true });
  process.env.TMPDIR = scratchDir;
}

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

type WithoutAt<E> = E extends unknown ? Omit<E, "at"> : never;
export type EventBody = WithoutAt<RunnerEvent>;

export interface Emitter {
  (event: EventBody): void;
  readonly terminated: boolean;
  /** Replaces `secret` with `[REDACTED]` in every later line. */
  redact(secret: string): void;
  /** Resolves once every line written so far has been flushed. */
  flush(): Promise<void>;
}

/** Writes one RunnerEvent per line. Drops everything after the first terminal (`result`/`error`) event. */
export function createEmitter(write: (chunk: string) => Promise<void>): Emitter {
  const secrets: string[] = [];
  let pending = Promise.resolve();
  let terminated = false;
  const emit = (event: EventBody) => {
    if (terminated) return;
    terminated = event.type === "result" || event.type === "error";
    const { type, ...fields } = event;
    let line = JSON.stringify({ type, at: new Date().toISOString(), ...fields });
    for (const secret of secrets) line = line.replaceAll(secret, "[REDACTED]");
    pending = write(`${line}\n`).catch(() => {});
  };
  return Object.assign(emit, {
    get terminated() {
      return terminated;
    },
    redact(secret: string) {
      if (secret) secrets.push(secret);
    },
    flush: () => pending,
  });
}

const PREVIEW_CHARS = 2000;
const TRUNCATED = "…[truncated]";

export function outputPreview(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  const text = content
    .map((c: { type?: string; text?: string }) => (c?.type === "text" ? (c.text ?? "") : `[${c?.type ?? "unknown"}]`))
    .join("\n");
  return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS - TRUNCATED.length) + TRUNCATED : text;
}

/** Undefined for all-zero usage (e.g. a request aborted before it was sent). */
export function toUsage(u: PiUsage): Usage | undefined {
  const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
  const usage: Usage = {
    input_tokens: count(u.input),
    output_tokens: count(u.output),
    cache_read_tokens: count(u.cacheRead),
    cache_write_tokens: count(u.cacheWrite),
  };
  if (usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens === 0) return undefined;
  const cost = u.cost?.total;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { ...usage, cost_usd: cost } : usage;
}

export interface MainIO {
  stdin: AsyncIterable<string | Uint8Array>;
  /** Resolves once `chunk` is flushed. */
  write(chunk: string): Promise<void>;
  /** Replaces the default `--faux` script (tests). */
  fauxScript?: FauxScript;
}

const processIO = (): MainIO => ({
  stdin: process.stdin,
  write: (chunk) => new Promise((resolve, reject) => process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()))),
});

/** `runner.mjs [--key-file PATH] [--faux] [--self-test]`; returns the exit code. */
export async function main(argv: string[], io: MainIO = processIO()): Promise<number> {
  const startedAt = Date.now();
  const emit = createEmitter(io.write);
  const fail = async (code: "invalid_input" | "agent_error", message: string) => {
    emit({ type: "error", code, message });
    await emit.flush();
    return code === "invalid_input" ? RUNNER_EXIT.invalid_input : RUNNER_EXIT.error;
  };

  let args: { "key-file"?: string; faux?: boolean; "self-test"?: boolean };
  try {
    args = parseArgs({
      args: argv,
      options: { "key-file": { type: "string" }, faux: { type: "boolean" }, "self-test": { type: "boolean" } },
    }).values;
  } catch (err) {
    return fail("invalid_input", errorMessage(err));
  }

  let creds: Credentials;
  try {
    creds = takeCredentials(args["key-file"], process.env);
  } catch (err) {
    return fail("invalid_input", `cannot read --key-file: ${errorMessage(err)}`);
  }
  for (const secret of secretsIn(creds)) emit.redact(secret);
  // stdout carries only RunnerEvent JSONL; route any library console output to stderr.
  console.log = console.info = console.debug = console.error;

  if (args["self-test"]) return selfTest(io);

  const input = parseInput(await readAll(io.stdin));
  if (typeof input === "string") return fail("invalid_input", input);

  const provider = input.model_provider;
  const apiKey = apiKeyFor(creds, provider);
  try {
    useScratch(input.scratch_dir);
    const models = createModels();
    const requested = models.getModel(provider, input.model);
    if (!requested) return fail("invalid_input", `unknown model "${provider}/${input.model}" (not in the Pi ${PI_VERSION} registry)`);

    let model = requested;
    if (args.faux) {
      model = registerFauxModel(models, (io.fauxScript ?? defaultFauxScript)(input));
    } else if (!apiKey) {
      return fail("agent_error", `no API key for provider "${provider}": pass --key-file or set the provider's env var`);
    }
    return await runSession({ input, models, apiKey, model: capMaxTokens(model, input.thinking_level), emit, startedAt });
  } catch (err) {
    console.error(err);
    if (!emit.terminated) return fail("agent_error", errorMessage(err));
    return RUNNER_EXIT.error;
  } finally {
    await emit.flush();
  }
}

function parseInput(raw: string): RunnerInput | string {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return `stdin is not valid JSON: ${errorMessage(err)}`;
  }
  const parsed = RunnerInput.safeParse(json);
  if (!parsed.success) {
    return `invalid RunnerInput: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`;
  }
  if (!isDirectory(parsed.data.repos_root)) return `repos_root ${parsed.data.repos_root} is not a directory`;
  return parsed.data;
}

async function selfTest(io: MainIO): Promise<number> {
  const models = createModels();
  const errors: string[] = [];
  for (const p of SUPPORTED_PROVIDERS) {
    if (!models.getModels(p).length) errors.push(`no models for provider "${p}"`);
  }
  const ok = errors.length === 0;
  const report = { ok, pi_version: PI_VERSION, prompt_version: PROMPT_VERSION, node: process.version, ...(ok ? {} : { errors }) };
  await io.write(`${JSON.stringify(report)}\n`);
  return ok ? RUNNER_EXIT.ok : RUNNER_EXIT.error;
}

async function readAll(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
  // Output is flushed; don't let lingering keep-alive sockets or timers in the provider SDKs hold the process open.
  setTimeout(() => process.exit(code), 1_000).unref();
}
