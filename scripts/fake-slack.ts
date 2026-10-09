/**
 * In-memory stand-in for the Slack Web API, for local end-to-end runs.
 * Point the workflow at it with SLACK_API_URL=http://localhost:4100/api/
 *
 * Test helpers:
 *   POST /_seed      {channel, ts?, thread_ts?, user, text}  -> adds a human message
 *   GET  /_messages?channel=C&thread_ts=T                    -> thread contents
 *   POST /_fail      {method, count, mode: "http500"|"not_ok"} -> fail the next N calls
 *   POST /_reset
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.FAKE_SLACK_PORT ?? 4100);
const BOT_USER_ID = process.env.FAKE_SLACK_BOT_USER_ID ?? "UBOT";
const BOT_ID = "BBOT";
const TEAM_ID = process.env.FAKE_SLACK_TEAM_ID ?? "T0001";

type Reaction = { name: string; user: string };

type Message = {
  ts: string;
  thread_ts?: string;
  channel: string;
  user?: string;
  bot_id?: string;
  text: string;
  blocks?: unknown;
  metadata?: unknown;
  reactions?: Reaction[];
};

let messages: Message[] = [];
let failures: Record<string, { count: number; mode: "http500" | "not_ok" }> = {};
let seq = 0;

function nextTs(): string {
  seq += 1;
  return `${Math.floor(Date.now() / 1000)}.${String(seq).padStart(6, "0")}`;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) return JSON.parse(raw);
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    out[k] = (v.startsWith("{") || v.startsWith("[")) ? safeJson(v) : v;
  }
  return out;
}

function safeJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function thread(channel: string, threadTs: string): Message[] {
  return messages
    .filter((m) => m.channel === channel && (m.ts === threadTs || m.thread_ts === threadTs))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

const api: Record<string, (p: Record<string, unknown>) => unknown> = {
  "auth.test": () => ({ ok: true, user_id: BOT_USER_ID, bot_id: BOT_ID, team_id: TEAM_ID, user: "support-triage-bot" }),
  "conversations.replies": (p) => {
    const channel = String(p.channel);
    const ts = String(p.ts);
    const msgs = thread(channel, ts);
    if (msgs.length === 0) return { ok: false, error: "thread_not_found" };
    return {
      ok: true,
      has_more: false,
      messages: msgs.map(({ channel: _c, ...m }) => (p.include_all_metadata ? m : { ...m, metadata: undefined })),
      response_metadata: { next_cursor: "" },
    };
  },
  "chat.postMessage": (p) => {
    const msg: Message = {
      ts: nextTs(),
      thread_ts: p.thread_ts ? String(p.thread_ts) : undefined,
      channel: String(p.channel),
      user: BOT_USER_ID,
      bot_id: BOT_ID,
      text: String(p.text ?? ""),
      blocks: p.blocks,
      metadata: p.metadata,
    };
    messages.push(msg);
    console.log(`[fake-slack] postMessage ${msg.channel}/${msg.thread_ts ?? "-"}: ${msg.text.slice(0, 120)}`);
    return { ok: true, channel: msg.channel, ts: msg.ts, message: msg };
  },
  "chat.update": (p) => {
    const m = messages.find((x) => x.channel === p.channel && x.ts === p.ts);
    if (!m) return { ok: false, error: "message_not_found" };
    m.text = String(p.text ?? m.text);
    if (p.blocks) m.blocks = p.blocks;
    return { ok: true, channel: m.channel, ts: m.ts };
  },
  "reactions.add": (p) => {
    const m = messages.find((x) => x.channel === p.channel && x.ts === String(p.timestamp));
    if (!m) return { ok: false, error: "message_not_found" };
    if (!m.reactions) m.reactions = [];
    if (m.reactions.some((r) => r.name === String(p.name) && r.user === BOT_USER_ID))
      return { ok: false, error: "already_reacted" };
    m.reactions.push({ name: String(p.name), user: BOT_USER_ID });
    return { ok: true };
  },
  "reactions.remove": (p) => {
    const m = messages.find((x) => x.channel === p.channel && x.ts === String(p.timestamp));
    if (!m) return { ok: false, error: "message_not_found" };
    if (!m.reactions) m.reactions = [];
    const idx = m.reactions.findIndex((r) => r.name === String(p.name) && r.user === BOT_USER_ID);
    if (idx < 0) return { ok: false, error: "no_reaction" };
    m.reactions.splice(idx, 1);
    return { ok: true };
  },
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/_seed" && req.method === "POST") {
      const b = await readBody(req);
      const msg: Message = {
        ts: b.ts ? String(b.ts) : nextTs(),
        thread_ts: b.thread_ts ? String(b.thread_ts) : undefined,
        channel: String(b.channel),
        user: String(b.user ?? "UHUMAN"),
        text: String(b.text ?? ""),
      };
      messages.push(msg);
      return send(res, 200, { ok: true, message: msg });
    }
    if (url.pathname === "/_messages") {
      const channel = url.searchParams.get("channel") ?? "";
      const threadTs = url.searchParams.get("thread_ts");
      return send(res, 200, threadTs ? thread(channel, threadTs) : messages.filter((m) => m.channel === channel));
    }
    if (url.pathname === "/_fail" && req.method === "POST") {
      const b = await readBody(req);
      failures[String(b.method)] = { count: Number(b.count ?? 1), mode: (b.mode as "http500" | "not_ok") ?? "http500" };
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/_reset" && req.method === "POST") {
      messages = [];
      failures = {};
      return send(res, 200, { ok: true });
    }
    if (url.pathname.startsWith("/api/")) {
      const method = url.pathname.slice("/api/".length);
      const handler = api[method];
      if (!handler) return send(res, 200, { ok: false, error: "unknown_method" });
      const f = failures[method];
      if (f && f.count > 0) {
        f.count -= 1;
        if (f.mode === "http500") return send(res, 500, { ok: false, error: "internal_error" });
        return send(res, 200, { ok: false, error: "fatal_error" });
      }
      const params = { ...Object.fromEntries(url.searchParams), ...(await readBody(req)) };
      return send(res, 200, handler(params));
    }
    send(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    send(res, 500, { ok: false, error: String(err) });
  }
}).listen(PORT, () => console.log(`[fake-slack] listening on http://localhost:${PORT} (bot ${BOT_USER_ID})`));
