import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerEvent } from "../src/types.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shq, SnapshotUnavailableError, type OpenSandbox } from "../src/sandbox/interface.ts";
import { localSandboxes, type LocalConfig } from "../src/sandbox/local.ts";
import { FAKE_RUNNER, makeRepo, runnerInput, runnerReport } from "./helpers.ts";

let root: string;
let cfg: LocalConfig;
let open: OpenSandbox;
let commits: Record<string, string>;

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
  it("builds the manifest from the checkouts and gives each sandbox its own scratch dir", async () => {
    const a = await open("ignored");
    const b = await open("ignored");
    expect(a.id).not.toBe(b.id);
    expect(a.manifest.repos).toEqual([
      { repository: "acme/widget", branch: "main", commit: commits["acme/widget"], path: join(root, "repos/acme/widget") },
      { repository: "acme/gadget", branch: "main", commit: commits["acme/gadget"], path: join(root, "repos/acme/gadget") },
    ]);
    expect(a.reposRoot).toBe(cfg.reposRoot);
    for (const sbx of [a, b]) expect(existsSync(sbx.scratchDir)).toBe(true);
  });

  it("treats a missing or dirty checkout as an unavailable snapshot", async () => {
    const missing = localSandboxes({ ...cfg, profile: { name: "test", repos: [{ repository: "acme/nope" }] } });
    await expect(missing("ignored")).rejects.toBeInstanceOf(SnapshotUnavailableError);

    const stray = join(root, "repos/acme/gadget/stray.txt");
    await writeFile(stray, "x");
    try {
      await expect(open("ignored")).rejects.toThrow(/acme\/gadget.*dirty/);
    } finally {
      await rm(stray);
    }
  });

  it("returns events and delivers the key only through a file the runner deletes", async () => {
    const sbx = await open("ignored");
    const key = "sk-ant-local-test-key";
    process.env.RESEARCHER_TEST_ECHO_KEY = key;
    let events: RunnerEvent[];
    try {
      const res = await sbx.run({ input: runnerInput(sbx), modelApiKey: key, timeoutMs: 10_000 });
      expect(res).toMatchObject({ exitCode: 0, aborted: false, invalidLines: 1 });
      expect(res.stderrTail).toContain("fake runner diagnostics");
      events = res.events;
    } finally {
      delete process.env.RESEARCHER_TEST_ECHO_KEY;
    }
    expect(events.map((e) => e.type)).toEqual(["started", "assistant_text", "result"]);
    const report = runnerReport(events);
    expect(report).toMatchObject({ key, keyFileGone: true, keyInEnv: false, cwd: expect.stringContaining(sbx.scratchDir) });
    expect(existsSync(report.keyPath!)).toBe(false);
  });

  it("removes the key file even when the runner leaves it behind", async () => {
    const sbx = await open("ignored");
    const { events } = await sbx.run({ input: runnerInput(sbx, "keep-key"), modelApiKey: "sk-ant-kept", timeoutMs: 10_000 });
    const report = runnerReport(events);
    expect(report.keyFileGone).toBe(false);
    expect(existsSync(report.keyPath!)).toBe(false);
  });

  it("kills the runner at the deadline and on abort", async () => {
    const sbx = await open("ignored");
    const input = runnerInput(sbx, "hang");
    const timedOut = await sbx.run({ input, timeoutMs: 500 });
    expect(timedOut).toMatchObject({ exitCode: 124, aborted: false });
    expect(timedOut.events.map((e) => e.type)).toContain("started");

    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 500);
    const aborted = await sbx.run({ input, timeoutMs: 60_000, signal: ac.signal });
    expect(aborted).toEqual(expect.objectContaining({ exitCode: null, aborted: true }));
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("bundles the real runner on first use when no runner command is configured", { timeout: 60_000 }, async () => {
    const bundled = localSandboxes({ ...cfg, runnerCmd: undefined, runnerArgs: "--faux" });
    const sbx = await bundled("ignored");
    const input = { ...runnerInput(sbx, "claude-sonnet-4-5"), manifest: sbx.manifest };
    const res = await sbx.run({ input, timeoutMs: 30_000 });
    expect(res.exitCode, res.stderrTail).toBe(0);
    expect(res.events.at(-1)).toMatchObject({ type: "result", result: { status: "final_answer" } });
  });

  it("close removes the sandbox dir and is idempotent", async () => {
    const sbx = await open("ignored");
    await sbx.close();
    expect(existsSync(sbx.scratchDir)).toBe(false);
    await expect(sbx.close()).resolves.toBeUndefined();
  });
});
