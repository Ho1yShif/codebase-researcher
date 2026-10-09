/**
 * Posts a question to the API, then either polls GET until done or starts
 * a local HTTP callback receiver.
 *
 *   tsx scripts/ask.ts --text "How does the CLI pick a workspace?" [--url http://localhost:3000] [--token $API_TOKEN] [--callback]
 */
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { verifyCallback } from "../src/types.ts";

const { values } = parseArgs({
  options: {
    text: { type: "string" },
    url: { type: "string", default: process.env.API_URL ?? "http://localhost:3000" },
    token: { type: "string", default: process.env.API_TOKEN ?? "test-token" },
    callback: { type: "boolean", default: false },
    "callback-port": { type: "string", default: "0" },
  },
});

if (!values.text) throw new Error("--text is required");

const base = values.url!.replace(/\/$/, "");
const headers = {
  "content-type": "application/json",
  Authorization: `Bearer ${values.token}`,
};

const transcript = [{ text: values.text }];

async function pollForResult(id: string): Promise<void> {
  process.stderr.write(`[ask] Polling GET /v1/questions/${id}...\n`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${base}/v1/questions/${id}`, { headers });
    const body = await res.json() as { status: string; trace_id?: string; reply?: unknown; error?: string };
    process.stderr.write(`[ask] status=${body.status}\n`);
    if (body.status === "completed" || body.status === "failed") {
      console.log(JSON.stringify(body, null, 2));
      return;
    }
  }
}

async function withCallback(): Promise<void> {
  const secret = "local-callback-secret-" + Math.random().toString(36).slice(2);
  const port = Number(values["callback-port"]) || 0;

  const result = await new Promise<unknown>((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString();
        const ok = verifyCallback({
          secret,
          signature: req.headers["x-triage-signature"] as string,
          timestamp: req.headers["x-triage-timestamp"] as string,
          body: rawBody,
        });
        if (!ok) {
          process.stderr.write("[ask] ⚠ callback signature verification FAILED\n");
          res.writeHead(401);
          res.end("bad signature");
          return;
        }
        process.stderr.write("[ask] ✓ callback signature verified\n");
        res.writeHead(200);
        res.end("ok");
        try {
          resolve(JSON.parse(rawBody));
        } catch {
          resolve(rawBody);
        }
        server.close();
      });
    });

    server.listen(port, "127.0.0.1", async () => {
      const addr = server.address() as { port: number };
      const callbackUrl = `http://localhost:${addr.port}/callback`;
      process.stderr.write(`[ask] Callback listener on ${callbackUrl}\n`);

      try {
        const res = await fetch(`${base}/v1/questions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            transcript,
            callback: { url: callbackUrl, secret },
          }),
        });
        const body = await res.json() as { id: string };
        process.stderr.write(`[ask] Started question ${body.id}, waiting for callback...\n`);
      } catch (err) {
        reject(err);
        server.close();
      }
    });

    setTimeout(() => {
      reject(new Error("callback timed out after 10 minutes"));
      server.close();
    }, 10 * 60_000).unref();
  });

  console.log(JSON.stringify(result, null, 2));
}

if (values.callback) {
  await withCallback();
} else {
  const res = await fetch(`${base}/v1/questions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ transcript }),
  });
  const body = await res.json() as { id: string };
  process.stderr.write(`[ask] Started question ${body.id}\n`);
  await pollForResult(body.id);
}
