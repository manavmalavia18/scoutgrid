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
