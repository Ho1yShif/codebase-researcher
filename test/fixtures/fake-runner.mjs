// Stand-in for the bundled runner.mjs that follows its CLI contract.
// Behavior is selected by input.model: "hang" never finishes, "keep-key" leaves the key file in place.
import { existsSync, readFileSync, unlinkSync } from "node:fs";

const args = process.argv.slice(2);
const at = new Date().toISOString();
if (args.includes("--self-test")) {
  console.log(JSON.stringify({ ok: true, pi_version: "0.0.0-fake", prompt_version: "fake" }));
  process.exit(0);
}

const keyPath = args.includes("--key-file") ? args[args.indexOf("--key-file") + 1] : null;
const input = JSON.parse(readFileSync(0, "utf8"));
let key = null;
if (keyPath) {
  key = readFileSync(keyPath, "utf8");
  if (input.model !== "keep-key") unlinkSync(keyPath);
}

// Split each line across writes so readers must line-buffer.
const emit = (event) => {
  const line = `${JSON.stringify(event)}\n`;
  process.stdout.write(line.slice(0, 7));
  process.stdout.write(line.slice(7));
};
emit({ type: "started", at, pi_version: "0.0.0-fake", model: input.model, prompt_version: "fake" });
process.stdout.write("this is not json\n");
const report = {
  key,
  keyPath,
  keyFileGone: keyPath ? !existsSync(keyPath) : null,
  keyInEnv: key !== null && Object.values(process.env).includes(key),
  cwd: process.cwd(),
  envKeys: Object.keys(process.env).sort(),
};
emit({ type: "assistant_text", at, text: JSON.stringify(report) });
process.stderr.write("fake runner diagnostics\n");

if (input.model === "hang") {
  setInterval(() => {}, 1000);
} else {
  emit({ type: "result", at, result: { status: "needs_clarification", question: "Which region?", why_needed: "Routing differs." } });
}
