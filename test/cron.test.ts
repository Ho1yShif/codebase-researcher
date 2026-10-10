import { describe, expect, it } from "vitest";
import { refreshSnapshot } from "../src/cron.ts";

const SNAPSHOT_NAME = "code-investigator-corpus";

describe("refreshSnapshot", () => {
  it("reports the built snapshot", async () => {
    const result = await refreshSnapshot({ snapshotName: SNAPSHOT_NAME, rebuild: async () => ({ id: "snp-1", repos: 3 }), log: () => {} });
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
      log: () => {},
    });
    expect(result).toMatchObject({ ok: false, snapshot_id: null, repos: 0, error: "build failed" });
  });

  it("emits exactly one JSON log line", async () => {
    const lines: string[] = [];
    await refreshSnapshot({ snapshotName: SNAPSHOT_NAME, rebuild: async () => ({ id: "snp-1", repos: 1 }), log: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "snapshot_refresh", ok: true, snapshot_name: SNAPSHOT_NAME, repos: 1 });
  });
});
