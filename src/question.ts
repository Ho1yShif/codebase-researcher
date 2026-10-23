import { z } from "zod";
import { MESSAGE_MAX_CHARS, Transcript, type FinalAnswer, type NeedsClarification } from "./investigation.ts";

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

/** The `answer_question` workflow input. The API builds the transcript from a question and, for a follow-up, the earlier run. */
export const AnswerQuestionInput = z.object({
  transcript: Transcript,
  callback: Callback.optional(),
  metadata: QuestionMetadata.optional(),
});
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInput>;

export type StartQuestion = (
  input: AnswerQuestionInput,
  opts: { idempotencyKey?: string; signal: AbortSignal },
) => Promise<{ id: string }>;

/** The workflow's output, also served by GET /v1/questions/:id. */
export type Reply =
  | { kind: "answer"; traceId: string; result: FinalAnswer; model?: string; manifestCreatedAt?: string }
  | { kind: "clarification"; traceId: string; result: NeedsClarification }
  | { kind: "failure"; traceId: string; reason: string };

/** The agent's turn in a follow-up's transcript: what the asker saw, plus the citations behind an answer. */
export function replyText(reply: Reply): string {
  let text: string;
  switch (reply.kind) {
    case "answer":
      text = [
        reply.result.answer,
        ...reply.result.evidence.map((e) => `- ${e.repository}@${e.commit.slice(0, 12)} ${e.path}:${e.start_line}-${e.end_line}`),
      ].join("\n");
      break;
    case "clarification":
      text = reply.result.question;
      break;
    case "failure":
      text = `I couldn't complete this investigation: ${reply.reason}.`;
      break;
  }
  return text.slice(0, MESSAGE_MAX_CHARS);
}
