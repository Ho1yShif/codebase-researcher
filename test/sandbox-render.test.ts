import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { manifestDigest } from "../src/types.ts";
import type { RepoManifest, RunnerEvent } from "../src/types.ts";
import { AbortError, ClientError, RenderError, SandboxSnapshotNotFoundError } from "@renderinc/sdk";
import type { SandboxExecEvent } from "@renderinc/sdk/experimental";
import { list as listTar } from "tar";
import { beforeEach, describe, expect, it } from "vitest";
import { configureSandboxes } from "../src/sandbox/index.ts";
import { SnapshotUnavailableError } from "../src/sandbox/interface.ts";
import { SandboxClient, type SandboxApi } from "../src/sandbox/render/client.ts";
import { resolveWorkspaceId, type NetworkPolicy, type RenderConfig } from "../src/sandbox/render/config.ts";
import { openRenderSandbox, runInvestigation } from "../src/sandbox/render/sandbox.ts";
import { buildSnapshot, parseLsRemote, pruneSnapshots } from "../src/sandbox/render/snapshot.ts";
import { runnerInput } from "./helpers.ts";
import config from "../config.ts";

const GH_TOKEN = "ghp_renderProviderSecret000000000000";
const MODEL_KEY = "sk-ant-api03-renderProviderSecret";
const LAYOUT = { reposRoot: "/opt/triage/repos", scratchDir: "/opt/triage/scratch" };
const SHA = "1".repeat(40);
const NAME = "code-investigator-corpus";
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
  /** The policy `create` reports; defaults to echoing the requested one. */
  createdPolicy?: unknown;
  exec_: ExecHandler = () => [exit(0)];
  /** Contents of sandbox files other than manifest.json; undefined means the download fails. */
  file_: (path: string) => string | undefined = () => undefined;
  status: "running" | "terminated" = "running";
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
          networkPolicy: (self.createdPolicy ?? input.networkPolicy ?? { type: "allow-all" }) as NonNullable<typeof input.networkPolicy>,
          region: "oregon",
          timeoutSeconds: input.timeoutSeconds ?? 7200,
          createdAt: new Date().toISOString(),
        };
      },
      async get(id) {
        return { id, status: self.status, plan: "starter", networkPolicy: { default: "allow-all" }, region: "oregon", timeoutSeconds: 1, createdAt: "" };
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
        const text = path.endsWith("/manifest.json") ? JSON.stringify(self.manifest()) : self.file_(path);
        if (text === undefined) throw new Error(`no such file: ${path}`);
        const data = Buffer.from(text);
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

let fake: FakeApi;
const SANDBOX_DIR = fileURLToPath(new URL("../sandbox-runtime/", import.meta.url));

function client(policy: NetworkPolicy = { default: "allow-list", allowedDomains: ["api.anthropic.com"] }, api = fake.api()) {
  const cfg: RenderConfig = {
    apiKey: "rnd_test",
    workspaceId: "tea-test",
    hostCredentials: { "github.com": { username: "x-access-token", token: GH_TOKEN } },
    networkPolicy: policy,
    investigationTimeoutSeconds: 1_800,
    builderTimeoutSeconds: 3_600,
    minRequestIntervalMs: 0,
    sandboxDir: SANDBOX_DIR,
  };
  return new SandboxClient(api, cfg, { pollMs: 1, bootTimeoutMs: 1_000, investigationGraceMs: 30_000 });
}

beforeEach(() => {
  fake = new FakeApi();
});

const event = (e: object) => `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`;

describe("runInvestigation", () => {
  it("reads events from the run's output file and counts invalid lines", async () => {
    const started = event({ type: "started", pi_version: "0.83.0", model: "m", prompt_version: "v3" });
    const result = event({ type: "result", result: { status: "needs_clarification", question: "Which region?", why_needed: "x" } });
    fake.exec_ = (_id, command) =>
      command.includes("run-investigation.sh") ? [out("runner ", "stderr"), out("diagnostics", "stderr"), exit(0)] : [exit(0)];
    fake.file_ = (path) => (path.endsWith(".jsonl") ? started + "not json\n" + '{"type":"nope"}\n' + result.trimEnd() : undefined);
    const stderr: string[] = [];
    const res = await runInvestigation(client(), "sbx-run", {
      input: runnerInput(LAYOUT),
      timeoutMs: 60_000,
      onStderr: (chunk) => void stderr.push(chunk),
    });
    expect(res).toMatchObject({ exitCode: 0, aborted: false, streamLost: false, invalidLines: 2, stderrTail: "runner diagnostics" });
    expect(res.events.map((e) => e.type)).toEqual(["started", "result"]);
    expect(stderr).toEqual(["runner ", "diagnostics"]);
    const runDir = /run-investigation\.sh (\S+) /.exec(fake.commands()[1]!)![1];
    expect(fake.calls.flatMap((c) => (c.op === "download" ? [c.path] : []))).toEqual([`${runDir}.jsonl`]);
  });

  it("uploads the model key as a file and never puts it in a command", async () => {
    await runInvestigation(client(), "sbx-run", {
      input: runnerInput(LAYOUT),
      modelApiKey: MODEL_KEY,
      timeoutMs: 90_000,
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

  it("keeps the partial output of an aborted run", async () => {
    const ac = new AbortController();
    const started = event({ type: "started", pi_version: "0", model: "m", prompt_version: "v" });
    fake.exec_ = (_id, command, signal) =>
      command.includes("run-investigation.sh")
        ? (async function* () {
            ac.abort();
            if (!signal!.aborted) await new Promise((resolve) => signal!.addEventListener("abort", resolve));
            throw new AbortError();
          })()
        : [exit(0)];
    fake.file_ = (path) => (path.endsWith(".jsonl") ? started + '{"type":"tool_c' : undefined);
    const aborted = await runInvestigation(client(), "sbx-run", { input: runnerInput(LAYOUT), timeoutMs: 60_000, signal: ac.signal });
    expect(aborted).toMatchObject({ exitCode: null, aborted: true, streamLost: false, invalidLines: 1 });
    expect(aborted.events.map((e) => e.type)).toEqual(["started"]);
  });

  it("recovers the exit status after the exec stream drops", async () => {
    const result = event({ type: "result", result: { status: "needs_clarification", question: "Which region?", why_needed: "x" } });
    fake.exec_ = (_id, command) =>
      command.includes("run-investigation.sh")
        ? (async function* () {
            yield out("partial diagnostics", "stderr");
            throw new RenderError("Sandbox exec stream ended without a terminal event.");
          })()
        : [exit(0)];
    let polls = 0;
    fake.file_ = (path) => (path.endsWith(".exit") ? (++polls < 3 ? undefined : "0\n") : path.endsWith(".jsonl") ? result : undefined);
    const res = await runInvestigation(client(), "sbx-run", { input: runnerInput(LAYOUT), timeoutMs: 60_000 });
    expect(res).toMatchObject({ exitCode: 0, aborted: false, streamLost: false, stderrTail: "partial diagnostics" });
    expect(res.events.map((e) => e.type)).toEqual(["result"]);
    expect(polls).toBe(3);
  });

  it("reports a lost run when the sandbox dies after the stream drops", async () => {
    fake.exec_ = (_id, command) =>
      command.includes("run-investigation.sh")
        ? (async function* () {
            throw new RenderError("Sandbox exec stream ended without a terminal event.");
          })()
        : [exit(0)];
    fake.status = "terminated";
    const lost = await runInvestigation(client(), "sbx-run", { input: runnerInput(LAYOUT), timeoutMs: 60_000 });
    expect(lost).toEqual({ exitCode: null, aborted: false, streamLost: true, stderrTail: "", events: [], invalidLines: 0 });
  });
});

const prepareExec: ExecHandler = (_id, command) => {
  if (command.includes("verify.sh")) {
    const line = `${info()}\n`;
    return [out("progress noise\n", "stderr"), out(line.slice(0, 20)), out(line.slice(20)), exit(0)];
  }
  if (command.includes("detect") || command.includes("printf \"%s")) {
    return [out("/opt/triage/app/node/bin/node\nsetpriv\n"), exit(0)];
  }
  return [out("progress noise\n", "stderr"), exit(0)];
};

describe("buildSnapshot", () => {
  it("builds a snapshot in an allow-all builder and names it", async () => {
    fake.exec_ = prepareExec;
    const built = await buildSnapshot(client(), { profile, heads, snapshotName: NAME });
    expect(built).toEqual({ id: "snp-new", sandboxGroupId: "sbg-1" });

    // Credential upload must happen after install-tools and the self-test (which execute third-party code)
    const tokenUpload = fake.calls.findIndex((c) => c.op === "upload" && c.path.includes("/creds/"));
    const installToolsExec = fake.calls.findIndex((c) => c.op === "exec" && c.command.includes("install-tools.sh"));
    const selfTestExec = fake.calls.findIndex((c) => c.op === "exec" && c.command.includes("--self-test"));
    expect(installToolsExec).toBeLessThan(tokenUpload);
    expect(selfTestExec).toBeLessThan(tokenUpload);

    // Clone execs must come after credential upload
    const cloneExecs = fake.calls.filter((c) => c.op === "exec" && c.command.includes("git") && c.command.includes("clone"));
    expect(cloneExecs.length).toBe(2);
    for (const clone of cloneExecs) {
      expect(fake.calls.indexOf(clone)).toBeGreaterThan(tokenUpload);
    }

    // The scrub (which deletes creds) must come after the clones
    const scrubExec = fake.calls.findIndex((c) => c.op === "exec" && c.command.includes("build/scrub-credentials.sh"));
    expect(scrubExec).toBeGreaterThan(fake.calls.indexOf(cloneExecs.at(-1)!));

    const creates = fake.calls.filter((c) => c.op === "create");
    expect(creates[0]!.input).toEqual({ timeoutSeconds: 3_600, networkPolicy: { type: "allow-all" } });
    expect(fake.calls.find((c) => c.op === "terminate")!.id).toBe(creates[0]!.id);
    expect(fake.inputs("snapshot.create")).toEqual([{ sandboxId: creates[0]!.id, kind: "filesystem", name: NAME }]);

    const commands = fake.commands();
    expect(commands.some((c) => c.includes(GH_TOKEN))).toBe(false);

    // Manifest is uploaded (computed in TypeScript), not generated by a script
    const manifestUpload = fake.calls.flatMap((c) => (c.op === "upload" && c.path === "/opt/triage/app/manifest.json" ? [c] : []))[0];
    expect(manifestUpload).toBeDefined();
    const uploadedManifest = JSON.parse(manifestUpload!.data as string);
    expect(uploadedManifest.profile).toBe("default");
    expect(uploadedManifest.repos).toHaveLength(2);

    // The runner is self-contained: nothing is installed with npm inside the sandbox
    expect(commands.every((c) => !/\bnpm\b/.test(c))).toBe(true);

    const uploads = fake.calls.filter((c) => c.op === "upload");
    expect(uploads[0]!.path).toBe("/tmp/triage-stage/stage.tgz");
    expect(uploads[0]!.contentType).toBeUndefined();
    expect(commands).toContain("tar -xzf /tmp/triage-stage/stage.tgz -C /tmp/triage-stage && rm /tmp/triage-stage/stage.tgz");
    const credUpload = uploads.find((u) => u.path.includes("/creds/"));
    expect(credUpload).toBeDefined();
    expect(credUpload!.data).toBe(`x-access-token\n${GH_TOKEN}`);

    // Stage archive: the runtime scripts, the builder-only scripts under build/, and the runner bundle
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
    expect([...files.keys()].filter((p) => !p.endsWith("/")).sort()).toEqual([
      "as-runner.sh",
      "build/git-credential-staged.sh",
      "build/scrub-credentials.sh",
      "install-tools.sh",
      "run-investigation.sh",
      "runner/runner.mjs",
      "verify.sh",
    ]);
    expect(files.get("runner/runner.mjs")).toContain("submit_investigation");

    // build/ scripts stay in the staging dir, which is deleted before verification and the snapshot
    expect(commands.some((c) => c.includes("cp /tmp/triage-stage/*.sh /opt/triage/app/"))).toBe(true);
    const removeStage = fake.calls.findIndex((c) => c.op === "exec" && c.command === "rm -rf /tmp/triage-stage");
    expect(removeStage).toBeGreaterThan(scrubExec);
    expect(removeStage).toBeLessThan(fake.calls.findIndex((c) => c.op === "snapshot.create"));

    expect(manifestDigest(uploadedManifest)).toBe(manifestDigest({ profile: "default", created_at: "", repos: heads }));
  });

  it("never uploads the token when the install phase fails", async () => {
    fake.exec_ = (id, command) =>
      command.includes("install-tools.sh") ? [out("install-tools: missing tools\n", "stderr"), exit(1)] : prepareExec(id, command);
    await expect(buildSnapshot(client(), { profile, heads, snapshotName: NAME })).rejects.toThrow("install-tools.sh");
    expect(fake.calls.some((c) => c.op === "upload" && c.path.includes("/creds/"))).toBe(false);
    expect(fake.calls.filter((c) => c.op === "terminate").map((c) => c.id)).toEqual(["sbx-1"]);
  });

  it("builds from the shipped config.ts", async () => {
    fake.exec_ = prepareExec;
    const shipped = { name: config.name, repos: config.repos };
    await expect(buildSnapshot(client(), { profile: shipped, heads, snapshotName: config.snapshotName })).resolves.toBeDefined();
    const manifestUpload = fake.calls.find((c) => c.op === "upload" && c.path === "/opt/triage/app/manifest.json");
    expect(JSON.parse((manifestUpload as { data: string }).data).profile).toBe(config.name);
  });

  it("rejects an invalid snapshotName", async () => {
    fake.exec_ = prepareExec;
    await expect(buildSnapshot(client(), { profile, heads, snapshotName: "bad name!" })).rejects.toThrow("not [A-Za-z0-9_.-]+");
  });
});

describe("pruneSnapshots", () => {
  const built = { id: "snp-new", sandboxGroupId: "sbg-1" };

  it("keeps the newest two and ignores snapshots with a different name", async () => {
    await pruneSnapshots(client(), built, NAME, 2);
    expect(fake.inputs("snapshot.list")).toHaveLength(1);
    expect(fake.inputs("snapshot.delete")).toEqual([]);
  });

  it("deletes this name's snapshots beyond the newest two, following the list cursor past the first page", async () => {
    const api = fake.api();
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
    await pruneSnapshots(client(undefined, api), built, NAME, 2);

    expect(fake.inputs("snapshot.list").map((i) => (i as { cursor?: string }).cursor)).toEqual([undefined, "o99"]);
    expect(fake.inputs("snapshot.delete")).toEqual([{ sandboxGroupId: "sbg-1", snapshotId: "snp-1" }]);
  });
});

describe("openRenderSandbox", () => {
  it("creates a sandbox by snapshot name with the configured policy and timeout", async () => {
    fake.exec_ = prepareExec;
    const sbx = await openRenderSandbox(client(), NAME);
    expect(sbx).toMatchObject(LAYOUT);
    expect(sbx.manifest.repos).toEqual(fake.manifest().repos);
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
      networkPolicy: { type: "allow-list", rules: [{ domain: "api.anthropic.com", protocol: "https" }] },
    });

    const commands = fake.commands();
    expect(commands.filter((c) => c.includes("verify.sh"))).toEqual([
      "bash /opt/triage/app/verify.sh --deny-probe https://example.com --allow-probe 'https://api.anthropic.com'",
    ]);
  });

  it("throws SnapshotUnavailableError when no snapshot with that name is available", async () => {
    fake.createError = (input) =>
      input?.snapshotName ? new SandboxSnapshotNotFoundError("snapshot not found", 404) : undefined;
    await expect(openRenderSandbox(client(), "no-such-snap")).rejects.toBeInstanceOf(
      SnapshotUnavailableError,
    );
  });

  it("terminates the sandbox when verify fails", async () => {
    fake.exec_ = (id, command) =>
      command.includes("verify.sh") ? [out("verify: egress to https://example.com is allowed\n", "stderr"), exit(1)] : prepareExec(id, command);
    await expect(openRenderSandbox(client({ default: "deny-all" }), NAME)).rejects.toThrow("verify.sh exited 1");
    expect(fake.calls.filter((c) => c.op === "terminate")).toHaveLength(1);
  });

  it("accepts a policy reported with only the deprecated default field", async () => {
    fake.exec_ = prepareExec;
    fake.createdPolicy = { default: "allow-list" };
    await expect(openRenderSandbox(client(), NAME)).resolves.toBeDefined();
  });

  it("terminates a sandbox created with wider egress than requested", async () => {
    fake.exec_ = prepareExec;
    fake.createdPolicy = { type: "allow-all" };
    await expect(openRenderSandbox(client(), NAME)).rejects.toThrow("refusing to widen egress");
    expect(fake.calls.filter((c) => c.op === "terminate")).toHaveLength(1);
  });

  it("refuses to create when the policy is allow-list with no domains", async () => {
    await expect(
      openRenderSandbox(client({ default: "allow-list", allowedDomains: [] }), NAME),
    ).rejects.toThrow("allow-list policy and no domains");
  });

  it("fails loudly when Render rejects the allow-list policy", async () => {
    fake.exec_ = prepareExec;
    fake.createError = (input) =>
      input?.snapshotName ? new ClientError("Failed to create sandbox: invalid networkPolicy", 400) : undefined;
    await expect(openRenderSandbox(client(), NAME)).rejects.toThrow(/SANDBOX_NETWORK_POLICY=allow-all/);
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

describe("configureSandboxes", () => {
  it("defaults to Render on Render and to local sandboxes elsewhere", async () => {
    await expect(configureSandboxes({ RENDER: "true" })).rejects.toThrow("RENDER_API_KEY is required");
    await expect(configureSandboxes({})).resolves.toBeTypeOf("function");
    await expect(configureSandboxes({ SANDBOX_PROVIDER: "nope" })).rejects.toThrow('SANDBOX_PROVIDER must be "render" or "local"');
  });
});
