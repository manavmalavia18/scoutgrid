#!/usr/bin/env node
// Prints a human-readable status summary for one HC local track. Never
// mutates anything on disk — pure read-only reporting. Usage:
//   node hc-local-status.mjs <track-label> <lockPath> <heartbeatPath> <feedPath>
import { existsSync, readFileSync } from 'node:fs';

const [, , label, lockPath, heartbeatPath, feedPath] = process.argv;

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { __parseError: true };
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

console.log(`== ${label} ==`);

const lock = readJson(lockPath);
if (!lock) {
  console.log('  lock:      not held (idle)');
} else if (lock.__parseError) {
  console.log('  lock:      present but unreadable (treat as stale)');
} else if (pidAlive(lock.pid)) {
  console.log(`  lock:      HELD — scan in progress (pid ${lock.pid}, since ${lock.at})`);
} else {
  console.log(`  lock:      stale (pid ${lock.pid} not running, since ${lock.at}) — next run reclaims it automatically`);
}

const heartbeat = readJson(heartbeatPath);
if (!heartbeat) {
  console.log('  heartbeat: none yet (no scan has completed)');
} else if (heartbeat.__parseError) {
  console.log('  heartbeat: present but unreadable');
} else if (heartbeat.exitCode === 0) {
  console.log(`  heartbeat: OK at ${heartbeat.at}`);
  console.log(`             newMatches=${heartbeat.newMatches} pagesFetched=${heartbeat.pagesFetched} transport=${heartbeat.transport} queriesSkipped=${heartbeat.queriesSkipped ?? 0}`);
  if (heartbeat.reusedFromOtherTrack) {
    console.log(`             reused ${heartbeat.reusedFromOtherTrack.jobsReused} job(s) from ${heartbeat.reusedFromOtherTrack.source}`);
  }
} else {
  console.log(`  heartbeat: FAILED at ${heartbeat.at} — reason=${heartbeat.reason}`);
  console.log(`             queriesTotal=${heartbeat.queriesTotal} queriesSkipped=${heartbeat.queriesSkipped} pagesFetched=${heartbeat.pagesFetched}`);
  if (heartbeat.firstBlockedResponse) {
    const d = heartbeat.firstBlockedResponse;
    console.log(`             first blocked response: HTTP ${d.status}, classification=${d.classification}, cf-ray=${d.headers?.['cf-ray'] || 'n/a'}`);
  }
}

const feed = readJson(feedPath);
if (!feed) {
  console.log('  feed:      no feed file yet');
} else if (feed.__parseError) {
  console.log('  feed:      present but unreadable');
} else {
  console.log(`  feed:      ${feed.count ?? (feed.jobs || []).length} job(s), fetchedAt=${feed.fetchedAt} (last-good — never overwritten by a failed scan)`);
}
