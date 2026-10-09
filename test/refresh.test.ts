import type { RepoManifest, RepoProfile } from "../src/types.ts";
import { beforeEach, describe, expect, it } from "vitest";
import type { BuildSnapshotOptions, BuiltSnapshot, InvestigationSandbox, SandboxProvider } from "../src/sandbox.ts";
import { refreshSnapshot } from "../src/refresh.ts";

const profile: RepoProfile = { name: "default", repos: [{ repository: "acme/widget" }] };
const layout = { reposRoot: "/repos", scratchDir: "/scratch", appDir: "/app" };
const heads = (commit: string): RepoManifest["repos"] => [
  { repository: "acme/widget", branch: "main", commit, path: "acme/widget" },
];

class FakeProvider implements SandboxProvider {
  readonly name = "local";
  currentHeads = heads("a".repeat(40));
  builds = 0;
  terminated: string[] = [];
  pruned: { name: string; keep: number }[] = [];
  shouldFailBuild = false;

  async resolveHeads() {
    return this.currentHeads;
  }

  async buildSnapshot(opts: BuildSnapshotOptions): Promise<BuiltSnapshot> {
    if (this.shouldFailBuild) throw new Error("build failed");
    const id = `snp-${++this.builds}`;
    return {
      id,
      manifest: { profile: opts.profile.name, created_at: new Date().toISOString(), repos: opts.heads },
      layout,
    };
  }

  async pruneSnapshots(snapshotName: string, keep: number): Promise<void> {
    this.pruned.push({ name: snapshotName, keep });
  }

  async createInvestigationSandbox(): Promise<InvestigationSandbox> {
    throw new Error("not used");
  }

  async runInvestigation(): Promise<never> {
    throw new Error("not used");
  }

  async terminate(id: string): Promise<void> {
    this.terminated.push(id);
  }
}

let provider: FakeProvider;
const SNAPSHOT_NAME = "support-triage-bot-corpus";

beforeEach(() => {
  provider = new FakeProvider();
});

describe("refreshSnapshot", () => {
  it("resolves heads, builds a snapshot, and prunes keeping 2", async () => {
    const result = await refreshSnapshot({ provider, profile, snapshotName: SNAPSHOT_NAME, log: () => {} });
    expect(result).toMatchObject({
      event: "snapshot_refresh",
      ok: true,
      snapshot_id: "snp-1",
      snapshot_name: SNAPSHOT_NAME,
      repos: 1,
    });
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(provider.builds).toBe(1);
    expect(provider.pruned).toEqual([{ name: SNAPSHOT_NAME, keep: 2 }]);
  });

  it("builds unconditionally every time (no change detection)", async () => {
    await refreshSnapshot({ provider, profile, snapshotName: SNAPSHOT_NAME, log: () => {} });
    const second = await refreshSnapshot({ provider, profile, snapshotName: SNAPSHOT_NAME, log: () => {} });
    expect(second).toMatchObject({ ok: true, snapshot_id: "snp-2" });
    expect(provider.builds).toBe(2);
  });

  it("returns ok: false on build failure without throwing", async () => {
    provider.shouldFailBuild = true;
    const result = await refreshSnapshot({ provider, profile, snapshotName: SNAPSHOT_NAME, log: () => {} });
    expect(result).toMatchObject({
      ok: false,
      snapshot_id: null,
      error: "build failed",
    });
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("emits exactly one JSON log line", async () => {
    const lines: string[] = [];
    await refreshSnapshot({ provider, profile, snapshotName: SNAPSHOT_NAME, log: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.event).toBe("snapshot_refresh");
    expect(parsed.ok).toBe(true);
    expect(parsed.snapshot_name).toBe(SNAPSHOT_NAME);
    expect(parsed.repos).toBe(1);
  });

  it("passes the snapshotName through to the provider", async () => {
    const received: string[] = [];
    const orig = provider.buildSnapshot.bind(provider);
    provider.buildSnapshot = async (opts) => {
      received.push(opts.snapshotName);
      return orig(opts);
    };
    await refreshSnapshot({ provider, profile, snapshotName: "custom-name-123", log: () => {} });
    expect(received).toEqual(["custom-name-123"]);
  });
});
