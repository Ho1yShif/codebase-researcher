# Extend the researcher

Start with a working deployment from [0_QUICKSTART.md](0_QUICKSTART.md).
This guide covers the supported extension points: the repository corpus,
agent behavior, model, public API, and channel adapters. Read
[2_ARCHITECTURE.md](2_ARCHITECTURE.md) before changing the host/runner or
Sandbox boundaries.

## Configure the repository corpus

[`config.ts`](../config.ts) is validated at import time by `defineConfig`:

```typescript
export default defineConfig({
  name: "Codebase Researcher",
  repos: [
    { repository: "myorg/api" },
    { repository: "myorg/web", branch: "release" },
  ],
  gitCredentials: {
    "github.com": {
      username: "x-access-token",
      tokenEnv: "GITHUB_TOKEN",
    },
  },
  labels: {
    owner: "Suggested owner",
    escalation: "Question for engineering",
    supportTeam: "the support team",
  },
  snapshotName: "my-researcher-corpus",
});
```

- `name` identifies the instance in prompts and replies.
- `repos` lists `owner/name` repositories. The default branch is resolved at
  snapshot time unless `branch` is set.
- `gitCredentials` maps each Git host to a username and the environment
  variable containing its token. An unset token means clone anonymously.
- `labels` controls Slack headings and failure wording. It does not rename API
  response fields.
- `snapshotName` is the stable name built by the cron and restored by the
  workflow. It must match `[A-Za-z0-9_.-]+` and be unique in the workspace.

`REPOS=owner/a,owner/b` and `SNAPSHOT_NAME=...` override the corresponding
values for local development and tests.

Repository, runner, prompt, and `sandbox/` changes become available
only after the snapshot cron builds a new snapshot. All checkouts and runtime
artifacts must fit within the Sandbox's 10 GB.

### Private repositories

Use a fine-grained, read-only token and add its variable only to the snapshot
cron. The workflow that runs the agent does not need Git credentials.

For GitHub, the default `GITHUB_TOKEN` mapping is sufficient. A fork of a
public repository cannot be made private, so create a new private repository
when the researcher itself must remain private.

### Other Git hosts

Set an HTTPS clone `url`, an evidence-link `browse` style, and credentials for
each host:

```typescript
export default defineConfig({
  name: "My Researcher",
  repos: [
    {
      repository: "myorg/infra",
      url: "https://gitlab.com/myorg/infra.git",
      browse: "gitlab",
    },
    {
      repository: "myorg/ops",
      url: "https://bitbucket.org/myorg/ops.git",
      browse: "bitbucket",
    },
  ],
  gitCredentials: {
    "gitlab.com": { username: "oauth2", tokenEnv: "GITLAB_TOKEN" },
    "bitbucket.org": {
      username: "x-token-auth",
      tokenEnv: "BITBUCKET_TOKEN",
    },
  },
  labels: {
    owner: "Suggested owner",
    escalation: "Question for engineering",
    supportTeam: "the support team",
  },
  snapshotName: "my-researcher-corpus",
});
```

Declare each token on the cron service in `render.yaml` with `sync: false`.
Only HTTPS clone URLs are accepted.

`browse` may be `github`, `gitlab`, `bitbucket`, or a template containing
`{base}`, `{repository}`, `{commit}`, `{path}`, `{start}`, and `{end}`.
Trusted host code builds links from validated citations; the model never
supplies a delivered evidence URL.

## Customize the agent

### Describe the product

[`prompt.md`](../prompt.md) is the instance-specific part of the system
prompt. Include:

- what the product does and who asks questions;
- which repository owns each subsystem;
- which sources take precedence when code, tests, and docs disagree;
- team names and ownership hints for `suggested_owner`;
- product vocabulary the agent should interpret consistently.

The core investigation method and result format live in
[`src/runner/core-prompt.md`](../src/runner/core-prompt.md). The instance
prompt must remain under 20 KB.

Both prompts are bundled into the runner and baked into the snapshot. Trigger
the snapshot cron after changing either. Each `turn_finished` event includes
`prompt_version`, a hash of the combined prompt.

### Change tools or behavior

The agent runs entirely inside the Sandbox:

- [`src/runner/session.ts`](../src/runner/session.ts) constructs the prompt and
  controls turns, retries, reminders, and time limits.
- [`src/runner/tools.ts`](../src/runner/tools.ts) exposes `read`, `ls`, and a
  guarded `bash`.
- [`src/runner/submit.ts`](../src/runner/submit.ts) validates the structured
  answer and every citation.
- [`src/investigation.ts`](../src/investigation.ts) defines the result schema.
- [`src/runner/protocol.ts`](../src/runner/protocol.ts) is the typed boundary
  between the host and bundled runner.

When adding a tool, decide separately:

1. Is it useful for the model?
2. What is the real security boundary if the model bypasses its input policy?
3. Which credentials or environment values can its subprocess observe?
4. How is its output bounded, logged, and validated?
5. Does it require broader egress or writable storage?

Do not rely on command parsing as the security boundary. The current command
filter is only a usability guard; filesystem permissions and Sandbox network
policy enforce the restrictions.

After runner changes, run `pnpm typecheck`, `pnpm test`, and the snapshot cron.
Use `LOCAL_RUNNER_ARGS=--faux` to exercise the full local path without a model.

## Choose a model

Set `MODEL_PROVIDER` and `MODEL` on the workflow service. Values declared in
`render.yaml` replace Dashboard edits when the Blueprint syncs, so commit the
desired defaults there.

| Provider | Example model | Key variable | Default egress host |
|---|---|---|---|
| `anthropic` | `claude-opus-5` | `ANTHROPIC_API_KEY` | `api.anthropic.com` |
| `openai` | Set explicitly | `OPENAI_API_KEY` | `api.openai.com` |
| `google` | Set explicitly | `GEMINI_API_KEY` | `generativelanguage.googleapis.com` |

The provider and model must exist in Pi's built-in model registry. Anthropic,
OpenAI, and Google are tested; other registered providers may work but are
not validated end to end.

For a non-Anthropic provider, add its key variable or `MODEL_API_KEY` to the
workflow service as `sync: false`. `PI_THINKING_LEVEL` accepts `off`,
`minimal`, `low`, `medium`, or `high`.

The investigation Sandbox's allow-list is derived from the selected model's
base URL. `SANDBOX_ALLOWED_DOMAINS` overrides it with a comma-separated list
of HTTPS hosts. Matching is exact; use a leftmost wildcard when subdomains are
required. Because this replaces the derived default, retain the model host:
`api.anthropic.com,api.github.com,*.pypi.org`. Use a dedicated, spend-capped
key; DNS remains a documented residual risk.

## Extend the question API

Every `/v1/*` request uses `Authorization: Bearer <API_TOKEN>`.
`GET /healthz` is unauthenticated.

### Start a question

```bash
curl -X POST "$API_URL/v1/questions" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ticket-4821" \
  -d '{
    "transcript":[
      {"text":"Where is workspace selection validated?","author":"u-42"}
    ],
    "metadata":{"ticket":4821}
  }'
```

The request body accepts:

- `transcript`: 1–200 messages, oldest first. `text` is at most 8,000
  characters; `author` and `is_agent` are optional. Mark earlier bot replies
  `is_agent: true` for follow-ups.
- `callback`: optional `{ "url": "https://...", "secret": "..." }`. Secrets
  must be 16–256 characters. Local development also permits localhost HTTP.
- `metadata`: optional routing data with at most 16 string, number, or boolean
  values. It is returned unchanged in the callback.

Use a stable `Idempotency-Key` when callers may retry. The API passes it to
Render Workflows, preventing a duplicate run.

### Poll and handle replies

`POST` returns `202 {"id":"<signed question id>"}`. Poll:

```bash
curl "$API_URL/v1/questions/<id>" \
  -H "Authorization: Bearer $API_TOKEN"
```

Pending and active runs return `{"status":"running"}`. A completed run
contains one of:

```typescript
type Reply =
  | {
      kind: "answer";
      traceId: string;
      result: FinalAnswer;
      model?: string;
      manifestCreatedAt?: string;
    }
  | {
      kind: "clarification";
      traceId: string;
      result: NeedsClarification;
    }
  | {
      kind: "failure";
      traceId: string;
      reason: string;
    };
```

For a clarification, append the question as `is_agent: true`, append the
user's answer, and start a new run with the full conversation. Failure reasons
are safe to display. A workflow-level `failed` status means the parent task
itself failed or was canceled.

Question IDs are `<task run ID>.<MAC>`, signed with `API_TOKEN`. Rotating the
token invalidates outstanding IDs. The signature also prevents this API from
reading unrelated workflow runs in the workspace.

### Receive callbacks

When a callback is supplied, `deliver` sends:

- `X-Researcher-Timestamp`: Unix seconds.
- `X-Researcher-Signature`:
  `v1=<HMAC-SHA256(secret, timestamp + "." + rawBody)>`.
- JSON body:
  `{ "trace_id": "...", "reply": {...}, "metadata": {...} }`.

Verify the signature against the raw body before parsing, reject timestamps
outside five minutes, and use a timing-safe comparison. TypeScript code in
this repository can call [`verifyCallback`](../src/callback.ts).

Delivery retries, so receivers must be idempotent on `trace_id`. Derive a
per-event callback secret instead of storing one long-lived secret. Workflow
inputs, including callback secrets, are visible to Dashboard users.

## Add a channel beyond Slack

The investigation pipeline knows about questions, not Slack. A Discord,
Teams, support-desk, CLI, or web adapter follows four steps:

1. **Verify and acknowledge the event.** Respond before the platform's
   deadline, then start slow work.
2. **Build a transcript.** Produce oldest-first
   `{ text, author?, is_agent? }` messages and fit them to the API limits.
3. **Start a question.** Include a callback, routing metadata, and the
   platform's event ID as the idempotency key.
4. **Verify and render the callback.** Handle all three reply kinds and make
   posting idempotent.

Run the adapter:

- **Inside the API service** when it is TypeScript and shares ownership with
  this project. Follow `mountSlackRoutes`, call `startQuestion` directly, add
  its environment schema, and include its files in the API `buildFilter`.
- **As a separate service** when another language or team owns it. Call the
  authenticated HTTP API and receive the signed callback.

When rendering:

- escape all model-written text for the destination's markup;
- suppress mentions such as `@everyone` and channel-wide notifications;
- use the trusted `evidence[].url` values as delivered;
- respect message-size limits, shortening detail before the short answer;
- show `failure.reason`, never internal logs or exception text.

Model the adapter's tests on [`test/slack.test.ts`](../test/slack.test.ts).
The built-in Slack implementation in [`src/slack/`](../src/slack) also shows
thread fitting, per-event secret derivation, acknowledgement-before-work, and
idempotent delivery.

## Run a second deployment

Service and snapshot names must be unique within a workspace. For another
instance:

1. Rename the project and all three services in `render.yaml`.
2. Update the `fromService` workflow name.
3. Choose a different `snapshotName` in `config.ts`.
4. Use a separate Slack app if the instance has a Slack adapter.

## Configuration reference

Every variable also appears in [`.env.example`](../.env.example). An empty
string is treated as unset.

### API service

| Variable | Default | Purpose |
|---|---|---|
| `API_TOKEN` | Generated | Authenticates `/v1/*` and signs question IDs |
| `PORT` | `3000` | HTTP port |
| `RENDER_API_KEY` | None | Starts and reads workflow runs |
| `WORKFLOW_SLUG` | Blueprint wiring | Builds the `answer_question` task slug |
| `WORKFLOW_TASK_SLUG` | Derived | Overrides the full task slug |
| `RENDER_USE_LOCAL_DEV` | `false` | Uses a local Workflows server |
| `RENDER_LOCAL_DEV_URL` | None | Local Workflows server URL |
| `SLACK_SIGNING_SECRET` | None | Verifies Slack events |
| `SLACK_BOT_TOKEN` | None | Calls Slack APIs |
| `ALLOWED_CHANNEL_IDS` | None | Allowed channel IDs or `*` |
| `SLACK_CALLBACK_KEY` | `API_TOKEN` | Derives per-event callback secrets |
| `SLACK_API_URL` | Slack default | Overrides Slack's API base URL |
| `PUBLIC_URL` | `RENDER_EXTERNAL_URL` | Public callback base URL |

### Workflow service

| Variable | Default | Purpose |
|---|---|---|
| `RENDER_API_KEY` | None | Sandbox operations |
| `RENDER_WORKSPACE_ID` | Resolved | Required when the key sees multiple workspaces |
| `SANDBOX_PROVIDER` | Render on Render, local elsewhere | Sandbox implementation |
| `MODEL_PROVIDER` | `anthropic` | Pi provider |
| `MODEL` | `claude-opus-5` | Model ID |
| `MODEL_API_KEY` | Provider variable | Explicit model key |
| `PI_THINKING_LEVEL` | `medium` | Reasoning effort |
| `AGENT_TIMEOUT_MS` | `900000` | Agent deadline |
| `SANDBOX_PROVISION_TIMEOUT_MS` | `300000` | Restore, boot, verify, and manifest deadline |
| `SANDBOX_NETWORK_POLICY` | `allow-list` | `allow-list`, `allow-all`, or `deny-all` |
| `SANDBOX_ALLOWED_DOMAINS` | Model host | Comma-separated HTTPS egress hosts; supports leftmost wildcards |
| `SANDBOX_TIMEOUT_SECONDS` | `1800` | Provider-side termination backstop |
| `RENDER_API_MIN_INTERVAL_MS` | `1000` | Per-client API request spacing |
| `SNAPSHOT_NAME` | `config.ts` | Snapshot-name override |
| `REPOS` | None | Repository-list override |

### Snapshot cron

| Variable | Default | Purpose |
|---|---|---|
| `RENDER_API_KEY` | None | Sandbox and snapshot operations |
| `RENDER_WORKSPACE_ID` | Resolved | Workspace selection |
| `GITHUB_TOKEN` | None | Private GitHub reads |
| Other `tokenEnv` variables | None | Tokens declared in `gitCredentials` |
| `SANDBOX_BUILDER_TIMEOUT_SECONDS` | `3600` | Builder termination backstop |
| `RENDER_API_MIN_INTERVAL_MS` | `1000` | API request spacing |
| `SNAPSHOT_NAME` | `config.ts` | Snapshot-name override |
| `REPOS` | None | Repository-list override |

### Local development and tests

| Variable | Default | Purpose |
|---|---|---|
| `LOCAL_REPOS_ROOT` | `.scratch/repos` | Root of local checkouts |
| `LOCAL_SANDBOXES_ROOT` | `.scratch/sandboxes` | Per-run scratch directories |
| `LOCAL_RUNNER_ARGS` | None | Extra runner flags, such as `--faux` |
| `LOCAL_RUNNER_CMD` | Bundled runner | Replaces the runner command |
| `LIVE_MODEL_PROVIDER` | None | Enables the live model test |
| `LIVE_MODEL` | Provider default | Overrides the live test model |
