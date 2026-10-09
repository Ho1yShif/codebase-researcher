import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoManifest, RunnerEvent } from "../src/types.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shq, SnapshotUnavailableError } from "../src/sandbox.ts";
import { LocalProvider } from "../src/sandbox-local.ts";
import { FAKE_RUNNER, makeRepo, runnerInput, runnerReport } from "./helpers.ts";

let root: string;
let provider: LocalProvider;
let heads: RepoManifest["repos"];
const profile = { name: "test", repos: [{ repository: "acme/widget" }, { repository: "acme/gadget" }] };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "triage-local-provider-"));
  await makeRepo(join(root, "repos"), "acme/widget");
  await makeRepo(join(root, "repos"), "acme/gadget");
  provider = new LocalProvider({
    reposRoot: join(root, "repos"),
    sandboxesRoot: join(root, "sandboxes"),
    appDir: join(root, "app"),
    runnerCmd: `${shq(process.execPath)} ${shq(FAKE_RUNNER)}`,
  });
  heads = await provider.resolveHeads(profile);
});

afterAll(() => rm(root, { recursive: true, force: true }));

async function createOne() {
  await provider.buildSnapshot({ profile, heads, snapshotName: "support-triage-bot-test-local" });
  return provider.createInvestigationSandbox({ snapshotName: "support-triage-bot-test-local" });
}

describe("LocalProvider", () => {
  it("resolves heads from local checkouts without network", () => {
    expect(heads.map((h) => [h.repository, h.branch])).toEqual([
      ["acme/widget", "main"],
      ["acme/gadget", "main"],
    ]);
    expect(heads.every((h) => /^[0-9a-f]{40}$/.test(h.commit))).toBe(true);
  });

  it("builds a snapshot and creates an investigation sandbox whose manifest matches the heads", async () => {
    const built = await provider.buildSnapshot({ profile, heads, snapshotName: "support-triage-bot-test-local" });
    expect(built.id).toBe("support-triage-bot-test-local");

    const sbx = await provider.createInvestigationSandbox({ snapshotName: "support-triage-bot-test-local" });
    expect(sbx.manifest.repos).toEqual(heads.map((h) => ({ ...h, path: join(root, "repos", h.repository) })));
    expect(existsSync(sbx.layout.scratchDir)).toBe(true);
  });

  it("creates investigation sandboxes while the checkouts still match", async () => {
    await provider.buildSnapshot({ profile, heads, snapshotName: "support-triage-bot-test-local" });
    const a = await provider.createInvestigationSandbox({ snapshotName: "support-triage-bot-test-local" });
    const b = await provider.createInvestigationSandbox({ snapshotName: "support-triage-bot-test-local" });
    expect(a.id).not.toBe(b.id);
    for (const sbx of [a, b]) {
      expect(sbx.manifest.repos).toEqual(heads.map((h) => ({ ...h, path: join(root, "repos", h.repository) })));
      expect(existsSync(sbx.layout.scratchDir)).toBe(true);
    }
  });

  it("throws SnapshotUnavailableError when no snapshot exists", async () => {
    await expect(provider.createInvestigationSandbox({ snapshotName: "nonexistent" })).rejects.toBeInstanceOf(
      SnapshotUnavailableError,
    );
  });

  it("pruneSnapshots is a no-op", async () => {
    await expect(provider.pruneSnapshots("support-triage-bot-test-local", 2)).resolves.toBeUndefined();
  });

  it("streams events and delivers the key only through a file the runner deletes", async () => {
    const sbx = await createOne();
    const key = "sk-ant-local-test-key";
    process.env.TRIAGE_TEST_ECHO_KEY = key;
    const events: RunnerEvent[] = [];
    try {
      const res = await provider.runInvestigation(sbx, {
        input: runnerInput(sbx.layout),
        modelApiKey: key,
        timeoutMs: 10_000,
        onEvent: (e) => void events.push(e),
      });
      expect(res).toMatchObject({ exitCode: 0, aborted: false, invalidLines: 1 });
      expect(res.stderrTail).toContain("fake runner diagnostics");
    } finally {
      delete process.env.TRIAGE_TEST_ECHO_KEY;
    }
    expect(events.map((e) => e.type)).toEqual(["started", "assistant_text", "result"]);
    const report = runnerReport(events);
    expect(report).toMatchObject({ key, keyFileGone: true, keyInEnv: false, cwd: expect.stringContaining(sbx.layout.scratchDir) });
    expect(existsSync(report.keyPath!)).toBe(false);
  });

  it("removes the key file even when the runner leaves it behind", async () => {
    const sbx = await createOne();
    const events: RunnerEvent[] = [];
    await provider.runInvestigation(sbx, {
      input: runnerInput(sbx.layout, "keep-key"),
      modelApiKey: "sk-ant-kept",
      timeoutMs: 10_000,
      onEvent: (e) => void events.push(e),
    });
    const report = runnerReport(events);
    expect(report.keyFileGone).toBe(false);
    expect(existsSync(report.keyPath!)).toBe(false);
  });

  it("kills the runner at the deadline and on abort", async () => {
    const sbx = await createOne();
    const input = runnerInput(sbx.layout, "hang");
    const timedOut = await provider.runInvestigation(sbx, { input, timeoutMs: 500, onEvent: () => {} });
    expect(timedOut).toMatchObject({ exitCode: 124, aborted: false });

    const ac = new AbortController();
    const started = Date.now();
    const aborted = await provider.runInvestigation(sbx, {
      input,
      timeoutMs: 60_000,
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === "assistant_text") ac.abort();
      },
    });
    expect(aborted).toEqual(expect.objectContaining({ exitCode: null, aborted: true }));
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("propagates onEvent errors", async () => {
    const sbx = await createOne();
    await expect(
      provider.runInvestigation(sbx, {
        input: runnerInput(sbx.layout),
        timeoutMs: 10_000,
        onEvent: () => {
          throw new Error("trace write failed");
        },
      }),
    ).rejects.toThrow("trace write failed");
  });

  it("terminate removes the sandbox dir", async () => {
    const id = "local-00000000-0000-4000-8000-000000000000";
    await mkdir(join(root, "sandboxes", id, "scratch"), { recursive: true });
    await provider.terminate(id);
    expect(existsSync(join(root, "sandboxes", id))).toBe(false);
    await expect(provider.terminate("../etc")).rejects.toThrow("refusing");
  });
});
