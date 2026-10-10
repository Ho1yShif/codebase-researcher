import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import config from "../config.ts";
import { SandboxClient } from "./sandbox/render/client.ts";
import { loadRenderConfig } from "./sandbox/render/config.ts";
import { rebuildSnapshot } from "./sandbox/render/snapshot.ts";
import { errorMessage } from "./types.ts";

const KEEP_SNAPSHOTS = 2;

export type RefreshDeps = {
  snapshotName: string;
  /** Builds the snapshot and prunes older ones. */
  rebuild: () => Promise<{ id: string; repos: number }>;
  log?: (line: string) => void;
};

type RefreshBase = { event: "snapshot_refresh"; snapshot_name: string; duration_ms: number };
type RefreshOutcome =
  | { ok: true; snapshot_id: string; repos: number }
  | { ok: false; snapshot_id: null; repos: 0; error: string };
export type RefreshResult = RefreshBase & RefreshOutcome;

/** Never throws: logs one `snapshot_refresh` JSON line either way. */
export async function refreshSnapshot({ snapshotName, rebuild, log = console.log }: RefreshDeps): Promise<RefreshResult> {
  const start = Date.now();
  let outcome: RefreshOutcome;
  try {
    const built = await rebuild();
    outcome = { ok: true, snapshot_id: built.id, repos: built.repos };
  } catch (err) {
    outcome = { ok: false, snapshot_id: null, repos: 0, error: errorMessage(err) };
  }
  const result: RefreshResult = { event: "snapshot_refresh", snapshot_name: snapshotName, duration_ms: Date.now() - start, ...outcome };
  log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { snapshotName } = config;
  const result = await refreshSnapshot({
    snapshotName,
    rebuild: async () =>
      rebuildSnapshot(SandboxClient.fromConfig(await loadRenderConfig()), {
        profile: { name: config.name, repos: config.repos },
        snapshotName,
        keep: KEEP_SNAPSHOTS,
      }),
  });
  process.exitCode = result.ok ? 0 : 1;
}
