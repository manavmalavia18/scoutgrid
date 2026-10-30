// Pure, testable logic for check-feed-staleness.mjs — given a feed's
// fetchedAt timestamp and its expected refresh cadence, decide whether it's
// stale enough to warrant an automatic retrigger. The actual file reading
// and GitHub API calls stay in the thin orchestration script so this can
// be unit tested without touching the filesystem or network.

/**
 * A feed counts as stale once it's past `thresholdMinutes` — deliberately
 * more than the feed's own cron cadence (not exactly equal to it), so a
 * single missed/slow cycle doesn't trigger a retry storm; only a feed
 * that's genuinely stuck (the Tailscale-exit-node-drops-mid-run pattern
 * this was built for) crosses the line.
 */
export function isStale(fetchedAtIso, thresholdMinutes, now = Date.now()) {
  const ms = Date.parse(fetchedAtIso);
  if (!Number.isFinite(ms)) return true; // missing/unparseable fetchedAt is itself a staleness signal
  const ageMinutes = (now - ms) / 60000;
  return ageMinutes > thresholdMinutes;
}

export function ageMinutesOf(fetchedAtIso, now = Date.now()) {
  const ms = Date.parse(fetchedAtIso);
  if (!Number.isFinite(ms)) return Infinity;
  return Math.round((now - ms) / 60000);
}

/**
 * The feeds this watchdog covers — every GitHub Actions workflow that
 * routes through the user's own Tailscale exit node (see each workflow's
 * own "Connect to Tailscale exit node" step), the ones actually vulnerable
 * to the Mac-sleeps-mid-run connectivity drop this watchdog exists for.
 * Threshold is roughly 3x the feed's own cron cadence: generous enough
 * that normal GH Actions scheduling jitter/contention never false-fires,
 * tight enough to catch a feed that's been stuck for multiple missed
 * cycles, not just one slow one.
 */
export const WATCHED_FEEDS = [
  { file: 'data/hiringcafe-feed.json', workflow: 'hc.yml', thresholdMinutes: 60 },
  { file: 'data/hiringcafe-feed-data.json', workflow: 'hc-data.yml', thresholdMinutes: 60 },
  { file: 'data/jr-board-fresh.json', workflow: 'jobright.yml', thresholdMinutes: 60 },
  { file: 'data/nextplay-feed.json', workflow: 'nextplay.yml', thresholdMinutes: 60 },
  { file: 'data/linkedin-feed.json', workflow: 'linkedin.yml', thresholdMinutes: 240 },
];

/** Extracts fetchedAt from the two known feed-JSON shapes used in this repo. */
export function fetchedAtFromFeedJson(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed.fetchedAt || null;
}
