import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CREDENTIALS,
  RepoManifest,
  RepoProfile,
  RunnerEvent,
  manifestDigest,
  type HostCredentials,
  type RepoProfile as RepoProfileType,
  type RunnerInput,
} from "./types.ts";
import config from "../config.ts";
import { ClientError, Render, SandboxSnapshotNotFoundError, SandboxSnapshotNotReadyError, ServerError } from "@renderinc/sdk";
import type { SandboxesClient, SandboxSnapshot, SandboxUploadContentType } from "@renderinc/sdk/experimental";
import { create as createTar } from "tar";
import { z } from "zod";



type Owner = { id: string; name: string; type: string };

/**
 * Resolves the workspace id from the Render API when `RENDER_WORKSPACE_ID` is not set.
 * Exactly one workspace → uses it; several → fails listing each; none → fails clearly.
 *
 * API: GET /v1/owners — https://api-docs.render.com/reference/list-owners
 */
export async function resolveWorkspaceId(
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<`tea-${string}`> {
  const owners = await listOwners(apiKey, fetcher);
  if (owners.length === 0) throw new Error("RENDER_API_KEY has no workspaces; check the key");
  if (owners.length > 1) {
    const list = owners.map((o) => `  ${o.id} (${o.name}, ${o.type})`).join("\n");
    throw new Error(`RENDER_WORKSPACE_ID is required: the API key has access to multiple workspaces:\n${list}`);
  }
  const id = owners[0]!.id as `tea-${string}`;
  return id;
}

async function listOwners(apiKey: string, fetcher: typeof fetch): Promise<Owner[]> {
  const owners: Owner[] = [];
  let cursor: string | undefined;
  for (;;) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetcher(`https://api.render.com/v1/owners?${params}`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Render API /v1/owners failed: ${res.status}`);
    const page = (await res.json()) as { owner: Owner; cursor: string }[];
    for (const item of page) owners.push(item.owner);
    if (page.length < 100) break;
    cursor = page.at(-1)?.cursor;
    if (!cursor) break;
  }
  return owners;
}




/** Runs git and resolves with trimmed stdout; rejects with stderr on non-zero exit. */
export function git(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout.trim());
      },
    );
  });
}

/** Read-only inspection flags: never trust repo-local config that could execute commands as the checker. */
export const SAFE_GIT = ["-c", "safe.directory=*", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

/** Returns null when the repo is clean and at `commit`, otherwise the reason it is not. */
export async function checkRepo(path: string, commit: string): Promise<string | null> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  let head: string;
  let status: string;
  try {
    head = await git([...SAFE_GIT, "-C", path, "rev-parse", "HEAD"], { env });
    status = await git([...SAFE_GIT, "-C", path, "status", "--porcelain", "--ignored"], { env });
  } catch (err) {
    return `${path}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (head !== commit) return `${path}: HEAD ${head} != manifest ${commit}`;
  if (status) return `${path}: working tree is dirty (${status.split("\n").length} entries)`;
  return null;
}




const AbsPath = z.string().regex(/^\//, "must be an absolute path");

export const SandboxLayoutSchema = z.object({
  reposRoot: AbsPath,
  scratchDir: AbsPath,
  appDir: AbsPath,
}) satisfies z.ZodType<SandboxLayout>;




/** Absolute paths inside a sandbox. Recorded when the sandbox is built or restored. */
export type SandboxLayout = {
  /** Parent of `<owner>/<name>` checkouts. */
  reposRoot: string;
  /** Writable per-investigation scratch space; wiped by cleanup. */
  scratchDir: string;
  /** Directory containing the runner bundle, its node_modules, and bin/run-investigation.sh. */
  appDir: string;
};

export type RunInvestigationOptions = {
  /** Built by the workflow; `repos_root` and `scratch_dir` must come from the sandbox's layout. */
  input: RunnerInput;
  /** Delivered to the runner as a file it deletes on read. Omitted only for local dev with ambient Pi auth. */
  modelApiKey?: string;
  /** Hard deadline. Enforced inside the sandbox (coreutils `timeout`) and client-side via abort. */
  timeoutMs: number;
  onEvent: (event: RunnerEvent) => void | Promise<void>;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
};

export type RunInvestigationResult = {
  /** null when the stream was aborted or lost before an exit event. */
  exitCode: number | null;
  /** We stopped waiting: the caller's signal or the client-side deadline fired. */
  aborted: boolean;
  /** The stream ended or failed without an exit event and without an abort; the remote process state is unknown. */
  streamLost: boolean;
  /** Last ~4 KB of stderr, for error records. */
  stderrTail: string;
  /** stdout lines that were not valid RunnerEvent JSON. */
  invalidLines: number;
};

export type InvestigationSandbox = {
  id: string;
  manifest: RepoManifest;
  layout: SandboxLayout;
  info: Record<string, unknown>;
};

export type BuiltSnapshot = {
  id: string;
  manifest: RepoManifest;
  layout: SandboxLayout;
};

export type BuildSnapshotOptions = {
  profile: RepoProfile;
  /** From `resolveHeads`. Paths in heads are provider-specific; the returned manifests carry real paths. */
  heads: RepoManifest["repos"];
  /** Unique per deployment: snapshots share one sandbox group per workspace, and pruning goes by name. */
  snapshotName: string;
};

/** Thrown when no snapshot with the requested name is available (expired, pruned, or not yet built). */
export class SnapshotUnavailableError extends Error {
  override name = "SnapshotUnavailableError";
}

export interface SandboxProvider {
  readonly name: "render" | "local";

  /** Resolves the current default-branch commit for each repo in the profile (trusted context only). */
  resolveHeads(profile: RepoProfile): Promise<RepoManifest["repos"]>;

  /** Builds one versioned snapshot containing the runner and exact repository heads. */
  buildSnapshot(opts: BuildSnapshotOptions): Promise<BuiltSnapshot>;

  /** Deletes older available/failed snapshots with this name, keeping the newest `keep`. Idempotent. */
  pruneSnapshots(snapshotName: string, keep: number): Promise<void>;

  /**
   * Creates an investigation sandbox restored from the newest available snapshot with `snapshotName`.
   * Applies the configured network policy and a provider-side `timeoutSeconds` backstop.
   * Waits until running, runs `verify.sh` with egress probes, and reads the manifest.
   * If anything after creation fails, terminates the sandbox before throwing.
   * Throws `SnapshotUnavailableError` when no snapshot with that name is available.
   */
  createInvestigationSandbox(opts: { snapshotName: string }): Promise<InvestigationSandbox>;

  /** Runs the runner once inside an investigation sandbox and streams its events. Never throws for non-zero exits. */
  runInvestigation(sandbox: InvestigationSandbox, opts: RunInvestigationOptions): Promise<RunInvestigationResult>;

  /** Idempotent: a sandbox that no longer exists counts as terminated. */
  terminate(id: string): Promise<void>;
}


// ── Runner output ───────────────────────────────────────────────────────


const STDERR_TAIL_BYTES = 4096;

/** Line-buffers runner stdout (chunks are not line-aligned), validates each line, and keeps a stderr tail. */
export class RunnerOutput {
  #buf = "";
  #stderr = "";
  #invalid = 0;
  /** Set when `onEvent` threw, so callers can tell a callback error from a lost stream. */
  callbackFailed = false;

  constructor(private readonly opts: Pick<RunInvestigationOptions, "onEvent" | "onStderr">) {}

  async stdout(chunk: string): Promise<void> {
    this.#buf += chunk;
    for (let nl = this.#buf.indexOf("\n"); nl !== -1; nl = this.#buf.indexOf("\n")) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      await this.#line(line);
    }
  }

  stderr(chunk: string): void {
    this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL_BYTES);
    this.opts.onStderr?.(chunk);
  }

  /** A trailing partial line is parsed after a clean exit and counted invalid after an abort or lost stream. */
  async finish(exitCode: number | null, aborted: boolean, streamLost = false): Promise<RunInvestigationResult> {
    const rest = this.#buf;
    this.#buf = "";
    if (rest.trim()) {
      if (aborted || streamLost) this.#invalid++;
      else await this.#line(rest);
    }
    return { exitCode, aborted, streamLost, stderrTail: this.#stderr, invalidLines: this.#invalid };
  }

  async #line(line: string): Promise<void> {
    if (!line.trim()) return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      this.#invalid++;
      return;
    }
    const parsed = RunnerEvent.safeParse(json);
    if (!parsed.success) {
      this.#invalid++;
      return;
    }
    try {
      await this.opts.onEvent(parsed.data);
    } catch (err) {
      this.callbackFailed = true;
      throw err;
    }
  }
}




export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);



export type NetworkPolicy =
  | { default: "allow-all" | "deny-all" }
  | { default: "allow-list"; allowedDomains: string[] };

export type RenderProviderConfig = {
  apiKey: string;
  workspaceId: `tea-${string}`;
  /** Resolved per-host credentials: host → { username, token }. */
  hostCredentials: Record<string, { username: string; token: string }>;
  networkPolicy: NetworkPolicy;
  investigationTimeoutSeconds: number;
  builderTimeoutSeconds: number;
  /** Client-side pacing for the 100 req/min workspace limit. */
  minRequestIntervalMs: number;
  sandboxDir: string;
  runnerDistDir: string;
};

export async function loadRenderConfig(
  env: NodeJS.ProcessEnv = process.env,
  derivedAllowedDomain?: string,
  fetcher?: typeof fetch,
): Promise<RenderProviderConfig> {
  const e = z
    .object({
      RENDER_API_KEY: z.string({ error: "RENDER_API_KEY is required for SANDBOX_PROVIDER=render" }).min(1, "RENDER_API_KEY is required for SANDBOX_PROVIDER=render"),
      RENDER_WORKSPACE_ID: z.string().regex(/^tea-/, "RENDER_WORKSPACE_ID must be a tea-… workspace id").optional(),
      SANDBOX_NETWORK_POLICY: z.enum(["allow-list", "allow-all", "deny-all"]).default("allow-list"),
      SANDBOX_ALLOWED_DOMAINS: z.string().optional(),
      SANDBOX_TIMEOUT_SECONDS: positiveInt(1_800).pipe(z.number().max(86_400)),
      SANDBOX_BUILDER_TIMEOUT_SECONDS: positiveInt(3_600).pipe(z.number().max(86_400)),
      RENDER_API_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1_000),
      RUNNER_DIST_DIR: z.string().default(join(REPO_ROOT, "sandbox/dist")),
    })
    .parse(env);
  const explicit = e.SANDBOX_ALLOWED_DOMAINS?.split(",").map((d) => d.trim()).filter(Boolean);
  const domains = explicit?.length ? explicit : derivedAllowedDomain ? [derivedAllowedDomain] : [];
  if (e.SANDBOX_NETWORK_POLICY === "allow-list" && !domains.length && e.SANDBOX_ALLOWED_DOMAINS !== undefined) {
    throw new Error("SANDBOX_ALLOWED_DOMAINS must list at least one domain when SANDBOX_NETWORK_POLICY=allow-list");
  }
  const workspaceId = e.RENDER_WORKSPACE_ID
    ? (e.RENDER_WORKSPACE_ID as `tea-${string}`)
    : await resolveWorkspaceId(e.RENDER_API_KEY, fetcher);
  return {
    apiKey: e.RENDER_API_KEY,
    workspaceId,
    hostCredentials: collectHostCredentials(config.gitCredentials, env),
    networkPolicy:
      e.SANDBOX_NETWORK_POLICY === "allow-list"
        ? { default: "allow-list", allowedDomains: domains }
        : { default: e.SANDBOX_NETWORK_POLICY },
    investigationTimeoutSeconds: e.SANDBOX_TIMEOUT_SECONDS,
    builderTimeoutSeconds: e.SANDBOX_BUILDER_TIMEOUT_SECONDS,
    minRequestIntervalMs: e.RENDER_API_MIN_INTERVAL_MS,
    sandboxDir: join(REPO_ROOT, "sandbox"),
    runnerDistDir: e.RUNNER_DIST_DIR,
  };
}

function collectHostCredentials(
  creds: HostCredentials | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, { username: string; token: string }> {
  const map = creds ?? DEFAULT_CREDENTIALS;
  const result: Record<string, { username: string; token: string }> = {};
  for (const [host, { username, tokenEnv }] of Object.entries(map)) {
    const token = env[tokenEnv]?.trim();
    if (token) result[host] = { username, token };
  }
  return result;
}

export type LocalProviderConfig = {
  reposRoot: string;
  /** Holds per-sandbox scratch dirs and snapshot metadata. */
  sandboxesRoot: string;
  appDir: string;
  /** Shell command; `--key-file PATH` is appended when a model key is supplied. */
  runnerCmd: string;
};

export function loadLocalConfig(env: NodeJS.ProcessEnv = process.env): LocalProviderConfig {
  const e = z
    .object({
      LOCAL_REPOS_ROOT: z.string().default(join(REPO_ROOT, ".scratch/repos")),
      LOCAL_SANDBOXES_ROOT: z.string().default(join(REPO_ROOT, ".scratch/sandboxes")),
      LOCAL_RUNNER_CMD: z.string().default(`node ${shq(join(REPO_ROOT, "sandbox/dist/runner.mjs"))}`),
    })
    .parse(env);
  return {
    reposRoot: e.LOCAL_REPOS_ROOT,
    sandboxesRoot: e.LOCAL_SANDBOXES_ROOT,
    appDir: join(REPO_ROOT, "sandbox"),
    runnerCmd: e.LOCAL_RUNNER_CMD,
  };
}



/** The subset of the SDK's SandboxesClient this provider uses; tests substitute a fake. */
export type SandboxApi = Pick<SandboxesClient, "create" | "get" | "exec" | "upload" | "download" | "terminate"> & {
  snapshots: Pick<SandboxesClient["snapshots"], "create" | "get" | "list" | "delete">;
};

type RenderSandbox = Awaited<ReturnType<SandboxApi["create"]>>;

export type RenderTimings = {
  /** Minimum gap between get()/snapshot polls (rate limit: 100 req/min per workspace). */
  pollMs: number;
  bootTimeoutMs: number;
  prepareTimeoutMs: number;
  snapshotTimeoutMs: number;
  verifyTimeoutMs: number;
  /** Client-side abort lands this long after the in-sandbox `timeout`, which should fire first. */
  investigationGraceMs: number;
};

const DEFAULT_TIMINGS: RenderTimings = {
  pollMs: 3_000,
  bootTimeoutMs: 5 * 60_000,
  prepareTimeoutMs: 60 * 60_000,
  snapshotTimeoutMs: 20 * 60_000,
  verifyTimeoutMs: 5 * 60_000,
  investigationGraceMs: 30_000,
};

const STAGE = "/tmp/triage-stage";
const OUTPUT_TAIL = 64 * 1024;
const SAFE_PATH = /^\/[\w./-]+$/;
const SAFE_REF = /^\w[\w./-]*$/;
const SAFE_NAME = /^[\w.-]+$/;
/** Must be unreachable under deny-all / allow-list; checked from inside each restored sandbox. */
const DENY_PROBE_URL = "https://example.com";
/** Where prepare.sh installs when it runs as root. Restores find verify.sh here, so builds that land elsewhere are rejected. */
const SANDBOX_APP = "/opt/triage/app";
const READY_RETRY = [404, 429, 503];

/** Builds a git credential helper for a specific host's username and token env var. */
function hostTokenHelper(username: string, envVar: string): string {
  return `credential.helper=!f() { test "$1" = get || return 0; printf 'username=${username}\\npassword=%s\\n' "$${envVar}"; }; f`;
}

const SandboxInfo = z.object({
  layout: SandboxLayoutSchema.refine((l) => Object.values(l).every((p) => SAFE_PATH.test(p)), "unsafe layout path"),
  runAs: z.string().min(1),
  uid: z.number().int(),
  drop: z.string(),
  node: z.string(),
  runnerNonDumpable: z.boolean(),
  dnsResolves: z.boolean(),
  selfTest: z.looseObject({ ok: z.literal(true), pi_version: z.string(), prompt_version: z.string() }),
});
type SandboxInfo = z.infer<typeof SandboxInfo>;

export class RenderProvider implements SandboxProvider {
  readonly name = "render";
  readonly #api: SandboxApi;
  readonly #cfg: RenderProviderConfig;
  readonly #t: RenderTimings;
  #sandboxGroupId: string | undefined;
  #nextRequestAt = 0;

  constructor(api: SandboxApi, cfg: RenderProviderConfig, timings: Partial<RenderTimings> = {}) {
    this.#api = api;
    this.#cfg = cfg;
    this.#t = { ...DEFAULT_TIMINGS, ...timings };
  }

  static fromConfig(cfg: RenderProviderConfig): RenderProvider {
    // useLocalDev: false keeps sandbox calls on api.render.com even when RENDER_USE_LOCAL_DEV is set for workflows.
    const render = new Render({ useLocalDev: false, token: cfg.apiKey, ownerId: cfg.workspaceId });
    return new RenderProvider(render.experimental.sandboxes, cfg);
  }

  async resolveHeads(profile: RepoProfile): Promise<RepoManifest["repos"]> {
    const hostCreds = this.#cfg.hostCredentials;
    return Promise.all(
      profile.repos.map(async ({ repository, branch, url: repoUrl, browse }) => {
        const url = repoUrl ?? `https://github.com/${repository}.git`;
        const host = new URL(url).hostname;
        const cred = hostCreds[host];
        // The token reaches git only through the environment of this trusted process, never argv or a URL.
        const envVar = `TRIAGE_TOKEN_${host.replace(/\W/g, "_").toUpperCase()}`;
        const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(cred ? { [envVar]: cred.token } : {}) };
        const auth = ["-c", "credential.helper=", ...(cred ? ["-c", hostTokenHelper(cred.username, envVar)] : [])];
        const args = branch ? ["ls-remote", url, `refs/heads/${branch}`] : ["ls-remote", "--symref", url, "HEAD"];
        let out: string;
        try {
          out = await git([...auth, ...args], { env });
        } catch (err) {
          throw new Error(`git ls-remote ${repository}: ${(err as Error).message}`);
        }
        const head = parseLsRemote(out, branch);
        if (!head) throw new Error(`git ls-remote ${repository}: no ${branch ? `branch ${branch}` : "default branch"} in output`);
        return { repository, ...head, path: repository, ...(repoUrl && { url: repoUrl }), ...(browse && { browse }) };
      }),
    );
  }

  async buildSnapshot({ profile, heads, snapshotName }: BuildSnapshotOptions): Promise<BuiltSnapshot> {
    if (!SAFE_NAME.test(profile.name)) throw new Error(`profile name ${JSON.stringify(profile.name)} is not [A-Za-z0-9_.-]+`);
    if (!SAFE_NAME.test(snapshotName)) throw new Error(`snapshot name ${JSON.stringify(snapshotName)} is not [A-Za-z0-9_.-]+`);
    for (const h of heads) {
      if (!SAFE_REF.test(h.branch)) throw new Error(`${h.repository}: unsupported branch name ${JSON.stringify(h.branch)}`);
    }
    const createdAt = new Date().toISOString();
    const digest = manifestDigest({ profile: profile.name, created_at: createdAt, repos: heads });
    const build = await this.#build(profile, heads, createdAt, digest, snapshotName);
    return { id: build.snapshot.id, manifest: build.manifest, layout: build.info.layout };
  }

  async pruneSnapshots(snapshotName: string, keep: number): Promise<void> {
    const sandboxGroupId = this.#sandboxGroupId;
    if (!sandboxGroupId) {
      warn("snapshot prune skipped: no snapshot built by this process", { snapshotName });
      return;
    }
    try {
      const list: Awaited<ReturnType<SandboxApi["snapshots"]["list"]>> = [];
      for (let cursor: string | undefined; ; ) {
        const page = await this.#call(() => this.#api.snapshots.list({ sandboxGroupId, status: ["available", "failed"], cursor, limit: 100 }));
        list.push(...page);
        cursor = page.at(-1)?.cursor;
        if (page.length < 100 || !cursor) break;
      }
      const matching = list
        .filter(({ snapshot }) => snapshot.name === snapshotName)
        .sort((a, b) => Date.parse(b.snapshot.requestedAt) - Date.parse(a.snapshot.requestedAt));
      for (const { snapshot } of matching.slice(keep)) {
        try {
          await this.#call(() => this.#api.snapshots.delete({ sandboxGroupId, snapshotId: snapshot.id }));
        } catch (err) {
          if (err instanceof SandboxSnapshotNotFoundError || (err instanceof ClientError && err.statusCode === 404)) continue;
          throw err;
        }
      }
    } catch (err) {
      warn("snapshot prune failed", { snapshotName, error: errorMessage(err) });
    }
  }

  async createInvestigationSandbox({ snapshotName }: { snapshotName: string }): Promise<InvestigationSandbox> {
    const policy = this.#cfg.networkPolicy;
    if (policy.default === "allow-list" && !policy.allowedDomains.length) {
      throw new Error("cannot create an investigation sandbox with allow-list policy and no domains");
    }
    let sandbox: RenderSandbox;
    try {
      sandbox = await this.#call(() =>
        this.#api.create({ snapshotName, networkPolicy: policy, timeoutSeconds: this.#cfg.investigationTimeoutSeconds }),
      );
    } catch (err) {
      if (err instanceof SandboxSnapshotNotFoundError || err instanceof SandboxSnapshotNotReadyError) {
        throw new SnapshotUnavailableError(`no available snapshot named ${JSON.stringify(snapshotName)}: ${err.message}`, { cause: err });
      }
      if (policy.default === "allow-list" && err instanceof ClientError && [400, 422].includes(err.statusCode)) {
        throw new Error(
          `Render rejected networkPolicy allow-list [${policy.allowedDomains.join(", ")}]: ${err.message}. ` +
            "This workspace may not support allow-list egress; set SANDBOX_NETWORK_POLICY=allow-all (or deny-all) to proceed.",
          { cause: err },
        );
      }
      throw err;
    }
    try {
      if (sandbox.networkPolicy && sandbox.networkPolicy.default !== policy.default) {
        throw new Error(
          `Render created ${sandbox.id} with networkPolicy ${sandbox.networkPolicy.default}, not ${policy.default}; refusing to widen egress`,
        );
      }
      await this.#waitRunning(sandbox.id);
      const layout = await this.#verifyInvestigationSandbox(sandbox.id);
      const manifest = await this.#readManifest(sandbox.id, layout.info.layout.appDir, null);
      return { id: sandbox.id, manifest, layout: layout.info.layout, info: this.#infoRecord(layout.info) };
    } catch (err) {
      await this.#terminateQuietly(sandbox.id);
      throw err;
    }
  }

  async runInvestigation(sandbox: InvestigationSandbox, opts: RunInvestigationOptions): Promise<RunInvestigationResult> {
    const { appDir } = sandbox.layout;
    const runDir = `/tmp/run-${randomUUID()}`;
    const deadline = AbortSignal.timeout(opts.timeoutMs + this.#t.investigationGraceMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
    const out = new RunnerOutput(opts);
    let streaming = false;
    try {
      await this.#check(sandbox.id, `mkdir -p -m 700 ${runDir}`, { timeoutMs: this.#t.verifyTimeoutMs, signal });
      await this.#upload(sandbox.id, `${runDir}/input.json`, JSON.stringify(opts.input), { signal });
      if (opts.modelApiKey) await this.#upload(sandbox.id, `${runDir}/key`, opts.modelApiKey, { signal });
      const command = `bash ${appDir}/run-investigation.sh ${runDir} ${Math.ceil(opts.timeoutMs / 1000)}`;
      const stream = await this.#call(() => this.#api.exec(sandbox.id, command, undefined, signal), { retryOn: [429, 503], signal });
      streaming = true;
      for await (const ev of stream) {
        if (ev.type === "exit") return await out.finish(ev.exit_code, false);
        if (ev.stream === "stdout") await out.stdout(ev.data);
        else out.stderr(ev.data);
      }
      return await out.finish(null, signal.aborted, !signal.aborted);
    } catch (err) {
      // An aborted or lost stream says nothing about the remote process; the caller marks the sandbox unhealthy.
      if (!out.callbackFailed && (signal.aborted || streaming)) return await out.finish(null, signal.aborted, !signal.aborted);
      throw err;
    }
  }

  async terminate(id: string): Promise<void> {
    await this.#doTerminate(id);
  }

  async #build(
    profile: RepoProfile,
    heads: RepoManifest["repos"],
    createdAt: string,
    digest: string,
    snapshotName: string,
  ): Promise<{ snapshot: SandboxSnapshot; info: SandboxInfo; manifest: RepoManifest }> {
    // Network policy is immutable per sandbox: only the builder gets egress for git/npm/apt.
    const builder = await this.#call(() =>
      this.#api.create({ timeoutSeconds: this.#cfg.builderTimeoutSeconds, networkPolicy: { default: "allow-all" } }),
    );
    try {
      await this.#waitRunning(builder.id);
      await this.#check(builder.id, `mkdir -p -m 700 ${STAGE}`, { timeoutMs: this.#t.bootTimeoutMs, waitReady: true });
      await this.#upload(builder.id, STAGE, await this.#stageArchive(), { contentType: "application/x-tar" });
      const tsv = heads.map((h) => `${h.repository}\t${h.branch}\t${h.commit}\t${h.url ?? ""}\t${h.browse ?? ""}\n`).join("");
      await this.#upload(builder.id, `${STAGE}/heads.tsv`, tsv);
      // npm and the runner self-test run third-party code, so the token arrives only once they are done.
      await this.#prepareStep(builder.id, `install ${STAGE}`);
      const hostCreds = this.#cfg.hostCredentials;
      for (const [host, { username, token }] of Object.entries(hostCreds)) {
        await this.#upload(builder.id, `${STAGE}/creds/${host}`, `${username}\n${token}`);
      }
      const info = parseInfo(await this.#prepareStep(builder.id, `checkout ${STAGE} ${shq(profile.name)} ${createdAt}`));
      if (info.layout.appDir !== SANDBOX_APP) {
        throw new Error(`builder installed the app at ${info.layout.appDir}, not ${SANDBOX_APP}; restored Sandboxes couldn't be verified`);
      }
      const manifest = await this.#readManifest(builder.id, info.layout.appDir, digest);
      const snap = await this.#snapshot(builder.id, snapshotName);
      return { snapshot: snap, info, manifest };
    } finally {
      await this.#terminateQuietly(builder.id);
    }
  }

  async #prepareStep(id: string, args: string): Promise<string> {
    const res = await this.#exec(id, `bash ${STAGE}/prepare.sh ${args}`, { timeoutMs: this.#t.prepareTimeoutMs });
    if (res.exitCode !== 0) {
      throw new Error(`prepare.sh ${args.split(" ")[0]} exited ${res.exitCode}: ${res.stderr.trim().slice(-2000)}`);
    }
    return res.stdout;
  }

  async #verifyInvestigationSandbox(id: string): Promise<{ info: SandboxInfo }> {
    const res = await this.#exec(id, `bash ${SANDBOX_APP}/verify.sh${this.#probeArgs()}`, {
      timeoutMs: this.#t.verifyTimeoutMs,
      waitReady: true,
    });
    if (res.exitCode !== 0) throw new Error(`verify.sh exited ${res.exitCode}: ${res.stderr.trim().slice(-2000)}`);
    return { info: parseInfo(res.stdout) };
  }

  #infoRecord(info: SandboxInfo): Record<string, unknown> {
    return {
      runAs: info.runAs,
      uid: info.uid,
      privilegeDrop: info.drop,
      node: info.node,
      runnerNonDumpable: info.runnerNonDumpable,
      dnsResolves: info.dnsResolves,
      piVersion: info.selfTest.pi_version,
      promptVersion: info.selfTest.prompt_version,
    };
  }

  #probeArgs(): string {
    const policy = this.#cfg.networkPolicy;
    if (policy.default === "allow-all") return "";
    const allowed = policy.default === "allow-list" ? policy.allowedDomains.find((d) => !d.startsWith("*.")) : undefined;
    return ` --deny-probe ${DENY_PROBE_URL}${allowed ? ` --allow-probe ${shq(`https://${allowed}`)}` : ""}`;
  }

  async #readManifest(id: string, appDir: string, digest: string | null): Promise<RepoManifest> {
    const file = await this.#call(() => this.#api.download(id, `${appDir}/manifest.json`), { retryOn: [429, 503] });
    const manifest = RepoManifest.parse(JSON.parse(file.data.toString("utf8")));
    if (digest !== null && manifestDigest(manifest) !== digest) throw new Error(`manifest in ${id} does not match the resolved heads`);
    return manifest;
  }

  async #snapshot(sandboxId: string, name: string): Promise<SandboxSnapshot> {
    let snap = await this.#call(() => this.#api.snapshots.create({ sandboxId, kind: "filesystem", name }));
    const until = Date.now() + this.#t.snapshotTimeoutMs;
    while (snap.status === "creating") {
      if (Date.now() > until) throw new Error(`snapshot ${snap.id} still creating after ${this.#t.snapshotTimeoutMs}ms`);
      await sleep(this.#t.pollMs);
      const { id, sandboxGroupId } = snap;
      snap = await this.#call(() => this.#api.snapshots.get({ sandboxGroupId, snapshotId: id }), { retryOn: [429, 503] });
    }
    if (snap.status !== "available") throw new Error(`snapshot ${snap.id} ${snap.status}: ${snap.error ?? "no error given"}`);
    this.#sandboxGroupId = snap.sandboxGroupId;
    return snap;
  }

  async #waitRunning(id: string): Promise<void> {
    const until = Date.now() + this.#t.bootTimeoutMs;
    for (;;) {
      const { status } = await this.#call(() => this.#api.get(id), { retryOn: READY_RETRY });
      if (status === "running") return;
      if (status === "errored" || status === "terminated") throw new Error(`sandbox ${id} is ${status}`);
      if (Date.now() > until) throw new Error(`sandbox ${id} still ${status} after ${this.#t.bootTimeoutMs}ms`);
      await sleep(this.#t.pollMs);
    }
  }

  async #stageArchive(): Promise<Buffer> {
    const { runnerDistDir, sandboxDir } = this.#cfg;
    await stat(join(runnerDistDir, "runner.mjs")).catch(() => {
      throw new Error(`runner bundle not found at ${runnerDistDir}/runner.mjs; build sandbox/runner first`);
    });
    const dir = await mkdtemp(join(tmpdir(), "triage-stage-"));
    try {
      await cp(runnerDistDir, join(dir, "runner"), {
        recursive: true,
        filter: (src) => !relative(runnerDistDir, src).split(sep).includes("node_modules"),
      });
      // Flat sandbox layout: copy all .sh and .mjs files, preserving runner/ subdir
      for (const entry of await readdir(sandboxDir)) {
        const full = join(sandboxDir, entry);
        if (entry === "runner" || entry === "dist" || entry === "deps" || entry === "node_modules") continue;
        if (entry.endsWith(".sh") || entry.endsWith(".mjs") || entry.endsWith(".md")) {
          await cp(full, join(dir, entry));
        }
      }
      const entries = (await readdir(dir)).filter(e => e !== "node_modules");
      const chunks: Buffer[] = [];
      for await (const chunk of createTar({ cwd: dir, portable: true }, entries)) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async #exec(
    id: string,
    command: string,
    opts: { timeoutMs: number; waitReady?: boolean; signal?: AbortSignal },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const retry = opts.waitReady
      ? { retryOn: READY_RETRY, attempts: Math.ceil(this.#t.bootTimeoutMs / Math.max(this.#t.pollMs, 1)) }
      : { retryOn: [429, 503] };
    let stdout = "";
    let stderr = "";
    try {
      const stream = await this.#call(() => this.#api.exec(id, command, undefined, signal), { ...retry, signal });
      for await (const ev of stream) {
        if (ev.type === "exit") return { exitCode: ev.exit_code, stdout, stderr };
        if (ev.stream === "stdout") stdout = (stdout + ev.data).slice(-OUTPUT_TAIL);
        else stderr = (stderr + ev.data).slice(-OUTPUT_TAIL);
      }
    } catch (err) {
      if (timeout.aborted) throw new Error(`exec in ${id} timed out after ${opts.timeoutMs}ms: ${command}`);
      throw err;
    }
    throw new Error(`exec in ${id} ended without an exit event: ${command}`);
  }

  async #check(id: string, command: string, opts: { timeoutMs: number; waitReady?: boolean; signal?: AbortSignal }): Promise<void> {
    const res = await this.#exec(id, command, opts);
    if (res.exitCode !== 0) throw new Error(`${command} exited ${res.exitCode} in ${id}: ${res.stderr.trim().slice(-1000)}`);
  }

  async #upload(
    id: string,
    path: string,
    data: string | Buffer,
    opts: { contentType?: SandboxUploadContentType; signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.#call(() => this.#api.upload(id, path, data, undefined, opts), { retryOn: [429, 503], signal: opts.signal });
  }

  async #doTerminate(id: string): Promise<void> {
    try {
      await this.#call(() => this.#api.terminate(id), { retryOn: [429, 503] });
    } catch (err) {
      if (err instanceof ClientError && err.statusCode === 404) return;
      throw err;
    }
  }

  async #terminateQuietly(id: string): Promise<void> {
    await this.#doTerminate(id).catch((err) => warn("terminate failed", { sandbox: id, error: errorMessage(err) }));
  }

  /** Paces every API call and retries the given statuses (429 by default, which is never processed server-side). */
  async #call<T>(
    fn: () => Promise<T>,
    opts: { retryOn?: readonly number[]; attempts?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const retryOn = opts.retryOn ?? [429];
    const attempts = opts.attempts ?? 5;
    for (let attempt = 1; ; attempt++) {
      const now = Date.now();
      const at = Math.max(now, this.#nextRequestAt);
      this.#nextRequestAt = at + this.#cfg.minRequestIntervalMs;
      if (at > now) await sleep(at - now, undefined, { signal: opts.signal });
      try {
        return await fn();
      } catch (err) {
        const status = err instanceof ClientError || err instanceof ServerError ? err.statusCode : undefined;
        if (attempt >= attempts || status === undefined || !retryOn.includes(status) || opts.signal?.aborted) throw err;
        await sleep(this.#t.pollMs, undefined, { signal: opts.signal });
      }
    }
  }
}

/** `ls-remote --symref <url> HEAD` or `ls-remote <url> refs/heads/<branch>` → branch + commit. */
export function parseLsRemote(out: string, branch?: string): { branch: string; commit: string } | null {
  let resolved = branch;
  let commit: string | undefined;
  for (const line of out.split("\n")) {
    const sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (sym) {
      resolved ??= sym[1];
      continue;
    }
    const ref = /^([0-9a-f]{40})\t(\S+)$/.exec(line);
    if (ref && ref[2] === (branch ? `refs/heads/${branch}` : "HEAD")) commit = ref[1];
  }
  return resolved && commit ? { branch: resolved, commit } : null;
}

function parseInfo(stdout: string): SandboxInfo {
  const last = stdout.trim().split("\n").at(-1) ?? "";
  try {
    return SandboxInfo.parse(JSON.parse(last));
  } catch (err) {
    throw new Error(`unexpected sandbox info line ${JSON.stringify(last.slice(0, 300))}: ${errorMessage(err)}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function warn(message: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: "warn", component: "render-provider", message, ...fields }));
}





import { LocalProvider } from "./sandbox-local.ts";

/** Selects by `SANDBOX_PROVIDER` (`render` | `local`); defaults to `render` on Render (which sets `RENDER=true`), else `local`. */
export async function createProvider(
  env: NodeJS.ProcessEnv = process.env,
  derivedAllowedDomain?: string,
  fetcher?: typeof fetch,
): Promise<SandboxProvider> {
  const kind = env.SANDBOX_PROVIDER || (env.RENDER === "true" ? "render" : "local");
  switch (kind) {
    case "local":
      return new LocalProvider(loadLocalConfig(env));
    case "render":
      return RenderProvider.fromConfig(await loadRenderConfig(env, derivedAllowedDomain, fetcher));
    default:
      throw new Error(`SANDBOX_PROVIDER must be "render" or "local", got ${JSON.stringify(kind)}`);
  }
}

