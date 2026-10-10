# Design

## Architecture

The system has three services:

**API** (`code-investigator-api`, web service) accepts questions over HTTP and optionally listens for Slack mentions. It starts a workflow run for each question and returns immediately, so Slack's 3-second acknowledgement deadline is met without background threads or queues.

**Workflow** (`code-investigator-workflow`, Render Workflow) defines one parent task (`answer_question`) and two subtasks (`investigate` and `deliver`). The parent task starts `investigate`, collects the result, and optionally starts `deliver` to POST the result to a callback URL.

**Cron** (`code-investigator-snapshots`, hourly) resolves the current default-branch HEAD for each configured repository, clones them into a builder Sandbox, locks the filesystem down, and takes a named snapshot. It then prunes older snapshots, keeping the newest two. The snapshot name is a stable string set in `config.ts`. Sandbox restore uses the same name, so the workflow always gets the latest available snapshot.

// TODO: Diagram

## Core concepts [TODO - BETTER TITLE]

The core abstraction is a question (a transcript, an optional callback, and optional metadata) answered asynchronously. Slack is one consumer, but the same API can serve any caller: a CLI, a web dashboard, a CI pipeline, or another bot. The Slack adapter translates between Slack's event model and the question API, but the investigation pipeline knows nothing about Slack.

This separation means the investigation logic does not depend on Slack's SDK, rate limits, or message formatting. It also means the Slack adapter can be turned off entirely (by omitting its env vars) without changing any other code.

Each question gets its own Sandbox. Reusing a Sandbox across questions would let one investigation's side effects (files in scratch, environment changes, leftover processes) influence the next. A fresh restore from an immutable snapshot guarantees that every question starts from the same known state. It also simplifies cleanup: the Sandbox is terminated in a `finally` block, and any failure to clean up is bounded by the provider-side timeout.

The cost is restore latency (about 15 seconds). This is acceptable for a support use case where investigations take ~1-2 minutes.

## Cron: Hourly rebuild

The cron runs every hour whether or not the repositories changed. This is simpler than webhook-driven builds and avoids the failure modes of webhook delivery (missed events, duplicate events, webhook secret rotation). An hourly cadence is frequent enough that investigations see commits within an hour of landing. It also keeps snapshots from expiring (Render's snapshot retention is time-based), so the bot stays available without monitoring snapshot age.

Building unconditionally means some builds are redundant (the same commits, the same snapshot). This is inexpensive: a build takes about 5 minutes and uses a starter-plan cron, and the two-snapshot retention window means only one redundant snapshot exists at any time.

## The security boundary

The goal is to prevent the model (via the coding agent's tool calls) from reading secrets it should not have, modifying the repositories, or reaching services beyond its own API provider.

**Filesystem isolation.** Repositories are cloned by a builder Sandbox with full egress. Before the snapshot, the lockdown step in `src/sandbox/render/snapshot.ts` transfers ownership to root, makes everything read-only, and gives the runner user write access only to a scratch directory. The runner binary (`node`) is installed as an execute-only copy, making the runner process non-dumpable: same-uid tool subprocesses cannot read its memory (which holds the model API key) through `/proc`.

**Credential separation.** Git tokens exist only during the builder's clone phase. They arrive as per-host files uploaded after the install phase (which runs npm and the runner self-test, both of which execute third-party code). After cloning, the credential scrub step deletes the files and verifies that no token value appears in any git config, `.git/` directory, or global credential store. The snapshot is taken only after this verification passes. Per-question Sandboxes restored from the snapshot never see git tokens.

The model API key is delivered to each investigation Sandbox as a one-time file. The runner reads it, deletes it, and removes every provider key var from `process.env` before starting the agent. Tool subprocesses inherit a clean environment built from an allowlist, so even if the agent constructs a command that reads environment variables, it finds nothing.

**Network policy.** Investigation Sandboxes are created with an allow-list network policy containing only the model provider's API host (derived automatically from the model's base URL in Pi's registry). The builder always uses allow-all because it needs to reach git hosts and npm.

### Known residual risk: DNS

The allow-list network policy blocks TCP/TLS connections to hosts not on the list, but DNS resolution still works for arbitrary names. An adversarial model could encode data in DNS queries (e.g., as subdomain labels) to exfiltrate the API key or investigation content. `verify.sh` checks and logs whether DNS resolves (`dnsResolves: true/false` in the sandbox info).

This is accepted as a residual risk for several reasons: the API key is spend-capped, the key is available only in memory (non-dumpable), and DNS exfiltration is low-bandwidth and noisy. A future mitigation could use a custom DNS resolver that blocks queries to non-allowlisted domains, but this is not implemented.

## What is deliberately out of scope

- **Web UI.** The API is the interface. A UI can be built on top of it.
- **Stored history.** Workflow runs are the history. A separate service could archive them, but the investigator does not.
- **Write access.** The agent cannot modify repositories, open pull requests, or write to any external system. Its only output is the structured investigation result.
- **Live-system inspection.** The agent reads checked-out source code, not running services, databases, or metrics. It answers "what does the code do," not "what is happening right now."
