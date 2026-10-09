#!/usr/bin/env bash
# Full clones (history and blobs, so log/blame work offline) of every repo in heads.tsv
# (repository<TAB>branch<TAB>commit<TAB>url<TAB>browse), each detached at its pinned commit.
# A credential helper reads the per-host token from <creds_dir>/<host> on demand, so no token
# appears in argv, remote URLs, or .git/config. Usage: clone.sh <repos_root> <heads.tsv> <creds_dir>
set -euo pipefail

repos_root=$1 heads=$2 creds_dir=$3
log() { printf 'clone: %s\n' "$*" >&2; }

# The empty helper resets system/global helpers first, so nothing can store the token.
# The second helper reads `host=` from git's credential protocol, finds the matching cred file,
# and returns the username and token stored there (line 1 = username, line 2 = token).
auth=(-c credential.helper=)
if [ -d "$creds_dir" ] && [ -n "$(ls -A "$creds_dir" 2>/dev/null)" ]; then
  export TRIAGE_CREDS_DIR=$creds_dir
  # shellcheck disable=SC2016 # expanded by git's helper shell, not here
  auth+=(-c 'credential.helper=!f() { test "$1" = get || return 0; host=""; while IFS= read -r line; do case "$line" in host=*) host="${line#host=}" ;; esac; done; case "$host" in ""|*[!A-Za-z0-9.:-]*) return 0 ;; esac; cf="$TRIAGE_CREDS_DIR/$host"; [ -s "$cf" ] || return 0; { IFS= read -r u && IFS= read -r p; } < "$cf"; printf "username=%s\npassword=%s\n" "$u" "$p"; }; f')
fi

while IFS=$'\t' read -r repo branch commit url browse; do
  [ -n "$repo" ] || continue
  clone_url="${url:-https://github.com/$repo.git}"
  case "$clone_url" in
    https://*) ;;
    file://*) [ "${TRIAGE_ALLOW_FILE_URLS:-}" = 1 ] || { log "$repo: file:// URLs require TRIAGE_ALLOW_FILE_URLS=1"; exit 1; } ;;
    *) log "$repo: unsupported URL scheme in $clone_url"; exit 1 ;;
  esac
  dest="$repos_root/$repo"
  log "$repo $branch@$commit"
  mkdir -p "$(dirname "$dest")"
  GIT_TERMINAL_PROMPT=0 git "${auth[@]}" clone --quiet --single-branch --branch "$branch" --no-tags -- "$clone_url" "$dest" >&2
  # Ownership/mode changes during lockdown and snapshot restore must not invalidate the stat cache.
  git -C "$dest" config core.checkStat minimal
  git -C "$dest" config core.trustctime false
  git -C "$dest" config gc.auto 0
  git -C "$dest" -c advice.detachedHead=false checkout --quiet --detach "$commit"
  head=$(git -C "$dest" rev-parse HEAD)
  if [ "$head" != "$commit" ]; then log "$repo: HEAD $head != $commit"; exit 1; fi
done <"$heads"
