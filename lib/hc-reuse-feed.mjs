// Cross-track result reuse for genuinely equivalent HiringCafe queries.
//
// "Equivalent" here means more than matching text: fetch-hiringcafe-feed.mjs
// builds every query's full searchState from the SAME fixed filters
// (locations, dateFetchedPastNDays, departments, roleTypes, seniorityLevel,
// securityClearances, sortBy) regardless of which track runs it — only
// `searchQuery` varies. No per-track filtering happens before a job is
// stored (acceptHiringCafeJob/acceptDataJob only run downstream in the
// dashboard), so two tracks requesting the identical searchQuery text would
// get byte-for-byte identical responses from HiringCafe. For exactly those
// query strings, re-requesting from a second track is a provably redundant
// network/browser request, not a different search.
//
// This module never decides whether a scan is healthy — that stays entirely
// inside assessHiringCafeScan(), driven only by the requesting track's own
// LIVE query results. Reused jobs are additive supplementary coverage,
// never a substitute for, or evidence toward, that health decision.

import { existsSync, readFileSync } from 'node:fs';

/** Case-insensitive intersection of two query lists — used to find exactly
 * which query strings are safe to reuse between two tracks whose
 * searchState filters are otherwise identical. Order follows `a`. */
export function findSharedQueries(a, b) {
  const bLower = new Set((b || []).map((q) => String(q).trim().toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const q of a || []) {
    const key = String(q).trim().toLowerCase();
    if (!key || seen.has(key) || !bLower.has(key)) continue;
    seen.add(key);
    out.push(String(q).trim());
  }
  return out;
}

/**
 * Loads another track's most-recently-published feed and returns only the
 * jobs that pass `accept`. Fails open to an empty array (never throws) on a
 * missing or corrupt feed file — a reuse source being unavailable must
 * degrade to "no bonus coverage this cycle", never to a crash, and never
 * to treating the requesting track's own cycle as blocked.
 *
 * The source feed is only ever read, never written — and because
 * recordFailedHiringCafeScan() never touches a track's published feed file
 * on a blocked cycle (see lib/hiringcafe-scan-health.mjs), whatever this
 * reads is guaranteed to be real, previously-fetched job data, never an
 * empty result from a blocked scan.
 */
export function loadReusableJobs({ feedPath, accept, existsSyncFn = existsSync, readFileSyncFn = readFileSync }) {
  if (!feedPath || !existsSyncFn(feedPath)) return [];
  try {
    const raw = JSON.parse(readFileSyncFn(feedPath, 'utf8'));
    const jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
    return typeof accept === 'function' ? jobs.filter((job) => accept(job)) : jobs;
  } catch {
    return [];
  }
}
