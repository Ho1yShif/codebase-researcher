import type { RepoManifest } from "../src/manifest.ts";
import type { RunnerEvent } from "../src/runner/protocol.ts";
import { SnapshotUnavailableError, type OpenSandbox, type RunInvestigationOptions, type RunInvestigationResult } from "../src/sandbox/interface.ts";

export const TEST_MANIFEST: RepoManifest = {
  profile: "local",
  created_at: "2026-10-01T12:00:00.000Z",
  repos: [
    { repository: "render-oss/cli", branch: "main", commit: "c".repeat(40), path: "/repos/render-oss/cli" },
    { repository: "render-oss/sdk", branch: "main", commit: "d".repeat(40), path: "/repos/render-oss/sdk" },
  ],
};

export type Script = {
  events?: RunnerEvent[];
  exitCode?: number | null;
  streamLost?: boolean;
  aborted?: boolean;
  stderrTail?: string;
  throws?: Error;
};

/** Hands out scripted sandboxes and records what ran and what was closed. */
export class FakeSandboxes {
  readonly runs: { sandboxId: string; opts: RunInvestigationOptions }[] = [];
  readonly closed: string[] = [];
  #scripts: Script[] = [];
  #next = 0;
  noSnapshot: boolean | "notReady" = false;

  script(...scripts: Script[]): this {
    this.#scripts.push(...scripts);
    return this;
  }

  readonly open: OpenSandbox = async () => {
    if (this.noSnapshot) throw new SnapshotUnavailableError("no snapshot", { notReady: this.noSnapshot === "notReady" });
    const id = `sbx-${++this.#next}`;
    return {
      id,
      manifest: TEST_MANIFEST,
      reposRoot: "/repos",
      scratchDir: "/scratch",
      info: {},
      run: (opts) => this.#run(id, opts),
      close: async () => void this.closed.push(id),
    };
  };

  async #run(sandboxId: string, opts: RunInvestigationOptions): Promise<RunInvestigationResult> {
    const script = this.#scripts.shift();
    if (!script) throw new Error("FakeSandboxes: no script left");
    this.runs.push({ sandboxId, opts });
    if (script.throws) throw script.throws;
    const aborted = (script.aborted ?? false) || (opts.signal?.aborted ?? false);
    const streamLost = !aborted && (script.streamLost ?? false);
    const exitCode = aborted || streamLost ? null : script.exitCode === undefined ? 0 : script.exitCode;
    return { exitCode, aborted, streamLost, stderrTail: script.stderrTail ?? "", events: script.events ?? [], invalidLines: 0 };
  }
}
