import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A blocked or starved search is not proof that every old job disappeared. */
export function assessHiringCafeScan({ pagesFetched, incomingCount, queryCount, failedQueries }) {
  if (!pagesFetched || failedQueries >= queryCount) {
    return { publish: false, reason: 'all_queries_failed' };
  }
  if (!incomingCount) {
    return { publish: false, reason: 'zero_jobs_after_successful_page' };
  }
  return { publish: true, reason: failedQueries ? 'partial_success' : 'ok' };
}

/** Publish failure observability without touching the last-known feed bytes. */
export function recordFailedHiringCafeScan({ heartbeatPath, reason, queryCount, failedQueries, pagesFetched, diagnostic = null, at = new Date().toISOString() }) {
  mkdirSync(dirname(heartbeatPath), { recursive: true });
  const payload = {
    at,
    exitCode: 1,
    reason,
    mode: 'hiringcafe-saved-search',
    queriesTotal: queryCount,
    queriesSkipped: failedQueries,
    pagesFetched,
    newMatches: 0,
  };
  // Additive, optional field — only present when a blocked response was
  // actually captured this cycle. Already sanitized by the caller (see
  // lib/hc-blocked-diagnostics.mjs); never re-derived or widened here.
  if (diagnostic) payload.firstBlockedResponse = diagnostic;
  writeFileSync(heartbeatPath, JSON.stringify(payload, null, 2));
}
