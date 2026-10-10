#!/usr/bin/env bash
# Runs a command as $TRIAGE_RUN_AS from the scratch dir with a minimal environment. As root it drops privileges
# (setpriv, runuser, or su, as chosen at prepare time); otherwise it only scrubs the environment.
# Usage: as-runner.sh <command> [args...]
set -euo pipefail

# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/env"
home="$TRIAGE_SCRATCH_DIR/home" tmp="$TRIAGE_SCRATCH_DIR/tmp"
mkdir -p "$home" "$tmp"
drop=false
if [ "$(id -u)" = 0 ] && [ "$TRIAGE_RUN_AS" != root ]; then
  drop=true
  chown "$TRIAGE_RUN_AS": "$home" "$tmp"
fi
cd "$TRIAGE_SCRATCH_DIR"

env_args=(
  HOME="$home" TMPDIR="$tmp" PATH="$TRIAGE_PATH" LANG=C.UTF-8 USER="$TRIAGE_RUN_AS"
  GIT_CONFIG_GLOBAL="$TRIAGE_APP_DIR/gitconfig" GIT_CONFIG_NOSYSTEM=1 GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0
)
if [ "$drop" = false ]; then exec env -i "${env_args[@]}" "$@"; fi
case "$TRIAGE_DROP" in
  setpriv)
    exec setpriv --reuid="$TRIAGE_RUN_AS" --regid="$(id -g "$TRIAGE_RUN_AS")" --init-groups --no-new-privs -- env -i "${env_args[@]}" "$@"
    ;;
  runuser) exec runuser -u "$TRIAGE_RUN_AS" -- env -i "${env_args[@]}" "$@" ;;
  su)
    # shellcheck disable=SC2016 # "$@" is expanded by the target user's shell
    exec su -s /bin/sh -c 'exec "$@"' -- "$TRIAGE_RUN_AS" sh env -i "${env_args[@]}" "$@"
    ;;
  *)
    echo "as-runner: no privilege-drop tool (TRIAGE_DROP=$TRIAGE_DROP)" >&2
    exit 1
    ;;
esac
