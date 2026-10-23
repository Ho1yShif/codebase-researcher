// Used by the workflow's `deliver` subtask (signs) and by TypeScript callback
// receivers (verifies). Note: callback secrets travel in task input, which is
// visible in the Render Dashboard.

import { createHmac, timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function signCallback(
  secret: string,
  body: string,
  timestampSeconds?: number,
): { signature: string; timestamp: number } {
  const ts = timestampSeconds ?? Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return { signature: `v1=${sig}`, timestamp: ts };
}

const CALLBACK_MAX_SKEW_SECONDS = 5 * 60;

export function verifyCallback(opts: {
  secret: string;
  signature: string | undefined;
  timestamp: string | number | undefined;
  body: string;
  maxAgeSeconds?: number;
  nowSeconds?: number;
}): boolean {
  const { signature, timestamp } = opts;
  if (!signature || timestamp === undefined) return false;
  const ts = typeof timestamp === "number" ? timestamp : Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (opts.maxAgeSeconds ?? CALLBACK_MAX_SKEW_SECONDS)) return false;
  const expected = `v1=${createHmac("sha256", opts.secret).update(`${ts}.${opts.body}`).digest("hex")}`;
  return safeEqual(expected, signature);
}
