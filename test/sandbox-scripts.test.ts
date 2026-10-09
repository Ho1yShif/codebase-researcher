import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerEvent } from "../src/types.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../src/sandbox.ts";
import { FAKE_RUNNER, makeRepo, runnerInput, runnerReport } from "./helpers.ts";

// The in-sandbox scripts, exercised on the non-root code path with local file:// remotes.
const SANDBOX = fileURLToPath(new URL("../sandbox/", import.meta.url));
const GH_TOKEN = "ghp_scriptTestToken0123456789";
const GL_TOKEN = "glpat_scriptTestToken9876543210";

let tmp: string;
let env: NodeJS.ProcessEnv;
let commit: string;
let repo: string;

function bash(script: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile("bash", [script, ...args], { env: { ...env, ...extraEnv } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "triage-scripts-"));
  const shim = join(tmp, "shim");
  await mkdir(join(tmp, "home"), { recursive: true });
  await mkdir(shim);
  // Hosts may lack coreutils timeout (macOS) or rg on the minimal TRIAGE_PATH. The timeout shim drops its options
  // and duration and runs the command; verify.sh only checks that rg exists.
  await writeFile(join(shim, "timeout"), '#!/bin/sh\nwhile [ "${1#-}" != "$1" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
  await writeFile(join(shim, "rg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  env = {
    PATH: `${shim}:${dirname(process.execPath)}:${process.env.PATH}`,
    HOME: join(tmp, "home"),
    GIT_CONFIG_GLOBAL: join(tmp, "home/.gitconfig"),
    GIT_CONFIG_SYSTEM: "/dev/null",
    DATABASE_URL: "postgres://must-not-leak",
  };
  const work = await makeRepo(join(tmp, "work"), "acme/widget");
  commit = work.commit;
  await git(["clone", "-q", "--bare", work.path, join(tmp, "remote/acme/widget.git")]);
  repo = join(tmp, "dx/repos/acme/widget");
});

afterAll(async () => {
  await chmod(join(tmp, "dx/repos"), 0o755).catch(() => {});
  execFileSync("chmod", ["-R", "u+w", tmp]);
  await rm(tmp, { recursive: true, force: true });
});

describe("prepare scripts", { timeout: 30_000 }, () => {
  const stage = () => join(tmp, "stage");
  const credsDir = () => join(stage(), "creds");

  async function writeCred(host: string, username: string, token: string) {
    const dir = credsDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, host), `${username}\n${token}`);
  }

  it("clone.sh pins each repo at its commit with the token kept out of git config", async () => {
    await mkdir(stage(), { recursive: true });
    await writeFile(join(stage(), "heads.tsv"), `acme/widget\tmain\t${commit}\tfile://${join(tmp, "remote/acme/widget.git")}\t\n`);
    await writeCred("github.com", "x-access-token", GH_TOKEN);
    const res = await bash(join(SANDBOX, "clone.sh"), [join(tmp, "dx/repos"), join(stage(), "heads.tsv"), credsDir()], {
      TRIAGE_ALLOW_FILE_URLS: "1",
    });
    expect(res.stderr).not.toContain(GH_TOKEN);
    expect(res.code).toBe(0);
    expect(await git(["-C", repo, "rev-parse", "HEAD"])).toBe(commit);
    await expect(git(["-C", repo, "symbolic-ref", "-q", "HEAD"])).rejects.toThrow();
    expect(await git(["-C", repo, "config", "core.checkStat"])).toBe("minimal");
    expect(await git(["-C", repo, "config", "remote.origin.url"])).not.toContain("@");
  });

  it("scrub-credentials.sh deletes all host tokens and rejects leftover credentials", async () => {
    const scrub = (extra: NodeJS.ProcessEnv = {}) => bash(join(SANDBOX, "scrub-credentials.sh"), [join(tmp, "dx/repos"), credsDir()], extra);
    await writeCred("github.com", "x-access-token", GH_TOKEN);
    const ok = await scrub();
    expect(ok).toMatchObject({ code: 0 });
    expect(existsSync(credsDir())).toBe(false);

    await writeCred("github.com", "x-access-token", GH_TOKEN);
    await git(["-C", repo, "config", "remote.backup.url", `https://x-access-token:${GH_TOKEN}@github.com/acme/widget.git`]);
    const leaked = await scrub();
    expect(leaked.code).not.toBe(0);
    expect(leaked.stderr).toContain("token value");
    await git(["-C", repo, "config", "--remove-section", "remote.backup"]);

    await writeCred("github.com", "x-access-token", GH_TOKEN);
    await git(["-C", repo, "config", "credential.helper", "store"]);
    const helper = await scrub();
    expect(helper.stderr).toContain("credential settings in .git/config");
    await git(["-C", repo, "config", "--unset", "credential.helper"]);
    await writeCred("github.com", "x-access-token", GH_TOKEN);
    expect(await scrub()).toMatchObject({ code: 0 });
  });

  it("scrub-credentials.sh covers two hosts and catches any leaked token", async () => {
    await writeCred("github.com", "x-access-token", GH_TOKEN);
    await writeCred("gitlab.com", "oauth2", GL_TOKEN);
    const scrubOk = await bash(join(SANDBOX, "scrub-credentials.sh"), [join(tmp, "dx/repos"), credsDir()]);
    expect(scrubOk).toMatchObject({ code: 0 });
    expect(existsSync(credsDir())).toBe(false);

    // Leak the GitLab token into a repo's .git/config
    await writeCred("github.com", "x-access-token", GH_TOKEN);
    await writeCred("gitlab.com", "oauth2", GL_TOKEN);
    await git(["-C", repo, "config", "remote.backup.url", `https://oauth2:${GL_TOKEN}@gitlab.com/acme/widget.git`]);
    const leaked = await bash(join(SANDBOX, "scrub-credentials.sh"), [join(tmp, "dx/repos"), credsDir()]);
    expect(leaked.code).not.toBe(0);
    expect(leaked.stderr).toContain("token value");
    await git(["-C", repo, "config", "--remove-section", "remote.backup"]);
  });

  it("lockdown.sh + verify.sh (non-root) make repos read-only and describe the sandbox", async () => {
    const root = join(tmp, "dx");
    const app = join(root, "app");
    await mkdir(join(app, "runner"), { recursive: true });
    await cp(SANDBOX, app, { recursive: true });
    await cp(SANDBOX, app, { recursive: true });
    await cp(FAKE_RUNNER, join(app, "runner/runner.mjs"));
    const user = userInfo().username;
    const lines = {
      TRIAGE_ROOT: root,
      TRIAGE_APP_DIR: app,
      TRIAGE_REPOS_ROOT: join(root, "repos"),
      TRIAGE_SCRATCH_DIR: join(root, "scratch"),
      TRIAGE_RUN_AS: user,
      TRIAGE_DROP: "none",
      TRIAGE_NODE: process.execPath,
      TRIAGE_RUNNER_NODE: process.execPath,
      TRIAGE_PATH: `${join(tmp, "shim")}:${dirname(process.execPath)}:/usr/bin:/bin`,
    };
    await writeFile(join(app, "env"), Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join(""));
    await writeFile(
      join(app, "manifest.json"),
      JSON.stringify({ profile: "t", created_at: new Date().toISOString(), repos: [{ repository: "acme/widget", branch: "main", commit, path: repo }] }),
    );

    expect(await bash(join(app, "lockdown.sh"), [])).toMatchObject({ code: 0 });
    expect(existsSync(join(app, "node-runner"))).toBe(false);
    const res = await bash(join(app, "verify.sh"), []);
    expect(res.stderr).toBe("");
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout.trim().split("\n").at(-1)!)).toMatchObject({
      layout: { reposRoot: lines.TRIAGE_REPOS_ROOT, scratchDir: lines.TRIAGE_SCRATCH_DIR, appDir: app },
      runAs: user,
      drop: "none",
      runnerNonDumpable: false,
      dnsResolves: expect.any(Boolean),
      selfTest: { ok: true, pi_version: "0.0.0-fake" },
    });
    expect(await readdir(lines.TRIAGE_SCRATCH_DIR)).toEqual([]);
  });

  it.skipIf(process.getuid?.() !== 0)("lockdown.sh (root) installs an execute-only node for the runner", async () => {
    const root = join(tmp, "triage-root");
    const app = join(root, "app");
    await mkdir(app, { recursive: true });
    await Promise.all([mkdir(app), mkdir(join(root, "repos")), mkdir(join(root, "scratch"))]);
    await cp(join(SANDBOX, "lockdown.sh"), join(app, "lockdown.sh"));
    const lines = {
      TRIAGE_ROOT: root,
      TRIAGE_APP_DIR: app,
      TRIAGE_REPOS_ROOT: join(root, "repos"),
      TRIAGE_SCRATCH_DIR: join(root, "scratch"),
      TRIAGE_RUN_AS: "nobody",
      TRIAGE_NODE: process.execPath,
      TRIAGE_RUNNER_NODE: join(app, "node-runner"),
    };
    await writeFile(join(app, "env"), Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join(""));
    expect(await bash(join(app, "lockdown.sh"), [])).toMatchObject({ code: 0 });
    const runner = await stat(lines.TRIAGE_RUNNER_NODE);
    expect([runner.mode & 0o7777, runner.uid, runner.gid]).toEqual([0o711, 0, 0]);
    expect(execFileSync(lines.TRIAGE_RUNNER_NODE, ["-p", "1 + 1"], { encoding: "utf8" }).trim()).toBe("2");
  });

  it("prepare.sh runs the install phase only before credentials are staged, and always deletes them", async () => {
    const staged = join(tmp, "stage-order");
    await mkdir(join(staged, "creds"), { recursive: true });
    await writeFile(join(staged, "creds/github.com"), `x-access-token\n${GH_TOKEN}`);
    const install = await bash(join(SANDBOX, "prepare.sh"), ["install", staged]);
    expect(install.code).not.toBe(0);
    expect(install.stderr).toContain("credential files exist");
    expect(existsSync(join(tmp, "home/dx"))).toBe(false);

    const checkout = await bash(join(SANDBOX, "prepare.sh"), ["checkout", staged, "t", new Date().toISOString()]);
    expect(checkout.code).not.toBe(0);
    expect(checkout.stderr).toContain("run the install phase first");
    expect(existsSync(join(staged, "creds"))).toBe(false);
    expect(install.stderr + checkout.stderr).not.toContain(GH_TOKEN);
  });

  it("run-investigation.sh feeds input on stdin, scrubs env, and removes the key", async () => {
    const app = join(tmp, "dx/app");
    const runDir = join(tmp, "runs/run-abc");
    await mkdir(join(app, "runner"), { recursive: true });
    await cp(SANDBOX, app, { recursive: true });
    await cp(FAKE_RUNNER, join(app, "runner/runner.mjs"));
    await mkdir(join(tmp, "dx/scratch"), { recursive: true });
    await writeFile(
      join(app, "env"),
      [
        `TRIAGE_APP_DIR=${app}`,
        `TRIAGE_REPOS_ROOT=${join(tmp, "dx/repos")}`,
        `TRIAGE_SCRATCH_DIR=${join(tmp, "dx/scratch")}`,
        `TRIAGE_RUN_AS=${userInfo().username}`,
        "TRIAGE_DROP=none",
        `TRIAGE_NODE=${process.execPath}`,
        `TRIAGE_RUNNER_NODE=${process.execPath}`,
        `TRIAGE_PATH=${dirname(process.execPath)}:/usr/bin:/bin`,
      ].join("\n"),
    );
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const layout = { reposRoot: join(tmp, "dx/repos"), scratchDir: join(tmp, "dx/scratch"), appDir: app };
    await writeFile(join(runDir, "input.json"), JSON.stringify(runnerInput(layout)));
    await writeFile(join(runDir, "key"), "sk-ant-script-key");

    const res = await bash(join(app, "run-investigation.sh"), [runDir, "30"]);
    expect(res.code).toBe(0);
    const events = res.stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => RunnerEvent.parse(JSON.parse(l)));
    expect(events.map((e) => e.type)).toEqual(["started", "assistant_text", "result"]);
    const report = runnerReport(events);
    expect(report).toMatchObject({ key: "sk-ant-script-key", keyFileGone: true, keyInEnv: false });
    expect(report.cwd).toContain(layout.scratchDir);
    expect(report.envKeys).not.toContain("DATABASE_URL");
    expect(report.envKeys).toEqual(expect.arrayContaining(["HOME", "PATH", "GIT_CONFIG_GLOBAL", "TMPDIR"]));
    expect(existsSync(join(runDir, "key"))).toBe(false);
  });
});
