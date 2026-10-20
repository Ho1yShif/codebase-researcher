#!/usr/bin/env bash
# Runs in the builder after cloning, before the snapshot. Fails if any staged token value made it into a git
# config, a credential store, or a repository's .git directory; otherwise deletes the staged credentials.
# Usage: scrub-credentials.sh <creds_dir> <repos_root>
set -euo pipefail

creds_dir=$1
repos_root=$2
fail() { printf 'scrub-credentials: %s\n' "$*" >&2; exit 1; }

repos=$(find "$repos_root" -mindepth 3 -maxdepth 3 -name .git -type d -exec dirname {} \;)
[ -n "$repos" ] || fail "no repos under $repos_root"

# ── Search for each token value ──────────────────────────────────────────
# grep -F -f reads the pattern from a file, so the token never appears in argv (visible in /proc).

if [ -d "$creds_dir" ]; then
  pattern_file=$(mktemp)
  trap 'rm -f "$pattern_file"' EXIT
  for cf in "$creds_dir"/*; do
    [ -s "$cf" ] || continue
    sed -n '2p' "$cf" >"$pattern_file"
    for f in ~/.gitconfig ~/.git-credentials ~/.config/git /etc/gitconfig; do
      if [ -e "$f" ] && grep -rqsF -f "$pattern_file" -- "$f"; then fail "token for $(basename "$cf") found in $f"; fi
    done
    while IFS= read -r r; do
      if grep -rqsF --exclude-dir=objects -f "$pattern_file" -- "$r/.git"; then fail "token for $(basename "$cf") found in $r/.git"; fi
    done <<<"$repos"
  done
fi

rm -rf "$creds_dir"
[ ! -e "$creds_dir" ] || fail "could not delete $creds_dir"

# ── No credential settings may survive ───────────────────────────────────

[ ! -e "$HOME/.git-credentials" ] || fail "$HOME/.git-credentials exists"
settings='^(credential\.|url\..*\.insteadof|http\..*\.extraheader)'
for scope in --system --global; do
  if git config "$scope" --get-regexp "$settings" >/dev/null 2>&1; then fail "credential settings in git $scope config"; fi
done
while IFS= read -r r; do
  if git -c safe.directory='*' -C "$r" config --local --get-regexp "$settings" >/dev/null 2>&1; then fail "$r: credential settings"; fi
  url=$(git -c safe.directory='*' -C "$r" config --local --get remote.origin.url 2>/dev/null || true)
  case "$url" in *@*) fail "$r: remote URL carries credentials" ;; esac
done <<<"$repos"
