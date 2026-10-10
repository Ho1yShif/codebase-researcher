/**
 * The smallest useful Render Sandbox round trip: create, wait, upload, exec, download, terminate.
 * The full system is built from these same calls; docs/sandboxes.md maps each one to where it is used.
 *
 *   RENDER_API_KEY=... RENDER_WORKSPACE_ID=tea-... pnpm exec tsx examples/hello-sandbox.ts [snapshot-name]
 */
import { setTimeout as sleep } from "node:timers/promises";
import { ClientError, Render } from "@renderinc/sdk";

const token = process.env.RENDER_API_KEY;
const ownerId = process.env.RENDER_WORKSPACE_ID as `tea-${string}` | undefined;
if (!token || !ownerId) throw new Error("set RENDER_API_KEY and RENDER_WORKSPACE_ID");
const snapshotName = process.argv[2];

const sandboxes = new Render({ token, ownerId, useLocalDev: false }).experimental.sandboxes;

/** A just-created sandbox answers 404 for a moment; treat that as "not ready yet". */
async function untilReady<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ClientError && err.statusCode === 404) || attempt === 30) throw err;
      await sleep(2_000);
    }
  }
}

/** Runs a command and collects stdout; the SDK streams output events and ends with an exit event. */
async function run(id: string, command: string): Promise<{ exitCode: number; stdout: string }> {
  let stdout = "";
  for await (const ev of await untilReady(() => sandboxes.exec(id, command))) {
    if (ev.type === "exit") return { exitCode: ev.exit_code, stdout };
    if (ev.stream === "stdout") stdout += ev.data;
    else process.stderr.write(ev.data);
  }
  throw new Error(`exec ended without an exit event: ${command}`);
}

const sandbox = await sandboxes.create({
  ...(snapshotName ? { snapshotName } : {}),
  // Backstop: Render terminates the sandbox after this even if this process dies before `terminate`.
  timeoutSeconds: 600,
  // This example needs no egress. Grant the least you need: allow-list a few hosts, or allow-all.
  networkPolicy: { default: "deny-all" },
});
console.log(`created ${sandbox.id} (${sandbox.status})`);

try {
  // `create` returns while the sandbox is still "creating".
  let status = sandbox.status;
  while (status !== "running") {
    if (status === "errored" || status === "terminated") throw new Error(`sandbox is ${status}`);
    await sleep(2_000);
    status = (await untilReady(() => sandboxes.get(sandbox.id))).status;
  }

  // Upload into an existing directory; files go in, results come back out through the same API.
  await run(sandbox.id, "mkdir -p /tmp/hello");
  await sandboxes.upload(sandbox.id, "/tmp/hello/input.txt", "hello from the host\n");

  const { exitCode, stdout } = await run(sandbox.id, "wc -c < /tmp/hello/input.txt > /tmp/hello/bytes.txt && uname -sr");
  console.log(`exit ${exitCode}: ${stdout.trim()}`);

  const bytes = await sandboxes.download(sandbox.id, "/tmp/hello/bytes.txt");
  console.log(`the sandbox counted ${bytes.data.toString("utf8").trim()} bytes`);
} finally {
  // Sandboxes are cheap to create and should not be reused across untrusted work: terminate every time.
  await sandboxes.terminate(sandbox.id);
  console.log(`terminated ${sandbox.id}`);
}
