# Quickstart

This guide takes you from a fork of this repository to a deployed researcher answering questions, then covers Slack, local development, customization, configuration, and operations. For how the code is organized, start with the walkthrough's [repository layout](WALKTHROUGH.md#repository-layout).

## Prerequisites

- A Render workspace with Sandboxes access, in the **Oregon** region (the only region Sandboxes run in during early access).
- A **Render API key** for that workspace. The API service uses it to start workflow runs; the workflow and the cron use it for Sandbox operations.
- **Paid instance types** for two services: the API (a free instance spins down and misses Slack's 3-second deadline) and the cron (the Standard plan, because bundling the runner needs more than 512 MB). The Blueprint already sets both.
- A **model API key**: Anthropic by default; see [Choose a model](#choose-a-model). Use a dedicated, spend-capped key.
- For private GitHub repositories, a **fine-grained GitHub token** with Contents: Read-only access to them.
- Optionally, a **Slack app** (see [Connect Slack](#connect-slack)).

## Deploy to Render

The Deploy to Render button in the [README](../README.md) deploys the example corpus as is. To investigate your own code, fork first and follow these steps.

### Fork and configure

Fork this repository, or clone it and push it to a new private repository (forks of public GitHub repositories can't be made private). Edit two files:

- [`config.ts`](../config.ts): set `name`, list your `repos` (one or more `owner/name` entries), and adjust `gitCredentials`, `labels`, and `snapshotName` as needed. See [Point it at your repositories](#point-it-at-your-repositories).
- [`prompt.md`](../prompt.md): describe your product, who asks questions, and which sources to trust. See [Describe your product](#describe-your-product).

Commit and push.

### Create the Blueprint

In the Render Dashboard, create a new Blueprint from your repository. It reads [`render.yaml`](../render.yaml) and creates a `codebase-researcher` project with a `production` environment containing three services in Oregon:

- `codebase-researcher-api` (web service, Starter): the HTTP API and the optional Slack adapter.
- `codebase-researcher-workflow` (workflow): the `answer_question` task and its `investigate` and `deliver` subtasks.
- `codebase-researcher-snapshots` (cron job, Standard, hourly): rebuilds the repository snapshot.

### Paste secrets

The Blueprint form prompts for each secret. Afterwards, check them in the Dashboard: an empty `sync: false` value is easy to miss, and a blank value counts as unset.

| Service | Variable | Notes |
|---|---|---|
| `codebase-researcher-api` | `RENDER_API_KEY` | For starting and reading workflow runs |
| `codebase-researcher-api` | `SLACK_SIGNING_SECRET` | Only if you use Slack |
| `codebase-researcher-api` | `SLACK_BOT_TOKEN` | Only if you use Slack |
| `codebase-researcher-api` | `ALLOWED_CHANNEL_IDS` | Only if you use Slack: comma-separated channel IDs |
| `codebase-researcher-workflow` | `RENDER_API_KEY` | Same key, for Sandbox operations |
| `codebase-researcher-workflow` | `RENDER_WORKSPACE_ID` | Your workspace ID (`tea-...`); optional when the key can see exactly one workspace |
| `codebase-researcher-workflow` | `ANTHROPIC_API_KEY` | Or another provider's key; see [Choose a model](#choose-a-model) |
| `codebase-researcher-snapshots` | `RENDER_API_KEY` | Same key, for building snapshots |
| `codebase-researcher-snapshots` | `RENDER_WORKSPACE_ID` | Same value; optional as above |
| `codebase-researcher-snapshots` | `GITHUB_TOKEN` | Only for private GitHub repositories; public ones are cloned anonymously |

The Blueprint generates `API_TOKEN` and `SLACK_CALLBACK_KEY`, and sets `WORKFLOW_SLUG` on the API from the workflow service.

### Build the first snapshot

Open `codebase-researcher-snapshots` in the Dashboard and click **Trigger Run**, or wait up to an hour for the first scheduled run. The first build takes about 5 minutes. Until it finishes, questions fail with "no repository snapshot is available", or "the repository snapshot isn't ready" while the snapshot is being captured.

The cron logs one `snapshot_refresh` line per run. `"ok": true` means the snapshot is ready.

## Ask your first question

Copy `API_TOKEN` from the API service's environment in the Dashboard, and use the service's URL (shown at the top of its page). Every `/v1/*` route requires `Authorization: Bearer <API_TOKEN>`.

```bash
export API_TOKEN=...
export API_URL=https://codebase-researcher-api.onrender.com

curl -X POST "$API_URL/v1/questions" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"transcript": [{"text": "How does the CLI pick a workspace in CI?"}]}'
```

The API answers `202` with a question ID:

```json
{"id": "trn-abc123def456.Kx9mZ7..."}
```

Poll it until the status changes from `running`:

```bash
curl "$API_URL/v1/questions/trn-abc123def456.Kx9mZ7..." \
  -H "Authorization: Bearer $API_TOKEN"
```

```json
{"id": "trn-abc123def456.Kx9mZ7...", "status": "running"}
```

An investigation usually takes one to two minutes. When it finishes, the status is `completed` and `reply` holds the result. `reply.kind` is `answer` (a structured answer with validated evidence), `clarification` (a question back to the asker), or `failure` (with a `reason` that is safe to show users). If the run itself failed, the status is `failed`.

To be notified instead of polling, pass a `callback` with an HTTPS URL and a secret; the workflow POSTs the signed result to it. The [question API](WALKTHROUGH.md#the-question-api) section of the walkthrough is the full reference for the request body, the response shapes, idempotency, and verifying callback signatures.

## Connect Slack

The Slack adapter is optional. It mounts on the API service when both `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` are set, and it calls the same question pipeline as the HTTP API.

### Create the Slack app

Create a Slack app with:

- **Bot token scopes:** `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `reactions:write`.
- **Event subscription request URL:** `https://<your-api-service>.onrender.com/slack/events`. Slack sends a verification challenge when you save it, so the API service must already be running with the signing secret set.
- **Bot event:** `app_mention`.

Install the app to your workspace and invite the bot to each channel you list in `ALLOWED_CHANNEL_IDS`.

### Set the environment variables

Set these on `codebase-researcher-api`:

| Variable | Value |
|---|---|
| `SLACK_SIGNING_SECRET` | From the Slack app's Basic Information page |
| `SLACK_BOT_TOKEN` | The Bot User OAuth Token (`xoxb-...`) |
| `ALLOWED_CHANNEL_IDS` | Comma-separated channel IDs, or `*` for every channel (development only) |
| `SLACK_CALLBACK_KEY` | Generated by the Blueprint; signs the per-mention callback secrets |

The adapter also needs the service's public URL to build its callback address. Render sets `RENDER_EXTERNAL_URL` automatically; set `PUBLIC_URL` to override it. Without either, the API logs `slack_disabled` and doesn't mount the Slack routes.

Anyone in an allowed channel can read the configured repositories through the bot, so list only channels whose members could read every repository.

### How the bot behaves

1. When someone mentions the bot in an allowed channel, the API acknowledges Slack immediately and reacts with :eyes:.
2. It reads the whole thread, marks the bot's own earlier replies as agent messages, and starts a question with a callback to `/slack/deliver`. The Slack event ID is the idempotency key, so a redelivered event doesn't start a second run.
3. When the result arrives, it posts a Block Kit reply in the thread and swaps :eyes: for :white_check_mark: (an answer or a clarification) or :warning: (a failure).

To ask a follow-up, mention the bot again in the same thread; the adapter reads the thread again, including its earlier answers. Messages from bots, including this one, never start a run. Threads longer than the API's limits are trimmed rather than rejected: the adapter keeps the opening message and the most recent ones (200 in all), cuts any message over 8,000 characters, and tells the agent what it left out.

## Run it locally

Local runs use the real workflow, API, runner, tools, and citation checks, but replace the Sandbox with a child process on your machine. Local sandboxes provide no isolation; they are for development and tests. The walkthrough's [Sandboxes](WALKTHROUGH.md#sandboxes) section explains the interface both kinds implement.

You need Node 22.19 or later (the repository pins Node 24 in `.node-version`), pnpm 11, and the Render CLI 2.11 or later. Install dependencies with:

```bash
pnpm install
```

### Clone local checkouts

Local sandboxes read checkouts under `.scratch/repos/<owner>/<name>` instead of a snapshot. Clone the repositories you want to investigate:

```bash
mkdir -p .scratch/repos/render-oss
for r in cli sdk; do
  git clone https://github.com/render-oss/$r .scratch/repos/render-oss/$r
done
```

Each investigation records the checkouts' current commits. It refuses to run if a repository listed in `REPOS` (or in `config.ts` when `REPOS` is unset) is missing or has any uncommitted, untracked, or ignored files, because citations into a dirty checkout wouldn't match the recorded commit.

### Start the workflow and the API

Start each process in its own terminal:

```bash
# Terminal 1: the Render Workflows local dev server, running the workflow service
SANDBOX_PROVIDER=local REPOS=render-oss/cli,render-oss/sdk LOCAL_RUNNER_ARGS=--faux \
  render workflows dev --port 8121 -- pnpm start:workflow

# Terminal 2: the API, pointed at the local workflow server
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

The local provider bundles the runner into `.scratch/runner/` each time an investigation starts, so edits to `prompt.md` and `src/runner/` apply to the next question. In local dev mode, a callback URL may also use `http://localhost` or `http://127.0.0.1`.

### Run without a model: `--faux`

`LOCAL_RUNNER_ARGS=--faux` makes the runner follow a deterministic script instead of calling a model. It lists the repositories root, reads the latest commit of the first repository, reads that repository's README (or its first tracked file), and submits a low-confidence answer citing it. This exercises the real tools, citation validation, and event stream with no API key and no network. Include the word "clarify" in the question to get a clarification instead.

To run a real investigation, drop `LOCAL_RUNNER_ARGS` and set your model key (for example `ANTHROPIC_API_KEY`) in terminal 1.

### Typecheck and test

```bash
pnpm typecheck
pnpm test
```

To also run a live smoke test of the runner against a real model, set `LIVE_MODEL_PROVIDER` and that provider's key variable (for example `ANTHROPIC_API_KEY`) before `pnpm test`. `LIVE_MODEL` overrides the test's default model.

### Environment files

[`.env.example`](../.env.example) lists every variable the services read, grouped by service. To use it, copy it to `.env` and pass it to a script with Node's `--env-file`, for example `pnpm exec tsx --env-file=.env src/api.ts`. Recent versions of `render workflows dev` load `.env` into the workflow process by default (see its `--env-file` flag), and `.env.example` sets `SANDBOX_PROVIDER=render`, so change that to `local` in a `.env` you use for local runs.

## Customize it

### Point it at your repositories

[`config.ts`](../config.ts) is the bot's configuration, validated by `defineConfig` in [`src/bot-config.ts`](../src/bot-config.ts):

```typescript
export default defineConfig({
  name: "Codebase Researcher",
  repos: [
    { repository: "myorg/api" },
    { repository: "myorg/web", branch: "release" },
  ],
  gitCredentials: {
    "github.com": { username: "x-access-token", tokenEnv: "GITHUB_TOKEN" },
  },
  labels: {
    owner: "Suggested owner",
    escalation: "Question for engineering",
    supportTeam: "the support team",
  },
  snapshotName: "codebase-researcher-corpus",
});
```

- `repos`: each entry is an `owner/name`. The snapshot uses the default branch's head unless you set `branch`. Add `url` and `browse` for repositories hosted somewhere other than GitHub (see [Repositories on other git hosts](#repositories-on-other-git-hosts)).
- `gitCredentials`: maps a git host to the username git should use and the environment variable that holds the token. Hosts whose variable is unset are cloned anonymously.
- `snapshotName`: the name the cron builds and the workflow restores. It must match `[A-Za-z0-9_.-]+` and be unique in the workspace.

All checkouts, tools, and the runner must fit in the Sandbox's 10 GB of storage. Repository changes reach investigations only through a new snapshot, so trigger the snapshot cron after you push.

The `REPOS` environment variable (`owner/a,owner/b`) replaces the repository list and `SNAPSHOT_NAME` replaces `snapshotName`. They are meant for local development and testing.

### Describe your product

[`prompt.md`](../prompt.md) is the instance section of the system prompt. The runner puts it ahead of the core instructions in [`src/runner/core-prompt.md`](../src/runner/core-prompt.md), which define the investigation method and the answer format. Use `prompt.md` to say what the product is, who asks the questions, which repositories implement which parts, and which sources to trust when they disagree. Naming your teams and what they own helps the agent fill in `suggested_owner`. Keep it under 20 KB; the bundle step refuses a larger file.

The prompt is bundled into the runner, which is baked into the snapshot, so trigger the snapshot cron after changing it. Each `turn_finished` log line carries a `prompt_version` (a hash of the full system prompt), so you can tell which prompt produced an answer. The walkthrough's [runner](WALKTHROUGH.md#the-runner) section covers how the prompt, the tools, and the submission check fit together.

### Change the labels

`labels` in `config.ts` set wording in Slack replies:

- `owner`: the heading over the suggested owner.
- `escalation`: the heading over the question for engineering.
- `supportTeam`: who a failure message tells people to contact, as in "share it with the support team for debugging".

Labels change only the Slack rendering, not the JSON field names in the API response. They are read by the API service, which redeploys on its own when `config.ts` changes; no new snapshot is needed.

### Choose a model

Set `MODEL_PROVIDER` and `MODEL` on the workflow service. Change them in `render.yaml` in your fork, so a Blueprint sync doesn't restore the old values. The Sandbox egress allow-list is derived from the model's base URL in Pi's model registry, so it follows the model automatically.

| Provider | `MODEL` | Egress host | Key variable |
|---|---|---|---|
| `anthropic` | `claude-opus-5` (default) | `api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `openai` | Set it explicitly | `api.openai.com` | `OPENAI_API_KEY` |
| `google` | Set it explicitly | `generativelanguage.googleapis.com` | `GEMINI_API_KEY` |

These three are tested. The `MODEL` default is `claude-opus-5` whatever the provider, so set `MODEL` whenever you change `MODEL_PROVIDER`. Other providers in Pi's registry (`openrouter`, `mistral`, `groq`, `xai`, `deepseek`, and more) will likely work but haven't been validated end to end, and tool-calling quality varies by model. A provider and model that aren't in the registry make every question fail as misconfigured.

The workflow passes `MODEL_API_KEY` to the runner if it is set, and otherwise the provider's own key variable from the table. For a provider other than Anthropic, add its key variable (or `MODEL_API_KEY`) to the workflow service as a `sync: false` entry in `render.yaml`. `PI_THINKING_LEVEL` sets the reasoning effort: `off`, `minimal`, `low`, `medium` (the default), or `high`.

Use a dedicated, spend-capped key. DNS still resolves inside investigation Sandboxes, so a key could in principle leave through DNS queries, and a spend cap limits the damage.

### Repositories on other git hosts

The default `gitCredentials` maps `github.com` to `GITHUB_TOKEN`. For repositories on other hosts, give each entry an HTTPS clone `url` and a `browse` style, and add the host's credentials:

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
  labels: { owner: "Suggested owner", escalation: "Question for engineering", supportTeam: "the support team" },
  snapshotName: "my-researcher-corpus",
});
```

Add each new token variable (here `GITLAB_TOKEN` and `BITBUCKET_TOKEN`) to the `codebase-researcher-snapshots` service in `render.yaml` with `sync: false`, and set its value. Only the cron needs git tokens.

`browse` controls evidence links: `"github"` (the default), `"gitlab"`, `"bitbucket"`, or a template string using `{base}`, `{repository}`, `{commit}`, `{path}`, `{start}`, and `{end}`, where `{base}` is the clone URL without `.git`. Set it whenever you set `url`, or links default to GitHub. Trusted code in the workflow builds these links from validated citations; the model can't supply its own.

### Add a channel beyond Slack

The investigation pipeline knows nothing about Slack. It answers a question: a transcript, an optional callback, and optional metadata. The Slack adapter in [`src/slack/`](../src/slack) is one translation between a chat platform and that question API. Any other channel (Discord, Microsoft Teams, a support desk, a CLI) follows the same four steps.

#### The four steps

1. **Receive and acknowledge the platform's event.** Verify its signature, then respond within the platform's deadline (3 seconds for both Slack and Discord) before doing anything slow. The Slack adapter responds first and does the rest in `startMention`, in [`src/slack/routes.ts`](../src/slack/routes.ts).
2. **Build a transcript.** An array of `{ text, author?, is_agent? }`, oldest first, with at most 200 messages of at most 8,000 characters each (`TRANSCRIPT_MAX_MESSAGES` and `MESSAGE_MAX_CHARS` in [`src/question.ts`](../src/question.ts)). Mark the bot's own earlier replies `is_agent: true` so follow-up questions read as a conversation. `fitTranscript` in [`src/slack/transcript.ts`](../src/slack/transcript.ts) trims a long thread to these limits; reuse it.
3. **Start a question with a callback.** Pass a callback URL that points back at your adapter, a callback secret, and `metadata` with whatever you need to route the reply (at most 16 string, number, or boolean values). Use the platform's event or interaction ID as the idempotency key, so a redelivered event doesn't start a second run.
4. **Receive the callback and render the reply.** Verify `X-Researcher-Signature` with `verifyCallback` from [`src/callback.ts`](../src/callback.ts), read your routing details back out of `metadata`, and render the `reply`: an `answer`, a `clarification`, or a `failure`.

Derive each callback secret from a key and the event ID (`HMAC-SHA256(key, event_id)`), as the Slack adapter does with `SLACK_CALLBACK_KEY`. The callback can then be verified without storing anything, and a leaked secret is good for one question only. Callback secrets travel in workflow task input, which is visible in the Render Dashboard.

#### Where the adapter runs

- **Inside the API service**, like Slack. Write a `mountXRoutes(app, deps, { startQuestion, log })` function, following `mountSlackRoutes` in [`src/slack/routes.ts`](../src/slack/routes.ts), and call it from the server block at the bottom of [`src/api.ts`](../src/api.ts) when its environment variables are set. Add those variables to the `Env` schema in `src/api.ts`, and add the adapter's files to the API service's `buildFilter` paths in `render.yaml`; the API's filter lists files explicitly, so changes to an unlisted file don't trigger a deploy. An adapter here calls `startQuestion` directly, with no extra hop or token.
- **As a separate service** that calls `POST /v1/questions` with `Authorization: Bearer <API_TOKEN>` and an `Idempotency-Key` header. Use this when the adapter is written in another language or owned by another team. The request and callback formats are in the [question API reference](WALKTHROUGH.md#the-question-api).

#### Rendering replies safely

- Escape model-written text for the platform's markup. The model can write `@everyone` or a link as easily as an answer. `escapeMrkdwn` in [`src/slack/format.ts`](../src/slack/format.ts) defuses Slack's `<!channel>` and `<@U…>`; on Discord, send `allowed_mentions: { parse: [] }`.
- Use `evidence[].url` as given. Trusted code builds those links after validating each citation; the model can't set them.
- Respect the platform's message limits (Slack sections are 3,000 characters; a Discord message is 2,000). Shorten lists, not the short answer.
- `failure.reason` is safe to show users; it never contains stack traces or secrets.

#### Sketch: a Discord slash command

This is a starting point, not a tested adapter. It handles a `/ask question:<text>` command through Discord's interactions endpoint. Register the command and set the app's Interactions Endpoint URL to `https://<your-api>/discord/interactions` in the Discord Developer Portal.

Two Discord details shape it:

- An interaction must be answered within 3 seconds, so the adapter answers with a deferred response (type 5, shown as "thinking…") and edits that message when the callback arrives.
- An interaction token is valid for 15 minutes. With the default 15-minute agent timeout plus the Sandbox restore, a slow investigation can outlive it. For long investigations, post the answer to the channel with a bot token instead (`POST /channels/{channel_id}/messages`).

Saved as `src/discord.ts`:

```typescript
import { createHmac, createPublicKey, verify } from "node:crypto";
import type { Hono } from "hono";
import { verifyCallback } from "./callback.ts";
import type { Log } from "./log.ts";
import { MESSAGE_MAX_CHARS, type Reply, type StartQuestion } from "./question.ts";
import { errorMessage } from "./util.ts";

type DiscordDeps = { publicKey: string; appId: string; callbackKey: string; publicUrl: string };

/** Discord signs interactions with Ed25519 over timestamp + body, using the app's public key (hex). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function verifyDiscord(publicKeyHex: string, signature: string | undefined, timestamp: string | undefined, body: string): boolean {
  if (!signature || !timestamp) return false;
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
  return verify(null, Buffer.from(timestamp + body), key, Buffer.from(signature, "hex"));
}

const callbackSecret = (key: string, interactionId: string) => createHmac("sha256", key).update(interactionId).digest("hex");

function toDiscord(reply: Reply): string {
  const text =
    reply.kind === "answer"
      ? [reply.result.answer, ...reply.result.evidence.map((e) => `<${e.url}>`)].join("\n")
      : reply.kind === "clarification"
        ? reply.result.question
        : `I couldn't complete this investigation: ${reply.reason}. Trace ${reply.traceId}`;
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
}

export function mountDiscordRoutes(app: Hono, deps: DiscordDeps, { startQuestion, log }: { startQuestion: StartQuestion; log: Log }) {
  app.post("/discord/interactions", async (c) => {
    const body = await c.req.text();
    if (!verifyDiscord(deps.publicKey, c.req.header("x-signature-ed25519"), c.req.header("x-signature-timestamp"), body)) {
      return c.text("invalid signature", 401);
    }
    const interaction = JSON.parse(body);
    if (interaction.type === 1) return c.json({ type: 1 }); // PING, sent when you save the endpoint URL

    const question = interaction.data?.options?.find((o: { name: string }) => o.name === "question")?.value;
    void startQuestion(
      {
        transcript: [{ text: String(question ?? "").slice(0, MESSAGE_MAX_CHARS), author: interaction.member?.user?.id ?? interaction.user?.id }],
        callback: { url: `${deps.publicUrl}/discord/deliver`, secret: callbackSecret(deps.callbackKey, interaction.id) },
        metadata: { interaction_id: interaction.id, token: interaction.token },
      },
      { idempotencyKey: interaction.id, signal: AbortSignal.timeout(10_000) },
    ).then(
      (run) => log.info("task started", { event: "task_started", interaction_id: interaction.id, run_id: run.id }),
      (err: unknown) => log.error("task start failed", { event: "task_start_failed", interaction_id: interaction.id, error: errorMessage(err) }),
    );
    return c.json({ type: 5 }); // deferred: "thinking…" until the callback edits it
  });

  app.post("/discord/deliver", async (c) => {
    const raw = await c.req.text();
    const { reply, metadata } = JSON.parse(raw) as { reply: Reply; metadata?: { interaction_id?: string; token?: string } };
    if (!metadata?.interaction_id || !metadata.token) return c.text("missing metadata", 400);
    const ok = verifyCallback({
      secret: callbackSecret(deps.callbackKey, metadata.interaction_id),
      signature: c.req.header("x-researcher-signature"),
      timestamp: c.req.header("x-researcher-timestamp"),
      body: raw,
    });
    if (!ok) return c.text("unauthorized", 401);

    const res = await fetch(`https://discord.com/api/v10/webhooks/${deps.appId}/${metadata.token}/messages/@original`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: toDiscord(reply), allowed_mentions: { parse: [] } }),
    });
    // A non-2xx makes the workflow's deliver subtask retry (up to 8 times).
    return res.ok ? c.text("ok") : c.text(`discord answered ${res.status}`, 502);
  });
}
```

Mount it next to the Slack adapter in `src/api.ts`, passing the same `startQuestion` and `log`:

```typescript
mountDiscordRoutes(app, { publicKey, appId, callbackKey, publicUrl }, { startQuestion, log });
```

The interaction token in `metadata` is visible in the Dashboard with the rest of the task input. It only lets someone edit this one response, and only until it expires.

To finish it: render the full answer (observed, inferred, and not established), handle follow-ups by threading replies, add tests modeled on the Slack adapter's in [`test/slack.test.ts`](../test/slack.test.ts), and add its environment variables to `render.yaml` and the [configuration reference](#configuration-reference).

### Run a second deployment

Snapshot names and service names must be unique per workspace. To run a second deployment in the same workspace, rename the project and all three services in `render.yaml`, update the `fromService` reference to the workflow service to match, and set a different `snapshotName` in `config.ts`. A second Slack bot also needs its own Slack app pointing at the new API service's URL.

## Configuration reference

Every variable is also listed, with comments, in [`.env.example`](../.env.example). A variable set to an empty string counts as unset.

### API service (`codebase-researcher-api`)

| Variable | Default | Description |
|---|---|---|
| `API_TOKEN` | Generated by the Blueprint | Bearer token for `/v1/*` routes. Also keys question IDs, so rotating it invalidates outstanding IDs |
| `PORT` | `3000` | HTTP port; Render sets it |
| `RENDER_API_KEY` | None | Starts and reads workflow runs. Required unless local dev mode is on |
| `WORKFLOW_SLUG` | Set by the Blueprint from the workflow service | Builds the task slug `<WORKFLOW_SLUG>/answer_question`; falls back to `codebase-researcher-workflow` |
| `WORKFLOW_TASK_SLUG` | `<WORKFLOW_SLUG>/answer_question` | Overrides the full task slug |
| `RENDER_USE_LOCAL_DEV` | `false` | Sends workflow calls to a local `render workflows dev` server |
| `RENDER_LOCAL_DEV_URL` | None | URL of that server; setting it also turns on local dev mode |
| `SLACK_SIGNING_SECRET` | None | Slack request signing secret |
| `SLACK_BOT_TOKEN` | None | Slack bot token; the adapter mounts when this and the signing secret are both set |
| `ALLOWED_CHANNEL_IDS` | None | Comma-separated channel IDs, or `*`. Empty means every mention is ignored |
| `SLACK_CALLBACK_KEY` | Generated by the Blueprint | Derives per-mention callback secrets; falls back to `API_TOKEN` |
| `SLACK_API_URL` | Slack's default | Overrides the Slack Web API base URL |
| `PUBLIC_URL` | `RENDER_EXTERNAL_URL` | Base URL for the Slack callback address |

### Workflow service (`codebase-researcher-workflow`)

| Variable | Default | Description |
|---|---|---|
| `RENDER_API_KEY` | None | Sandbox operations |
| `RENDER_WORKSPACE_ID` | Resolved from the key | Required when the key can see more than one workspace |
| `SANDBOX_PROVIDER` | `render` on Render, otherwise `local` | `render` or `local` |
| `MODEL_PROVIDER` | `anthropic` | Provider name in Pi's registry |
| `MODEL` | `claude-opus-5` | Model ID in that provider's registry |
| `PI_MODEL` | None | Used when `MODEL` is unset |
| `MODEL_API_KEY` | None | Model key; when unset, the provider's own variable (such as `ANTHROPIC_API_KEY`) is used |
| `ANTHROPIC_API_KEY` | None | The key when `MODEL_PROVIDER` is `anthropic` and `MODEL_API_KEY` is unset |
| `PI_THINKING_LEVEL` | `medium` | `off`, `minimal`, `low`, `medium`, or `high` |
| `AGENT_TIMEOUT_MS` | `900000` (15 minutes) | How long the agent may run inside the Sandbox |
| `SANDBOX_PROVISION_TIMEOUT_MS` | `300000` (5 minutes) | Deadline for opening a Render investigation Sandbox: restoring from the snapshot, booting, running `verify.sh`, and reading its manifest. A Sandbox that isn't ready in time is terminated and the attempt retried. Local sandboxes ignore it |
| `SANDBOX_NETWORK_POLICY` | `allow-list` | Egress for investigation Sandboxes: `allow-list`, `allow-all`, or `deny-all` |
| `SANDBOX_ALLOWED_DOMAINS` | Derived from the model | Comma-separated hosts; replaces the derived host |
| `SANDBOX_TIMEOUT_SECONDS` | `1800` | Render terminates an investigation Sandbox after this long, even if the workflow never does. Keep it above the provision and agent timeouts combined |
| `RENDER_API_MIN_INTERVAL_MS` | `1000` | Minimum gap between Sandbox API calls from one task run |
| `SNAPSHOT_NAME` | `snapshotName` in `config.ts` | Overrides the snapshot name |
| `REPOS` | None | Comma-separated `owner/name` list that replaces the repositories in `config.ts` (local dev and testing) |

### Cron job (`codebase-researcher-snapshots`)

| Variable | Default | Description |
|---|---|---|
| `RENDER_API_KEY` | None | Sandbox and snapshot operations |
| `RENDER_WORKSPACE_ID` | Resolved from the key | Required when the key can see more than one workspace |
| `GITHUB_TOKEN` | None | Token for private GitHub repositories; public ones are cloned anonymously |
| Other `tokenEnv` variables | None | Any token variable named in `gitCredentials`, such as `GITLAB_TOKEN` |
| `SANDBOX_BUILDER_TIMEOUT_SECONDS` | `3600` | Render terminates the builder Sandbox after this long |
| `RENDER_API_MIN_INTERVAL_MS` | `1000` | Minimum gap between Sandbox API calls |
| `SNAPSHOT_NAME` | `snapshotName` in `config.ts` | Overrides the snapshot name |
| `REPOS` | None | Replaces the repository list (local dev and testing) |

### Local development and tests

| Variable | Default | Description |
|---|---|---|
| `LOCAL_REPOS_ROOT` | `.scratch/repos` | Parent of the `<owner>/<name>` checkouts local sandboxes read |
| `LOCAL_SANDBOXES_ROOT` | `.scratch/sandboxes` | Holds a scratch directory for each open local sandbox |
| `LOCAL_RUNNER_ARGS` | None | Appended to the bundled runner's command, such as `--faux` |
| `LOCAL_RUNNER_CMD` | None | Replaces the bundled runner entirely, such as `node /abs/path/to/runner.mjs` |
| `LIVE_MODEL_PROVIDER` | None | With that provider's key set, `pnpm test` also runs a live runner smoke test |
| `LIVE_MODEL` | Per provider | Overrides the live test's model |

## Operate it

### Log events

Every service writes one JSON object per line: `{"level", "msg", "event"?, ...fields}`. Workflow lines also carry `task` (`answer_question` or `investigate`), and errors appear in an `err` field as `{name, message}`. Search for these `event` values:

| Service | `event` | Level | Fields | Meaning |
|---|---|---|---|---|
| API | `listening` | info | `port` | The server is up |
| API | `shutting_down` | info | | The server received `SIGTERM` |
| API | `task_started` | info | `run_id`; from Slack also `channel`, `event_id` | A workflow run was started |
| API | `request_failed` | error | `method`, `path`, `error` | An HTTP API request failed with a 500 |
| API | `slack_enabled` | info | | The Slack adapter is mounted |
| API | `slack_disabled` | warn | `reason` | Slack credentials are set but no public URL is, so the adapter isn't mounted |
| API | `slack_no_channels` | warn | | `ALLOWED_CHANNEL_IDS` is empty, so every mention is ignored |
| API | `mention_ignored` | info | `reason`, `channel` | A mention came from a channel not in `ALLOWED_CHANNEL_IDS` |
| API | `slack_retry` | info | `event_id`, `retry_num` | Slack redelivered an event; it starts no second run |
| API | `eyes_failed` | warn | `error` | The :eyes: reaction failed; the question still runs |
| API | `task_start_failed` | error | `event_id`, `error` | Starting a run from Slack failed; the thread gets a failure reply |
| API | `failure_reply_failed` | error | `event_id`, `error` | Posting that failure reply also failed |
| Workflow | `turn_finished` | info | `trace_id`, `outcome`, `model`, `prompt_version`, `repos`, `usage`, `cost_usd`, `duration_ms` | One question finished; `repos` lists the commit of each repository it read |
| Workflow | `workflow_misconfigured` | warn | `provider` and `model`, or `err` | An unknown model, or bad Sandbox configuration, stopped the investigation |
| Workflow | `invalid_question` | warn | `trace_id`, `error` | The run's input failed validation; the caller gets a failure reply |
| Workflow | `deliver_failed` | error | `trace_id`, `err` | The callback still failed after every retry |
| Cron | `snapshot_refresh` | info or error | `ok`, `snapshot_id`, `snapshot_name`, `repos`, `duration_ms`, `error` | A snapshot build finished (`ok: true`, with `repos` the count) or failed (`ok: false`, with `error`) |

A few warnings have a `msg` but no `event`:

- `could not terminate sandbox` (`sandbox_id`, `err`), from the workflow or the cron: a Sandbox couldn't be terminated. Render still terminates it when its timeout (`SANDBOX_TIMEOUT_SECONDS` or `SANDBOX_BUILDER_TIMEOUT_SECONDS`) runs out.
- `snapshot prune failed` (`snapshot_name`, `err`), from the cron: older snapshots weren't deleted. The new snapshot is still in place and the build still counts as a success.
- `investigation failed` (`trace_id`, `err`), from the workflow: the `investigate` subtask failed on every attempt, and the reply says "the investigation kept failing on infrastructure errors".

Every reply carries a trace ID, the workflow's task run ID. To find a question's run, open the workflow service's task runs in the Dashboard and search for it. The cron's `snapshot_refresh` line is the one to alert on: alert when `ok` is false on consecutive runs. A failed build leaves the previous snapshot in place.

### After changing config or env vars

Each service redeploys on its own when files in its `buildFilter` (in `render.yaml`) change. What a change needs beyond that depends on where it takes effect:

- **Repositories in `config.ts`, `prompt.md`, `src/runner/`, or anything under `sandbox-runtime/`:** these are baked into the snapshot, so trigger the snapshot cron. Investigations keep using the old snapshot until a new one is recorded.
- **`snapshotName` in `config.ts`:** the workflow looks for the new name as soon as it redeploys, so trigger the snapshot cron right away. Questions fail with "no repository snapshot is available" until the build finishes.
- **`labels` in `config.ts`:** the API service redeploys; nothing else is needed.
- **Environment variables:** save them in the Dashboard and let the service redeploy. For the cron, **Trigger Run** picks up new values immediately; scheduled runs use the values from the last deploy.

### Troubleshooting

Start with the logs of the service named in each case.

**Every question fails with "the investigation kept failing on infrastructure errors".** Open `codebase-researcher-workflow`'s logs and its failed `investigate` runs, and find the error behind the retries:

- `Render rejected networkPolicy allow-list`: your workspace doesn't accept allow-list egress. Set `SANDBOX_NETWORK_POLICY=allow-all` on the workflow service. This lets investigation Sandboxes reach any host, so weigh the [security boundary](WALKTHROUGH.md#the-security-boundary) first.
- `verify.sh exited`, `unexpected sandbox info line`, or `could not confirm the runner is non-dumpable`: the restored Sandbox failed verification, and the message says which check. A snapshot built by an older version of this repository fails here; trigger the snapshot cron.
- `could not open a sandbox ... within 300000ms (SANDBOX_PROVISION_TIMEOUT_MS)`: restores are slow, usually because many questions arrived together and are sharing the Sandbox API rate limit. Raise `SANDBOX_PROVISION_TIMEOUT_MS`, or expect fewer concurrent questions (see [Operating limits](#operating-limits)).

**Every question fails with "the investigation service is misconfigured".** Find `workflow_misconfigured` in the workflow's logs:

- With `provider` and `model`: that model isn't in Pi's registry. Check `MODEL_PROVIDER` and `MODEL`.
- With an `err` that says `RENDER_WORKSPACE_ID is required: the API key has access to multiple workspaces`: set `RENDER_WORKSPACE_ID` on the workflow service and the cron to the workspace's `tea-…` ID.
- With an `err` that mentions `RENDER_API_KEY is required for Render sandboxes`: set the key on the workflow service.

**Every question fails with "the agent stopped without submitting an answer".** Check that the provider's key is set on the workflow service and is valid. A missing or rejected key ends the run before the agent can submit.

**Questions fail with "the repository snapshot isn't ready" or "no repository snapshot is available".** Trigger `codebase-researcher-snapshots` and read its `snapshot_refresh` line. When `ok` is false, `error` names the step:

- `git ls-remote <repo>`: the repository is private and `GITHUB_TOKEN` is missing or lacks access, or the name in `config.ts` is wrong.
- `RENDER_WORKSPACE_ID is required`: set it on the cron, as above.
- A run that stops without a `snapshot_refresh` line ran out of memory. The cron needs the Standard plan.

**The Slack bot never answers.** Check the API service's logs:

- No `slack_enabled` line: `SLACK_SIGNING_SECRET` or `SLACK_BOT_TOKEN` is missing, or `slack_disabled` says the public URL is.
- `slack_no_channels` or `mention_ignored`: add the channel's ID to `ALLOWED_CHANNEL_IDS`.
- Nothing at all when you mention the bot: the app's event subscription URL is wrong, the `app_mention` event isn't subscribed, or the bot isn't in the channel.
- `eyes_failed`: the app is missing the `reactions:write` scope.
- `task_start_failed`: the API couldn't start the workflow run, and `error` says why (usually `RENDER_API_KEY`).

**The bot reacts but never replies.** Find the run in the workflow service. If it finished, its `deliver` subtask shows why the callback failed. A 401 from `/slack/deliver` means `SLACK_CALLBACK_KEY` changed while the question was running.

### Operating limits

These come from the platform and shape how far one deployment goes:

- **Sandbox API rate limit:** 100 requests a minute per workspace, shared with everything else in it. Each investigation makes 15 to 20 requests, mostly while restoring and verifying its Sandbox. Request spacing (`RENDER_API_MIN_INTERVAL_MS`) applies per task run, not per workspace, so many questions arriving together can exceed the limit. The client retries 429 responses, which slows restores down. Expect a handful of concurrent questions per workspace, not dozens.
- **Sandbox size:** 2 CPUs, 4 GB of RAM, and 10 GB of storage. The checkouts, tools, and runner must fit in 10 GB.
- **Region:** Oregon only, during early access.
- **Run retention:** Render keeps each workflow run's input and result for 30 days. After that, `GET /v1/questions/:id` returns 404. Until then, transcripts and callback secrets are visible to anyone with access to the workflow service in the Dashboard.
- **Snapshot expiry:** snapshots use Render's default lifetime. The hourly cron keeps a fresh one available. If builds fail long enough for the last snapshot to expire, questions fail until a build succeeds.
- **Timeouts:** each `investigate` attempt gets `SANDBOX_PROVISION_TIMEOUT_MS` to open its Sandbox, `AGENT_TIMEOUT_MS` for the agent, and 5 more minutes for setup, collecting output, and cleanup: 25 minutes with the defaults. Infrastructure failures are retried twice, so in the worst case a failing question takes about 75 minutes to report back.

### Measured numbers

From live runs against real Render Sandboxes with `claude-opus-5`:

- Building a 17-repository snapshot (about 2 GB of checkouts): about 5 minutes.
- Restoring a fresh Sandbox from the snapshot: about 15 seconds.
- Investigations: 45 to 140 seconds, at $0.20 to $0.45 each.
- Concurrent questions restore independent Sandboxes from the same immutable snapshot.
