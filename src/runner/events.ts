import type { RunnerEvent, Usage } from "./protocol.ts";
import type { Usage as PiUsage } from "@earendil-works/pi-ai";

type WithoutAt<E> = E extends unknown ? Omit<E, "at"> : never;
export type EventBody = WithoutAt<RunnerEvent>;

export interface Emitter {
  (event: EventBody): void;
  readonly terminated: boolean;
  /** Replaces `secret` with `[REDACTED]` in every later line. */
  redact(secret: string): void;
  /** Resolves once every line written so far has been flushed. */
  flush(): Promise<void>;
}

/** Writes one RunnerEvent per line. Drops everything after the first terminal (`result`/`error`) event. */
export function createEmitter(write: (chunk: string) => Promise<void>): Emitter {
  const secrets: string[] = [];
  let pending = Promise.resolve();
  let terminated = false;
  const emit = (event: EventBody) => {
    if (terminated) return;
    terminated = event.type === "result" || event.type === "error";
    const { type, ...fields } = event;
    let line = JSON.stringify({ type, at: new Date().toISOString(), ...fields });
    for (const secret of secrets) line = line.replaceAll(secret, "[REDACTED]");
    pending = write(`${line}\n`).catch(() => {});
  };
  return Object.assign(emit, {
    get terminated() {
      return terminated;
    },
    redact(secret: string) {
      if (secret) secrets.push(secret);
    },
    flush: () => pending,
  });
}

const PREVIEW_CHARS = 2000;
const TRUNCATED = "…[truncated]";

export function outputPreview(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  const text = content
    .map((c: { type?: string; text?: string }) => (c?.type === "text" ? (c.text ?? "") : `[${c?.type ?? "unknown"}]`))
    .join("\n");
  return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS - TRUNCATED.length) + TRUNCATED : text;
}

/** Undefined for all-zero usage (e.g. a request aborted before it was sent). */
export function toUsage(u: PiUsage): Usage | undefined {
  const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
  const usage: Usage = {
    input_tokens: count(u.input),
    output_tokens: count(u.output),
    cache_read_tokens: count(u.cacheRead),
    cache_write_tokens: count(u.cacheWrite),
  };
  if (usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens === 0) return undefined;
  const cost = u.cost?.total;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { ...usage, cost_usd: cost } : usage;
}
