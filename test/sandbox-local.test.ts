import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shq, SnapshotUnavailableError, type OpenSandbox } from "../src/sandbox/interface.ts";
import { localSandboxes, type LocalConfig } from "../src/sandbox/local.ts";
import { FAKE_RUNNER, makeRepo, runnerInput, runnerReport } from "./helpers.ts";

let root: string;
let cfg: LocalConfig;
let open: OpenSandbox;
let commits: Record<string, string>;
const OPEN = { timeoutMs: 60_000 };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "researcher-local-sandbox-"));
  commits = {
    "acme/widget": (await makeRepo(join(root, "repos"), "acme/widget")).commit,
    "acme/gadget": (await makeRepo(join(root, "repos"), "acme/gadget")).commit,
  };
  cfg = {
    profile: { name: "test", repos: [{ repository: "acme/widget" }, { repository: "acme/gadget" }] },
    reposRoot: join(root, "repos"),
    sandboxesRoot: join(root, "sandboxes"),
    runnerCmd: `${shq(process.execPath)} ${shq(FAKE_RUNNER)}`,
  };
  open = localSandboxes(cfg);
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("localSandboxes", () => {
  it("runs the runner against the clean checkouts, from each sandbox's own scratch dir", async () => {
    const a = await open("ignored", OPEN);
    const b = await open("ignored", OPEN);
    expect(a.scratchDir).not.toBe(b.scratchDir);
    expect(a.manifest.repos).toEqual([
      { repository: "acme/widget", branch: "main", commit: commits["acme/widget"], path: join(root, "repos/acme/widget") },
      { repository: "acme/gadget", branch: "main", commit: commits["acme/gadget"], path: join(root, "repos/acme/gadget") },
    ]);

    const res = await a.run({ input: runnerInput(a), timeoutMs: 10_000 });

    expect(res).toMatchObject({ exitCode: 0, aborted: false, streamLost: false });
    expect(res.events.map((e) => e.type)).toEqual(["started", "assistant_text", "result"]);
    expect(runnerReport(res.events).cwd).toContain(a.scratchDir);
    await a.close();
    expect(existsSync(a.scratchDir)).toBe(false);
  });

  it("treats a missing or dirty checkout as an unavailable snapshot", async () => {
    const missing = localSandboxes({ ...cfg, profile: { name: "test", repos: [{ repository: "acme/nope" }] } });
    await expect(missing("ignored", OPEN)).rejects.toBeInstanceOf(SnapshotUnavailableError);

    const stray = join(root, "repos/acme/gadget/stray.txt");
    await writeFile(stray, "x");
    try {
      await expect(open("ignored", OPEN)).rejects.toBeInstanceOf(SnapshotUnavailableError);
    } finally {
      await rm(stray);
    }
  });

  it("kills the runner at the deadline and on abort", async () => {
    const sbx = await open("ignored", OPEN);
    const input = runnerInput(sbx, "hang");
    const timedOut = await sbx.run({ input, timeoutMs: 500 });
    expect(timedOut).toMatchObject({ exitCode: 124, aborted: false });
    expect(timedOut.events.map((e) => e.type)).toContain("started");

    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 500);
    const aborted = await sbx.run({ input, timeoutMs: 60_000, signal: ac.signal });
    expect(aborted).toMatchObject({ exitCode: null, aborted: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps orchestration secrets and the model key out of the runner's environment, and removes the key file", async () => {
    const key = "sk-ant-local-test-key";
    const secrets = { RENDER_API_KEY: "rnd_secret", GITHUB_TOKEN: "ghp_secret", DATABASE_URL: "postgres://secret", SLACK_BOT_TOKEN: "xoxb-secret" };
    const injected = { ...secrets, RESEARCHER_TEST_ECHO_KEY: key };
    Object.assign(process.env, injected);
    const sbx = await open("ignored", OPEN);
    let report: ReturnType<typeof runnerReport>;
    try {
      const { events } = await sbx.run({ input: runnerInput(sbx, "keep-key"), modelApiKey: key, timeoutMs: 10_000 });
      report = runnerReport(events);
    } finally {
      for (const name of Object.keys(injected)) delete process.env[name];
    }

    expect(report.key).toBe(key);
    expect(report.keyInEnv).toBe(false);
    expect(report.envKeys.filter((name) => name in secrets)).toEqual([]);
    expect(existsSync(report.keyPath!)).toBe(false);
  });

  it("bundles the real runner on first use when no runner command is configured", { timeout: 60_000 }, async () => {
    const bundled = localSandboxes({ ...cfg, runnerCmd: undefined, runnerArgs: "--faux" });
    const sbx = await bundled("ignored", OPEN);
    const res = await sbx.run({ input: { ...runnerInput(sbx, "claude-sonnet-4-5"), manifest: sbx.manifest }, timeoutMs: 30_000 });
    expect(res.exitCode, res.stderrTail).toBe(0);
    expect(res.events.at(-1)).toMatchObject({ type: "result", result: { status: "final_answer" } });
  });
});
