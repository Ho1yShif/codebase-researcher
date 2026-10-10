import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build, type Plugin } from "esbuild";
import { REPO_ROOT } from "./interface.ts";

const INSTANCE_PROMPT_MAX_BYTES = 20 * 1024;

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

/**
 * Bundles src/runner/main.ts and every package it uses into one self-contained ESM file, so the sandbox
 * needs only Node to run it: no npm, no node_modules.
 */
export async function bundleRunner(): Promise<string> {
  const { size } = await stat(join(REPO_ROOT, "prompt.md"));
  if (size > INSTANCE_PROMPT_MAX_BYTES) {
    throw new Error(`prompt.md is ${size} bytes (limit ${INSTANCE_PROMPT_MAX_BYTES}). Trim it or raise INSTANCE_PROMPT_MAX_BYTES in src/sandbox/runner-bundle.ts.`);
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
    // Bundled CommonJS dependencies call require() for Node built-ins, which ESM doesn't define.
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    plugins: [rawText],
    logLevel: "warning",
  });
  return result.outputFiles[0]!.text;
}

/** Writes the bundle to `dir/runner.mjs` and returns that path. */
export async function writeRunnerBundle(dir: string): Promise<string> {
  const path = join(dir, "runner.mjs");
  await mkdir(dir, { recursive: true });
  await writeFile(path, await bundleRunner());
  return path;
}
