import type { RepoProfile } from "./types.ts";
import config from "../config.ts";
import { createProvider } from "./sandbox.ts";
import type { SandboxProvider } from "./sandbox.ts";
import { z } from "zod";

export type RefreshDeps = {
  provider: SandboxProvider;
  profile: RepoProfile;
  snapshotName: string;
  log?: (line: string) => void;
};

export type RefreshResult = {
  event: "snapshot_refresh";
  ok: boolean;
  snapshot_id: string | null;
  snapshot_name: string;
  repos: number;
  duration_ms: number;
  error?: string;
};

/**
 * Resolve heads, build a snapshot, and prune older ones keeping the newest 2.
 *
 * No database and no lock: Render does not start a cron run while the previous one is still running
 * (verify this assumption against Render's cron scheduling behavior).
 */
export async function refreshSnapshot(deps: RefreshDeps): Promise<RefreshResult> {
  const start = Date.now();
  try {
    const heads = await deps.provider.resolveHeads(deps.profile);
    const built = await deps.provider.buildSnapshot({
      profile: deps.profile,
      heads,
      snapshotName: deps.snapshotName,
    });
    await deps.provider.pruneSnapshots(deps.snapshotName, 2);
    return emit(deps, {
      event: "snapshot_refresh",
      ok: true,
      snapshot_id: built.id,
      snapshot_name: deps.snapshotName,
      repos: heads.length,
      duration_ms: Date.now() - start,
    });
  } catch (err) {
    return emit(deps, {
      event: "snapshot_refresh",
      ok: false,
      snapshot_id: null,
      snapshot_name: deps.snapshotName,
      repos: 0,
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function emit(deps: RefreshDeps, result: RefreshResult): RefreshResult {
  (deps.log ?? console.log)(JSON.stringify(result));
  return result;
}

const profile = { name: config.name, repos: config.repos };
const snapshotName = config.snapshotName;

if (process.argv[1]?.endsWith("refresh.ts")) {
  try {
    const provider = await createProvider();
    const result = await refreshSnapshot({ provider, profile, snapshotName });
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    console.error(JSON.stringify({ event: "snapshot_refresh_error", error: err instanceof Error ? (err.stack ?? err.message) : String(err) }));
    process.exitCode = 1;
  }
}
