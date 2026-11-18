#!/usr/bin/env bash
# Publish only this workflow's owned snapshot files on top of current main.
# A soft reset preserves an OLD runner's whole tree/index and can silently
# undo unrelated commits made while the scan was running.
set -euo pipefail
if (( $# < 2 )); then
  echo 'usage: push-owned-snapshot.sh COMMIT_PREFIX path ...' >&2
  exit 2
fi
prefix=$1
shift

# On a self-hosted runner's persistent workspace, actions/checkout's
# injected credential (an http.extraheader on this one repo clone) isn't as
# reliably present for the whole job as it is on a disposable hosted-runner
# VM -- confirmed live 2026-11-17: a push failed with "fatal: could not
# read Username for 'https://github.com': Device not configured" (no TTY
# to prompt for credentials) after a long-running scrape step, well after
# checkout had run successfully. Making the push self-authenticating here
# removes the dependency on that state surviving the whole job, without
# changing anything for the GitHub-hosted workflows that call this same
# script and have never hit this (their checkout is always fresh).
if [[ -n "${GITHUB_TOKEN:-}" && -n "${GITHUB_REPOSITORY:-}" ]]; then
  git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
fi

snapshot=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/scoutgrid-snapshot.XXXXXX")
trap 'rm -rf "$snapshot"' EXIT
for path in "$@"; do
  if [[ ! -f "$path" ]]; then
    echo "missing owned output: $path" >&2
    exit 2
  fi
  mkdir -p "$snapshot/$(dirname "$path")"
  cp "$path" "$snapshot/$path"
done
for attempt in 1 2 3 4 5 6 7 8; do
  git fetch origin main --quiet
  git reset --hard origin/main --quiet
  for path in "$@"; do
    mkdir -p "$(dirname "$path")"
    cp "$snapshot/$path" "$path"
  done
  git add -- "$@"
  if git diff --cached --quiet; then
    echo 'owned outputs already published'
    exit 0
  fi
  git commit -m "$prefix: $(date -u +%Y-%m-%dT%H:%M:%SZ)" --quiet
  if git push origin HEAD:main; then
    exit 0
  fi
  backoff=$((attempt * 8))
  echo "push attempt $attempt failed; retrying in ${backoff}s" >&2
  sleep "$backoff"
done
echo 'failed to publish owned outputs after 8 attempts' >&2
exit 1
