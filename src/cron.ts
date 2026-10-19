import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import config from "../config.ts";
import { createLog, type Log } from "./log.ts";
import { SandboxClient } from "./sandbox/render/client.ts";
import { loadRenderConfig } from "./sandbox/render/config.ts";
import { rebuildSnapshot } from "./sandbox/render/snapshot.ts";
import { errorMessage } from "./util.ts";

const KEEP_SNAPSHOTS = 2;

export type RefreshDeps = {
  snapshotName: string;
  /** Builds the snapshot and prunes older ones. */
  rebuild: () => Promise<{ id: string; repos: number }>;
  log: Log;
};

type RefreshBase = { event: "snapshot_refresh"; snapshot_name: string; duration_ms: number };
type RefreshOutcome =
  | { ok: true; snapshot_id: string; repos: number }
  | { ok: false; snapshot_id: null; repos: 0; error: string };
export type RefreshResult = RefreshBase & RefreshOutcome;

/** Never throws: logs one `snapshot_refresh` line either way. */
export async function refreshSnapshot({ snapshotName, rebuild, log }: RefreshDeps): Promise<RefreshResult> {
  const start = Date.now();
  let outcome: RefreshOutcome;
  try {
    const built = await rebuild();
    outcome = { ok: true, snapshot_id: built.id, repos: built.repos };
  } catch (err) {
    outcome = { ok: false, snapshot_id: null, repos: 0, error: errorMessage(err) };
  }
  const result: RefreshResult = { event: "snapshot_refresh", snapshot_name: snapshotName, duration_ms: Date.now() - start, ...outcome };
  if (result.ok) log.info("snapshot refreshed", result);
  else log.error("snapshot refresh failed", result);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { snapshotName } = config;
  const log = createLog();
  const result = await refreshSnapshot({
    snapshotName,
    log,
    rebuild: async () =>
      rebuildSnapshot(SandboxClient.fromConfig(await loadRenderConfig(), log), {
        profile: { name: config.name, repos: config.repos },
        snapshotName,
        keep: KEEP_SNAPSHOTS,
      }),
  });
  process.exitCode = result.ok ? 0 : 1;
}
