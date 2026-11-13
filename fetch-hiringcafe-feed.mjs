#!/usr/bin/env node
/**
 * Hiring Cafe feed — exact saved search from hiringcafe.com (software engineer,
 * US + flexible regions, IC, entry/mid, no clearance, last 2 days).
 * Keeps every hit HC returns; filtering belongs in the Jobs UI.
 *
 * HTTP first; Cloudflare 403 → patchright headed Chrome (same stack as JobRight).
 *
 *   npm run feed:hc
 *   npm run feed:hc:loop
 */
import { spawnSync } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import hiringcafe, {
  parseHits,
  buildSearchUrl,
  extractPageProps,
  resolveSearchState,
} from './providers/hiringcafe.mjs';
import { fetchText, BROWSER_LIKE_USER_AGENT } from './providers/_http.mjs';
import { canonicalGhalKey } from './lib/ghal-job-key.mjs';
import { mergeDiscoveredJobs } from './lib/feed-discovery.mjs';
import {
  DEFAULT_HIRINGCAFE_QUERIES,
  parseHiringCafeQueries,
  acceptHiringCafeJob,
} from './lib/hiringcafe-query.mjs';
import { httpLooksBlocked } from './lib/hiringcafe-http-blocked.mjs';
import { assessHiringCafeScan, recordFailedHiringCafeScan } from './lib/hiringcafe-scan-health.mjs';
import { buildBlockedDiagnostic } from './lib/hc-blocked-diagnostics.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
// Overridable so the same script can run a second, independent feed (e.g.
// the data-roles track for jobs-da.manavmalavia.org) without touching this
// file — just point HC_OUT/HC_HEARTBEAT/HC_LOCK at different paths.
const OUT = resolve(ROOT, process.env.HC_OUT || 'data/hiringcafe-feed.json');
const HITS_TMP = resolve(ROOT, process.env.HC_HITS_TMP || 'data/hc-hits.tmp.json');
const HEARTBEAT = resolve(ROOT, process.env.HC_HEARTBEAT || 'data/scan-hc-heartbeat.json');
const LOCK = resolve(ROOT, process.env.HC_LOCK || 'data/hc-feed.lock');
// Each independent track MUST use its own Chrome profile directory — a
// patchright persistent context takes a real OS-level lock on its
// user_data_dir (Chrome's SingletonLock), so two tracks sharing the default
// here would silently race for the lock the moment their schedules (or a
// manual workflow_dispatch) overlap, rather than failing loudly in an
// obvious way. hc-data.yml sets HC_PROFILE to a distinct directory; see
// browser_runtime.py's profile-lock diagnostics for what the failure looks
// like if a future track forgets to set this.
const PROFILE = resolve(ROOT, process.env.HC_PROFILE || 'data/hiringcafe-profile');
const PY = process.env.HC_PYTHON || 'python3';
const SCRAPE = join(ROOT, 'scrape-hiringcafe.py');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const LOOP = process.argv.includes('--loop');
const PAGES = Math.max(1, Math.min(80, Number(argVal('--pages', '50')) || 50));
/**
 * HC dateFetchedPastNDays: 2 on the saved search (~733–760 jobs).
 * 1/3/7 dump junk; 2 and 4 work. Override with --days.
 */
const HC_DAYS = Math.max(1, Math.min(7, Number(argVal('--days', '2')) || 2));
const KEEP_HOURS = Math.max(1, Math.min(168, Number(argVal('--hours', String(HC_DAYS * 24))) || HC_DAYS * 24));
const SLEEP_SEC = Math.max(60, Number(argVal('--sleep', '600')) || 600);

const QUERIES = parseHiringCafeQueries(argVal(
  '--query',
  process.env.HC_QUERIES || DEFAULT_HIRINGCAFE_QUERIES.join('|'),
));

function jobKey(job) {
  return canonicalGhalKey(job.url) || String(job.url || '').toLowerCase();
}

/** Exact searchState from the saved hiringcafe.com URL. */
function searchState(query) {
  return resolveSearchState({
    searchState: {
      locations: [{
        formatted_address: 'United States',
        types: ['country'],
        geometry: { location: { lat: 33.7485, lon: -84.3871 } },
        id: 'user_country',
        address_components: [{ long_name: 'United States', short_name: 'US', types: ['country'] }],
        options: { flexible_regions: ['anywhere_in_continent', 'anywhere_in_world'] },
      }],
      searchQuery: query,
      dateFetchedPastNDays: HC_DAYS,
      hideJobTypes: ['Applied'],
      departments: ['Software Development', 'Engineering', 'Information Technology'],
      roleTypes: ['Individual Contributor'],
      seniorityLevel: ['Entry Level', 'Mid Level', 'No Prior Experience Required'],
      securityClearances: ['None'],
      sortBy: 'date',
    },
  });
}

async function fetchQueryHttp(query, seen, jobs) {
  const state = searchState(query);
  let page = 0;
  let isLast = false;
  let pagesFetched = 0;
  let totalCount = null;

  while (page < PAGES && !isLast) {
    const url = buildSearchUrl(state, page);
    const html = await fetchText(url, {
      redirect: 'error',
      headers: {
        'user-agent': BROWSER_LIKE_USER_AGENT,
        accept: 'text/html',
      },
    });
    const pp = extractPageProps(html);
    if (!pp) throw new Error(`hiringcafe: missing __NEXT_DATA__ on page ${page} (${query})`);
    if (totalCount == null && Number.isFinite(pp.ssrTotalCount)) totalCount = pp.ssrTotalCount;

    const batch = parseHits(pp.ssrHits);
    let added = 0;
    for (const job of batch) {
      const key = jobKey(job);
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(job);
      added += 1;
    }

    process.stderr.write(`HC [${query}] page ${page + 1}/${PAGES} hits=${batch.length} new=${added} kept=${seen.size}${totalCount != null ? '/' + totalCount : ''}\n`);
    isLast = batch.length === 0
      || added === 0
      || (Number.isFinite(totalCount) && seen.size >= totalCount);
    if (pp.ssrIsLastPage && batch.length > 0 && !(Number.isFinite(totalCount) && seen.size >= totalCount)) {
      process.stderr.write(`HC [${query}] ssrIsLastPage on page ${page} but kept ${seen.size}/${totalCount} — continue\n`);
    }
    page += 1;
    pagesFetched = page;
    if (!isLast && page < PAGES) await new Promise((r) => setTimeout(r, 180));
  }

  return {
    pagesFetched,
    truncated: !isLast && page >= PAGES,
    totalCount,
  };
}

function fetchViaPatchright(query) {
  if (!existsSync(SCRAPE)) {
    throw new Error('Hiring Cafe patchright scraper missing (scrape-hiringcafe.py)');
  }
  const env = { ...process.env };
  if (String(env.PLAYWRIGHT_BROWSERS_PATH || '').includes('cursor-sandbox-cache')) {
    delete env.PLAYWRIGHT_BROWSERS_PATH;
  }
  const r = spawnSync(PY, [
    SCRAPE,
    '--pages', String(PAGES),
    '--days', String(HC_DAYS),
    '--query', query,
    '--out', HITS_TMP,
    '--profile', PROFILE,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    // Was 300_000 (5min). A healthy query normally finishes in ~15-30s (see
    // scan-hc-heartbeat.json's elapsedSec for a full multi-query cycle).
    // With DEFAULT_HIRINGCAFE_QUERIES/DEFAULT_DATA_QUERIES now at 13-16
    // queries, letting even a handful of them legitimately run to a 5min
    // ceiling could blow well past hc.yml/hc-data.yml's 25min job timeout —
    // and a job-timeout kill is NOT a catchable JS error (unlike the
    // per-query try/catch below), so it loses the ENTIRE cycle's progress,
    // not just the slow query. Confirmed live 2026-10-27: a run got killed
    // at exactly 25:00 mid-scrape, and the cancel-in-progress:false
    // concurrency group then blocked every other scheduled trigger behind
    // it for hours — this is what caused the stale report. 60s gives
    // ~16x headroom over the normal case while keeping the worst-case total
    // (all queries timing out) at ~16-17 minutes, comfortably inside the
    // job budget.
    //
    // NOTE: this is an outer wall-clock ceiling on the WHOLE python
    // subprocess (all pages for one query), independent of
    // scrape-hiringcafe.py's own per-navigation HC_NAV_TIMEOUT_MS/
    // HC_SELECTOR_TIMEOUT_MS. Raising either of those env vars much past
    // ~55s risks this outer timeout killing the subprocess first — it has
    // no idea a slow page load is "expected", it just sees the process
    // still running at 60s and kills it, which then surfaces here as a
    // generic non-zero exit rather than scrape-hiringcafe.py's own
    // navigation_error/missing_job_data diagnosis.
    timeout: 60_000,
  });
  if (r.stderr) process.stderr.write(r.stderr);
  const diagnostic = extractBlockedDiagnosticFromStderr(r.stderr);
  if ((r.status ?? 1) !== 0) {
    const err = new Error(`patchright HC scrape exited ${r.status ?? 1}: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
    if (diagnostic) err.diagnostic = diagnostic;
    throw err;
  }
  const raw = JSON.parse(readFileSync(HITS_TMP, 'utf8'));
  return {
    jobs: parseHits(raw.hits || []),
    pagesFetched: Number(raw.pagesFetched) || 0,
    truncated: Boolean(raw.truncated),
    totalCount: Number.isFinite(raw.totalCount) ? raw.totalCount : null,
  };
}

/**
 * scrape-hiringcafe.py prints one `HC_BLOCKED_DIAGNOSTIC: {...}` JSON line
 * to stderr right before raising on a blocked page — already sanitized on
 * the Python side (status/classification/headers allowlist only, no page
 * content, no cookies). This just locates and parses that one line; it
 * never re-derives or widens what's in it.
 */
function extractBlockedDiagnosticFromStderr(stderr) {
  const match = /^HC_BLOCKED_DIAGNOSTIC: (.+)$/m.exec(stderr || '');
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function loadPreviousSnapshot() {
  if (!existsSync(OUT)) return { jobs: [], fetchedAt: '' };
  try {
    const raw = JSON.parse(readFileSync(OUT, 'utf8'));
    return {
      jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
      fetchedAt: raw.fetchedAt || '',
    };
  } catch {
    return { jobs: [], fetchedAt: '' };
  }
}

async function fetchFeed() {
  const started = Date.now();
  let pagesFetched = 0;
  let truncated = false;
  const totals = {};
  let transport = 'http';
  const incoming = [];
  const seen = new Set();
  // Sanitized diagnostic for only the FIRST blocked response this cycle —
  // never re-captured once set, regardless of how many later queries also
  // fail, so the heartbeat reflects the earliest, most diagnostic signal.
  let firstBlockedDiagnostic = null;

  try {
    for (const query of QUERIES) {
      const r = await fetchQueryHttp(query, seen, incoming);
      pagesFetched += r.pagesFetched;
      truncated = truncated || r.truncated;
      totals[query] = r.totalCount;
    }
  } catch (err) {
    if (!httpLooksBlocked(err)) throw err;
    process.stderr.write(`HC http blocked (${err.status || err.message}) — patchright headed Chrome\n`);
    if (!firstBlockedDiagnostic && err.status) {
      // markerText comes from err.body only to compute a classification —
      // the body itself is never attached to the diagnostic or logged.
      firstBlockedDiagnostic = buildBlockedDiagnostic({ status: err.status, headers: err.headers, markerText: err.body });
    }
    transport = 'patchright';
    pagesFetched = 0;
    truncated = false;
    incoming.length = 0;
    seen.clear();
    let queryIndex = 0;
    for (const query of QUERIES) {
      // Isolate each query's failure — before query-broadening this loop had
      // exactly one iteration, so a single Page.goto timeout aborting the
      // whole function cost nothing. With 4 queries, the chance any one of
      // them times out per cycle is much higher, and an uncaught throw here
      // used to skip the merge+write+heartbeat entirely, discarding
      // whatever the earlier queries in THIS cycle already found — that's
      // what silently stalled the feed for 24+ hours.
      if (queryIndex > 0) {
        // Each query launches a fresh headed Chrome on the SAME profile dir.
        // Chrome's SingletonLock can briefly outlive the previous process
        // even after spawnSync returns, so launching the next query too fast
        // hits "profile already in use", which then shows up confusingly as
        // a #__NEXT_DATA__ wait_for_selector timeout. A short real pause
        // lets the lock clear before the next browser launch.
        spawnSync('sleep', ['3']);
      }
      queryIndex += 1;
      try {
        const r = fetchViaPatchright(query);
        for (const job of r.jobs) {
          const k = jobKey(job);
          if (!k || seen.has(k)) continue;
          seen.add(k);
          incoming.push(job);
        }
        pagesFetched += r.pagesFetched;
        truncated = truncated || r.truncated;
        totals[query] = r.totalCount;
      } catch (qErr) {
        process.stderr.write(`HC patchright query "${query}" failed, skipping this query for this cycle: ${qErr.message || qErr}\n`);
        totals[query] = totals[query] ?? null;
        if (!firstBlockedDiagnostic && qErr.diagnostic) {
          firstBlockedDiagnostic = qErr.diagnostic;
        }
      }
    }
  }

  const previous = loadPreviousSnapshot();
  const failedQueries = transport === 'patchright'
    ? Object.values(totals).filter((n) => n == null).length
    : 0;
  const health = assessHiringCafeScan({
    pagesFetched,
    incomingCount: incoming.length,
    queryCount: QUERIES.length,
    failedQueries,
    previousCount: previous.jobs.length,
  });
  if (!health.publish) {
    recordFailedHiringCafeScan({
      heartbeatPath: HEARTBEAT,
      reason: health.reason,
      queryCount: QUERIES.length,
      failedQueries,
      pagesFetched,
      diagnostic: firstBlockedDiagnostic,
    });
    throw new Error(`HiringCafe scan unavailable (${health.reason}): preserved prior feed`);
  }
  const jobs = mergeDiscoveredJobs(previous.jobs, incoming, {
    keyOf: jobKey,
    now: new Date().toISOString(),
    keepHours: KEEP_HOURS,
    legacyDiscoveredAt: previous.fetchedAt,
  });

  mkdirSync(resolve(ROOT, 'data'), { recursive: true });
  const payload = {
    fetchedAt: new Date().toISOString(),
    provider: hiringcafe.id,
    window: `${KEEP_HOURS}h`,
    hcDaysRequested: HC_DAYS,
    searchProfile: 'hc-saved-search',
    query: QUERIES.join(' | '),
    queries: QUERIES,
    days: HC_DAYS,
    pagesFetched,
    truncated,
    transport,
    hcTotals: totals,
    count: jobs.length,
    jobs,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  writeFileSync(HEARTBEAT, JSON.stringify({
    at: payload.fetchedAt,
    exitCode: 0,
    elapsedSec: Math.round((Date.now() - started) / 1000),
    newMatches: jobs.length,
    advertised: Object.values(totals).find((n) => Number.isFinite(n)) ?? jobs.length,
    pagesFetched,
    mode: 'hiringcafe-saved-search',
    query: payload.query,
    hours: KEEP_HOURS,
    truncated,
    transport,
    // Visibility into how often the 60s per-query patchright timeout (see
    // fetchViaPatchright) is actually clipping a legitimate slow query —
    // there was previously no signal at all for this; a `queriesSkipped`
    // that stays near 0 across real runs confirms 60s has enough headroom,
    // a sustained nonzero count means it's too tight and needs raising.
    queriesSkipped: transport === 'patchright'
      ? Object.values(totals).filter((n) => n == null).length
      : 0,
  }, null, 2));

  console.log(JSON.stringify({
    ok: true,
    window: payload.window,
    count: jobs.length,
    incoming: incoming.length,
    pagesFetched,
    truncated,
    transport,
    hcTotals: totals,
    queries: QUERIES,
    out: OUT,
  }));
  return payload;
}

function acquireLock() {
  mkdirSync(resolve(ROOT, 'data'), { recursive: true });
  if (existsSync(LOCK)) {
    try {
      const prev = JSON.parse(readFileSync(LOCK, 'utf8'));
      try {
        process.kill(prev.pid, 0);
        console.error(`skip — HC feed already running (pid ${prev.pid})`);
        return false;
      } catch {
        /* dead pid */
      }
    } catch { /* replace */ }
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  return true;
}

function releaseLock() {
  try { unlinkSync(LOCK); } catch { /* ignore */ }
}

async function main() {
  if (!acquireLock()) process.exit(0);
  try {
    if (!LOOP) {
      await fetchFeed();
      return;
    }
    for (;;) {
      try {
        await fetchFeed();
      } catch (err) {
        console.error('HC feed error:', err.message || err);
        writeFileSync(HEARTBEAT, JSON.stringify({
          at: new Date().toISOString(),
          exitCode: 1,
          error: String(err.message || err),
          mode: 'hiringcafe-saved-search',
        }, null, 2));
      }
      process.stderr.write(`Sleeping ${SLEEP_SEC}s…\n`);
      await new Promise((r) => setTimeout(r, SLEEP_SEC * 1000));
    }
  } finally {
    try { unlinkSync(HITS_TMP); } catch { /* ignore */ }
    releaseLock();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
