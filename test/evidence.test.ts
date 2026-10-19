import { describe, expect, it } from "vitest";
import { buildEvidenceUrl, type Evidence, type FinalAnswer } from "../src/investigation.ts";
import type { RepoManifest } from "../src/manifest.ts";
import { filterEvidence } from "../src/tasks.ts";

const sha = "a".repeat(40);
const manifest: RepoManifest = {
  profile: "test",
  created_at: new Date().toISOString(),
  repos: [
    { repository: "acme/api", branch: "main", commit: sha, path: "/opt/researcher/repos/acme/api" },
  ],
};

const evidence = (overrides: Partial<Evidence> = {}): Evidence => ({
  repository: "acme/api",
  commit: sha.slice(0, 7),
  path: "src/main.ts",
  start_line: 1,
  end_line: 10,
  ...overrides,
});

const finalAnswer = (ev: Evidence[]): FinalAnswer => ({
  status: "final_answer",
  answer: "test",
  confidence: "high",
  observed_in_code: ["x"],
  inferred_behavior: [],
  not_established: [],
  evidence: ev,
  suggested_owner: "team",
  escalation_question: "?",
});

describe("filterEvidence", () => {
  it("sets a GitHub url on kept evidence by default", () => {
    const { result, dropped } = filterEvidence(finalAnswer([evidence()]), manifest);
    expect(dropped).toEqual([]);
    expect(result.status === "final_answer" && result.evidence[0]?.url).toBe(
      `https://github.com/acme/api/blob/${sha}/src/main.ts#L1-L10`,
    );
  });

  it("overwrites a model-supplied url", () => {
    const e = evidence({ url: "https://evil.example.com" });
    const { result } = filterEvidence(finalAnswer([e]), manifest);
    expect(result.status === "final_answer" && result.evidence[0]?.url).toMatch(/^https:\/\/github\.com\//);
    expect(result.status === "final_answer" && result.evidence[0]?.url).not.toContain("evil");
  });

  it("uses browse and url from the manifest repo when present", () => {
    const m: RepoManifest = {
      ...manifest,
      repos: [{ ...manifest.repos[0]!, browse: "gitlab", url: "https://gitlab.com/acme/platform/api.git" } as RepoManifest["repos"][number]],
    };
    const { result } = filterEvidence(finalAnswer([evidence()]), m);
    expect(result.status === "final_answer" && result.evidence[0]?.url).toBe(
      `https://gitlab.com/acme/platform/api/-/blob/${sha}/src/main.ts#L1-L10`,
    );
  });

  it("passes through a needs_clarification result unchanged", () => {
    const clarify = { status: "needs_clarification" as const, question: "?", why_needed: "x" };
    const { result, dropped } = filterEvidence(clarify, manifest);
    expect(result).toEqual(clarify);
    expect(dropped).toEqual([]);
  });
});

const linksSha = "0123456789abcdef0123456789abcdef01234567";
const e = { repository: "acme/api", commit: linksSha, path: "src/main.ts", start_line: 10, end_line: 24 };

describe("buildEvidenceUrl", () => {
  it("defaults to the existing GitHub URL shape", () => {
    expect(buildEvidenceUrl(e)).toBe(
      `https://github.com/acme/api/blob/${linksSha}/src/main.ts#L10-L24`,
    );
  });

  it("encodes path segments", () => {
    expect(buildEvidenceUrl({ ...e, path: "./docs/a b|c>.md", start_line: 3, end_line: 3 })).toBe(
      `https://github.com/acme/api/blob/${linksSha}/docs/a%20b%7Cc%3E.md#L3-L3`,
    );
  });

  it("builds a GitLab URL from the clone URL", () => {
    const url = buildEvidenceUrl(e, "gitlab", "https://gitlab.com/acme/platform/api.git");
    expect(url).toBe(`https://gitlab.com/acme/platform/api/-/blob/${linksSha}/src/main.ts#L10-L24`);
  });

  it("builds a Bitbucket URL from the clone URL", () => {
    const url = buildEvidenceUrl(e, "bitbucket", "https://bitbucket.org/acme/api.git");
    expect(url).toBe(`https://bitbucket.org/acme/api/src/${linksSha}/src/main.ts#lines-10:24`);
  });

  it("expands a custom template", () => {
    const tpl = "{base}/-/blob/{commit}/{path}?start={start}&end={end}";
    const url = buildEvidenceUrl(e, tpl, "https://git.corp.example.com/acme/api.git");
    expect(url).toBe(`https://git.corp.example.com/acme/api/-/blob/${linksSha}/src/main.ts?start=10&end=24`);
  });

  it("uses github.com/{repository} as the base when no URL is given", () => {
    const url = buildEvidenceUrl(e, "gitlab");
    expect(url).toBe(`https://github.com/acme/api/-/blob/${linksSha}/src/main.ts#L10-L24`);
  });
});
