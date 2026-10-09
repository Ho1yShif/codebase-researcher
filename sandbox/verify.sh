#!/usr/bin/env bash
# Verifies a prepared sandbox: the builder before it is snapshotted, and every pool member after restore.
# Prints one JSON line describing the sandbox (layout, runner user, Pi/prompt versions, runner dumpability, DNS).
# Usage: verify.sh [--deny-probe URL] [--allow-probe URL]   (egress probes run as the runner user)
set -euo pipefail

app=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=/dev/null
. "$app/env"
fail() { printf 'verify: %s\n' "$*" >&2; exit 1; }
as_runner() { "$app/as-runner.sh" "$@"; }

deny_probe="" allow_probe=""
while [ $# -gt 0 ]; do
  case "$1" in
    --deny-probe) deny_probe=$2; shift 2 ;;
    --allow-probe) allow_probe=$2; shift 2 ;;
    *) fail "unknown argument $1" ;;
  esac
done

for tool in git rg timeout; do PATH="$TRIAGE_PATH" command -v "$tool" >/dev/null || fail "missing $tool"; done
node_version=$("$TRIAGE_NODE" -p 'process.versions.node') || fail "node does not run"
[ "${node_version%%.*}" -ge 22 ] || fail "node $node_version is older than 22"

bash "$app/scrub-credentials.sh" "$TRIAGE_REPOS_ROOT" /tmp/triage-stage/creds
[ ! -e /tmp/triage-stage ] || fail "staging dir /tmp/triage-stage still exists"

entries=$("$TRIAGE_NODE" -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const r of m.repos) console.log([r.commit, r.path, r.repository].join("\t"));
' "$app/manifest.json") || fail "cannot read manifest"
[ -n "$entries" ] || fail "manifest lists no repos"
g() { GIT_OPTIONAL_LOCKS=0 git -c safe.directory='*' -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$path" "$@"; }
while IFS=$'\t' read -r commit path repo; do
  head=$(g rev-parse HEAD 2>&1) || fail "$repo: $head"
  [ "$head" = "$commit" ] || fail "$repo: HEAD $head != manifest $commit"
  dirty=$(g status --porcelain --ignored 2>&1) || fail "$repo: git status failed: $dirty"
  [ -z "$dirty" ] || fail "$repo: working tree modified"
done <<<"$entries"

self_test=$(as_runner "$TRIAGE_RUNNER_NODE" "$app/runner/runner.mjs" --self-test) || fail "runner self-test failed"

# Tool subprocesses run with the runner's uid; only a non-dumpable runner keeps its memory (the model key) from them.
non_dumpable=false
if [ "$(id -u)" = 0 ] && [ "$TRIAGE_RUN_AS" != root ]; then
  # The sandbox has no usable /dev/fd, so the probe reports its pid through a file instead of process substitution.
  pidfile="$TRIAGE_SCRATCH_DIR/.triage-dumpable-probe.pid"
  rm -f "$pidfile"
  as_runner "$TRIAGE_RUNNER_NODE" -e 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)' "$pidfile" &
  launcher=$!
  for _ in $(seq 1 100); do [ -s "$pidfile" ] && break; sleep 0.2; done
  pid=$(cat "$pidfile" 2>/dev/null) || fail "$TRIAGE_RUNNER_NODE did not start"
  stop_probe() { kill "$pid" 2>/dev/null || true; wait "$launcher" 2>/dev/null || true; }
  if err=$(as_runner cat "/proc/$pid/maps" 2>&1 >/dev/null); then
    stop_probe
    fail "runner is dumpable: $TRIAGE_RUN_AS can read /proc/$pid/maps of $TRIAGE_RUNNER_NODE"
  fi
  stop_probe
  case "$err" in *"Permission denied"*) non_dumpable=true ;; *) fail "dumpability probe inconclusive: $err" ;; esac
fi
# Informational: resolution of arbitrary names is an exfiltration channel the network policy does not close.
dns_resolves=false
if timeout 10 "$app/as-runner.sh" getent hosts example.com >/dev/null 2>&1; then dns_resolves=true; fi

repo=$(find "$TRIAGE_REPOS_ROOT" -mindepth 2 -maxdepth 2 -type d | head -n 1)
[ -n "$repo" ] || fail "no repos under $TRIAGE_REPOS_ROOT"
if as_runner touch "$repo/.triage-write-probe" 2>/dev/null; then
  rm -f "$repo/.triage-write-probe"
  fail "$repo is writable by $TRIAGE_RUN_AS"
fi
as_runner touch "$TRIAGE_SCRATCH_DIR/.triage-write-probe" || fail "scratch is not writable by $TRIAGE_RUN_AS"

probe='fetch(process.argv[1], { redirect: "manual", signal: AbortSignal.timeout(8000) }).then(() => process.exit(0), () => process.exit(1))'
if [ -n "$deny_probe" ] && as_runner "$TRIAGE_NODE" -e "$probe" "$deny_probe"; then fail "egress to $deny_probe is allowed"; fi
if [ -n "$allow_probe" ] && ! as_runner "$TRIAGE_NODE" -e "$probe" "$allow_probe"; then fail "egress to $allow_probe is blocked"; fi

find "$TRIAGE_SCRATCH_DIR" -mindepth 1 -delete

"$TRIAGE_NODE" -e '
const [reposRoot, scratchDir, appDir, runAs, uid, drop, selfTest, nonDumpable, dnsResolves] = process.argv.slice(1);
const info = { reposRoot, scratchDir, appDir };
console.log(JSON.stringify({
  layout: info, runAs, uid: Number(uid), drop, node: process.version,
  runnerNonDumpable: nonDumpable === "true", dnsResolves: dnsResolves === "true",
  selfTest: JSON.parse(selfTest.trim().split("\n").pop()),
}));
' "$TRIAGE_REPOS_ROOT" "$TRIAGE_SCRATCH_DIR" "$TRIAGE_APP_DIR" "$TRIAGE_RUN_AS" "$(id -u)" "$TRIAGE_DROP" "$self_test" "$non_dumpable" "$dns_resolves"
