# support-triage-bot

A template for getting evidence-backed answers to support questions about your codebases. Fork this repo, point it at your repositories and model, deploy three services on Render, and start asking questions through the HTTP API or Slack.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/render-examples/support-triage-bot)

The button deploys this repository as is, investigating its example corpus: three public repositories (the Render CLI, SDK, and agent skills). To point it at your own code, fork first and deploy your fork.

Each question runs inside a fresh, isolated Sandbox restored from an hourly snapshot of your repositories. An AI coding agent reads the code with read-only tools, validates every citation against the checkout, and returns a structured answer: short answer, confidence level, observations, inferences, unknowns, file-and-line evidence, a suggested owner, and an escalation-ready question for engineering.

## How a question flows

1. A caller posts a question to `POST /v1/questions` (or mentions the bot in Slack, which calls the same endpoint internally). The API starts an `answer_question` workflow run and returns `202 { id }`.
2. The workflow starts the `investigate` subtask, which restores a fresh Sandbox from the current repository snapshot.
3. Inside the Sandbox, the runner starts the coding agent with the conversation transcript and the repository manifest. The agent reads code, git history, and search results through read-only tools, then calls `submit_investigation` with a structured result. Every cited file, commit, and line range is validated against the checkout before the submission is accepted.
4. The workflow collects the result and, if the caller included a callback URL, starts the `deliver` subtask to POST the signed result back.
5. The Sandbox is terminated in a `finally` block and never reused.
6. An hourly cron job rebuilds the repository snapshot. It clones the configured repos into a builder Sandbox, locks them down, and keeps the newest two snapshots so a question that started restoring just before a new build can finish.

Security properties of this design:

- Every question gets its own Sandbox, restored from an immutable snapshot. No state carries between questions.
- Repositories are root-owned and read-only inside the Sandbox. The runner process runs as an unprivileged user.
- The model API key is delivered as a one-time file that the runner deletes on read. The runner binary is execute-only (non-dumpable), so the agent's tool subprocesses cannot read its memory or the key through `/proc`.
- HTTP(S) egress is restricted to an allow-list containing only the model provider's API host (derived automatically from the model). DNS still resolves arbitrary names (see the design doc for the residual risk).
- Git tokens exist only in the builder Sandbox during the clone phase. They are scrubbed and verified absent before the snapshot is taken. Per-question Sandboxes never see them.

## Prerequisites

- A Render workspace with Sandboxes access, in the **Oregon** region (the only region Sandboxes run in during early access).
- **Paid instance types** for the API service (a free instance spins down and misses Slack's 3-second deadline) and the cron (starter plan).
- A **model API key** (Anthropic by default; see [Choosing a model](#choosing-a-model)). Use a dedicated, spend-capped key.
- Optionally, a **Slack app** (see [Slack adapter](#slack-adapter)).

## Deploy

### 1. Fork and configure

Fork this repository (or clone it and push to a new private repository: forks of public GitHub repositories can't be made private). Edit two files:

- `config.ts`: set your `name`, list your `repos` (one or more `owner/name` entries), and adjust `gitCredentials`, `labels`, and `snapshotName` as needed.
- `prompt.md`: describe your product, who asks questions, and which sources to trust.

Commit and push.

### 2. Create the Blueprint

Create a Blueprint in the Render Dashboard from your repository. It provisions three services in Oregon:

- `support-triage-bot-api` (web, starter): the HTTP API and optional Slack adapter.
- `support-triage-bot-workflow` (workflow): the `answer_question` task and its `investigate` and `deliver` subtasks.
- `support-triage-bot-snapshots` (cron, hourly): snapshot refresh.

The Blueprint also creates an env group (`support-triage-bot-shared`) containing `RENDER_API_KEY` and `RENDER_WORKSPACE_ID`, shared by the API and cron services.

### 3. Paste secrets

When prompted (and verify afterwards in the Dashboard; empty `sync: false` values are easy to miss):

| Where | Variable | Notes |
|---|---|---|
| `support-triage-bot-shared` env group | `RENDER_API_KEY` | Render API key for Sandbox operations |
| `support-triage-bot-shared` env group | `RENDER_WORKSPACE_ID` | Optional when the key sees exactly one workspace |
| `support-triage-bot-workflow` | `RENDER_API_KEY` | Same key (env groups cannot be linked to workflow services) |
| `support-triage-bot-workflow` | `RENDER_WORKSPACE_ID` | Same value; optional as above |
| `support-triage-bot-workflow` | `ANTHROPIC_API_KEY` | Or the provider's key var; see [Choosing a model](#choosing-a-model) |
| `support-triage-bot-api` | `SLACK_SIGNING_SECRET` | From the Slack app (only if using Slack) |
| `support-triage-bot-api` | `SLACK_BOT_TOKEN` | Bot token (only if using Slack) |
| `support-triage-bot-api` | `ALLOWED_CHANNEL_IDS` | Comma-separated channel IDs (only if using Slack) |
| `support-triage-bot-snapshots` | `GITHUB_TOKEN` | Fine-grained token with Contents: Read-only on private repos |

`API_TOKEN` and `SLACK_CALLBACK_KEY` are auto-generated by the Blueprint.

### 4. First snapshot

Trigger `support-triage-bot-snapshots` once from the Dashboard, or wait up to an hour for the first scheduled run. The first build takes about 5 minutes. Questions return "the repository snapshot isn't ready yet" until it finishes.

## Using the API

All `/v1/*` routes require `Authorization: Bearer <API_TOKEN>`.

### Start a question

```bash
curl -X POST https://support-triage-bot-api.onrender.com/v1/questions \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"transcript": [{"text": "How does the CLI pick a workspace in CI?"}]}'
```

Response (`202`):

```json
{"id": "tskr-abc123def456.Kx9mZ7..."}
```

The request body accepts:

- `transcript` (required): an array of messages, each with `text` (string, max 8000 chars), optional `author` (string), and optional `is_agent` (boolean).
- `callback` (optional): `{ "url": "https://...", "secret": "<16-256 chars>" }`. The URL must be HTTPS.
- `metadata` (optional): a flat object of up to 16 string/number/boolean values, echoed back in the callback.

An `Idempotency-Key` header (optional) prevents duplicate workflow runs for the same request.

### Poll for the result

```bash
curl https://support-triage-bot-api.onrender.com/v1/questions/tskr-abc123def456.Kx9mZ7... \
  -H "Authorization: Bearer $API_TOKEN"
```

While running:

```json
{"id": "tskr-abc123def456.Kx9mZ7...", "status": "running"}
```

When completed:

```json
{
  "id": "tskr-abc123def456.Kx9mZ7...",
  "status": "completed",
  "trace_id": "tskr-abc123def456",
  "reply": {
    "kind": "answer",
    "traceId": "tskr-abc123def456",
    "result": {
      "status": "final_answer",
      "answer": "...",
      "confidence": "high",
      "observed_in_code": ["..."],
      "inferred_behavior": ["..."],
      "not_established": ["..."],
      "evidence": [
        {"repository": "owner/repo", "commit": "abc1234", "path": "src/file.ts", "start_line": 10, "end_line": 25, "url": "https://..."}
      ],
      "suggested_owner": "...",
      "escalation_question": "..."
    },
    "model": "claude-opus-5",
    "manifestCreatedAt": "2026-10-08T12:00:00.000Z"
  }
}
```

A reply may also have `kind: "clarification"` (with `result.question` and `result.why_needed`) or `kind: "failure"` (with `reason`).

When failed:

```json
{"id": "...", "status": "failed", "error": "task failed"}
```

Question IDs are signed: only IDs that this API issued can be read. Rotating `API_TOKEN` invalidates outstanding IDs.

### Callback format

If you included a `callback`, the workflow POSTs the result to your URL with these headers:

- `X-Triage-Timestamp`: Unix timestamp (seconds).
- `X-Triage-Signature`: `v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>`.

The body is JSON with `trace_id`, `reply`, and the caller's `metadata` (use metadata to correlate callbacks with your requests). The callback is retried up to 8 times with exponential backoff.

Verify the signature in Node:

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret: string, signature: string, timestamp: string, body: string): boolean {
  const maxAge = 5 * 60;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > maxAge) return false;
  const expected = `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

Note: callback secrets travel in workflow task input, which is visible in the Render Dashboard.

### `scripts/ask.ts`

A convenience script for testing:

```bash
# Poll mode
tsx scripts/ask.ts --text "How does X work?" --url http://localhost:3000 --token $API_TOKEN

# Callback mode (starts a local HTTP receiver, verifies the signature)
tsx scripts/ask.ts --text "How does X work?" --callback
```

## Slack adapter

The Slack integration is optional. It activates when both `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` are set on the API service.

When active: mention the bot in an allowed channel, it reacts with eyes, reads the full thread, starts an investigation with a per-event callback to `/slack/deliver`, posts the Block Kit reply, and swaps eyes for white_check_mark (answer or clarification) or warning (failure). Follow-ups work by mentioning the bot again in the same thread; the workflow re-reads the whole thread transcript.

### Slack app setup

Create a Slack app with:

- **Bot token scopes:** `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `reactions:write`.
- **Event subscription request URL:** `https://support-triage-bot-api.onrender.com/slack/events`
- **Bot event:** `app_mention`

Install the app to your workspace and invite the bot to the channels listed in `ALLOWED_CHANNEL_IDS`.

Set these env vars on the API service:

| Variable | Value |
|---|---|
| `SLACK_SIGNING_SECRET` | From the Slack app's Basic Information page |
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `ALLOWED_CHANNEL_IDS` | Comma-separated channel IDs, or `*` for all (dev only) |
| `SLACK_CALLBACK_KEY` | Auto-generated by the Blueprint; used to sign per-event callback secrets |

The API service also needs `PUBLIC_URL` or `RENDER_EXTERNAL_URL` (Render sets the latter automatically) so it can construct the callback URL for `/slack/deliver`.

## Configuration

### API service (`support-triage-bot-api`)

| Variable | Default | Description |
|---|---|---|
| `API_TOKEN` | (generated) | Bearer token for `/v1/*` routes |
| `PORT` | `3000` | HTTP server port |
| `RENDER_API_KEY` | (from env group) | Render API key for starting workflow runs |
| `RENDER_WORKSPACE_ID` | (from env group) | Optional when the key sees exactly one workspace |
| `WORKFLOW_SLUG` | (from Blueprint) | Set by `fromService`; used to construct the task slug |
| `WORKFLOW_TASK_SLUG` | `<WORKFLOW_SLUG>/answer_question` | Overrides the full task slug |
| `RENDER_USE_LOCAL_DEV` | — | Truthy value enables local workflow dev mode |
| `RENDER_LOCAL_DEV_URL` | — | URL of the local `render workflows dev` server |
| `SLACK_SIGNING_SECRET` | — | Slack request signing secret |
| `SLACK_BOT_TOKEN` | — | Slack bot token; Slack adapter mounts when both this and the signing secret are set |
| `ALLOWED_CHANNEL_IDS` | — | Comma-separated channel IDs, or `*` |
| `SLACK_CALLBACK_KEY` | (generated) | Key for deriving per-event callback secrets |
| `SLACK_API_URL` | Slack default | Override for local development with `fake-slack.ts` |
| `PUBLIC_URL` | `RENDER_EXTERNAL_URL` | Base URL for constructing callback URLs |

### Workflow service (`support-triage-bot-workflow`)

| Variable | Default | Description |
|---|---|---|
| `RENDER_API_KEY` | — | Render API key for Sandbox operations |
| `RENDER_WORKSPACE_ID` | — | Optional when the key sees exactly one workspace |
| `SANDBOX_PROVIDER` | `render` on Render, else `local` | `render` or `local` |
| `MODEL_PROVIDER` | `anthropic` | Provider name from Pi's registry |
| `MODEL` | `claude-opus-5` | Model ID from the provider's registry |
| `PI_MODEL` | — | Alias for `MODEL` (fallback) |
| `MODEL_API_KEY` | — | Preferred; falls back to the provider's env var (e.g. `ANTHROPIC_API_KEY`) |
| `ANTHROPIC_API_KEY` | — | Used when `MODEL_PROVIDER` is `anthropic` and `MODEL_API_KEY` is not set |
| `PI_THINKING_LEVEL` | `medium` | One of `off`, `minimal`, `low`, `medium`, `high` |
| `AGENT_TIMEOUT_MS` | `900000` (15 min) | Maximum time the agent may run inside the Sandbox |
| `SANDBOX_PROVISION_TIMEOUT_MS` | `300000` (5 min) | Maximum time to wait for a Sandbox restore |
| `SANDBOX_NETWORK_POLICY` | `allow-list` | `allow-list`, `allow-all`, or `deny-all` for investigation Sandboxes |
| `SANDBOX_ALLOWED_DOMAINS` | derived from model | Comma-separated; overrides the domain derived from the model's base URL |
| `SANDBOX_TIMEOUT_SECONDS` | `1800` | Provider-side safety timeout for investigation Sandboxes |
| `SNAPSHOT_NAME` | from `config.ts` | Override the snapshot name |
| `REPOS` | — | Comma-separated `owner/name` list; overrides the repo list from `config.ts` (for local dev/testing) |
| `RENDER_API_MIN_INTERVAL_MS` | `1000` | Minimum gap between Sandbox API calls (rate limit pacing) |
| `RUNNER_DIST_DIR` | `sandbox/dist` | Path to the built runner bundle |

### Cron service (`support-triage-bot-snapshots`)

| Variable | Default | Description |
|---|---|---|
| `RENDER_API_KEY` | (from env group) | Render API key for Sandbox operations |
| `RENDER_WORKSPACE_ID` | (from env group) | Optional when the key sees exactly one workspace |
| `SANDBOX_PROVIDER` | `render` on Render, else `local` | `render` or `local` |
| `GITHUB_TOKEN` | — | For private GitHub repos; public repos are cloned anonymously |
| `SANDBOX_BUILDER_TIMEOUT_SECONDS` | `3600` | Provider-side timeout for the builder Sandbox |
| `SNAPSHOT_NAME` | from `config.ts` | Override the snapshot name |
| `REPOS` | — | Comma-separated override (for local dev/testing) |

## Choosing a model

Set `MODEL_PROVIDER` and `MODEL` on the workflow service. The Sandbox egress allow-list derives automatically from the model's base URL in Pi's registry.

Tested providers:

| Provider | Default model | Egress host | Key env var |
|---|---|---|---|
| `anthropic` | `claude-opus-5` | `api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `openai` | set `MODEL` explicitly | `api.openai.com` | `OPENAI_API_KEY` |
| `google` | set `MODEL` explicitly | `generativelanguage.googleapis.com` | `GEMINI_API_KEY` |

Other providers in Pi's registry (`openrouter`, `mistral`, `groq`, `xai`, `deepseek`, and more) will likely work but have not been validated end-to-end. Tool-calling quality varies by model.

Use a **dedicated, spend-capped API key**. DNS still resolves inside investigation Sandboxes, so a key could theoretically be exfiltrated via DNS. A spend cap limits the blast radius.

## Repositories on other git hosts

The default `gitCredentials` in `config.ts` maps `github.com` to `GITHUB_TOKEN`. To add repos from other hosts, specify `url` (HTTPS clone URL) and `browse` on each repo entry, and add the host's credentials:

```typescript
export default defineConfig({
  name: "My Triage",
  repos: [
    { repository: "myorg/api" },
    { repository: "myorg/infra", url: "https://gitlab.com/myorg/infra.git", browse: "gitlab" },
    { repository: "myorg/ops", url: "https://bitbucket.org/myorg/ops.git", browse: "bitbucket" },
  ],
  gitCredentials: {
    "github.com": { username: "x-access-token", tokenEnv: "GITHUB_TOKEN" },
    "gitlab.com": { username: "oauth2", tokenEnv: "GITLAB_TOKEN" },
    "bitbucket.org": { username: "x-token-auth", tokenEnv: "BITBUCKET_TOKEN" },
  },
  labels: { owner: "Suggested owner", escalation: "Escalation question", supportTeam: "Support" },
  snapshotName: "my-triage-corpus",
});
```

The `browse` field controls evidence links: `"github"` (default), `"gitlab"`, `"bitbucket"`, or a template string with `{base}`, `{repository}`, `{commit}`, `{path}`, `{start}`, `{end}`. Evidence URLs are set by trusted code in the workflow; the model cannot inject its own.

## Repository layout

```
config.ts                 # repos, credentials, labels, snapshot name
prompt.md                 # domain section of the system prompt
render.yaml               # Blueprint: three services + env group
.env.example              # all env vars with comments
package.json              # scripts: start:api, start:workflow, refresh, build:runner, typecheck, test
src/
  api.ts                  # Hono HTTP server: /v1/questions, /slack/events, /slack/deliver
  workflow.ts             # Render Workflow: answer_question, investigate, deliver tasks
  investigate.ts          # orchestrates sandbox + runner, classifies results, delivers callbacks
  slack.ts                # Slack adapter: signature verification, thread reading, Block Kit formatting
  sandbox.ts              # Render Sandbox provider, snapshot builder, runner output parser
  sandbox-local.ts        # local provider (no isolation; for development and tests)
  refresh.ts              # snapshot refresh (resolveHeads, buildSnapshot, pruneSnapshots)
  types.ts                # schemas: transcript, investigation result, evidence, manifest, callback signing
  runner/
    main.ts               # runner entry point: reads input, loads credentials, starts the agent
    run.ts                 # agent session: system prompt, tools, turn loop, submission reminder
    tools.ts              # read-only shell policy, safe bash tool, search tool fallbacks
    submit.ts             # submit_investigation tool: validates citations against the checkout
    faux.ts               # deterministic --faux mode for testing without a model
sandbox/
  prepare.sh              # builder phases: install (tools, deps, self-test) and checkout (clone, lockdown)
  clone.sh                # git clone with per-host credential helpers
  scrub-credentials.sh    # deletes credential files, verifies no token survived
  lockdown.sh             # root-owns repos, runner gets only scratch, execute-only node binary
  verify.sh               # verifies layout, permissions, egress policy, runner dumpability
  install-tools.sh        # ensures git, ripgrep, Node >= 22, npm in the builder
  run-investigation.sh    # launches the runner as the unprivileged user under coreutils timeout
  as-runner.sh            # privilege drop wrapper (setpriv/runuser/su)
  core-prompt.md          # core section of the system prompt (bundled into the runner)
scripts/
  ask.ts                  # CLI for testing: post a question, poll or receive a callback
  fake-slack.ts           # in-memory Slack API stand-in for local development
  send-mention.ts         # seeds a message and delivers a signed app_mention to the API
  build-runner.mjs        # bundles the runner with esbuild
```

## Local development

Prerequisites: Node >= 22.19, pnpm 11, Render CLI >= 2.11.

### Set up local checkouts

Clone the repos you want to investigate into `.scratch/repos`:

```bash
mkdir -p .scratch/repos/render-oss
for r in cli sdk; do
  git clone https://github.com/render-oss/$r .scratch/repos/render-oss/$r
done
```

### Record a local snapshot

```bash
REPOS=render-oss/cli,render-oss/sdk pnpm refresh
```

This uses the `local` provider by default and writes snapshot metadata to `.scratch/sandboxes/snapshots/`.

### Build the runner

```bash
pnpm build:runner
```

### Run the workflow locally

Start each process in its own terminal:

```bash
# Terminal 1: Render Workflows local dev server
SANDBOX_PROVIDER=local \
  LOCAL_RUNNER_CMD="node $(pwd)/sandbox/dist/runner.mjs --faux" \
  render workflows dev --port 8121 -- pnpm start:workflow

# Terminal 2: API server
API_TOKEN=dev-token \
  RENDER_USE_LOCAL_DEV=true RENDER_LOCAL_DEV_URL=http://localhost:8121 \
  pnpm start:api
```

Test with `scripts/ask.ts`:

```bash
tsx scripts/ask.ts --text "How does the CLI pick a workspace?" --token dev-token
```

Drop `--faux` from `LOCAL_RUNNER_CMD` and set your model API key (`ANTHROPIC_API_KEY`, etc.) to run a real investigation.

### The Slack path locally

```bash
# Terminal 1: fake Slack server
tsx scripts/fake-slack.ts

# Terminal 2: workflow
SANDBOX_PROVIDER=local \
  LOCAL_RUNNER_CMD="node $(pwd)/sandbox/dist/runner.mjs --faux" \
  render workflows dev --port 8121 -- pnpm start:workflow

# Terminal 3: API with Slack adapter
API_TOKEN=dev-token SLACK_SIGNING_SECRET=e2e-signing-secret ALLOWED_CHANNEL_IDS='*' \
  SLACK_CALLBACK_KEY=e2e-callback-key PUBLIC_URL=http://localhost:3000 \
  SLACK_BOT_TOKEN=xoxb-e2e-fake SLACK_API_URL=http://localhost:4100/api/ \
  RENDER_USE_LOCAL_DEV=true RENDER_LOCAL_DEV_URL=http://localhost:8121 \
  pnpm start:api

# Terminal 4: send a mention
SLACK_SIGNING_SECRET=e2e-signing-secret tsx scripts/send-mention.ts \
  --text "How does the CLI pick a workspace?"

# Check the thread for the reply
curl "localhost:4100/_messages?channel=C0SUPPORT&thread_ts=<thread_ts from above>"
```

Include "clarify" in the message text to exercise the clarification flow with `--faux`.

### The runner's `--faux` mode

When the runner is started with `--faux`, it uses a deterministic script instead of calling a model. It lists the repos root, reads a file from the first repository, and submits a low-confidence answer citing that file. This exercises the real tool execution, citation validation, and event streaming without an API key or network access.

### Typecheck and test

```bash
pnpm typecheck
pnpm test
```

## Operating it

### Log events

Every service emits structured JSON logs. Key events by service:

| Service | `event` | Key fields | Meaning |
|---|---|---|---|
| API | `task_started` | `run_id`, `channel`, `event_id` | A workflow run was started |
| API | `task_start_failed` | `error` | Starting the workflow run failed |
| API | `slack_enabled` | — | Slack adapter mounted |
| Workflow | `turn_finished` | `trace_id`, `outcome`, `model`, `usage`, `cost_usd`, `duration_ms` | One question answered |
| Workflow | `workflow_misconfigured` | reason | Configuration error prevented the investigation |
| Cron | `snapshot_refresh` | `ok`, `snapshot_id`, `snapshot_name`, `repos`, `duration_ms`, `error` | Hourly build completed or failed |

### Finding a run by trace id

Every reply carries a trace ID (the workflow task run ID). Find the run in the Render Dashboard under the workflow service's task runs.

### Snapshot health

The cron logs one `snapshot_refresh` JSON line per run. Alert on consecutive runs where `ok` is false. A failed build leaves the previous snapshot in place. The hourly schedule keeps snapshots from expiring.

### After env var changes

Redeploy the affected service. For the cron, "Trigger Run" in the Dashboard picks up new values immediately; scheduled runs use the values from the last deploy.

After changing `config.ts`, `prompt.md`, or anything under `sandbox/`, trigger the snapshot cron. These files are baked into the snapshot at build time and do not reach investigations until a new snapshot is recorded.

## Measured numbers

Live runs against real Render Sandboxes with `claude-opus-5`:

- A 17-repository snapshot build (about 2 GB of checkouts): about 5 minutes.
- Restoring a fresh Sandbox from the snapshot: about 15 seconds.
- Investigations: 45-140 seconds at $0.20-$0.45 each.
- Concurrent questions restore independent Sandboxes from the same immutable snapshot.

## Running a second deployment

To run a second deployment in the same Render workspace, rename all three services and the env group in `render.yaml` to avoid collisions, and set a different `snapshotName` in `config.ts`. Snapshot names and service names must be unique per workspace.

## License

MIT. See [LICENSE](LICENSE).
