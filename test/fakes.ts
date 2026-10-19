import type { Slack, BotIdentity } from "../src/slack/client.ts";
import type { RepoManifest } from "../src/manifest.ts";
import type { RunnerEvent } from "../src/runner/protocol.ts";
import { SnapshotUnavailableError, type OpenSandbox, type RunInvestigationOptions, type RunInvestigationResult } from "../src/sandbox/interface.ts";

type Reaction = { name: string; user: string };

type FakeMessage = {
  ts: string;
  thread_ts?: string;
  channel: string;
  user?: string;
  bot_id?: string;
  text: string;
  blocks?: unknown;
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
  reactions?: Reaction[];
};

const BOT_USER_ID = "UBOT";
const BOT_ID = "BBOT";

/** In-memory Slack stand-in for unit tests. No HTTP, no fake server. */
export function createFakeSlack(): Slack & {
  messages: FakeMessage[];
  seed(msg: Omit<FakeMessage, "ts"> & { ts?: string }): FakeMessage;
} {
  let seq = 0;
  const nextTs = () => {
    seq += 1;
    return `1700000000.${String(seq).padStart(6, "0")}`;
  };
  const messages: FakeMessage[] = [];

  const thread = (channel: string, threadTs: string) =>
    messages
      .filter((m) => m.channel === channel && (m.ts === threadTs || m.thread_ts === threadTs))
      .sort((a, b) => Number(a.ts) - Number(b.ts));

  const seed = (msg: Omit<FakeMessage, "ts"> & { ts?: string }): FakeMessage => {
    const m: FakeMessage = { ts: msg.ts ?? nextTs(), ...msg };
    messages.push(m);
    return m;
  };

  const web = {
    auth: {
      test: async () => ({ ok: true, user_id: BOT_USER_ID, bot_id: BOT_ID }),
    },
    conversations: {
      replies: async (params: { channel: string; ts: string; cursor?: string; limit?: number; include_all_metadata?: boolean }) => {
        const msgs = thread(params.channel, params.ts);
        return {
          ok: true,
          messages: msgs.map(({ channel: _c, ...m }) =>
            params.include_all_metadata ? m : { ...m, metadata: undefined },
          ),
          has_more: false,
          response_metadata: { next_cursor: "" },
        };
      },
    },
    chat: {
      postMessage: async (p: {
        channel: string;
        thread_ts?: string;
        text?: string;
        blocks?: unknown;
        metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
        unfurl_links?: boolean;
      }) => {
        const msg: FakeMessage = {
          ts: nextTs(),
          thread_ts: p.thread_ts,
          channel: p.channel,
          user: BOT_USER_ID,
          bot_id: BOT_ID,
          text: String(p.text ?? ""),
          blocks: p.blocks,
          metadata: p.metadata,
        };
        messages.push(msg);
        return { ok: true, channel: msg.channel, ts: msg.ts, message: msg };
      },
    },
    reactions: {
      add: async (p: { channel: string; timestamp: string; name: string }) => {
        const m = messages.find((x) => x.channel === p.channel && x.ts === p.timestamp);
        if (!m) throw platformError("message_not_found");
        if (!m.reactions) m.reactions = [];
        if (m.reactions.some((r) => r.name === p.name && r.user === BOT_USER_ID))
          throw platformError("already_reacted");
        m.reactions.push({ name: p.name, user: BOT_USER_ID });
        return { ok: true };
      },
      remove: async (p: { channel: string; timestamp: string; name: string }) => {
        const m = messages.find((x) => x.channel === p.channel && x.ts === p.timestamp);
        if (!m) throw platformError("message_not_found");
        if (!m.reactions) m.reactions = [];
        const idx = m.reactions.findIndex((r) => r.name === p.name && r.user === BOT_USER_ID);
        if (idx < 0) throw platformError("no_reaction");
        m.reactions.splice(idx, 1);
        return { ok: true };
      },
    },
  } as unknown as Slack["web"];

  return {
    web,
    identity: async () => ({ userId: BOT_USER_ID, botId: BOT_ID } as BotIdentity),
    messages,
    seed,
  };
}

function platformError(code: string): Error {
  const err = new Error(`An API error occurred: ${code}`);
  (err as unknown as { data: { error: string } }).data = { error: code };
  return err;
}

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
