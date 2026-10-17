import { z } from "zod";

// ── Transcript ──────────────────────────────────────────────────────────────

export const TranscriptMessage = z.object({
  ts: z.string(),
  user_id: z.string().nullable(),
  is_agent: z.boolean(),
  text: z.string(),
  at: z.iso.datetime().optional(),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessage>;

export const Transcript = z.array(TranscriptMessage);
export type Transcript = z.infer<typeof Transcript>;

// ── Investigation ───────────────────────────────────────────────────────────

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

export const Evidence = z.object({
  repository: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  path: z.string().min(1),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  url: z.url().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

export const NeedsClarification = z.object({
  status: z.literal("needs_clarification"),
  question: z.string().min(1),
  why_needed: z.string().min(1),
});
export type NeedsClarification = z.infer<typeof NeedsClarification>;

export const FinalAnswer = z.object({
  status: z.literal("final_answer"),
  answer: z.string().min(1),
  confidence: Confidence,
  observed_in_code: z.array(z.string()),
  inferred_behavior: z.array(z.string()),
  not_established: z.array(z.string()),
  evidence: z.array(Evidence),
  suggested_owner: z.string().min(1),
  escalation_question: z.string().min(1),
});
export type FinalAnswer = z.infer<typeof FinalAnswer>;

export const InvestigationResult = z.discriminatedUnion("status", [NeedsClarification, FinalAnswer]);
export type InvestigationResult = z.infer<typeof InvestigationResult>;

// ── Evidence URLs ───────────────────────────────────────────────────────────

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

const cleanPath = (raw: string) => encodePath(raw.replace(/^(\.?\/)+/, ""));

function browseBase(repoUrl: string | undefined, repository: string): string {
  if (repoUrl) return repoUrl.replace(/\.git$/, "");
  return `https://github.com/${repository}`;
}

export function buildEvidenceUrl(
  e: Pick<Evidence, "repository" | "commit" | "path" | "start_line" | "end_line">,
  browse?: string,
  repoUrl?: string,
): string {
  const path = cleanPath(e.path);
  const base = browseBase(repoUrl, e.repository);

  switch (browse ?? "github") {
    case "github":
      return `https://github.com/${encodePath(e.repository)}/blob/${e.commit}/${path}#L${e.start_line}-L${e.end_line}`;
    case "gitlab":
      return `${base}/-/blob/${e.commit}/${path}#L${e.start_line}-L${e.end_line}`;
    case "bitbucket":
      return `${base}/src/${e.commit}/${path}#lines-${e.start_line}:${e.end_line}`;
    default:
      return browse!
        .replaceAll("{base}", base)
        .replaceAll("{repository}", e.repository)
        .replaceAll("{commit}", e.commit)
        .replaceAll("{path}", path)
        .replaceAll("{start}", String(e.start_line))
        .replaceAll("{end}", String(e.end_line));
  }
}

// ── Manifest ────────────────────────────────────────────────────────────────

const CloneUrl = z
  .string()
  .url()
  .refine((u) => {
    const p = new URL(u);
    return p.protocol === "https:" && !p.username && !p.password;
  }, "must be an https:// URL without credentials");

const Browse = z.string().regex(/^[^\t\r\n]+$/, "must be one line without tabs");

export const RepoEntry = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  branch: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  path: z.string().min(1),
  url: CloneUrl.optional(),
  browse: Browse.optional(),
});
export type RepoEntry = z.infer<typeof RepoEntry>;

export const RepoManifest = z.object({
  profile: z.string().min(1),
  created_at: z.iso.datetime(),
  repos: z.array(RepoEntry).min(1),
});
export type RepoManifest = z.infer<typeof RepoManifest>;

export const RepoProfile = z.object({
  name: z.string().min(1),
  repos: z
    .array(
      z.object({
        repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
        branch: z.string().min(1).optional(),
        url: CloneUrl.optional(),
        browse: Browse.optional(),
      }),
    )
    .min(1),
});
export type RepoProfile = z.infer<typeof RepoProfile>;

export function manifestDigest(manifest: RepoManifest): string {
  return manifest.repos
    .map((r) => `${r.repository}@${r.commit}`)
    .sort()
    .join(",");
}

// ── Provider key map ────────────────────────────────────────────────────────

export const PROVIDER_KEY_ENV: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
  "ant-ling": ["ANT_LING_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  google: ["GEMINI_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  groq: ["GROQ_API_KEY"],
  huggingface: ["HF_TOKEN"],
  "kimi-coding": ["KIMI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"],
  "qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
  radius: ["RADIUS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  xai: ["XAI_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
};

export const ALL_PROVIDER_KEY_ENV: readonly string[] = [...new Set(Object.values(PROVIDER_KEY_ENV).flat())];

export function providerApiKey(provider: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const name = PROVIDER_KEY_ENV[provider]?.[0];
  return (name && env[name]?.trim()) || undefined;
}

// ── Runner ──────────────────────────────────────────────────────────────────

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

// ── API transcript (the public shape accepted by POST /v1/questions) ────

export const MESSAGE_MAX_CHARS = 8000;
export const TRANSCRIPT_MAX_MESSAGES = 200;

export const ApiTranscriptMessage = z.object({
  text: z.string().max(MESSAGE_MAX_CHARS),
  author: z.string().optional(),
  is_agent: z.boolean().optional(),
});
export type ApiTranscriptMessage = z.infer<typeof ApiTranscriptMessage>;

export const ApiTranscript = z.array(ApiTranscriptMessage).min(1).max(TRANSCRIPT_MAX_MESSAGES);
export type ApiTranscript = z.infer<typeof ApiTranscript>;

/** Convert the public transcript shape to the internal one the runner expects. */
export function toInternalTranscript(api: ApiTranscript): Transcript {
  return api.map((m, i) => ({
    ts: String(i),
    user_id: m.author ?? null,
    is_agent: m.is_agent ?? false,
    text: m.text,
  }));
}

// ── Callback ────────────────────────────────────────────────────────────

export const Callback = z.object({
  url: z.string(),
  secret: z.string().min(16).max(256),
});
export type Callback = z.infer<typeof Callback>;

export const QuestionMetadata = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
).refine((r) => Object.keys(r).length <= 16, "metadata may have at most 16 keys");
export type QuestionMetadata = z.infer<typeof QuestionMetadata>;

export const AnswerQuestionInput = z.object({
  transcript: ApiTranscript,
  callback: Callback.optional(),
  metadata: QuestionMetadata.optional(),
});
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInput>;

// ── Reply (the workflow's output, also served by GET /v1/questions/:id) ─

export type Reply =
  | { kind: "answer"; traceId: string; result: FinalAnswer; model?: string; manifestCreatedAt?: string }
  | { kind: "clarification"; traceId: string; result: NeedsClarification }
  | { kind: "failure"; traceId: string; reason: string };

// ── BotConfig ───────────────────────────────────────────────────────────────

export const HostCredential = z.object({
  username: z.string().regex(/^[\w.@+-]+$/, "must be [A-Za-z0-9_.@+-]+"),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be a valid env var name"),
});
export type HostCredential = z.infer<typeof HostCredential>;

export const HostCredentials = z.record(z.string().regex(/^[a-z0-9.-]+(:\d{1,5})?$/, "must be a host name"), HostCredential);
export type HostCredentials = z.infer<typeof HostCredentials>;

export const DEFAULT_CREDENTIALS: HostCredentials = {
  "github.com": { username: "x-access-token", tokenEnv: "GITHUB_TOKEN" },
};

export const BotConfig = z.object({
  name: z.string().min(1),
  repos: z
    .array(
      z.object({
        repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
        branch: z.string().min(1).optional(),
        url: CloneUrl.optional(),
        browse: Browse.optional(),
      }),
    )
    .min(1),
  gitCredentials: HostCredentials.optional().default(DEFAULT_CREDENTIALS),
  labels: z.object({
    owner: z.string().min(1),
    escalation: z.string().min(1),
    supportTeam: z.string().min(1),
  }),
  snapshotName: z.string().min(1).default("codebase-researcher-corpus"),
});
export type BotConfig = z.infer<typeof BotConfig>;

/**
 * Validates and returns the BotConfig, applying env overrides.
 * `REPOS=owner/a,owner/b` replaces the repo list (for local dev and testing).
 * `SNAPSHOT_NAME` overrides `snapshotName`.
 */
export function defineConfig(
  raw: z.input<typeof BotConfig>,
  env: NodeJS.ProcessEnv = process.env,
): BotConfig {
  const config = BotConfig.parse(raw);
  const repos = env.REPOS?.trim();
  if (repos) {
    config.repos = BotConfig.shape.repos.parse(
      repos.split(",").map((r) => ({ repository: r.trim() })),
    );
  }
  if (env.SNAPSHOT_NAME) {
    config.snapshotName = env.SNAPSHOT_NAME;
  }
  return config;
}

/** Starts an `answer_question` run; shared by the HTTP API and the Slack adapter. */
export type StartQuestion = (
  input: { transcript: ApiTranscript; callback?: Callback; metadata?: QuestionMetadata },
  opts: { idempotencyKey?: string; signal: AbortSignal },
) => Promise<{ id: string }>;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
