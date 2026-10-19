import { describe, expect, it } from "vitest";
import { refreshSnapshot } from "../src/cron.ts";
import { createLog } from "../src/log.ts";

const SNAPSHOT_NAME = "codebase-researcher-corpus";
const silent = createLog({}, () => {});

describe("refreshSnapshot", () => {
  it("reports the built snapshot", async () => {
    const result = await refreshSnapshot({ snapshotName: SNAPSHOT_NAME, rebuild: async () => ({ id: "snp-1", repos: 3 }), log: silent });
    expect(result).toMatchObject({
      event: "snapshot_refresh",
      ok: true,
      snapshot_id: "snp-1",
      snapshot_name: SNAPSHOT_NAME,
      repos: 3,
    });
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns ok: false on build failure without throwing", async () => {
    const result = await refreshSnapshot({
      snapshotName: SNAPSHOT_NAME,
      rebuild: async () => {
        throw new Error("build failed");
      },
      log: silent,
    });
    expect(result).toMatchObject({ ok: false, snapshot_id: null, repos: 0, error: "build failed" });
  });

  it("emits exactly one JSON log line carrying the whole result", async () => {
    const lines: string[] = [];
    const log = createLog({}, (l) => void lines.push(l));
    const result = await refreshSnapshot({ snapshotName: SNAPSHOT_NAME, rebuild: async () => ({ id: "snp-1", repos: 1 }), log });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ level: "info", msg: "snapshot refreshed", ...result });
  });

  it("logs a failed refresh at error level with the same fields", async () => {
    const lines: string[] = [];
    const log = createLog({}, (l) => void lines.push(l));
    await refreshSnapshot({ snapshotName: SNAPSHOT_NAME, rebuild: async () => { throw new Error("clone failed"); }, log });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "error",
      event: "snapshot_refresh",
      ok: false,
      snapshot_id: null,
      snapshot_name: SNAPSHOT_NAME,
      repos: 0,
      error: "clone failed",
      duration_ms: expect.any(Number),
    });
  });
});
