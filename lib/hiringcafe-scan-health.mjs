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
export function recordFailedHiringCafeScan({ heartbeatPath, reason, queryCount, failedQueries, pagesFetched, at = new Date().toISOString() }) {
  mkdirSync(dirname(heartbeatPath), { recursive: true });
  writeFileSync(heartbeatPath, JSON.stringify({
    at,
    exitCode: 1,
    reason,
    mode: 'hiringcafe-saved-search',
    queriesTotal: queryCount,
    queriesSkipped: failedQueries,
    pagesFetched,
    newMatches: 0,
  }, null, 2));
}
