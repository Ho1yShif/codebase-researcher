import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerInput } from "../types.ts";
import {
  type FauxProviderHandle,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "./main.ts";
import { SUBMIT_TOOL } from "./submit.ts";

export const FAUX_MODEL = "faux";
export type FauxScript = (input: RunnerInput) => FauxResponseStep[];

export function registerFauxModel(modelRuntime: ModelRuntime, steps: FauxResponseStep[]): { model: Model; faux: FauxProviderHandle } {
  const faux = fauxProvider({ provider: FAUX_MODEL, models: [{ id: FAUX_MODEL, reasoning: false }] });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(steps);
  return { model: faux.getModel(), faux };
}

const toolUse = { stopReason: "toolUse" } as const;
const call = (name: string, args: Record<string, unknown>, note?: string) =>
  fauxAssistantMessage(note ? [fauxText(note), fauxToolCall(name, args)] : fauxToolCall(name, args), toolUse);

/**
 * Deterministic `--faux` run that exercises the real tools against the real checkouts: list the repos root,
 * read git history and a real file from the first manifest repository, then submit a citation of that file.
 * A latest human message containing "clarify" gets needs_clarification instead (for two-turn tests).
 */
export const defaultFauxScript: FauxScript = (input) => {
  const ls = call("ls", { path: input.repos_root }, "[faux] Listing the repositories root.");
  const latestHuman = input.transcript.findLast((m) => !m.is_agent);
  if (/\bclarify\b/i.test(latestHuman?.text ?? "")) {
    return [
      ls,
      call(SUBMIT_TOOL, {
        status: "needs_clarification",
        question: "[faux test] Which service type and region does your question apply to?",
        why_needed: "[faux test] Deterministic faux-provider clarification; no model was called.",
      }),
    ];
  }

  const repo = input.manifest.repos[0]!;
  const file = citableFile(join(input.repos_root, repo.repository));
  const endLine = Math.min(file.lines, 20);
  return [
    ls,
    call("bash", { command: `git -C ${repo.repository} log -1 --format='%H %s'` }),
    call("read", { path: `${repo.repository}/${file.path}`, limit: endLine }),
    call(SUBMIT_TOOL, {
      status: "final_answer",
      answer: `[faux test answer] Deterministic faux-provider run; no model was called and nothing was investigated. It read ${repo.repository}/${file.path} to exercise the tools.`,
      confidence: "low",
      observed_in_code: [`[faux] ${repo.repository} contains ${file.path} (${file.lines} lines) at the manifest commit.`],
      inferred_behavior: [],
      not_established: ["[faux] Everything: this answer was produced by the faux provider."],
      evidence: [{ repository: repo.repository, commit: repo.commit, path: file.path, start_line: 1, end_line: endLine }],
      suggested_owner: "[faux] n/a",
      escalation_question: "[faux] None; this was a test run.",
    }),
  ];
};

/** The repository's root README if tracked, else its first tracked non-empty file. */
function citableFile(repoDir: string): { path: string; lines: number } {
  const tracked = execFileSync("git", ["-c", "safe.directory=*", "-C", repoDir, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const ordered = [...tracked.filter((p) => /^readme(\.[a-z]+)?$/i.test(p)), ...tracked];
  for (const path of ordered) {
    const full = join(repoDir, path);
    if (!lstatSync(full).isFile()) continue;
    const text = readFileSync(full, "utf8");
    if (text.length > 0) return { path, lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0) };
  }
  throw new Error(`faux: no tracked non-empty file in ${repoDir}`);
}
