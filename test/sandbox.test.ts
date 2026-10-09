import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { manifestDigest } from "../src/types.ts";
import type { RepoManifest, RunnerEvent } from "../src/types.ts";
import { AbortError, ClientError, RenderError, SandboxSnapshotNotFoundError } from "@renderinc/sdk";
import type { SandboxExecEvent } from "@renderinc/sdk/experimental";
import { list as listTar } from "tar";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createProvider, SnapshotUnavailableError, parseLsRemote, RenderProvider, resolveWorkspaceId } from "../src/sandbox.ts";
import type { NetworkPolicy, RenderProviderConfig, InvestigationSandbox, SandboxApi } from "../src/sandbox.ts";
import { runnerInput } from "./helpers.ts";

const GH_TOKEN = "ghp_renderProviderSecret000000000000";
const MODEL_KEY = "sk-ant-api03-renderProviderSecret";
const LAYOUT = { reposRoot: "/opt/triage/repos", scratchDir: "/opt/triage/scratch", appDir: "/opt/triage/app" };
const SHA = "1".repeat(40);
const NAME = "support-triage-bot-corpus";
const profile = { name: "default", repos: [{ repository: "render-oss/cli" }, { repository: "acme/api", branch: "main" }] };
const heads: RepoManifest["repos"] = [
  { repository: "render-oss/cli", branch: "main", commit: SHA, path: "render-oss/cli" },
  { repository: "acme/api", branch: "main", commit: "2".repeat(40), path: "acme/api" },
];

type Call =
  | { op: "create"; id: string; input: Parameters<SandboxApi["create"]>[0] }
  | { op: "exec"; id: string; command: string }
  | { op: "upload"; id: string; path: string; data: unknown; contentType?: string }
  | { op: "download" | "terminate"; id: string; path?: string }
  | { op: "snapshot.create" | "snapshot.get" | "snapshot.list" | "snapshot.delete"; id?: string; input?: unknown };

type ExecHandler = (id: string, command: string, signal?: AbortSignal) => SandboxExecEvent[] | AsyncGenerator<SandboxExecEvent>;

const out = (data: string, stream: "stdout" | "stderr" = "stdout"): SandboxExecEvent => ({ type: "output", stream, data });
const exit = (code = 0): SandboxExecEvent => ({ type: "exit", exit_code: code });
const info = () =>
  JSON.stringify({
    layout: LAYOUT,
    runAs: "investigator",
    uid: 0,
    drop: "setpriv",
    node: "v24.14.1",
    runnerNonDumpable: true,
    dnsResolves: true,
    selfTest: { ok: true, pi_version: "0.83.0", prompt_version: "v3" },
  });

/** In-memory stand-in for the SDK's SandboxesClient that records every call. */
class FakeApi {
  calls: Call[] = [];
  createError?: (input: Parameters<SandboxApi["create"]>[0]) => Error | undefined;
  exec_: ExecHandler = () => [exit(0)];
  manifest = (): RepoManifest => ({
    profile: "default",
    created_at: new Date().toISOString(),
    repos: heads.map((h) => ({ ...h, path: `/opt/triage/repos/${h.repository}` })),
  });
  #n = 0;

  api(): SandboxApi {
    const self = this;
    return {
      async create(input = {}) {
        const err = self.createError?.(input);
        if (err) throw err;
        const id = `sbx-${++self.#n}`;
        self.calls.push({ op: "create", id, input });
        return {
          id,
          status: "creating",
          plan: "starter",
          networkPolicy: input.networkPolicy ?? { default: "allow-all" },
          region: "oregon",
          timeoutSeconds: input.timeoutSeconds ?? 7200,
          createdAt: new Date().toISOString(),
        };
      },
      async get(id) {
        return { id, status: "running", plan: "starter", networkPolicy: { default: "allow-all" }, region: "oregon", timeoutSeconds: 1, createdAt: "" };
      },
      async exec(id, command, _ownerId, signal) {
        self.calls.push({ op: "exec", id, command });
        if (signal?.aborted) throw new AbortError();
        const events = self.exec_(id, command, signal);
        return Array.isArray(events) ? (async function* () { yield* events; })() : events;
      },
      async upload(id, path, data, _ownerId, opts) {
        self.calls.push({ op: "upload", id, path, data, contentType: opts?.contentType });
      },
      async download(id, path) {
        self.calls.push({ op: "download", id, path });
        const data = Buffer.from(JSON.stringify(self.manifest()));
        return { data, size: data.length };
      },
      async terminate(id) {
        self.calls.push({ op: "terminate", id });
      },
      snapshots: {
        async create(input) {
          self.calls.push({ op: "snapshot.create", input });
          return snapshot("snp-new", "creating", input.name);
        },
        async get(input) {
          self.calls.push({ op: "snapshot.get", input });
          return snapshot(input.snapshotId, "available", NAME);
        },
        async list(input) {
          self.calls.push({ op: "snapshot.list", input });
          return [
            { snapshot: snapshot("snp-new", "available", NAME), cursor: "a" },
            { snapshot: snapshot("snp-old", "available", NAME), cursor: "b" },
            { snapshot: snapshot("snp-other", "available", "someone-else"), cursor: "c" },
          ];
        },
        async delete(input) {
          self.calls.push({ op: "snapshot.delete", input });
        },
      },
    } as SandboxApi;
  }

  commands(): string[] {
    return this.calls.flatMap((c) => (c.op === "exec" ? [c.command] : []));
  }

  inputs(op: Call["op"]): unknown[] {
    return this.calls.flatMap((c) => (c.op === op && "input" in c ? [c.input] : []));
  }
}

function snapshot(id: string, status: "creating" | "available" | "failed", name?: string) {
  return {
    id,
    sandboxGroupId: "sbg-1",
    sourceSandboxId: "sbx-1",
    name: name ?? null,
    kind: "filesystem" as const,
    status,
    plan: "starter" as const,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

let tmp: string;
let fake: FakeApi;
const SANDBOX_DIR = fileURLToPath(new URL("../sandbox/", import.meta.url));

function provider(policy: NetworkPolicy = { default: "allow-list", allowedDomains: ["api.anthropic.com"] }, api = fake.api()) {
  const cfg: RenderProviderConfig = {
    apiKey: "rnd_test",
    workspaceId: "tea-test",
    hostCredentials: { "github.com": { username: "x-access-token", token: GH_TOKEN } },
    networkPolicy: policy,
    investigationTimeoutSeconds: 1_800,
    builderTimeoutSeconds: 3_600,
    minRequestIntervalMs: 0,
    sandboxDir: SANDBOX_DIR,
    runnerDistDir: join(tmp, "dist"),
  };
  return new RenderProvider(api, cfg, { pollMs: 1, bootTimeoutMs: 1_000, investigationGraceMs: 30_000 });
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "triage-render-provider-"));
  await mkdir(join(tmp, "dist/node_modules/left-pad"), { recursive: true });
  await writeFile(join(tmp, "dist/runner.mjs"), "// runner\n");
  await writeFile(join(tmp, "dist/package.json"), "{}\n");
  await writeFile(join(tmp, "dist/package-lock.json"), "{}\n");
  await writeFile(join(tmp, "dist/node_modules/left-pad/index.js"), "// must not be uploaded\n");
});

afterAll(() => rm(tmp, { recursive: true, force: true }));

beforeEach(() => {
  fake = new FakeApi();
});

function investigation(overrides: Partial<InvestigationSandbox> = {}): InvestigationSandbox {
  return {
    id: "sbx-run",
    manifest: fake.manifest(),
    layout: LAYOUT,
    info: {},
    ...overrides,
  };
}

const event = (e: object) => `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`;

describe("RenderProvider.runInvestigation", () => {
  it("parses JSONL split across chunks and counts invalid lines", async () => {
    const started = event({ type: "started", pi_version: "0.83.0", model: "m", prompt_version: "v3" });
    const result = event({ type: "result", result: { status: "needs_clarification", question: "Which region?", why_needed: "x" } });
    fake.exec_ = (_id, command) =>
      command.includes("run-investigation.sh")
        ? [
            out(started.slice(0, 10)),
            out(started.slice(10) + "not json\n" + '{"type":"nope"}\n' + result.slice(0, 5)),
            out("runner diagnostics", "stderr"),
            out(result.slice(5).trimEnd()),
            exit(0),
          ]
        : [exit(0)];
    const events: RunnerEvent[] = [];
    const res = await provider().runInvestigation(investigation(), {
      input: runnerInput(LAYOUT),
      timeoutMs: 60_000,
      onEvent: (e) => void events.push(e),
    });
    expect(res).toEqual({ exitCode: 0, aborted: false, streamLost: false, invalidLines: 2, stderrTail: "runner diagnostics" });
    expect(events.map((e) => e.type)).toEqual(["started", "result"]);
  });

  it("uploads the model key as a file and never puts it in a command", async () => {
    await provider().runInvestigation(investigation(), {
      input: runnerInput(LAYOUT),
      modelApiKey: MODEL_KEY,
      timeoutMs: 90_000,
      onEvent: () => {},
    });
    const commands = fake.commands();
    expect(commands.some((c) => c.includes(MODEL_KEY))).toBe(false);
    const runDir = /^mkdir -p -m 700 (\/tmp\/run-[0-9a-f-]{36})$/.exec(commands[0]!)?.[1];
    expect(runDir).toBeDefined();
    expect(commands[1]).toBe(`bash /opt/triage/app/run-investigation.sh ${runDir} 90`);
    const uploads = fake.calls.filter((c) => c.op === "upload");
    expect(uploads.map((u) => u.path)).toEqual([`${runDir}/input.json`, `${runDir}/key`]);
    expect(uploads[1]!.data).toBe(MODEL_KEY);
    expect(JSON.parse(uploads[0]!.data as string)).toMatchObject({ repos_root: LAYOUT.reposRoot });
  });

  it("distinguishes a caller abort from a lost stream", async () => {
    const ac = new AbortController();
    fake.exec_ = (_id, command, signal) =>
      command.includes("run-investigation.sh")
        ? (async function* () {
            yield out(event({ type: "started", pi_version: "0", model: "m", prompt_version: "v" }));
            if (!signal!.aborted) await new Promise((resolve) => signal!.addEventListener("abort", resolve));
            throw new AbortError();
          })()
        : [exit(0)];
    const aborted = await provider().runInvestigation(investigation(), {
      input: runnerInput(LAYOUT),
      timeoutMs: 60_000,
      signal: ac.signal,
      onEvent: () => ac.abort(),
    });
    expect(aborted).toMatchObject({ exitCode: null, aborted: true, streamLost: false });

    fake.exec_ = (_id, command) =>
      command.includes("run-investigation.sh")
        ? (async function* () {
            yield out('{"type":"sta');
            throw new RenderError("Sandbox exec stream ended without a terminal event.");
          })()
        : [exit(0)];
    const lost = await provider().runInvestigation(investigation(), { input: runnerInput(LAYOUT), timeoutMs: 60_000, onEvent: () => {} });
    expect(lost).toEqual({ exitCode: null, aborted: false, streamLost: true, invalidLines: 1, stderrTail: "" });
  });
});

const prepareExec: ExecHandler = (_id, command) => {
  if (command.includes("prepare.sh checkout") || command.includes("verify.sh")) {
    const line = `${info()}\n`;
    return [out("progress noise\n", "stderr"), out(line.slice(0, 20)), out(line.slice(20)), exit(0)];
  }
  return [out("progress noise\n", "stderr"), exit(0)];
};

describe("RenderProvider.buildSnapshot", () => {
  it("builds a snapshot in an allow-all builder and names it", async () => {
    fake.exec_ = prepareExec;
    const p = provider();
    const built = await p.buildSnapshot({ profile, heads, snapshotName: NAME });

    const ops = fake.calls.map((c) => (c.op === "exec" ? `exec:${c.command.split(" ").slice(0, 3).join(" ")}` : c.op));
    expect(ops).toEqual([
      "create",
      "exec:mkdir -p -m",
      "upload",
      "upload",
      "exec:bash /tmp/triage-stage/prepare.sh install",
      "upload",
      "exec:bash /tmp/triage-stage/prepare.sh checkout",
      "download",
      "snapshot.create",
      "snapshot.get",
      "terminate",
    ]);
    const tokenUpload = fake.calls.findIndex((c) => c.op === "upload" && c.path.includes("/creds/"));
    const execAt = (phase: string) => fake.calls.findIndex((c) => c.op === "exec" && c.command.includes(`prepare.sh ${phase} `));
    expect(execAt("install")).toBeLessThan(tokenUpload);
    expect(tokenUpload).toBeLessThan(execAt("checkout"));

    const creates = fake.calls.filter((c) => c.op === "create");
    expect(creates[0]!.input).toEqual({ timeoutSeconds: 3_600, networkPolicy: { default: "allow-all" } });
    expect(fake.calls.find((c) => c.op === "terminate")!.id).toBe(creates[0]!.id);
    expect(fake.inputs("snapshot.create")).toEqual([{ sandboxId: creates[0]!.id, kind: "filesystem", name: NAME }]);

    const commands = fake.commands();
    expect(commands.some((c) => c.includes(GH_TOKEN))).toBe(false);
    expect(commands[1]).toBe("bash /tmp/triage-stage/prepare.sh install /tmp/triage-stage");
    expect(commands[2]).toMatch(/^bash \/tmp\/triage-stage\/prepare.sh checkout \/tmp\/triage-stage 'default' \d{4}-\d\d-\d\dT/);

    const uploads = fake.calls.filter((c) => c.op === "upload");
    expect(uploads.map((u) => [u.path, u.contentType])).toEqual([
      ["/tmp/triage-stage", "application/x-tar"],
      ["/tmp/triage-stage/heads.tsv", undefined],
      ["/tmp/triage-stage/creds/github.com", undefined],
    ]);
    expect(uploads[2]!.data).toBe(`x-access-token\n${GH_TOKEN}`);
    expect(uploads[1]!.data).toBe(`render-oss/cli\tmain\t${SHA}\t\t\nacme/api\tmain\t${"2".repeat(40)}\t\t\n`);
    const files = new Map<string, string>();
    await pipeline(
      Readable.from(uploads[0]!.data as Buffer),
      listTar({
        onReadEntry: (e) => {
          const chunks: Buffer[] = [];
          e.on("data", (c: Buffer) => chunks.push(c));
          e.on("end", () => files.set(e.path, Buffer.concat(chunks).toString("utf8")));
        },
      }),
    );
    expect([...files.keys()]).toEqual(
      expect.arrayContaining([
        "runner/runner.mjs",
        "runner/package.json",
        "runner/package-lock.json",
        "run-investigation.sh",
        "as-runner.sh",
        "prepare.sh",
      ]),
    );
    expect([...files.keys()].some((e) => e.includes("node_modules"))).toBe(false);
    const install = /install_phase\(\) \{[\s\S]*?\n\}/.exec(files.get("prepare.sh")!)?.[0] ?? "";
    expect(install).toContain("npm ci --omit=dev --ignore-scripts");
    expect(install).not.toMatch(/npm (install|i) /);

    const digest = manifestDigest({ profile: "default", created_at: "", repos: heads });
    expect(built.layout).toEqual(LAYOUT);
    expect(manifestDigest(built.manifest)).toBe(digest);
  });

  it("never uploads the token when the install phase fails", async () => {
    fake.exec_ = (id, command) =>
      command.includes("prepare.sh install") ? [out("prepare: runner self-test failed\n", "stderr"), exit(1)] : prepareExec(id, command);
    await expect(provider().buildSnapshot({ profile, heads, snapshotName: NAME })).rejects.toThrow("prepare.sh install exited 1: prepare: runner self-test failed");
    expect(fake.calls.some((c) => c.op === "upload" && c.path.includes("/creds/"))).toBe(false);
    expect(fake.commands().some((c) => c.includes("prepare.sh checkout"))).toBe(false);
    expect(fake.calls.filter((c) => c.op === "terminate").map((c) => c.id)).toEqual(["sbx-1"]);
  });

  it("rejects an invalid snapshotName", async () => {
    fake.exec_ = prepareExec;
    await expect(provider().buildSnapshot({ profile, heads, snapshotName: "bad name!" })).rejects.toThrow("not [A-Za-z0-9_.-]+");
  });
});

describe("RenderProvider.pruneSnapshots", () => {
  it("keeps the newest two and deletes the rest with the same name", async () => {
    fake.exec_ = prepareExec;
    const p = provider();
    await p.buildSnapshot({ profile, heads, snapshotName: NAME });
    await p.pruneSnapshots(NAME, 2);

    const list = fake.calls.find((c) => c.op === "snapshot.list");
    expect(list).toBeDefined();
    const deletes = fake.calls.filter((c) => c.op === "snapshot.delete");
    expect(deletes).toHaveLength(0);
  });

  it("deletes this name's snapshots beyond the newest two, following the list cursor past the first page", async () => {
    fake.exec_ = prepareExec;
    const api = fake.api();
    const p = provider(undefined, api);
    await p.buildSnapshot({ profile, heads, snapshotName: NAME });
    const at = (ageMs: number) => new Date(Date.now() - ageMs).toISOString();
    const others = Array.from({ length: 100 }, (_, i) => ({ snapshot: snapshot(`snp-other-${i}`, "available", "someone-else"), cursor: `o${i}` }));
    api.snapshots.list = async (input) => {
      fake.calls.push({ op: "snapshot.list", input });
      if (!input.cursor) return others;
      return [
        { snapshot: { ...snapshot("snp-3", "available", NAME), requestedAt: at(1000) }, cursor: "a" },
        { snapshot: { ...snapshot("snp-1", "available", NAME), requestedAt: at(3000) }, cursor: "b" },
        { snapshot: { ...snapshot("snp-2", "available", NAME), requestedAt: at(2000) }, cursor: "c" },
      ];
    };
    await p.pruneSnapshots(NAME, 2);

    expect(fake.inputs("snapshot.list").map((i) => (i as { cursor?: string }).cursor)).toEqual([undefined, "o99"]);
    expect(fake.inputs("snapshot.delete")).toEqual([{ sandboxGroupId: "sbg-1", snapshotId: "snp-1" }]);
  });

  it("ignores snapshots with a different name", async () => {
    fake.exec_ = prepareExec;
    const p = provider();
    await p.buildSnapshot({ profile, heads, snapshotName: NAME });
    await p.pruneSnapshots(NAME, 2);
    const deletes = fake.calls.filter((c) => c.op === "snapshot.delete");
    expect(deletes).toHaveLength(0);
  });
});

describe("RenderProvider.createInvestigationSandbox", () => {
  it("creates a sandbox by snapshot name with the configured policy and timeout", async () => {
    fake.exec_ = prepareExec;
    const p = provider();
    await p.buildSnapshot({ profile, heads, snapshotName: NAME });
    fake.calls = [];

    const sbx = await p.createInvestigationSandbox({ snapshotName: NAME });
    expect(sbx.layout).toEqual(LAYOUT);
    expect(sbx.manifest).toBeDefined();
    expect(sbx.info).toMatchObject({
      runAs: "investigator",
      runnerNonDumpable: true,
      dnsResolves: true,
      piVersion: "0.83.0",
      promptVersion: "v3",
    });

    const creates = fake.calls.filter((c) => c.op === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toEqual({
      snapshotName: NAME,
      timeoutSeconds: 1_800,
      networkPolicy: { default: "allow-list", allowedDomains: ["api.anthropic.com"] },
    });

    const commands = fake.commands();
    expect(commands.filter((c) => c.includes("verify.sh"))).toEqual([
      "bash /opt/triage/app/verify.sh --deny-probe https://example.com --allow-probe 'https://api.anthropic.com'",
    ]);
  });

  it("throws SnapshotUnavailableError when no snapshot with that name is available", async () => {
    fake.createError = (input) =>
      input?.snapshotName ? new SandboxSnapshotNotFoundError("snapshot not found", 404) : undefined;
    await expect(provider().createInvestigationSandbox({ snapshotName: "no-such-snap" })).rejects.toBeInstanceOf(
      SnapshotUnavailableError,
    );
  });

  it("terminates the sandbox when verify fails", async () => {
    fake.exec_ = (_id, command) =>
      command.includes("verify.sh")
        ? [out("verify: egress to https://example.com is allowed\n", "stderr"), exit(1)]
        : prepareExec(_id, command);
    const p = provider({ default: "deny-all" });
    await p.buildSnapshot({ profile, heads, snapshotName: NAME });
    fake.calls = [];

    await expect(p.createInvestigationSandbox({ snapshotName: NAME })).rejects.toThrow("verify.sh exited 1");
    expect(fake.calls.filter((c) => c.op === "terminate")).toHaveLength(1);
  });

  it("refuses to create when the policy is allow-list with no domains", async () => {
    await expect(
      provider({ default: "allow-list", allowedDomains: [] }).createInvestigationSandbox({ snapshotName: NAME }),
    ).rejects.toThrow("allow-list policy and no domains");
  });

  it("fails loudly when Render rejects the allow-list policy", async () => {
    fake.exec_ = prepareExec;
    fake.createError = (input) =>
      input?.snapshotName ? new ClientError("Failed to create sandbox: invalid networkPolicy", 400) : undefined;
    const p = provider();
    await p.buildSnapshot({ profile, heads, snapshotName: NAME });
    fake.calls = [];

    await expect(p.createInvestigationSandbox({ snapshotName: NAME })).rejects.toThrow(/SANDBOX_NETWORK_POLICY=allow-all/);
  });
});

describe("parseLsRemote", () => {
  it("reads the default branch from --symref output", () => {
    expect(parseLsRemote(`ref: refs/heads/main\tHEAD\n${SHA}\tHEAD\n`)).toEqual({ branch: "main", commit: SHA });
  });

  it("reads an explicit branch", () => {
    expect(parseLsRemote(`${SHA}\trefs/heads/release\n`, "release")).toEqual({ branch: "release", commit: SHA });
    expect(parseLsRemote("", "release")).toBeNull();
  });
});

function fakeFetch(owners: { id: string; name: string; type: string }[]): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!url.includes("/v1/owners")) throw new Error(`unexpected fetch: ${url}`);
    return new Response(
      JSON.stringify(owners.map((owner, i) => ({ owner, cursor: `c${i}` }))),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

describe("resolveWorkspaceId", () => {
  it("returns the id when exactly one workspace exists", async () => {
    const id = await resolveWorkspaceId("rnd_key", fakeFetch([{ id: "tea-abc123", name: "My Team", type: "team" }]));
    expect(id).toBe("tea-abc123");
  });

  it("fails with a list when multiple workspaces exist", async () => {
    await expect(
      resolveWorkspaceId("rnd_key", fakeFetch([
        { id: "tea-personal", name: "Personal", type: "user" },
        { id: "tea-team1", name: "Acme Corp", type: "team" },
      ])),
    ).rejects.toThrow(/RENDER_WORKSPACE_ID is required.*tea-personal.*tea-team1/s);
  });

  it("fails clearly when no workspaces exist", async () => {
    await expect(
      resolveWorkspaceId("rnd_key", fakeFetch([])),
    ).rejects.toThrow("RENDER_API_KEY has no workspaces");
  });
});

describe("createProvider", () => {
  it("defaults to the Render provider on Render and to the local provider elsewhere", async () => {
    await expect(createProvider({ RENDER: "true" })).rejects.toThrow("RENDER_API_KEY is required");
    expect((await createProvider({})).name).toBe("local");
  });
});
