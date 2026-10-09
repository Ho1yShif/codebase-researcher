#!/usr/bin/env bash
# Deletes per-host credential files and proves no token from any host survived the clone. Runs before the
# builder is snapshotted and again (via verify.sh) in every pool member.
# Usage: scrub-credentials.sh <repos_root> <creds_dir>
set -euo pipefail

repos_root=$1 creds_dir=$2
fail() { printf 'scrub-credentials: %s\n' "$*" >&2; exit 1; }
g() { git -c safe.directory='*' -C "$1" "${@:2}"; }

repos=$(find "$repos_root" -mindepth 3 -maxdepth 3 -name .git -type d -exec dirname {} \;)
[ -n "$repos" ] || fail "no repos under $repos_root"

# Check every credential file's token against git configs and repo internals, then delete it.
if [ -d "$creds_dir" ]; then
  for cred_file in "$creds_dir"/*; do
    [ -s "$cred_file" ] || continue
    # The token is on the second line; use it as the grep pattern via -f.
    token_tmp=$(mktemp)
    sed -n '2p' "$cred_file" > "$token_tmp"
    for f in "$HOME/.gitconfig" "$HOME/.git-credentials" "$HOME/.config/git" /etc/gitconfig; do
      if [ -e "$f" ] && grep -rqsF -f "$token_tmp" -- "$f"; then rm -f "$token_tmp"; fail "token value from $(basename "$cred_file") found in $f"; fi
    done
    while IFS= read -r r; do
      if grep -rqsF --exclude-dir=objects -f "$token_tmp" -- "$r/.git"; then rm -f "$token_tmp"; fail "token value from $(basename "$cred_file") found in $r/.git"; fi
    done <<<"$repos"
    rm -f "$token_tmp"
  done
fi
rm -rf "$creds_dir"
[ ! -e "$creds_dir" ] || fail "could not delete $creds_dir"
[ ! -e "$HOME/.git-credentials" ] || fail "$HOME/.git-credentials exists"

pattern='^(credential\.|url\..*\.insteadof|http\..*\.extraheader)'
for scope in --system --global; do
  if git config "$scope" --get-regexp "$pattern" >/dev/null 2>&1; then fail "credential settings in git $scope config"; fi
done
while IFS= read -r r; do
  if g "$r" config --local --get-regexp "$pattern" >/dev/null 2>&1; then fail "$r: credential settings in .git/config"; fi
  url=$(g "$r" config --local --get remote.origin.url || true)
  case "$url" in *@*) fail "$r: remote URL carries credentials" ;; esac
done <<<"$repos"
