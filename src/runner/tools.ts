import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  type AgentTool,
  type BashToolDetails,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExecutionToolContext,
  type ReadToolDetails,
  createBashTool,
  createReadTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Type } from "typebox";

/*
 * Usability guard, not a security boundary: it rejects obviously mutating or networked commands so the
 * model gets a clear message and adapts instead of burning turns. Shell parsing here is approximate and
 * can be bypassed. The real write barrier is filesystem permissions on the snapshot's read-only checkouts;
 * the real network barrier is the sandbox egress policy.
 */

const READ_ONLY_GIT = new Set([
  "annotate", "blame", "branch", "cat-file", "check-attr", "check-ignore", "cherry", "config", "describe",
  "diff", "diff-files", "diff-index", "diff-tree", "for-each-ref", "grep", "help", "log", "ls-files",
  "ls-tree", "merge-base", "name-rev", "range-diff", "rev-list", "rev-parse", "shortlog", "show",
  "show-ref", "status", "tag", "version", "whatchanged",
]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);
const BRANCH_WRITE_FLAGS = new Set([
  "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-f", "--force", "-u",
  "--set-upstream-to", "--unset-upstream", "--edit-description", "-t", "--track", "--no-track",
]);
const TAG_WRITE_FLAGS = new Set([
  "-d", "--delete", "-a", "--annotate", "-s", "--sign", "-u", "--local-user", "-m", "--message", "-F",
  "--file", "-f", "--force", "-e", "--edit",
]);
const REF_LIST_VALUE_FLAGS = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]);
const CONFIG_WRITE_FLAGS = new Set([
  "--global", "--system", "--add", "--unset", "--unset-all", "--replace-all", "--rename-section",
  "--remove-section", "-e", "--edit", "set", "unset", "rename-section", "remove-section", "edit",
]);

const DENIED = new Map<string, string>([
  ...["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp", "socat"].map(
    (c) => [c, "there is no network access"] as const,
  ),
  ...["sudo", "su", "doas"].map((c) => [c, "privilege escalation is not allowed"] as const),
  ...["npx", "bunx"].map((c) => [c, "downloading packages needs the network"] as const),
]);
const INSTALL_VERBS: Record<string, string[]> = {
  npm: ["install", "i", "ci", "add", "update", "exec"],
  pnpm: ["install", "i", "add", "update", "dlx"],
  yarn: ["install", "add", "dlx"],
  bun: ["install", "i", "add"],
  pip: ["install"],
  pip3: ["install"],
  pipx: ["install"],
  uv: ["install", "add", "sync"],
  gem: ["install"],
  cargo: ["install"],
  go: ["get", "install"],
  "apt-get": ["install"],
  apt: ["install"],
  apk: ["add"],
  brew: ["install"],
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
/** Prefix commands whose arguments are another command, with the flags that take a separate value. */
const WRAPPERS: Record<string, string[]> = {
  env: ["-u", "-C", "--unset", "--chdir"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  nice: ["-n", "--adjustment"],
  xargs: ["-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a"],
  stdbuf: ["-i", "-o", "-e"],
  command: [],
  exec: [],
  time: [],
  nohup: [],
  builtin: [],
};

export interface PolicyContext {
  scratchDir: string;
}

/** Returns why `command` is rejected, or undefined if it may run. */
export function rejectReason(command: string, ctx: PolicyContext): string | undefined {
  for (const words of splitCommands(command)) {
    const reason = checkSimpleCommand(words, ctx);
    if (reason) return reason;
  }
  return undefined;
}

function checkSimpleCommand(words: string[], ctx: PolicyContext): string | undefined {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) i++;
    else if (Object.hasOwn(WRAPPERS, basename(word))) i = skipWrapperArgs(basename(word), words, i + 1);
    else break;
  }
  if (i >= words.length) return undefined;
  const name = basename(words[i]!);
  const args = words.slice(i + 1);

  const denied = DENIED.get(name);
  if (denied) return `${name} is not allowed: ${denied}`;
  const verb = args.find((a) => !a.startsWith("-"));
  if (verb && INSTALL_VERBS[name]?.includes(verb)) return `${name} ${verb} is not allowed: installing packages needs the network`;
  if (name === "git") return checkGit(args);
  if (name === "chmod" || name === "chown" || name === "chgrp") return checkPermissionChange(name, args, ctx);
  if (SHELLS.has(name)) {
    const script = args[args.indexOf("-c") + 1];
    return args.includes("-c") && script ? rejectReason(script, ctx) : undefined;
  }
  if (name === "eval") return rejectReason(args.join(" "), ctx);
  return undefined;
}

function skipWrapperArgs(wrapper: string, words: string[], i: number): number {
  const valueFlags = WRAPPERS[wrapper]!;
  let sawDuration = false;
  while (i < words.length) {
    const word = words[i]!;
    if (word.startsWith("-")) i += valueFlags.includes(word) ? 2 : 1;
    else if (wrapper === "timeout" && !sawDuration) (sawDuration = true), i++;
    else break;
  }
  return i;
}

function checkGit(args: string[]): string | undefined {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    const arg = args[i]!;
    if (arg === "-c" || arg.startsWith("--config-env") || arg.startsWith("--exec-path")) {
      return `git ${arg} is not allowed: it can run arbitrary commands via config`;
    }
    i += GIT_OPTIONS_WITH_VALUE.has(arg) ? 2 : 1;
  }
  const sub = args[i];
  if (sub === undefined) return undefined;
  const rest = args.slice(i + 1);
  if (!READ_ONLY_GIT.has(sub)) {
    return `git ${sub} is not allowed: the checkouts are read-only (allowed: ${[...READ_ONLY_GIT].join(", ")})`;
  }
  if ((sub === "branch" || sub === "tag") && !isRefListing(sub, rest)) {
    return `git ${sub} may only list refs here (e.g. git ${sub} --list, git ${sub} --contains <commit>)`;
  }
  if (sub === "config") {
    const write = rest.find((a) => CONFIG_WRITE_FLAGS.has(a.split("=")[0]!));
    const positional = rest.filter((a) => !a.startsWith("-"));
    if (write || positional.length > 1) return "git config may only read values here (e.g. git config --get <key>, git config --list)";
  }
  return undefined;
}

function isRefListing(sub: "branch" | "tag", rest: string[]): boolean {
  const writeFlags = sub === "branch" ? BRANCH_WRITE_FLAGS : TAG_WRITE_FLAGS;
  if (rest.some((a) => writeFlags.has(a.split("=")[0]!))) return false;
  if (rest.includes("-l") || rest.includes("--list")) return true;
  for (let i = 0; i < rest.length; i++) {
    if (REF_LIST_VALUE_FLAGS.has(rest[i]!)) i++;
    else if (!rest[i]!.startsWith("-")) return false;
  }
  return true;
}

function checkPermissionChange(name: string, args: string[], ctx: PolicyContext): string | undefined {
  const operands = args.filter((a) => !a.startsWith("-"));
  const targets = operands.slice(1);
  const inScratch = (p: string) =>
    p === ctx.scratchDir || p.startsWith(`${ctx.scratchDir}/`) || /^(\$\{?(TMPDIR|HOME)\}?|~)(\/|$)/.test(p);
  if (targets.length > 0 && targets.every(inScratch)) return undefined;
  return `${name} is only allowed on files in the scratch directory (${ctx.scratchDir})`;
}

/**
 * Splits a shell command line into simple commands (lists of words with quotes removed). Command
 * substitutions and subshells become separate commands, so `echo $(curl x)` yields ["echo"], ["curl", "x"].
 */
export function splitCommands(line: string): string[][] {
  type Quote = "'" | '"' | undefined;
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: Quote;
  // Open substitutions: the char that closes each one and the quote state to resume after it.
  const open: Array<{ close: ")" | "`"; quote: Quote }> = [];
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else word += c;
      continue;
    }
    if (c === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
      continue;
    }
    if (!quote && c === open.at(-1)?.close) {
      endCommand();
      quote = open.pop()!.quote;
      inWord = quote !== undefined;
      continue;
    }
    if (c === "`" || (c === "$" && line[i + 1] === "(")) {
      // Substitutions run even inside double quotes; their body is parsed unquoted.
      endCommand();
      open.push({ close: c === "`" ? "`" : ")", quote });
      quote = undefined;
      if (c === "$") i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = undefined;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (/\s/.test(c) && c !== "\n") {
      endWord();
    } else if (";&|()\n".includes(c)) {
      endCommand();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 300;
const LS_DEFAULT_LIMIT = 500;
const LS_MAX_LIMIT = 2000;
const OUTPUT_LIMIT = `${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES / 1024}KB`;

export interface InspectionToolOptions {
  reposRoot: string;
  scratchDir: string;
}

/**
 * Builds the child env from an allowlist so nothing from the runner's environment (model credentials,
 * pool metadata) can reach a model-controlled process.
 */
export function shellEnv(path: string | undefined, scratchDir: string): Record<string, string> {
  return {
    PATH: path || "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG || "C.UTF-8",
    HOME: scratchDir,
    TMPDIR: scratchDir,
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    // Checkouts can be owned by another uid (read-only mount); without this git refuses "dubious ownership".
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };
}

/** The read-only tools the agent gets, all rooted at the checkouts. */
export function createInspectionTools(opts: InspectionToolOptions): AgentTool<any>[] {
  const context: ExecutionToolContext = {
    env: new NodeExecutionEnv({ cwd: opts.reposRoot, shellEnv: shellEnv(process.env.PATH, opts.scratchDir) }),
  };
  return [createTextReadTool(context, opts), createLsTool(opts), createSafeBashTool(context, opts)];
}

/** Pi's read tool without image attachments: the agent investigates source, and images only cost tokens. */
function createTextReadTool(context: ExecutionToolContext, { reposRoot }: InspectionToolOptions) {
  const inner = createReadTool();
  const tool: AgentTool<typeof inner.parameters, ReadToolDetails | undefined> = {
    ...inner,
    description:
      `Read a text file. path is relative to ${reposRoot} or absolute. offset is the first line to read (1-based) and ` +
      `limit the number of lines. Output is truncated to ${OUTPUT_LIMIT}; continue with offset for the rest.`,
    async execute(toolCallId, params, signal) {
      const result = await inner.execute(toolCallId, params, signal, undefined, context);
      const content = result.content.map((c) => (c.type === "image" ? { type: "text" as const, text: "[image omitted]" } : c));
      return { ...result, content };
    },
  };
  return tool;
}

const LsParams = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list, relative to the repositories root or absolute (default: the root)" })),
  limit: Type.Optional(Type.Integer({ description: `Maximum entries to return (default ${LS_DEFAULT_LIMIT})` })),
});

function createLsTool({ reposRoot }: InspectionToolOptions): AgentTool<typeof LsParams> {
  return {
    name: "ls",
    label: "ls",
    description: `List a directory's entries in sorted order, with a trailing / on directories. Paths are relative to ${reposRoot}.`,
    parameters: LsParams,
    async execute(_toolCallId, { path, limit }) {
      const entries = await readdir(resolve(reposRoot, path ?? "."), { withFileTypes: true });
      const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort((a, b) => a.localeCompare(b));
      const max = Math.min(Math.max(limit ?? LS_DEFAULT_LIMIT, 1), LS_MAX_LIMIT);
      let text = names.slice(0, max).join("\n") || "(empty directory)";
      if (names.length > max) text += `\n\n[${names.length - max} more entries; raise limit or use bash]`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

/** Pi's bash tool with an allowlisted env, the read-only command policy, and bounded timeouts. */
function createSafeBashTool(context: ExecutionToolContext, { reposRoot, scratchDir }: InspectionToolOptions) {
  const inner = createBashTool({
    prepare: (execution) => {
      execution.cwd = reposRoot;
      execution.env = shellEnv(process.env.PATH, scratchDir);
      execution.inheritEnv = false;
    },
  });
  const tool: AgentTool<typeof inner.parameters, BashToolDetails | undefined> = {
    ...inner,
    description:
      `Run a bash command for read-only inspection. Working directory: ${reposRoot} (repositories at <owner>/<name>). ` +
      `Writable scratch directory: ${scratchDir} ($HOME and $TMPDIR point there). ` +
      "Use it to search (rg, git -C <owner>/<name> grep, find), for git history (git -C <owner>/<name> log/show/blame/diff/ls-files), " +
      "sed -n, wc, and small scripts or tests that do not modify the checkouts. Mutating git commands, network tools, package installs " +
      `and sudo are rejected. Output keeps the last ${OUTPUT_LIMIT}. timeout is in seconds: default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}.`,
    async execute(toolCallId, params, signal, onUpdate) {
      const reason = rejectReason(params.command, { scratchDir });
      if (reason) {
        throw new Error(
          `Command rejected by the read-only shell policy: ${reason}. ` +
            "The checkouts are read-only and there is no network; inspect with read-only commands instead.",
        );
      }
      const timeout = Math.min(Math.max(params.timeout ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
      return inner.execute(toolCallId, { ...params, timeout }, signal, onUpdate, context);
    },
  };
  return tool;
}

