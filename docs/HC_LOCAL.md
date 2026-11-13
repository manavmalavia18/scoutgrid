# Running the HiringCafe scanner locally on macOS (`hc-local`)

Runs the existing Software and Data HiringCafe scan pipelines
(`fetch-hiringcafe-feed.mjs` / `run-hc.mjs` / `scrape-hiringcafe.py`,
completely unmodified) on your own Mac instead of GitHub Actions. All
output stays on your machine — nothing here ever commits, pushes, or
touches the hosted dashboard.

## What this reuses, unchanged

- **Query/pagination/parsing**: `providers/hiringcafe.mjs`, same `searchState()`.
- **Dedup/retention**: `lib/feed-discovery.mjs`'s `mergeDiscoveredJobs()`.
- **Last-good-feed protection + nonzero exit on failure**:
  `lib/hiringcafe-scan-health.mjs` — a blocked/failed scan never overwrites
  the last successfully-fetched feed, and `run-hc.mjs` exits non-zero.
- **Cloudflare diagnostics**: `lib/hc-blocked-diagnostics.mjs` — sanitized
  status/classification/headers for the first blocked response per scan.
- **Cross-track reuse**: the Data track reuses the two queries
  ("data engineer", "machine learning engineer") that are provably
  identical to ones the Software track already runs, pulling them from the
  *local* Software feed instead of re-requesting them — same mechanism as
  production's `HC_REUSE_FEED_FROM`, just pointed at local files.

`scripts/hc-local.sh` only supplies local file paths, a local Python venv,
and local `launchd` scheduling. It does not reimplement any scanning,
parsing, dedup, or safety logic.

## Layout

```
~/.scoutgrid-local/
  venv/                         # dedicated Python venv (patchright + chromium)
  software/
    hiringcafe-feed.json        # last-good Software feed
    scan-hc-heartbeat.json      # last scan's status/diagnostics
    hc-feed.lock                # held only while a scan is in progress
    hiringcafe-profile/         # Chrome profile, isolated from the Data track
  data/
    hiringcafe-feed-data.json
    scan-hc-heartbeat-data.json
    hc-feed-data.lock
    hiringcafe-profile-data/
  logs/
    software.log  data.log                  # manual run-once output
    software-launchd.log  data-launchd.log   # launchd-triggered run output

~/Library/LaunchAgents/
  com.scoutgrid.hc-local.software.plist   # installed, NOT loaded by default
  com.scoutgrid.hc-local.data.plist       # installed, NOT loaded by default
```

Nothing is written under `~/Desktop`, `~/Documents`, `~/Downloads`, or
elsewhere in `~/Library` that's TCC-protected (those silently crash-loop a
launchd job with exit 78 — logs/data deliberately live in a plain
`~/.scoutgrid-local` dot-directory instead).

## Commands

```bash
cd /Users/manavmalavia/Projects/scoutgrid

# One-time (also runs automatically before any other command):
./scripts/hc-local.sh setup

# Run one scan cycle right now, foreground, for one or both tracks:
./scripts/hc-local.sh run-once software
./scripts/hc-local.sh run-once data
./scripts/hc-local.sh run-once          # both (default)

# Check status: launchd schedule state, lock, last heartbeat, last feed:
./scripts/hc-local.sh status

# Enable recurring local scans (every 45 min, matching hc.yml/hc-data.yml's
# cadence — NOT increased). Disabled by default; this is the only thing
# that turns scheduling on:
./scripts/hc-local.sh start software
./scripts/hc-local.sh start data
./scripts/hc-local.sh start             # both

# Disable recurring local scans again (does not interrupt an in-progress
# scan — only stops future scheduled runs):
./scripts/hc-local.sh stop
```

Optional: for a plain `hc-local` command instead of the full path, add an
alias to your shell profile:

```bash
echo 'alias hc-local="/Users/manavmalavia/Projects/scoutgrid/scripts/hc-local.sh"' >> ~/.zshrc
```

## Notes

- **Scheduling is off by default.** `setup` only writes the `launchd`
  plists (`RunAtLoad: false`, not loaded) — nothing runs until you call
  `start`.
- **Overlapping scans are prevented** the same way the GitHub Actions
  version is: `run-hc.mjs`'s own lock file (`hc-feed.lock` /
  `hc-feed-data.lock`) is checked before a new scan starts. If a scan is
  already running, the new invocation prints `skip — HC feed already
  running` and exits 0 without touching anything.
- **A blocked/failed scan never overwrites the last-good feed.** `status`
  will show `heartbeat: FAILED` with the reason and, when available, a
  sanitized Cloudflare diagnostic (HTTP status, classification, `cf-ray`)
  — the feed file itself stays exactly as it was after the last success.
- **No access-bypass work is included or planned here**: no fingerprint
  changes, no proxy rotation, no challenge solving, no CloakBrowser in this
  path. If HiringCafe is currently Cloudflare-blocking (as of this
  writing, confirmed via the GitHub Actions pipeline), the local run will
  show the same block — that's expected and correctly reported, not a bug
  in this setup.
- Local Data-track live query list has one extra query ("python engineer")
  compared to `hc-data.yml`'s production list: it's computed directly from
  `DEFAULT_DATA_QUERIES` minus the reused queries
  (`scripts/hc-local-data-queries.mjs`), so it doesn't inherit a pre-existing,
  unrelated gap in the production workflow's hand-written query string.

## Tests

```bash
node --test test/hc-local-cli.test.mjs
```

Covers: clean-state `status`, `setup` idempotency, plists written but
never auto-loaded, `start`/`stop` driving `launchctl` correctly (via a
stubbed `launchctl`, never the real one), per-track schedule isolation,
overlapping-scan prevention, stale-vs-live lock classification, and
`status` surfacing a preserved failure heartbeat (including a Cloudflare
diagnostic) without touching the last-good feed.
