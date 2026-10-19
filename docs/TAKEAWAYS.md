# Takeaways

The patterns in this project worth copying, and where each one lives. Items under "Running untrusted work in Sandboxes" apply to any Sandbox integration. Items under "Working with AI agents" are specific to running a coding agent next to an API key.

## Architecture

- **The question is the unit of work; channels are adapters.** The pipeline answers a transcript with an optional callback and metadata, and knows nothing about Slack. A new channel translates its events into the same question API without touching the investigation code. See [`src/question.ts`](../src/question.ts), [`src/slack/routes.ts`](../src/slack/routes.ts), [The question API](WALKTHROUGH.md#the-question-api), and [Add a channel beyond Slack](QUICKSTART.md#add-a-channel-beyond-slack).

- **Do expensive, privileged setup once in a builder; give every unit of work a fresh, unprivileged copy.** The hourly builder needs the network and git credentials; an investigation needs neither. Each question restores its own Sandbox from the snapshot and terminates it in a `finally` block, so no question sees another's leftovers. See [`src/sandbox/render/snapshot.ts`](../src/sandbox/render/snapshot.ts), [`src/tasks.ts`](../src/tasks.ts), and [Sandboxes](WALKTHROUGH.md#sandboxes).

- **Address snapshots by name, and keep the newest two.** Sandboxes are created from `snapshotName`, which resolves to the newest available snapshot, so the cron can replace it without coordinating with the workflow. Keeping two covers a question that started restoring just before a new build finished. See [`src/cron.ts`](../src/cron.ts) and `pruneSnapshots` in [`src/sandbox/render/snapshot.ts`](../src/sandbox/render/snapshot.ts).

- **Keep a local provider seam.** Application code depends on the `Sandbox` interface, not on Render's API, and a local implementation runs the same runner as a child process against local checkouts (with no isolation). The whole workflow runs on a laptop, and most tests never touch the cloud. See [`src/sandbox/interface.ts`](../src/sandbox/interface.ts), [`src/sandbox/local.ts`](../src/sandbox/local.ts), and [Repository layout](WALKTHROUGH.md#repository-layout).

## Running untrusted work in Sandboxes

- **Orchestrate from the host, script inside the sandbox.** Step order, timeouts, and error handling live in TypeScript, where they can be tested against a fake API. Anything long or security-critical that runs inside is a real shell script you can read and test locally. See `buildSnapshot` in [`src/sandbox/render/snapshot.ts`](../src/sandbox/render/snapshot.ts) and [`sandbox-runtime/`](../sandbox-runtime).

- **Order steps by trust.** Third-party code (the tool installer and the runner's self-test) runs before any credential is uploaded, and a test asserts that order. See `buildSnapshot` in [`src/sandbox/render/snapshot.ts`](../src/sandbox/render/snapshot.ts) and [`test/sandbox-render.test.ts`](../test/sandbox-render.test.ts).

- **Ship artifacts; don't install in the sandbox.** The runner is bundled on the host into one self-contained JavaScript file, so the sandbox needs only Node: no package manager, no install scripts, no registry access. See [`src/sandbox/runner-bundle.ts`](../src/sandbox/runner-bundle.ts).

- **Verify the sandbox you got, not the steps that built it.** `verify.sh` runs on the builder before the snapshot and on every restored sandbox before it gets work: repositories match the manifest, no credentials survived, checkouts are read-only, scratch is writable, the runner passes its self-test, and egress probes behave as the policy says. A sandbox that fails is terminated instead of used. See [`sandbox-runtime/verify.sh`](../sandbox-runtime/verify.sh) and `openRenderSandbox` in [`src/sandbox/render/sandbox.ts`](../src/sandbox/render/sandbox.ts).

- **Grant the least egress, and refuse more than you asked for.** Investigation Sandboxes allow one host, the model provider's API, derived from the model's base URL. If Render returns a sandbox with a different policy than requested, it is terminated rather than used. See [`src/sandbox/render/sandbox.ts`](../src/sandbox/render/sandbox.ts), [`src/sandbox/render/config.ts`](../src/sandbox/render/config.ts), and [The security boundary](WALKTHROUGH.md#the-security-boundary).

- **Deliver credentials as short-lived files.** Git tokens are uploaded as per-host files for the clone only, then scrubbed by a script that fails the build if any trace remains. The model key reaches each run as a file the runner deletes on read, and tool subprocesses get an environment built from an allowlist. Commands, URLs, and environment variables leak into process listings and `.git/config`, so secrets never go there. See [`sandbox-runtime/build/`](../sandbox-runtime/build), `takeCredentials` in [`src/runner/main.ts`](../src/runner/main.ts), and `shellEnv` in [`src/runner/tools.ts`](../src/runner/tools.ts).

- **Write results to files so a dropped exec stream is recoverable.** The run script writes the runner's events and its exit status to root-owned files beside the run folder. If the exec stream drops, the job keeps running, so the host polls for the exit file and then downloads the events. See `runInvestigation` in [`src/sandbox/render/sandbox.ts`](../src/sandbox/render/sandbox.ts) and [`sandbox-runtime/run-investigation.sh`](../sandbox-runtime/run-investigation.sh).

- **Put a deadline on every phase, plus a provider-side backstop.** `SANDBOX_PROVISION_TIMEOUT_MS` bounds restore, boot, and verification; the agent timeout is enforced inside the sandbox and again on the host; `timeoutSeconds` on create makes Render terminate a sandbox the host never closed. Task timeouts are computed from these budgets rather than set by hand. See [`src/sandbox/render/sandbox.ts`](../src/sandbox/render/sandbox.ts) and [`src/workflow.ts`](../src/workflow.ts).

## Working with AI agents

- **Validate model output against ground truth before accepting it.** The submit tool checks every citation against the manifest and the checkout (repository, commit, a real file inside the repository, a line range within it) and returns the list of problems so the model can fix them, up to three attempts. The host checks citations against the manifest again before delivering. See [`src/runner/submit.ts`](../src/runner/submit.ts) and `filterEvidence` in [`src/tasks.ts`](../src/tasks.ts).

- **Build anything users trust in trusted code.** Evidence URLs are built by the host from the validated citation and the repository's browse pattern; the model can't set them. Model-written text is escaped before rendering, so it can't ping a channel or disguise a link behind other text. See `buildEvidenceUrl` in [`src/investigation.ts`](../src/investigation.ts) and [`src/slack/format.ts`](../src/slack/format.ts).

- **Define a typed contract between host and runner.** Input and events are zod schemas in one file. The runner writes one JSON event per line to stdout, ends with exactly one `result` or `error`, and redacts secrets from every line; the host parses tolerantly, so a killed run still yields its partial events. See [`src/runner/protocol.ts`](../src/runner/protocol.ts), [`src/runner/events.ts`](../src/runner/events.ts), and [The runner](WALKTHROUGH.md#the-runner).

- **Retry infrastructure failures; report agent failures.** `classifyRun` turns agent outcomes (no submission, invalid submission, timeout) into a failure reply, and throws when the sandbox failed (lost stream, killed by a signal) so the workflow retries on a fresh Sandbox. Every path, including an unreadable question, still sends the caller a reply. See [`src/tasks.ts`](../src/tasks.ts) and [The workflow](WALKTHROUGH.md#the-workflow).

- **Treat a command filter as a usability guard, not a boundary.** The read-only shell policy rejects obvious writes and network tools so the model adapts instead of wasting turns, but shell parsing can be bypassed. The real barriers are filesystem permissions, the egress policy, and the allowlisted tool environment. See [`src/runner/tools.ts`](../src/runner/tools.ts).

- **Ship a deterministic mode that doesn't call a model.** `--faux` replays a scripted session through the real tools against the real checkouts and submits a citation that passes validation, so the pipeline can be tested end to end without an API key. See [`src/runner/faux.ts`](../src/runner/faux.ts) and [`test/runner.test.ts`](../test/runner.test.ts).

## Integration and operations

- **Acknowledge webhooks first, then do the work, keyed on the event ID.** Slack retries unless it gets a 200 within 3 seconds, so the adapter verifies the signature, responds, and only then reads the thread and starts the run. The event ID is the idempotency key, so a redelivered event doesn't start a second run. See [`src/slack/routes.ts`](../src/slack/routes.ts) and [The API service and Slack adapter](WALKTHROUGH.md#the-api-service-and-slack-adapter).

- **Sign what you hand out, and derive secrets instead of storing them.** Each callback is signed with `HMAC(key, event_id)` over a timestamp and the body, so the receiver verifies it without storing anything and a leaked secret is good for one question. Question IDs carry an HMAC keyed on `API_TOKEN`, so `GET /v1/questions/:id` can read only runs this API started. See [`src/callback.ts`](../src/callback.ts) and [`src/api.ts`](../src/api.ts).

- **Log one structured line per outcome.** Every question ends with a `turn_finished` line (outcome, model, prompt version, commits, tokens, cost, duration) and every cron run with a `snapshot_refresh` line, so each alert needs one filter. The cron also exits non-zero when a build fails. See [`src/log.ts`](../src/log.ts), [`src/cron.ts`](../src/cron.ts), and [Operate it](QUICKSTART.md#operate-it).

- **State residual risks plainly.** DNS still resolves inside the Sandbox, the model provider's host is shared with its other customers, and anyone who can ask can read the code. Each is written down with why it's accepted and what would close it. See [The security boundary](WALKTHROUGH.md#the-security-boundary) and [Out of scope](WALKTHROUGH.md#out-of-scope).

## Render platform features shown here

- **Workflows for durable, retried work.** One parent task runs two subtasks with their own retry and timeout policies: `investigate` retries infrastructure failures, `deliver` retries the callback POST, and the parent never retries. Task runs double as the question history, so there's no database. See [`src/workflow.ts`](../src/workflow.ts) and [The workflow](WALKTHROUGH.md#the-workflow).

- **Sandboxes and snapshots, with SDK gaps kept in one wrapper.** Named filesystem snapshots, per-sandbox network policies, and `timeoutSeconds` cover the lifecycle above. `SandboxClient` adds what SDK 1.2.0 leaves to callers (pacing for the 100-requests-a-minute limit, 429 and 503 retries, waiting for `running`, collecting exec output), and `wirePolicy` sends policies in the shape the API accepts; each piece can go when the SDK covers it. See [`src/sandbox/render/client.ts`](../src/sandbox/render/client.ts) and [`examples/hello-sandbox.ts`](../examples/hello-sandbox.ts), the full round trip in under 80 lines.

- **One Blueprint wires three services.** `fromService` passes the workflow's slug to the API, `generateValue` creates `API_TOKEN` and `SLACK_CALLBACK_KEY`, `sync: false` prompts for secrets at deploy time, and per-service `buildFilter` paths keep a runner change from redeploying the API. Plans are deliberate: a paid API instance so a spun-down instance doesn't miss Slack's deadline, and a standard cron because bundling the runner needs more than 512 MB. See [`render.yaml`](../render.yaml) and [Customize it](QUICKSTART.md#customize-it).
