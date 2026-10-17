# codebase-researcher

A template for getting evidence-backed answers to questions about how your code behaves. Fork this repo, point it at your repositories and model, deploy three services on Render, and start asking questions through the HTTP API or Slack.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/render-examples/codebase-researcher)

The button deploys this repository as is, investigating its example corpus: three public repositories (the Render CLI, SDK, and agent skills). To point it at your own code, fork first and deploy your fork.

Each question runs inside a fresh, isolated Sandbox restored from an hourly snapshot of your repositories. An AI coding agent reads the code with read-only tools, validates every citation against the checkout, and returns a structured answer: short answer, confidence level, observations, inferences, unknowns, file-and-line evidence, a suggested owner, and an escalation-ready question for engineering.

**Learning Render Sandboxes?** Start with [`examples/hello-sandbox.ts`](examples/hello-sandbox.ts), a short round trip through the Sandbox API, then read [docs/sandboxes.md](docs/sandboxes.md), which walks through how this project builds, restores, verifies, and secures its sandboxes. The reasoning behind the overall design is in [docs/design.md](docs/design.md).

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
- The model API key is delivered as a one-time file that the runner deletes on read. The runner binary is execute-only (non-dumpable), so the agent's tool subprocesses cannot read its memory or the key through `/proc`. Every restored sandbox proves this before it gets work, and a sandbox that can't is refused.
- HTTP(S) egress is restricted to an allow-list containing only the model provider's API host (derived automatically from the model). DNS still resolves arbitrary names (see the design doc for the residual risk).
- Git tokens exist only in the builder Sandbox during the clone phase. They are scrubbed and verified absent before the snapshot is taken. Per-question Sandboxes never see them.
- Anyone who can ask the bot can read the configured repositories through it, so limit who can ask. The [design doc](docs/design.md#the-security-boundary) lists this and the other residual risks.

## Prerequisites

- A Render workspace with Sandboxes access, in the **Oregon** region (the only region Sandboxes run in during early access).
- **Paid instance types** for the API service (a free instance spins down and misses Slack's 3-second deadline) and the cron (standard plan: bundling the runner needs more than 512 MB).
- A **model API key** (Anthropic by default; see [Choosing a model](#choosing-a-model)). Use a dedicated, spend-capped key.
- Optionally, a **Slack app** (see [Slack adapter](#slack-adapter)).

## Deploy

### 1. Fork and configure

Fork this repository (or clone it and push to a new private repository: forks of public GitHub repositories can't be made private). Edit two files:

- `config.ts`: set your `name`, list your `repos` (one or more `owner/name` entries), and adjust `gitCredentials`, `labels`, and `snapshotName` as needed.
- `prompt.md`: describe your product, who asks questions, and which sources to trust.

Commit and push.

### 2. Create the Blueprint

Create a Blueprint in the Render Dashboard from your repository. It creates a `codebase-researcher` project with a `production` environment containing three services in Oregon:

- `codebase-researcher-api` (web, starter): the HTTP API and optional Slack adapter.
- `codebase-researcher-workflow` (workflow): the `answer_question` task and its `investigate` and `deliver` subtasks.
- `codebase-researcher-snapshots` (cron, standard, hourly): snapshot refresh.

### 3. Paste secrets

When prompted (and verify afterwards in the Dashboard; empty `sync: false` values are easy to miss):

| Where | Variable | Notes |
|---|---|---|
| `codebase-researcher-api` | `RENDER_API_KEY` | Render API key, for starting and reading workflow runs |
| `codebase-researcher-workflow` | `RENDER_API_KEY` | Same key, for Sandbox operations |
| `codebase-researcher-workflow` | `RENDER_WORKSPACE_ID` | Your workspace ID (`tea-...`); optional when the key sees exactly one workspace |
| `codebase-researcher-workflow` | `ANTHROPIC_API_KEY` | Or the provider's key var; see [Choosing a model](#choosing-a-model) |
| `codebase-researcher-api` | `SLACK_SIGNING_SECRET` | From the Slack app (only if using Slack) |
| `codebase-researcher-api` | `SLACK_BOT_TOKEN` | Bot token (only if using Slack) |
| `codebase-researcher-api` | `ALLOWED_CHANNEL_IDS` | Comma-separated channel IDs (only if using Slack) |
| `codebase-researcher-snapshots` | `RENDER_API_KEY` | Same key, for building snapshots |
| `codebase-researcher-snapshots` | `RENDER_WORKSPACE_ID` | Same value; optional as above |
| `codebase-researcher-snapshots` | `GITHUB_TOKEN` | Fine-grained token with Contents: Read-only on private repos |

`API_TOKEN` and `SLACK_CALLBACK_KEY` are auto-generated by the Blueprint.

### 4. First snapshot

Trigger `codebase-researcher-snapshots` once from the Dashboard, or wait up to an hour for the first scheduled run. The first build takes about 5 minutes. Until it finishes, questions fail with "no repository snapshot is available" (or "isn't ready" while the snapshot is being captured).

## Using the API

All `/v1/*` routes require `Authorization: Bearer <API_TOKEN>`.

### Start a question

```bash
curl -X POST https://codebase-researcher-api.onrender.com/v1/questions \
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
curl https://codebase-researcher-api.onrender.com/v1/questions/tskr-abc123def456.Kx9mZ7... \
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

- `X-Researcher-Timestamp`: Unix timestamp (seconds).
- `X-Researcher-Signature`: `v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>`.

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

## Slack adapter

The Slack integration is optional. It activates when both `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` are set on the API service.

When active: mention the bot in an allowed channel, it reacts with eyes, reads the full thread, starts an investigation with a per-event callback to `/slack/deliver`, posts the Block Kit reply, and swaps eyes for white_check_mark (answer or clarification) or warning (failure). Follow-ups work by mentioning the bot again in the same thread; the workflow re-reads the whole thread transcript. Threads that exceed the API's limits are trimmed rather than rejected: the bot keeps the opening message and the most recent ones (200 in all), cuts any message over 8,000 characters, and tells the agent what it left out.

### Slack app setup

Create a Slack app with:

- **Bot token scopes:** `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `reactions:write`.
- **Event subscription request URL:** `https://codebase-researcher-api.onrender.com/slack/events`
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

### Other channels

Slack is one adapter over the question API. To answer questions from Discord, Microsoft Teams, or anything else, follow [docs/channels.md](docs/channels.md): the four steps every adapter takes, where to run it, and a sketch of a Discord slash command.

## Configuration

### API service (`codebase-researcher-api`)

| Variable | Default | Description |
|---|---|---|
| `API_TOKEN` | (generated) | Bearer token for `/v1/*` routes |
| `PORT` | `3000` | HTTP server port |
| `RENDER_API_KEY` | — | Render API key for starting workflow runs |
| `WORKFLOW_SLUG` | (from Blueprint) | Set by `fromService`; used to construct the task slug |
| `WORKFLOW_TASK_SLUG` | `<WORKFLOW_SLUG>/answer_question` | Overrides the full task slug |
| `RENDER_USE_LOCAL_DEV` | — | Truthy value enables local workflow dev mode |
| `RENDER_LOCAL_DEV_URL` | — | URL of the local `render workflows dev` server |
| `SLACK_SIGNING_SECRET` | — | Slack request signing secret |
| `SLACK_BOT_TOKEN` | — | Slack bot token; Slack adapter mounts when both this and the signing secret are set |
| `ALLOWED_CHANNEL_IDS` | — | Comma-separated channel IDs, or `*` |
| `SLACK_CALLBACK_KEY` | (generated) | Key for deriving per-event callback secrets |
| `SLACK_API_URL` | Slack default | Overrides the Slack Web API base URL |
| `PUBLIC_URL` | `RENDER_EXTERNAL_URL` | Base URL for constructing callback URLs |

### Workflow service (`codebase-researcher-workflow`)

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

### Cron service (`codebase-researcher-snapshots`)

| Variable | Default | Description |
|---|---|---|
| `RENDER_API_KEY` | — | Render API key for Sandbox operations |
| `RENDER_WORKSPACE_ID` | — | Optional when the key sees exactly one workspace |
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
  name: "My Researcher",
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
  snapshotName: "my-researcher-corpus",
});
```

The `browse` field controls evidence links: `"github"` (default), `"gitlab"`, `"bitbucket"`, or a template string with `{base}`, `{repository}`, `{commit}`, `{path}`, `{start}`, `{end}`. Evidence URLs are set by trusted code in the workflow; the model cannot inject its own.

## Repository layout

```
config.ts                 # repos, credentials, labels, snapshot name
prompt.md                 # domain section of the system prompt
render.yaml               # Blueprint: one project, three services
.env.example              # all env vars with comments
package.json              # scripts: start:api, start:workflow, refresh, typecheck, test
docs/
  design.md               # architecture, the security boundary, residual risks
  channels.md             # adding a channel beyond Slack, with a Discord sketch
  sandboxes.md            # walkthrough of the Sandbox integration: what is essential, hardening, or an SDK gap
examples/
  hello-sandbox.ts        # minimal Sandbox round trip: create, wait, upload, exec, download, terminate
src/
  api.ts                  # API service entry: Hono HTTP server for /v1/questions, /slack/events, /slack/deliver
  workflow.ts             # workflow service entry: config, timeouts, task registrations
  cron.ts                 # cron service entry: rebuilds the snapshot and logs the outcome
  tasks.ts                # task bodies: answer_question, investigate, deliver; run classification
  slack.ts                # Slack adapter: signature verification, thread reading, Block Kit formatting
  callback.ts             # callback signing and verification, constant-time compare
  log.ts                  # JSON-lines logger
  types.ts                # schemas: transcript, investigation result, evidence, manifest, runner I/O, bot config
  sandbox/
    index.ts              # configureSandboxes: picks Render or local sandboxes from the environment
    interface.ts          # the Sandbox contract both providers implement, runner output parser, git helper
    runner-bundle.ts      # bundles src/runner and its packages into one self-contained file for the builder (and local runs)
    local.ts              # local sandboxes over your own checkouts (no isolation; for development and tests)
    render/
      config.ts           # Render env config and workspace resolution
      client.ts           # rate-limited, retrying wrapper around the SDK's Sandbox API
      sandbox.ts          # in-sandbox layout, verification, opening sandboxes, running an investigation
      snapshot.ts         # snapshot build pipeline: resolve heads, build, prune
  runner/
    main.ts               # runner entry point: reads input, loads credentials, starts the agent
    session.ts            # agent session: system prompt, tools, turn loop, submission reminder
    core-prompt.md        # core section of the system prompt (bundled into the runner)
    tools.ts              # read-only shell policy; the read, ls, and safe bash tools
    submit.ts             # submit_investigation tool: validates citations against the checkout
    faux.ts               # deterministic --faux mode for testing without a model
sandbox-runtime/          # copied into the builder sandbox and baked into the snapshot
  verify.sh               # verifies layout, permissions, egress policy, runner dumpability
  install-tools.sh        # ensures git, ripgrep, and Node >= 22 in the builder
  run-investigation.sh    # launches the runner as the unprivileged user under coreutils timeout
  as-runner.sh            # privilege drop wrapper (setpriv/runuser/su)
  build/                  # builder-only, deleted before the snapshot
    git-credential-staged.sh  # git credential helper that reads the staged per-host token files
    scrub-credentials.sh      # fails the build if a token leaked, then deletes the staged credentials
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

Local sandboxes use these checkouts directly, so there is no snapshot to build. Each investigation records their current commits and refuses to run if a checkout listed in `REPOS` (or `config.ts`) is missing or has uncommitted changes.

### Run the workflow locally

Start each process in its own terminal. The local provider bundles the runner into `.scratch/runner/` on the first investigation.

```bash
# Terminal 1: Render Workflows local dev server
SANDBOX_PROVIDER=local REPOS=render-oss/cli,render-oss/sdk LOCAL_RUNNER_ARGS=--faux \
  render workflows dev --port 8121 -- pnpm start:workflow

# Terminal 2: API server
API_TOKEN=dev-token \
  RENDER_USE_LOCAL_DEV=true RENDER_LOCAL_DEV_URL=http://localhost:8121 \
  pnpm start:api
```

Ask a question, then poll with the returned `id`:

```bash
curl -s localhost:3000/v1/questions -H "Authorization: Bearer dev-token" -H "content-type: application/json" \
  -d '{"transcript":[{"text":"How does the CLI pick a workspace?"}]}'
curl -s localhost:3000/v1/questions/<id> -H "Authorization: Bearer dev-token"
```

Include "clarify" in the question to exercise the clarification flow with `--faux`. Drop `LOCAL_RUNNER_ARGS` and set your model API key (`ANTHROPIC_API_KEY`, etc.) to run a real investigation.

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
| API | `task_start_failed` | `event_id`, `error` | Starting the workflow run from Slack failed; the thread gets a failure reply |
| API | `slack_retry` | `event_id`, `retry_num` | Slack redelivered an event; it starts no second run |
| API | `request_failed` | `method`, `path`, `error` | An HTTP API request failed with a 500 |
| API | `slack_enabled` | — | Slack adapter mounted |
| API | `slack_no_channels` | `message` | Slack is on but `ALLOWED_CHANNEL_IDS` is empty, so every mention is ignored |
| API | `mention_ignored` | `reason`, `channel` | A mention came from a channel that isn't in `ALLOWED_CHANNEL_IDS` |
| Workflow | `turn_finished` | `trace_id`, `outcome`, `model`, `usage`, `cost_usd`, `duration_ms` | One question answered |
| Workflow | `workflow_misconfigured` | reason | Configuration error prevented the investigation |
| Cron | `snapshot_refresh` | `ok`, `snapshot_id`, `snapshot_name`, `repos`, `duration_ms`, `error` | Hourly build completed or failed |

### Finding a run by trace id

Every reply carries a trace ID (the workflow task run ID). Find the run in the Render Dashboard under the workflow service's task runs.

### Snapshot health

The cron logs one `snapshot_refresh` JSON line per run. Alert on consecutive runs where `ok` is false. A failed build leaves the previous snapshot in place. The hourly schedule keeps snapshots from expiring.

### After env var changes

Redeploy the affected service. For the cron, "Trigger Run" in the Dashboard picks up new values immediately; scheduled runs use the values from the last deploy.

After changing `config.ts`, `prompt.md`, `src/runner/`, or anything under `sandbox-runtime/`, trigger the snapshot cron. These files are baked into the snapshot at build time and do not reach investigations until a new snapshot is recorded.

## Troubleshooting

Start with the logs of the service named in each case; every event below is a JSON line you can search for.

**Every question fails with "the investigation kept failing on infrastructure errors".** Open `codebase-researcher-workflow`'s logs and find the error behind the retries:

- `Render rejected networkPolicy allow-list`: your workspace doesn't accept allow-list egress. Set `SANDBOX_NETWORK_POLICY=allow-all` on the workflow service. This lets investigation sandboxes reach any host, so read [Security properties](#how-a-question-flows) with that in mind.
- `RENDER_WORKSPACE_ID is required: the API key has access to multiple workspaces`: set `RENDER_WORKSPACE_ID` on the workflow service and the cron to the workspace's `tea-…` ID.
- `verify.sh exited`: the restored sandbox failed verification. The message says which check failed. A snapshot built by an older version of this repository fails here; trigger the snapshot cron.

**Questions return "the repository snapshot isn't ready" or "no repository snapshot is available".** Trigger `codebase-researcher-snapshots` and read its `snapshot_refresh` line. When `ok` is false, `error` names the step:

- `git ls-remote <repo>` failures: the repository is private and `GITHUB_TOKEN` is missing or lacks access, or the name in `config.ts` is wrong.
- A run that stops without a `snapshot_refresh` line: the cron ran out of memory. It needs the Standard plan.

**The Slack bot never answers.** Check the API service's logs:

- No `slack_enabled` line: `SLACK_SIGNING_SECRET` or `SLACK_BOT_TOKEN` is missing, or `slack_disabled` says `PUBLIC_URL` is.
- `slack_no_channels` or `mention_ignored`: add the channel's ID to `ALLOWED_CHANNEL_IDS`.
- Nothing at all when you mention the bot: the app's event subscription URL is wrong, the `app_mention` event isn't subscribed, or the bot isn't in the channel.
- `eyes_failed`: the app is missing the `reactions:write` scope.
- `task_start_failed`: the API couldn't start the workflow run; the error says why (usually `RENDER_API_KEY`).

**The bot reacts but never replies.** Find the run in the workflow service. If it finished, its `deliver` subtask shows why the callback failed: a 401 from `/slack/deliver` means `SLACK_CALLBACK_KEY` changed while the question was running.

## Operating limits

These come from the platform and shape how far one deployment goes:

- **Sandbox API rate limit:** 100 requests a minute per workspace, shared with everything else in it. Each investigation makes 15 to 20 requests, mostly while restoring and verifying its sandbox. Request spacing (`RENDER_API_MIN_INTERVAL_MS`) is per task run, not per workspace, so many questions arriving together can exceed the limit. The client retries 429s, which slows restores down; expect a handful of concurrent questions per workspace, not dozens.
- **Sandbox size:** 2 CPU, 4 GB of RAM, and 10 GB of storage. The checkouts, tools, and runner must fit in 10 GB.
- **Region:** Oregon only, during early access.
- **Run retention:** Render keeps each workflow run's input and result for 30 days. After that, `GET /v1/questions/:id` returns 404. Until then, transcripts and callback secrets are visible to anyone with access to the workflow service in the Dashboard.
- **Snapshot expiry:** snapshots use Render's default lifetime. The hourly cron keeps a fresh one available; if it fails long enough for the last snapshot to expire, questions fail until a build succeeds.
- **Timeouts:** an investigation gets `AGENT_TIMEOUT_MS` (15 minutes by default). Each `investigate` attempt is allowed the agent timeout plus 10 minutes for restore and cleanup, and infrastructure failures are retried twice, so in the worst case a failing question takes about 75 minutes to report back.

## Measured numbers

Live runs against real Render Sandboxes with `claude-opus-5`:

- A 17-repository snapshot build (about 2 GB of checkouts): about 5 minutes.
- Restoring a fresh Sandbox from the snapshot: about 15 seconds.
- Investigations: 45-140 seconds at $0.20-$0.45 each.
- Concurrent questions restore independent Sandboxes from the same immutable snapshot.

## Running a second deployment

To run a second deployment in the same Render workspace, rename the project and all three services in `render.yaml` (and the `fromService` reference to the workflow) to avoid collisions, and set a different `snapshotName` in `config.ts`. Snapshot names and service names must be unique per workspace.

## License

MIT. See [LICENSE](LICENSE).
