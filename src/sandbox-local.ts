import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoManifest, RepoProfile } from "./types.ts";
import type { LocalProviderConfig } from "./sandbox.ts";
import { checkRepo, git, SAFE_GIT } from "./sandbox.ts";
import {
  type BuildSnapshotOptions,
  type BuiltSnapshot,
  type InvestigationSandbox,
  SnapshotUnavailableError,
  type RunInvestigationOptions,
  type RunInvestigationResult,
  type SandboxLayout,
  type SandboxProvider,
} from "./sandbox.ts";
import { RunnerOutput } from "./sandbox.ts";

const KILL_AFTER_MS = 10_000;
/** What coreutils `timeout` exits with; the Render provider reports the same status on deadline. */
const TIMEOUT_EXIT = 124;
const SECRET_ENV = /^(DATABASE_URL.*|RENDER_API_KEY|.*_TOKEN|SLACK_.*)$/;
const LOCAL_ID = /^local-[0-9a-f-]+$/;

/**
 * Local checkouts stand in for the snapshot. No isolation: for local end-to-end runs and tests only.
 */
export class LocalProvider implements SandboxProvider {
  readonly name = "local";

  constructor(private readonly cfg: LocalProviderConfig) {}

  async resolveHeads(profile: RepoProfile): Promise<RepoManifest["repos"]> {
    return Promise.all(
      profile.repos.map(async ({ repository, branch, url, browse }) => {
        const path = join(this.cfg.reposRoot, repository);
        try {
          const commit = await git([...SAFE_GIT, "-C", path, "rev-parse", "HEAD"]);
          const current = branch ?? (await git([...SAFE_GIT, "-C", path, "rev-parse", "--abbrev-ref", "HEAD"]));
          return { repository, branch: current, commit, path, ...(url && { url }), ...(browse && { browse }) };
        } catch (err) {
          throw new Error(`resolveHeads ${repository} at ${path}: ${(err as Error).message}`);
        }
      }),
    );
  }

  async buildSnapshot({ profile, heads, snapshotName }: BuildSnapshotOptions): Promise<BuiltSnapshot> {
    const repos = heads.map((h) => ({ ...h, path: join(this.cfg.reposRoot, h.repository) }));
    const problems = await this.#problems(repos);
    if (problems.length) throw new Error(`local checkouts moved: ${problems.join("; ")}`);
    const manifest: RepoManifest = { profile: profile.name, created_at: new Date().toISOString(), repos };
    const layout: SandboxLayout = { reposRoot: this.cfg.reposRoot, scratchDir: this.cfg.sandboxesRoot, appDir: this.cfg.appDir };
    const snapshotDir = join(this.cfg.sandboxesRoot, "snapshots");
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(snapshotDir, `${snapshotName}.json`), JSON.stringify({ manifest, layout }));
    return { id: snapshotName, manifest, layout };
  }

  async pruneSnapshots(_snapshotName: string, _keep: number): Promise<void> {
    // no-op: local snapshots are just metadata files referencing shared checkouts.
  }

  async createInvestigationSandbox({ snapshotName }: { snapshotName: string }): Promise<InvestigationSandbox> {
    const snapshotPath = join(this.cfg.sandboxesRoot, "snapshots", `${snapshotName}.json`);
    let raw: string;
    try {
      raw = await readFile(snapshotPath, "utf8");
    } catch {
      throw new SnapshotUnavailableError(`no local snapshot named ${JSON.stringify(snapshotName)}`);
    }
    const { manifest, layout } = JSON.parse(raw) as { manifest: RepoManifest; layout: SandboxLayout };
    const problems = await this.#problems(manifest.repos);
    if (problems.length) throw new SnapshotUnavailableError(`local checkouts moved: ${problems.join("; ")}`);
    const id = `local-${randomUUID()}`;
    const scratchDir = join(this.cfg.sandboxesRoot, id, "scratch");
    await mkdir(scratchDir, { recursive: true });
    return { id, manifest, layout: { ...layout, scratchDir }, info: {} };
  }

  async runInvestigation(sandbox: InvestigationSandbox, opts: RunInvestigationOptions): Promise<RunInvestigationResult> {
    const { scratchDir } = sandbox.layout;
    await mkdir(scratchDir, { recursive: true });
    const runDir = await mkdtemp(join(tmpdir(), "triage-run-"));
    try {
      const args: string[] = [];
      if (opts.modelApiKey) {
        const keyFile = join(runDir, "key");
        await writeFile(keyFile, opts.modelApiKey, { mode: 0o600 });
        args.push("--key-file", keyFile);
      }
      return await this.#spawn(scratchDir, args, opts);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  }

  async terminate(id: string): Promise<void> {
    if (!LOCAL_ID.test(id)) throw new Error(`refusing to remove unexpected local sandbox id ${id}`);
    await rm(join(this.cfg.sandboxesRoot, id), { recursive: true, force: true });
  }

  async #problems(repos: RepoManifest["repos"]): Promise<string[]> {
    return (await Promise.all(repos.map((r) => checkRepo(r.path, r.commit)))).filter((p) => p !== null);
  }

  #spawn(cwd: string, args: string[], opts: RunInvestigationOptions): Promise<RunInvestigationResult> {
    const out = new RunnerOutput(opts);
    if (opts.signal?.aborted) return out.finish(null, true);
    return new Promise((resolve, reject) => {
      // detached: the runner leads its own process group, so stragglers it spawns die with it.
      const child = spawn("/bin/sh", ["-c", `exec ${this.cfg.runnerCmd} "$@"`, "sh", ...args], {
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

      let events = Promise.resolve();
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        events = events.then(() => out.stdout(chunk));
        events.catch(() => killGroup("SIGKILL"));
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => out.stderr(chunk));
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
        events
          .then(() => {
            if (killedBy === "abort") return out.finish(null, true);
            if (killedBy === "deadline") return out.finish(TIMEOUT_EXIT, false);
            // A null code means a signal killed the runner (e.g. the OOM killer): unknown cause, so report it as lost.
            return out.finish(code, false, code === null);
          })
          .then(resolve, reject);
      });
    });
  }
}

/** Inherits the dev environment minus orchestration secrets; the model key arrives only via the key file. */
function childEnv(modelApiKey?: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => !SECRET_ENV.test(k) && (modelApiKey === undefined || v !== modelApiKey)),
  );
}

