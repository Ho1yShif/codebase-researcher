import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, parseRunnerEvents } from "../src/sandbox/interface.ts";
import { FAKE_RUNNER, makeRepo, runnerInput, runnerReport } from "./helpers.ts";

const SANDBOX = fileURLToPath(new URL("../sandbox-runtime/", import.meta.url));

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
  tmp = await mkdtemp(join(tmpdir(), "researcher-scripts-"));
  const shim = join(tmp, "shim");
  await mkdir(join(tmp, "home"), { recursive: true });
  await mkdir(shim);
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

  // Clone a repo so verify.sh and run-investigation.sh tests have a checkout to work with
  await mkdir(dirname(repo), { recursive: true });
  await git(["clone", "-q", join(tmp, "remote/acme/widget.git"), repo]);
  await git(["-C", repo, "checkout", "--detach", commit]);
  await git(["-C", repo, "config", "core.checkStat", "minimal"]);
  await git(["-C", repo, "config", "core.trustctime", "false"]);
  await git(["-C", repo, "config", "gc.auto", "0"]);
});

afterAll(async () => {
  await chmod(join(tmp, "dx/repos"), 0o755).catch(() => {});
  const { execFileSync } = await import("node:child_process");
  execFileSync("chmod", ["-R", "u+w", tmp]);
  await rm(tmp, { recursive: true, force: true });
});

describe("sandbox runtime scripts", { timeout: 30_000 }, () => {
  it("verify.sh (non-root) makes repos read-only and describes the sandbox", async () => {
    const root = join(tmp, "dx");
    const app = join(root, "app");
    await mkdir(join(app, "runner"), { recursive: true });
    await cp(SANDBOX, app, { recursive: true });
    await cp(FAKE_RUNNER, join(app, "runner/runner.mjs"));
    const user = userInfo().username;
    const lines = {
      RESEARCHER_ROOT: root,
      RESEARCHER_APP_DIR: app,
      RESEARCHER_REPOS_ROOT: join(root, "repos"),
      RESEARCHER_SCRATCH_DIR: join(root, "scratch"),
      RESEARCHER_RUN_AS: user,
      RESEARCHER_DROP: "none",
      RESEARCHER_NODE: process.execPath,
      RESEARCHER_RUNNER_NODE: process.execPath,
      RESEARCHER_PATH: `${join(tmp, "shim")}:${dirname(process.execPath)}:/usr/bin:/bin`,
    };
    await writeFile(join(app, "env"), Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join(""));
    await writeFile(
      join(app, "manifest.json"),
      JSON.stringify({ profile: "t", created_at: new Date().toISOString(), repos: [{ repository: "acme/widget", branch: "main", commit, path: repo }] }),
    );
    await mkdir(join(root, "scratch"), { recursive: true });

    // Lockdown: make repos read-only (non-root path, same as the TypeScript lockdown does)
    const { execFileSync } = await import("node:child_process");
    execFileSync("chmod", ["-R", "a-w", join(root, "repos")]);

    const res = await bash(join(app, "verify.sh"), []);
    // Restore write permission for cleanup
    execFileSync("chmod", ["-R", "u+w", join(root, "repos")]);

    expect(res.stderr).toBe("");
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout.trim().split("\n").at(-1)!)).toMatchObject({
      runAs: user,
      drop: "none",
      runnerNonDumpable: false,
      dnsResolves: expect.any(Boolean),
      selfTest: { ok: true, pi_version: "0.0.0-fake" },
    });
    expect(await readdir(lines.RESEARCHER_SCRATCH_DIR)).toEqual([]);
  });

  it("run-investigation.sh feeds input on stdin, writes events and exit status beside the run dir, and removes the key", async () => {
    const app = join(tmp, "dx/app");
    const runDir = join(tmp, "runs/run-abc");
    await mkdir(join(app, "runner"), { recursive: true });
    await cp(SANDBOX, app, { recursive: true });
    await cp(FAKE_RUNNER, join(app, "runner/runner.mjs"));
    await mkdir(join(tmp, "dx/scratch"), { recursive: true });
    await writeFile(
      join(app, "env"),
      [
        `RESEARCHER_APP_DIR=${app}`,
        `RESEARCHER_REPOS_ROOT=${join(tmp, "dx/repos")}`,
        `RESEARCHER_SCRATCH_DIR=${join(tmp, "dx/scratch")}`,
        `RESEARCHER_RUN_AS=${userInfo().username}`,
        "RESEARCHER_DROP=none",
        `RESEARCHER_NODE=${process.execPath}`,
        `RESEARCHER_RUNNER_NODE=${process.execPath}`,
        `RESEARCHER_PATH=${dirname(process.execPath)}:/usr/bin:/bin`,
      ].join("\n"),
    );
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const layout = { reposRoot: join(tmp, "dx/repos"), scratchDir: join(tmp, "dx/scratch") };
    await writeFile(join(runDir, "input.json"), JSON.stringify(runnerInput(layout)));
    await writeFile(join(runDir, "key"), "sk-ant-script-key");

    const res = await bash(join(app, "run-investigation.sh"), [runDir, "30"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
    expect(await readFile(`${runDir}.exit`, "utf8")).toBe("0\n");
    const { events, invalidLines } = parseRunnerEvents(await readFile(`${runDir}.jsonl`, "utf8"));
    expect(invalidLines).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["started", "assistant_text", "result"]);
    const report = runnerReport(events);
    expect(report).toMatchObject({ key: "sk-ant-script-key", keyFileGone: true, keyInEnv: false });
    expect(report.cwd).toContain(layout.scratchDir);
    expect(report.envKeys).not.toContain("DATABASE_URL");
    expect(report.envKeys).toEqual(expect.arrayContaining(["HOME", "PATH", "GIT_CONFIG_GLOBAL", "TMPDIR"]));
    expect(existsSync(join(runDir, "key"))).toBe(false);
  });
});

describe("builder-only scripts", { timeout: 30_000 }, () => {
  const TOKEN = "ghp_scrubTestToken0000000000000000000";
  const helper = join(SANDBOX, "build/git-credential-staged.sh");
  const scrub = join(SANDBOX, "build/scrub-credentials.sh");

  async function stageCreds(): Promise<string> {
    const dir = await mkdtemp(join(tmp, "creds-"));
    await writeFile(join(dir, "github.com"), `x-access-token\n${TOKEN}`);
    return dir;
  }

  function askHelper(credsDir: string, action: string, request: string) {
    return new Promise<string>((resolve, reject) => {
      const child = execFile("bash", [helper, credsDir, action], { env }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      child.stdin!.end(request);
    });
  }

  it("git-credential-staged.sh answers get for a staged host only", async () => {
    const creds = await stageCreds();
    expect(await askHelper(creds, "get", "protocol=https\nhost=github.com\n\n")).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
    expect(await askHelper(creds, "get", "protocol=https\nhost=gitlab.com\n\n")).toBe("");
    expect(await askHelper(creds, "get", "protocol=https\nhost=../github.com\n\n")).toBe("");
    expect(await askHelper(creds, "store", "protocol=https\nhost=github.com\n\n")).toBe("");
  });

  it("scrub-credentials.sh deletes staged credentials when no token leaked", async () => {
    const creds = await stageCreds();
    const res = await bash(scrub, [creds, join(tmp, "dx/repos")]);
    expect(res.stderr).toBe("");
    expect(res.code).toBe(0);
    expect(existsSync(creds)).toBe(false);
  });

  it("scrub-credentials.sh fails, keeping the evidence, when a token reached a repo's .git", async () => {
    const creds = await stageCreds();
    await git(["-C", repo, "config", "remote.origin.pushurl", `https://x:${TOKEN}@github.com/acme/widget.git`]);
    try {
      const res = await bash(scrub, [creds, join(tmp, "dx/repos")]);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("token for github.com found in");
      expect(res.stderr).not.toContain(TOKEN);
    } finally {
      await git(["-C", repo, "config", "--unset", "remote.origin.pushurl"]);
    }
  });
});
