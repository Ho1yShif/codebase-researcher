import { z } from "zod";

export const TranscriptMessage = z.object({
  ts: z.string(),
  user_id: z.string().nullable(),
  is_agent: z.boolean(),
  text: z.string(),
  at: z.iso.datetime().optional(),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessage>;

export const Transcript = z.array(TranscriptMessage);
export type Transcript = z.infer<typeof Transcript>;

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

export const Evidence = z.object({
  repository: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  path: z.string().min(1),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  url: z.url().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

export const NeedsClarification = z.object({
  status: z.literal("needs_clarification"),
  question: z.string().min(1),
  why_needed: z.string().min(1),
});
export type NeedsClarification = z.infer<typeof NeedsClarification>;

export const FinalAnswer = z.object({
  status: z.literal("final_answer"),
  answer: z.string().min(1),
  confidence: Confidence,
  observed_in_code: z.array(z.string()),
  inferred_behavior: z.array(z.string()),
  not_established: z.array(z.string()),
  evidence: z.array(Evidence),
  suggested_owner: z.string().min(1),
  escalation_question: z.string().min(1),
});
export type FinalAnswer = z.infer<typeof FinalAnswer>;

export const InvestigationResult = z.discriminatedUnion("status", [NeedsClarification, FinalAnswer]);
export type InvestigationResult = z.infer<typeof InvestigationResult>;

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

const cleanPath = (raw: string) => encodePath(raw.replace(/^(\.?\/)+/, ""));

function browseBase(repoUrl: string | undefined, repository: string): string {
  if (repoUrl) return repoUrl.replace(/\.git$/, "");
  return `https://github.com/${repository}`;
}

export function buildEvidenceUrl(
  e: Pick<Evidence, "repository" | "commit" | "path" | "start_line" | "end_line">,
  browse?: string,
  repoUrl?: string,
): string {
  const path = cleanPath(e.path);
  const base = browseBase(repoUrl, e.repository);

  switch (browse ?? "github") {
    case "github":
      return `https://github.com/${encodePath(e.repository)}/blob/${e.commit}/${path}#L${e.start_line}-L${e.end_line}`;
    case "gitlab":
      return `${base}/-/blob/${e.commit}/${path}#L${e.start_line}-L${e.end_line}`;
    case "bitbucket":
      return `${base}/src/${e.commit}/${path}#lines-${e.start_line}:${e.end_line}`;
    default:
      return browse!
        .replaceAll("{base}", base)
        .replaceAll("{repository}", e.repository)
        .replaceAll("{commit}", e.commit)
        .replaceAll("{path}", path)
        .replaceAll("{start}", String(e.start_line))
        .replaceAll("{end}", String(e.end_line));
  }
}
