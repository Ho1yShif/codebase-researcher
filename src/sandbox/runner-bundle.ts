import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { build, type Plugin } from "esbuild";
import { REPO_ROOT } from "./interface.ts";

/** Installed in the sandbox with `npm ci` from sandbox-runtime/deps; everything else is bundled. */
export const RUNNER_EXTERNALS = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "typebox"] as const;
const DEPS_DIR = join(REPO_ROOT, "sandbox-runtime/deps");
const INSTANCE_PROMPT_MAX_BYTES = 20 * 1024;

export type RunnerBundle = { "runner.mjs": string; "package.json": string; "package-lock.json": string };

const require = createRequire(import.meta.url);

/** Inlines `import text from "./file.md?raw"` as a string, matching Vite's `?raw` under vitest. */
const rawText: Plugin = {
  name: "raw-text",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => {
      const bare = args.path.slice(0, -"?raw".length);
      return { path: bare.startsWith(".") ? join(args.resolveDir, bare) : require.resolve(bare), namespace: "raw" };
    });
    b.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => ({ contents: await readFile(args.path, "utf8"), loader: "text" }));
  },
};

/** Bundles src/runner/main.ts into one ESM file plus the package.json and lockfile for its externals. */
export async function bundleRunner(): Promise<RunnerBundle> {
  const { size } = await stat(join(REPO_ROOT, "prompt.md"));
  if (size > INSTANCE_PROMPT_MAX_BYTES) {
    throw new Error(`prompt.md is ${size} bytes (limit ${INSTANCE_PROMPT_MAX_BYTES}). Trim it or raise INSTANCE_PROMPT_MAX_BYTES in src/sandbox/runner-bundle.ts.`);
  }

  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  const dependencies = Object.fromEntries(RUNNER_EXTERNALS.map((name) => [name, pkg.dependencies[name]]));
  for (const [name, version] of Object.entries(dependencies)) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${name} must be pinned to an exact version, got ${version}`);
  }
  const [depsPkg, lock] = await Promise.all(
    ["package.json", "package-lock.json"].map((name) => readFile(join(DEPS_DIR, name), "utf8")),
  ) as [string, string];
  if (
    !isDeepStrictEqual(JSON.parse(depsPkg), { type: "module", private: true, dependencies }) ||
    !isDeepStrictEqual(JSON.parse(lock).packages?.[""]?.dependencies, dependencies)
  ) {
    throw new Error(
      `sandbox-runtime/deps does not pin ${JSON.stringify(dependencies)}; update sandbox-runtime/deps/package.json, then run ` +
        "`npm install --package-lock-only --ignore-scripts` in sandbox-runtime/deps",
    );
  }

  const result = await build({
    absWorkingDir: join(REPO_ROOT, "src/runner"),
    entryPoints: ["main.ts"],
    outfile: "runner.mjs",
    write: false,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: RUNNER_EXTERNALS.flatMap((name) => [name, `${name}/*`]),
    plugins: [rawText],
    logLevel: "warning",
  });
  return { "runner.mjs": result.outputFiles[0]!.text, "package.json": depsPkg, "package-lock.json": lock };
}

/**
 * Writes the bundle to `dir` and returns the path of runner.mjs. `dir` must sit inside the repo so the
 * externals resolve from its node_modules.
 */
export async function writeRunnerBundle(dir: string): Promise<string> {
  const bundle = await bundleRunner();
  await mkdir(dir, { recursive: true });
  for (const [name, contents] of Object.entries(bundle)) await writeFile(join(dir, name), contents);
  return join(dir, "runner.mjs");
}
