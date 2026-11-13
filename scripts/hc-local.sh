#!/usr/bin/env bash
# hc-local — run Scoutgrid's existing HiringCafe Patchright/Chrome scanner
# locally on macOS, fully outside the git repo, for both the Software and
# Data tracks. Reuses fetch-hiringcafe-feed.mjs / run-hc.mjs / scrape-hiringcafe.py
# as-is (same query, pagination, parsing, dedup, retention, last-good-feed
# protection, and cross-track reuse logic hc.yml/hc-data.yml use in CI) --
# this script only supplies local paths and local scheduling, it does not
# reimplement any scanning logic.
#
# Usage:
#   hc-local.sh setup                 # create local dirs/venv/plists (idempotent, auto-run by others)
#   hc-local.sh run-once [software|data|both]   (default: both)
#   hc-local.sh start    [software|data|both]   # enable recurring local scans (launchd)
#   hc-local.sh stop     [software|data|both]   # disable recurring local scans
#   hc-local.sh status   [software|data|both]
#
# Nothing here ever touches the git repo's data/ directory, commits, or
# pushes anything -- everything lives under $HC_LOCAL_DIR
# (default: ~/.scoutgrid-local), a plain dot-directory in $HOME (NOT under
# Desktop/Documents/Downloads/Library -- those are TCC-protected and will
# silently crash-loop a launchd job that logs there).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DIR="${HC_LOCAL_DIR:-$HOME/.scoutgrid-local}"
VENV="$LOCAL_DIR/venv"
# Override (used by tests) to skip real venv/Chromium provisioning — when
# set, setup() trusts it's already a usable interpreter and never touches
# $VENV. Left unset, the normal "create $VENV if missing" path runs.
PY="${HC_LOCAL_PYTHON:-$VENV/bin/python3}"
LOG_DIR="$LOCAL_DIR/logs"
SW_DIR="$LOCAL_DIR/software"
DA_DIR="$LOCAL_DIR/data"
LAUNCH_AGENTS_DIR="${HC_LOCAL_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHCTL="${HC_LOCAL_LAUNCHCTL:-launchctl}"
LABEL_PREFIX="com.scoutgrid.hc-local"
NODE_BIN="$(command -v node)"
# Cadence intentionally matches the existing production workflows
# (hc.yml/hc-data.yml both run every 45 minutes) -- this does NOT raise
# cadence beyond what's already established as safe for this source.
START_INTERVAL_SEC=2700

log() { echo "[hc-local] $*"; }

track_label() { echo "${LABEL_PREFIX}.$1"; }
track_plist() { echo "$LAUNCH_AGENTS_DIR/$(track_label "$1").plist"; }

setup() {
  mkdir -p "$SW_DIR" "$DA_DIR" "$LOG_DIR"
  mkdir -p "$SW_DIR/hiringcafe-profile" "$DA_DIR/hiringcafe-profile-data"
  if [ -z "${HC_LOCAL_PYTHON:-}" ] && [ ! -x "$PY" ]; then
    log "creating local venv at $VENV"
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install --quiet --upgrade pip patchright
    "$PY" -m patchright install chromium
  fi
  write_plist software
  write_plist data
}

write_plist() {
  local track="$1"
  local plist
  plist="$(track_plist "$track")"
  mkdir -p "$LAUNCH_AGENTS_DIR"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(track_label "$track")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$REPO_ROOT/scripts/hc-local.sh</string>
    <string>run-once</string>
    <string>$track</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_ROOT</string>
  <key>StartInterval</key>
  <integer>$START_INTERVAL_SEC</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/$track-launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/$track-launchd.log</string>
</dict>
</plist>
PLIST
  log "wrote $plist (not loaded — run 'hc-local.sh start $track' to enable recurring scans)"
}

resolve_tracks() {
  case "${1:-both}" in
    software|data) echo "$1" ;;
    both|"") echo "software data" ;;
    *) log "unknown track '$1' (expected software|data|both)"; exit 2 ;;
  esac
}

run_once_track() {
  local track="$1"
  setup
  log "running $track scan (this reuses the existing fetch-hiringcafe-feed.mjs pipeline unchanged)"
  (
    cd "$REPO_ROOT"
    export HC_PYTHON="$PY"
    case "$track" in
      software)
        export HC_OUT="$SW_DIR/hiringcafe-feed.json"
        export HC_HITS_TMP="$SW_DIR/hc-hits.tmp.json"
        export HC_HEARTBEAT="$SW_DIR/scan-hc-heartbeat.json"
        export HC_LOCK="$SW_DIR/hc-feed.lock"
        export HC_PROFILE="$SW_DIR/hiringcafe-profile"
        unset HC_QUERIES HC_REUSE_FEED_FROM || true
        ;;
      data)
        export HC_OUT="$DA_DIR/hiringcafe-feed-data.json"
        export HC_HITS_TMP="$DA_DIR/hc-hits-data.tmp.json"
        export HC_HEARTBEAT="$DA_DIR/scan-hc-heartbeat-data.json"
        export HC_LOCK="$DA_DIR/hc-feed-data.lock"
        export HC_PROFILE="$DA_DIR/hiringcafe-profile-data"
        # Same cross-track reuse hc-data.yml uses in production, pointed at
        # the LOCAL software feed instead of the repo's committed one --
        # preserves the exact same reuse behavior/coverage locally.
        export HC_QUERIES="$("$NODE_BIN" "$REPO_ROOT/scripts/hc-local-data-queries.mjs")"
        export HC_REUSE_FEED_FROM="$SW_DIR/hiringcafe-feed.json"
        ;;
    esac
    set +e
    "$NODE_BIN" run-hc.mjs --hours 96 2>&1 | tee -a "$LOG_DIR/$track.log"
    local status=${PIPESTATUS[0]}
    set -e
    if [ "$status" -ne 0 ]; then
      log "$track scan exited non-zero ($status) — see $LOG_DIR/$track.log and the heartbeat for the reason. Last-good feed (if any) is untouched."
    fi
  )
}

cmd_run_once() {
  local tracks
  tracks="$(resolve_tracks "${1:-both}")"
  for t in $tracks; do run_once_track "$t"; done
}

cmd_start() {
  setup
  local tracks
  tracks="$(resolve_tracks "${1:-both}")"
  for t in $tracks; do
    local plist label
    plist="$(track_plist "$t")"
    label="$(track_label "$t")"
    "$LAUNCHCTL" bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || true
    "$LAUNCHCTL" enable "gui/$(id -u)/$label" 2>/dev/null || true
    log "started recurring local scans for $t (every $((START_INTERVAL_SEC/60)) min, next run on schedule — not immediately)"
  done
}

cmd_stop() {
  local tracks
  tracks="$(resolve_tracks "${1:-both}")"
  for t in $tracks; do
    local label
    label="$(track_label "$t")"
    "$LAUNCHCTL" bootout "gui/$(id -u)/$label" 2>/dev/null || true
    log "stopped recurring local scans for $t (an in-progress scan, if any, is not interrupted — only future scheduled runs are disabled)"
  done
}

cmd_status() {
  local tracks
  tracks="$(resolve_tracks "${1:-both}")"
  for t in $tracks; do
    local label
    label="$(track_label "$t")"
    if "$LAUNCHCTL" list 2>/dev/null | grep -q "$label"; then
      log "$t: recurring local scans ENABLED (launchd label $label loaded)"
    else
      log "$t: recurring local scans disabled (run 'hc-local.sh start $t' to enable)"
    fi
    case "$t" in
      software)
        "$NODE_BIN" "$REPO_ROOT/scripts/hc-local-status.mjs" software "$SW_DIR/hc-feed.lock" "$SW_DIR/scan-hc-heartbeat.json" "$SW_DIR/hiringcafe-feed.json"
        ;;
      data)
        "$NODE_BIN" "$REPO_ROOT/scripts/hc-local-status.mjs" data "$DA_DIR/hc-feed-data.lock" "$DA_DIR/scan-hc-heartbeat-data.json" "$DA_DIR/hiringcafe-feed-data.json"
        ;;
    esac
  done
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    setup) setup ;;
    run-once) cmd_run_once "${1:-both}" ;;
    start) cmd_start "${1:-both}" ;;
    stop) cmd_stop "${1:-both}" ;;
    status) cmd_status "${1:-both}" ;;
    *)
      echo "Usage: hc-local.sh {setup|run-once|start|stop|status} [software|data|both]" >&2
      exit 2
      ;;
  esac
}

main "$@"
