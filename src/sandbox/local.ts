import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import config from "../../config.ts";
import { errorMessage, type RepoManifest, type RepoProfile } from "../types.ts";
import { writeRunnerBundle } from "./runner-bundle.ts";
import {
  REPO_ROOT,
  SnapshotUnavailableError,
  appendStderrTail,
  git,
  parseRunnerEvents,
  shq,
  type OpenSandbox,
  type RunInvestigationOptions,
  type RunInvestigationResult,
} from "./interface.ts";

export type LocalConfig = {
  profile: RepoProfile;
  /** Parent of `<owner>/<name>` checkouts. */
  reposRoot: string;
  /** Holds a scratch dir per open sandbox. */
  sandboxesRoot: string;
  /**
   * Shell command; `--key-file PATH` is appended when a model key is supplied.
   * Unset: the runner is bundled into `.scratch/runner/` on first use and run with this node.
   */
  runnerCmd?: string;
  /** Shell words appended to the bundled runner's command (e.g. `--faux`); ignored when `runnerCmd` is set. */
  runnerArgs?: string;
};

export function loadLocalConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig {
  const e = z
    .object({
      LOCAL_REPOS_ROOT: z.string().default(join(REPO_ROOT, ".scratch/repos")),
      LOCAL_SANDBOXES_ROOT: z.string().default(join(REPO_ROOT, ".scratch/sandboxes")),
      LOCAL_RUNNER_CMD: z.string().optional(),
      LOCAL_RUNNER_ARGS: z.string().optional(),
    })
    .parse(env);
  return {
    profile: { name: config.name, repos: config.repos },
    reposRoot: e.LOCAL_REPOS_ROOT,
    sandboxesRoot: e.LOCAL_SANDBOXES_ROOT,
    runnerCmd: e.LOCAL_RUNNER_CMD,
    runnerArgs: e.LOCAL_RUNNER_ARGS,
  };
}

const KILL_AFTER_MS = 10_000;
/** What coreutils `timeout` exits with; the Render sandbox reports the same status on deadline. */
const TIMEOUT_EXIT = 124;
const SECRET_ENV = /^(DATABASE_URL.*|RENDER_API_KEY|.*_TOKEN|SLACK_.*)$/;
/** Read-only inspection flags: never trust repo-local config that could execute commands as the checker. */
const SAFE_GIT = ["-c", "safe.directory=*", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

/**
 * Runs the runner as a local child process against clean checkouts under `reposRoot`, which stand in
 * for the snapshot (the snapshot name is ignored). No isolation: for local end-to-end runs and tests only.
 */
export function localSandboxes(cfg: LocalConfig): OpenSandbox {
  let runnerCmd: Promise<string> | undefined;
  const resolveRunnerCmd = () =>
    (runnerCmd ??= cfg.runnerCmd !== undefined
      ? Promise.resolve(cfg.runnerCmd)
      : writeRunnerBundle(join(REPO_ROOT, ".scratch/runner")).then(
          (path) => [shq(process.execPath), shq(path), cfg.runnerArgs].filter(Boolean).join(" "),
          (err) => {
            runnerCmd = undefined;
            throw err;
          },
        ));
  return async () => {
    const manifest: RepoManifest = {
      profile: cfg.profile.name,
      created_at: new Date().toISOString(),
      repos: await Promise.all(cfg.profile.repos.map((repo) => checkout(cfg.reposRoot, repo))),
    };
    const id = `local-${randomUUID()}`;
    const dir = join(cfg.sandboxesRoot, id);
    const scratchDir = join(dir, "scratch");
    await mkdir(scratchDir, { recursive: true });
    return {
      id,
      manifest,
      reposRoot: cfg.reposRoot,
      scratchDir,
      info: {},
      run: async (opts) => runLocal(await resolveRunnerCmd(), scratchDir, opts),
      close: () => rm(dir, { recursive: true, force: true }),
    };
  };
}

/** Reads a checkout's HEAD; a dirty working tree would make citations unreliable, so it counts as unavailable. */
async function checkout(reposRoot: string, { repository, branch, url, browse }: RepoProfile["repos"][number]): Promise<RepoManifest["repos"][number]> {
  const path = join(reposRoot, repository);
  const g = (...args: string[]) => git([...SAFE_GIT, "-C", path, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  let commit: string, current: string, status: string;
  try {
    commit = await g("rev-parse", "HEAD");
    current = branch ?? (await g("rev-parse", "--abbrev-ref", "HEAD"));
    status = await g("status", "--porcelain", "--ignored");
  } catch (err) {
    throw new SnapshotUnavailableError(`${repository} at ${path}: ${errorMessage(err)}`);
  }
  if (status) throw new SnapshotUnavailableError(`${repository} at ${path}: working tree is dirty (${status.split("\n").length} entries)`);
  return { repository, branch: current, commit, path, ...(url && { url }), ...(browse && { browse }) };
}

async function runLocal(runnerCmd: string, scratchDir: string, opts: RunInvestigationOptions): Promise<RunInvestigationResult> {
  await mkdir(scratchDir, { recursive: true });
  const runDir = await mkdtemp(join(tmpdir(), "triage-run-"));
  try {
    const args: string[] = [];
    if (opts.modelApiKey) {
      const keyFile = join(runDir, "key");
      await writeFile(keyFile, opts.modelApiKey, { mode: 0o600 });
      args.push("--key-file", keyFile);
    }
    return await spawnRunner(runnerCmd, scratchDir, args, opts);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

function spawnRunner(runnerCmd: string, cwd: string, args: string[], opts: RunInvestigationOptions): Promise<RunInvestigationResult> {
  if (opts.signal?.aborted) {
    return Promise.resolve({ exitCode: null, aborted: true, streamLost: false, stderrTail: "", events: [], invalidLines: 0 });
  }
  return new Promise((resolve, reject) => {
    // detached: the runner leads its own process group, so stragglers it spawns die with it.
    const child = spawn("/bin/sh", ["-c", `exec ${runnerCmd} "$@"`, "sh", ...args], {
      cwd,
      env: childEnv(opts.modelApiKey),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    let killedBy: "deadline" | "abort" | null = null;
    let hardKill: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      killedBy ??= "deadline";
      killGroup("SIGTERM");
      hardKill = setTimeout(() => killGroup("SIGKILL"), KILL_AFTER_MS);
    }, opts.timeoutMs);
    const onAbort = () => {
      killedBy = "abort";
      killGroup("SIGKILL");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const settle = () => {
      clearTimeout(deadline);
      clearTimeout(hardKill);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    let stdout = "";
    let stderrTail = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderrTail = appendStderrTail(stderrTail, chunk);
      opts.onStderr?.(chunk);
    });
    child.stdin.on("error", () => {
      // the runner may exit without reading stdin
    });
    child.stdin.end(JSON.stringify(opts.input));

    child.on("error", (err) => {
      settle();
      reject(err);
    });
    child.on("exit", () => killGroup("SIGKILL"));
    child.on("close", (code) => {
      settle();
      const aborted = killedBy === "abort";
      const exitCode = aborted ? null : killedBy === "deadline" ? TIMEOUT_EXIT : code;
      // A null code means a signal killed the runner (e.g. the OOM killer): unknown cause, so report it as lost.
      resolve({ exitCode, aborted, streamLost: !aborted && exitCode === null, stderrTail, ...parseRunnerEvents(stdout) });
    });
  });
}

/** Inherits the dev environment minus orchestration secrets; the model key arrives only via the key file. */
function childEnv(modelApiKey?: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => !SECRET_ENV.test(k) && (modelApiKey === undefined || v !== modelApiKey)),
  );
}
