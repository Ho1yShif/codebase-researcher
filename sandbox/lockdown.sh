#!/usr/bin/env bash
# Makes the repos read-only. As root, gives scratch (and nothing else) to the runner user created at install time,
# so investigations cannot modify repos or the app, and installs the execute-only node the runner is launched with:
# a process exec'd from a binary it cannot read is non-dumpable, so same-uid tool subprocesses cannot read its
# memory (the model key) through /proc. Without root, a-w is accident prevention only.
# Usage: lockdown.sh   (paths come from <app_dir>/env)
set -euo pipefail

# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/env"
log() { printf 'lockdown: %s\n' "$*" >&2; }

if [ "$(id -u)" != 0 ]; then
  chmod -R a-w "$TRIAGE_REPOS_ROOT"
  log "not root: repos are a-w but still owned by $TRIAGE_RUN_AS (accident prevention only)"
  exit 0
fi

if ! id -u "$TRIAGE_RUN_AS" >/dev/null 2>&1; then
  log "runner user $TRIAGE_RUN_AS does not exist"
  exit 1
fi
chown -R root:root "$TRIAGE_ROOT"
chmod 755 "$TRIAGE_ROOT"
chmod -R a+rX,go-w "$TRIAGE_APP_DIR"
chmod -R a+rX,a-w "$TRIAGE_REPOS_ROOT"
chown "$TRIAGE_RUN_AS": "$TRIAGE_SCRATCH_DIR"
chmod 700 "$TRIAGE_SCRATCH_DIR"
# After the recursive chmod above, which would make it readable again.
install -o root -g root -m 0711 "$TRIAGE_NODE" "$TRIAGE_RUNNER_NODE"
log "repos are root-owned and read-only; scratch belongs to $TRIAGE_RUN_AS; runner node is execute-only"
