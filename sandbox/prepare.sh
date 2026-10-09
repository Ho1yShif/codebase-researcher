#!/usr/bin/env bash
# Trusted refresh phase, run in the builder sandbox (allow-all egress) as two execs so host tokens exist
# only while repos are cloned. The snapshot refresher first uploads <stage>/{prepare,bin,runner,heads.tsv}.
#   prepare.sh install <stage_dir>                          tools, runner deps, runner user, self-test
#   (the pool manager then uploads <stage>/creds/<host> files, one per host with username\ntoken)
#   prepare.sh checkout <stage_dir> <profile> <created_at>  clone, scrub, manifest, lockdown, verify
# The last stdout line of `checkout` is verify.sh's JSON description of the sandbox; all progress goes to stderr.
set -euo pipefail
umask 022

phase=$1 stage=$2
creds_dir="$stage/creds"
log() { printf 'prepare: %s\n' "$*" >&2; }
fail() { log "$*"; exit 1; }

if [ "$(id -u)" = 0 ]; then
  root=/opt/triage run_as=investigator
else
  root="$HOME/triage" run_as=$(id -un)
fi
case "$root" in *[!A-Za-z0-9._/-]*) fail "unsupported root path $root" ;; esac
app="$root/app"

create_runner_user() {
  if id -u "$run_as" >/dev/null 2>&1; then return; fi
  if command -v useradd >/dev/null; then
    useradd --system --user-group --no-create-home --home-dir "$root/scratch/home" --shell /usr/sbin/nologin "$run_as"
  elif command -v adduser >/dev/null; then
    addgroup -S "$run_as"
    adduser -S -D -H -h "$root/scratch/home" -s /sbin/nologin -G "$run_as" "$run_as"
  else
    fail "cannot create $run_as: no useradd or adduser"
  fi
}

install_phase() {
  # Everything here may run third-party code (npm, the runner self-test), so no token must exist yet.
  if [ -d "$creds_dir" ] && [ -n "$(ls -A "$creds_dir" 2>/dev/null)" ]; then
    fail "credential files exist in $creds_dir before the install phase"
  fi
  if [ -e "$root" ]; then fail "$root already exists; prepare expects a fresh builder"; fi
  mkdir -p "$app" "$root/repos" "$root/scratch"
  cp "$stage"/*.sh "$stage"/*.mjs "$app/"
  cp -R "$stage/runner" "$app/"
  log "root=$root uid=$(id -u) run_as=$run_as"

  bash "$app/install-tools.sh" "$app"
  local node drop=none runner_node
  if [ -x "$app/node/bin/node" ]; then node="$app/node/bin/node"; else node=$(command -v node); fi
  runner_node=$node
  if [ "$(id -u)" = 0 ]; then
    for tool in setpriv runuser su; do
      if command -v "$tool" >/dev/null; then drop=$tool; break; fi
    done
    [ "$drop" != none ] || fail "running as root but no setpriv/runuser/su to drop privileges"
    create_runner_user
    # Execute-only copy of $node, installed by lockdown.sh.
    runner_node="$app/node-runner"
  fi

  {
    printf 'TRIAGE_ROOT=%q\n' "$root"
    printf 'TRIAGE_APP_DIR=%q\n' "$app"
    printf 'TRIAGE_REPOS_ROOT=%q\n' "$root/repos"
    printf 'TRIAGE_SCRATCH_DIR=%q\n' "$root/scratch"
    printf 'TRIAGE_RUN_AS=%q\n' "$run_as"
    printf 'TRIAGE_DROP=%q\n' "$drop"
    printf 'TRIAGE_NODE=%q\n' "$node"
    printf 'TRIAGE_RUNNER_NODE=%q\n' "$runner_node"
    printf 'TRIAGE_PATH=%q\n' "$app/bin:$(dirname "$node"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  } >"$app/env"
  printf '[safe]\n\tdirectory = *\n[core]\n\tfsmonitor = false\n[gc]\n\tauto = 0\n' >"$app/gitconfig"

  log "installing runner dependencies"
  [ -f "$app/runner/package-lock.json" ] || fail "runner/package-lock.json is missing; rebuild sandbox/runner"
  (
    cd "$app/runner"
    PATH="$(dirname "$node"):$PATH"
    export PATH
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache "$stage/npm-cache"
  ) >&2

  # Uploaded files can arrive owner-only; the self-test runs as the runner user.
  chmod 755 "$root"
  chmod -R a+rX,go-w "$app"
  timeout 120 "$app/as-runner.sh" "$node" "$app/runner/runner.mjs" --self-test >&2 || fail "runner self-test failed"
}

checkout_phase() {
  local profile=$1 created_at=$2
  trap 'rm -rf "$creds_dir"' EXIT
  [ -f "$app/env" ] || fail "$app/env is missing; run the install phase first"
  # shellcheck source=/dev/null
  . "$app/env"
  bash "$app/clone.sh" "$TRIAGE_REPOS_ROOT" "$stage/heads.tsv" "$creds_dir"
  bash "$app/scrub-credentials.sh" "$TRIAGE_REPOS_ROOT" "$creds_dir"
  "$TRIAGE_NODE" "$app/write-manifest.mjs" "$stage/heads.tsv" "$profile" "$created_at" "$TRIAGE_REPOS_ROOT" >"$app/manifest.json"
  bash "$app/lockdown.sh"
  rm -rf "$stage"
  bash "$app/verify.sh"
}

case "$phase" in
  install) install_phase ;;
  checkout) checkout_phase "$3" "$4" ;;
  *) fail "unknown phase '$phase' (expected install or checkout)" ;;
esac
