# Quickstart

Deploy the researcher, ask a question, connect Slack, and run it locally. Once
the default path works, use [1_EXTENSION.md](1_EXTENSION.md) to point it at
your code, change the agent, or add another channel. For the implementation,
continue to [2_ARCHITECTURE.md](2_ARCHITECTURE.md).

## Prerequisites

- A Render workspace with Sandboxes access in **Oregon**.
- A **Render API key** for that workspace.
- The paid instance types already selected in `render.yaml`: Starter for the
  API and Standard for the snapshot cron.
- A dedicated, spend-capped **model API key**. Anthropic is the default; see
  [Choose a model](1_EXTENSION.md#choose-a-model).
- For private repositories, a read-only token for their Git host.
- Optionally, a Slack app for the built-in channel adapter.

## Deploy to Render

The Deploy to Render button in the [README](../README.md) deploys the public
example corpus as is. To investigate your own code, fork this repository
first.

### Configure the fork

Edit and commit:

- [`config.ts`](../config.ts): set the instance name, repositories, Git
  credentials, labels, and snapshot name.
- [`prompt.md`](../prompt.md): describe the product, likely askers, repository
  responsibilities, and source-of-truth rules.

The extension guide covers the complete
[repository configuration](1_EXTENSION.md#configure-the-repository-corpus)
and [prompt](1_EXTENSION.md#customize-the-agent).

### Create the Blueprint

Create a Blueprint from the fork in the Render Dashboard. [`render.yaml`](../render.yaml)
creates one project with three services:

- `codebase-researcher-api`: HTTP API and optional Slack adapter.
- `codebase-researcher-workflow`: the durable question workflow.
- `codebase-researcher-snapshots`: the hourly snapshot refresh cron.

### Set secrets

The Blueprint prompts for these values. Check them after creation because a
blank `sync: false` value counts as unset.

| Service | Variable | Required when |
|---|---|---|
| API | `RENDER_API_KEY` | Always |
| API | `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `ALLOWED_CHANNEL_IDS` | Using Slack |
| Workflow | `RENDER_API_KEY` | Always |
| Workflow | `RENDER_WORKSPACE_ID` | The key can access multiple workspaces |
| Workflow | `ANTHROPIC_API_KEY` | Using the default model |
| Snapshot cron | `RENDER_API_KEY` | Always |
| Snapshot cron | `RENDER_WORKSPACE_ID` | The key can access multiple workspaces |
| Snapshot cron | `GITHUB_TOKEN` | Reading private GitHub repositories |

The Blueprint generates `API_TOKEN` and `SLACK_CALLBACK_KEY`, and wires
`WORKFLOW_SLUG` from the workflow service into the API.

### Build the first snapshot

Open `codebase-researcher-snapshots` and click **Trigger Run**, or wait for its
hourly schedule. The first build takes about five minutes. A successful run
logs one `snapshot_refresh` event with `"ok": true`.

Questions cannot run until an available snapshot exists. A build in progress
produces a "snapshot isn't ready" reply; no completed build produces a "no
repository snapshot is available" reply.

## Ask your first question

Copy `API_TOKEN` from the API service and use its public URL:

```bash
export API_TOKEN=...
export API_URL=https://codebase-researcher-api.onrender.com

curl -X POST "$API_URL/v1/questions" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"transcript":[{"text":"How does the CLI pick a workspace in CI?"}]}'
```

The API returns `202` with a signed question ID:

```json
{"id":"trn-abc123def456.Kx9mZ7..."}
```

Poll with that ID:

```bash
curl "$API_URL/v1/questions/trn-abc123def456.Kx9mZ7..." \
  -H "Authorization: Bearer $API_TOKEN"
```

While the workflow is active, the status is `running`. When it finishes,
`reply.kind` is:

- `answer`: a structured answer with commit-pinned, validated evidence.
- `clarification`: a focused question to send back to the asker.
- `failure`: a user-safe explanation without internal errors or secrets.

An investigation usually takes one to two minutes. The full request,
polling, callback, and idempotency contracts are in
[Extend the question API](1_EXTENSION.md#extend-the-question-api).

## Connect Slack

Slack is optional. The adapter mounts when `SLACK_SIGNING_SECRET` and
`SLACK_BOT_TOKEN` are both set and the API has a public URL.

### Create the Slack app

Configure:

- Bot scopes: `app_mentions:read`, `chat:write`, `channels:history`,
  `groups:history`, and `reactions:write`.
- Event request URL:
  `https://<your-api-service>.onrender.com/slack/events`.
- Bot event: `app_mention`.

Install the app and invite it to every permitted channel.

### Configure the API service

Set:

| Variable | Value |
|---|---|
| `SLACK_SIGNING_SECRET` | Slack app signing secret |
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `ALLOWED_CHANNEL_IDS` | Comma-separated channel IDs |
| `SLACK_CALLBACK_KEY` | Blueprint-generated callback-signing key |

Render supplies `RENDER_EXTERNAL_URL`; `PUBLIC_URL` can override it. Avoid
`ALLOWED_CHANNEL_IDS=*` outside development. Anyone who can ask the bot can
read the configured repositories through it.

### Slack behavior

1. A mention is acknowledged immediately and receives an :eyes: reaction.
2. The adapter reads and fits the thread into the API limits, then starts a
   question keyed by Slack's event ID.
3. The workflow calls `/slack/deliver` with a signed reply.
4. The adapter posts once in the thread and changes the reaction to
   :white_check_mark: or :warning:.

Mention the bot again in the same thread for a follow-up. The adapter includes
its earlier replies as agent messages so the next investigation sees the
conversation.

## Run it locally

Local development uses the real workflow, runner, tools, and citation checks,
but replaces Render Sandboxes with a child process over local checkouts. It
provides **no isolation**; do not treat it as a security boundary.

Use the Node version in `.node-version`, pnpm 11, and Render CLI 2.11 or later:

```bash
pnpm install
```

### Clone local checkouts

Local repositories live under `.scratch/repos/<owner>/<name>`:

```bash
mkdir -p .scratch/repos/render-oss
for r in cli sdk; do
  git clone "https://github.com/render-oss/$r" ".scratch/repos/render-oss/$r"
done
```

Each configured checkout must exist and have no uncommitted, untracked, or
ignored files. The clean `HEAD` becomes the commit recorded in evidence.

### Start the workflow and API

Run each command in its own terminal:

```bash
# Terminal 1
SANDBOX_PROVIDER=local REPOS=render-oss/cli,render-oss/sdk LOCAL_RUNNER_ARGS=--faux \
  render workflows dev --port 8121 -- pnpm start:workflow

# Terminal 2
API_TOKEN=dev-token \
  RENDER_USE_LOCAL_DEV=true RENDER_LOCAL_DEV_URL=http://localhost:8121 \
  pnpm start:api
```

Then ask and poll:

```bash
curl -s localhost:3000/v1/questions \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"transcript":[{"text":"What changed in the latest commit?"}]}'

curl -s localhost:3000/v1/questions/<id> \
  -H "Authorization: Bearer dev-token"
```

`LOCAL_RUNNER_ARGS=--faux` follows a deterministic script through the real
tools and citation validator without calling a model. Remove it and set the
selected provider's API key to run a real investigation.

The local provider rebuilds `.scratch/runner/runner.mjs` for each
investigation, so runner and prompt edits apply to the next question.

### Test

```bash
pnpm typecheck
pnpm test
```

Set `LIVE_MODEL_PROVIDER` and that provider's key to include the live model
smoke test. `LIVE_MODEL` overrides its default model.

## Operate it

### Log events

All services emit one JSON object per line. The most useful events are:

| Event | Service | Meaning |
|---|---|---|
| `task_started` | API | A workflow run started |
| `turn_finished` | Workflow | Final outcome, model, prompt version, commits, usage, cost, and duration |
| `investigation_failed` | Workflow | The agent ran but did not submit an accepted result |
| `workflow_misconfigured` | Workflow | Model or Sandbox configuration is invalid |
| `deliver_failed` | Workflow | Callback retries were exhausted |
| `snapshot_refresh` | Cron | Snapshot build result, repository count, and duration |

Every reply includes the workflow run's trace ID. Use it to find the task run
in the Dashboard. Alert on consecutive `snapshot_refresh` events with
`"ok": false`; a failed refresh leaves the previous snapshot available.

### After a change

- Changes to repositories, `prompt.md`, `src/runner/`, or
  `sandbox-runtime/` require a successful snapshot refresh.
- Changing `snapshotName` requires an immediate refresh; questions fail until
  the new name exists.
- Label changes require only the API redeploy.
- Environment changes take effect when that service redeploys. Trigger the
  cron manually to use new cron variables immediately.

### Troubleshooting

- **No snapshot / snapshot not ready:** trigger the snapshot cron and inspect
  its `snapshot_refresh` event. Common causes are missing Git credentials,
  the wrong workspace ID, or a failed `verify.sh` check.
- **Investigation service is misconfigured:** inspect
  `workflow_misconfigured`. Verify `MODEL_PROVIDER`, `MODEL`,
  `RENDER_API_KEY`, and `RENDER_WORKSPACE_ID`.
- **Agent stopped without submitting:** inspect `investigation_failed`.
  Authentication failures usually mean the model key is missing or invalid.
- **Infrastructure retries exhausted:** inspect failed `investigate` task
  runs. Restore timeouts, Sandbox verification, or a rejected network policy
  are common causes.
- **Slack never answers:** confirm `slack_enabled`, the event URL,
  `app_mention`, channel access, and the bot's scopes. A reaction with no
  reply points to the workflow or `deliver` subtask.

### Operating limits

- Sandbox API calls share the workspace's 100-requests-per-minute limit. Each
  investigation makes roughly 15–20 calls, so expect a handful of concurrent
  questions, not dozens.
- A Sandbox has 2 CPUs, 4 GB RAM, and 10 GB storage; the runner, tools, and
  repositories must fit.
- Workflow runs are retained for 30 days. Their inputs include transcripts
  and callback secrets.
- The hourly cron keeps the named snapshot fresh and prevents expiry.
- Default maximums are five minutes to provision a Sandbox and 15 minutes for
  the agent. Render also applies task and Sandbox-level backstops.

See [3_TAKEAWAYS.md](3_TAKEAWAYS.md) for the operational and security
patterns worth carrying into other agent systems.
