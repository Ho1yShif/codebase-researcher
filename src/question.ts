import { z } from "zod";
import type { FinalAnswer, NeedsClarification, Transcript } from "./investigation.ts";

export const MESSAGE_MAX_CHARS = 8000;
export const TRANSCRIPT_MAX_MESSAGES = 200;

export const ApiTranscriptMessage = z.object({
  text: z.string().max(MESSAGE_MAX_CHARS),
  author: z.string().optional(),
  is_agent: z.boolean().optional(),
});
export type ApiTranscriptMessage = z.infer<typeof ApiTranscriptMessage>;

/** The public transcript shape accepted by POST /v1/questions. */
export const ApiTranscript = z.array(ApiTranscriptMessage).min(1).max(TRANSCRIPT_MAX_MESSAGES);
export type ApiTranscript = z.infer<typeof ApiTranscript>;

/** Convert the public transcript shape to the internal one the runner expects. */
export function toInternalTranscript(api: ApiTranscript): Transcript {
  return api.map((m, i) => ({
    ts: String(i),
    user_id: m.author ?? null,
    is_agent: m.is_agent ?? false,
    text: m.text,
  }));
}

export const Callback = z.object({
  url: z.string(),
  secret: z.string().min(16).max(256),
});
export type Callback = z.infer<typeof Callback>;

export const QuestionMetadata = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
).refine((r) => Object.keys(r).length <= 16, "metadata may have at most 16 keys");
export type QuestionMetadata = z.infer<typeof QuestionMetadata>;

export const AnswerQuestionInput = z.object({
  transcript: ApiTranscript,
  callback: Callback.optional(),
  metadata: QuestionMetadata.optional(),
});
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInput>;

/** Starts an `answer_question` run; shared by the HTTP API and the Slack adapter. */
export type StartQuestion = (
  input: { transcript: ApiTranscript; callback?: Callback; metadata?: QuestionMetadata },
  opts: { idempotencyKey?: string; signal: AbortSignal },
) => Promise<{ id: string }>;

/** The workflow's output, also served by GET /v1/questions/:id. */
export type Reply =
  | { kind: "answer"; traceId: string; result: FinalAnswer; model?: string; manifestCreatedAt?: string }
  | { kind: "clarification"; traceId: string; result: NeedsClarification }
  | { kind: "failure"; traceId: string; reason: string };
