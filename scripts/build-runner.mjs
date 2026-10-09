import { copyFile, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../src/runner/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
// Installed inside the sandbox with `npm ci --omit=dev --ignore-scripts` from the committed sandbox-deps/
// package.json + package-lock.json (copied into dist/); everything else is bundled.
const EXTERNAL = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"];
const DEPS_DIR = join(repoRoot, "sandbox/deps");
const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));

const INSTANCE_PROMPT_MAX_BYTES = 20 * 1024;

/** Inlines `import text from "./file.md?raw"` as a string, matching Vite's `?raw` under vitest. */
const rawText = {
  name: "raw-text",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => {
      const bare = args.path.slice(0, -"?raw".length);
      const resolved = bare.startsWith(".") ? join(args.resolveDir, bare) : require.resolve(bare);
      return { path: resolved, namespace: "raw" };
    });
    b.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => ({ contents: await readFile(args.path, "utf8"), loader: "text" }));
  },
};

await build({
  absWorkingDir: root,
  entryPoints: [join(root, "main.ts")],
  outfile: join(repoRoot, "sandbox/dist/runner.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNAL.flatMap((name) => [name, `${name}/*`]),
  plugins: [rawText],
  logLevel: "warning",
});

const instancePromptPath = join(repoRoot, "prompt.md");
const { size } = await stat(instancePromptPath);
if (size > INSTANCE_PROMPT_MAX_BYTES) {
  throw new Error(
    `instance/prompt.md is ${size} bytes (limit ${INSTANCE_PROMPT_MAX_BYTES}). ` +
      "Trim it or raise INSTANCE_PROMPT_MAX_BYTES in sandbox/runner/build.mjs.",
  );
}

const dependencies = Object.fromEntries(EXTERNAL.map((name) => [name, pkg.dependencies[name]]));
for (const [name, version] of Object.entries(dependencies)) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${name} must be pinned to an exact version, got ${version}`);
}
const readJson = async (name) => JSON.parse(await readFile(join(DEPS_DIR, name), "utf8"));
const [depsPkg, lock] = await Promise.all([readJson("package.json"), readJson("package-lock.json")]);
if (
  !isDeepStrictEqual(depsPkg, { type: "module", private: true, dependencies }) ||
  !isDeepStrictEqual(lock.packages?.[""]?.dependencies, dependencies)
) {
  throw new Error(
    `sandbox-deps/ does not pin ${JSON.stringify(dependencies)}; update sandbox-deps/package.json, then run ` +
      "`npm install --package-lock-only --ignore-scripts` in sandbox/runner/sandbox-deps",
  );
}
for (const name of ["package.json", "package-lock.json"]) await copyFile(join(DEPS_DIR, name), join(repoRoot, "sandbox/dist", name));
