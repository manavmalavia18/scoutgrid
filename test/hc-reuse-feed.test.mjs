import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSharedQueries, loadReusableJobs, restoreReuseDiscoveredAt } from '../lib/hc-reuse-feed.mjs';
import { mergeDiscoveredJobs } from '../lib/feed-discovery.mjs';
import { DEFAULT_HIRINGCAFE_QUERIES } from '../lib/hiringcafe-query.mjs';
import { DEFAULT_DATA_QUERIES } from '../lib/data-query.mjs';
import { acceptDataJob } from '../lib/data-query.mjs';

test('findSharedQueries is case/whitespace-insensitive and de-duplicates', () => {
  const a = ['Data Engineer', ' Backend Engineer ', 'data engineer'];
  const b = ['data engineer', 'frontend engineer'];
  assert.deepEqual(findSharedQueries(a, b), ['Data Engineer']);
});

test('findSharedQueries returns an empty array for disjoint lists', () => {
  assert.deepEqual(findSharedQueries(['a'], ['b']), []);
});

test('findSharedQueries handles missing/empty inputs without throwing', () => {
  assert.deepEqual(findSharedQueries(null, undefined), []);
  assert.deepEqual(findSharedQueries([], []), []);
});

test('the real software/data query lists currently overlap on exactly two terms', () => {
  // This is the actual audited overlap this task is based on — if someone
  // edits either list later, this test documents (and re-verifies) the
  // real current overlap rather than a stale assumption.
  const shared = findSharedQueries(DEFAULT_DATA_QUERIES, DEFAULT_HIRINGCAFE_QUERIES);
  assert.deepEqual(shared.map((s) => s.toLowerCase()).sort(), ['data engineer', 'machine learning engineer']);
});

test('loadReusableJobs reads another feed and filters it through the given accept predicate', () => {
  const dir = mkdtempSync(join(process.env.SCOUTGRID_TEST_TMP || tmpdir(), 'hc-reuse-'));
  try {
    const feedPath = join(dir, 'other-feed.json');
    writeFileSync(feedPath, JSON.stringify({
      jobs: [
        { title: 'Data Engineer', url: 'https://example.org/jobs/1' },
        { title: 'Senior Data Engineer', url: 'https://example.org/jobs/2' }, // SENIOR_OR_MANAGEMENT excluded
        { title: 'Frontend Engineer', url: 'https://example.org/jobs/3' }, // not a data signal
        { title: 'Machine Learning Engineer', url: 'https://example.org/jobs/4' },
      ],
    }));
    const jobs = loadReusableJobs({ feedPath, accept: acceptDataJob });
    assert.deepEqual(jobs.map((j) => j.title).sort(), ['Data Engineer', 'Machine Learning Engineer']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadReusableJobs fails open to an empty array for a missing feed file, never throws', () => {
  assert.deepEqual(loadReusableJobs({ feedPath: '/nonexistent/path/feed.json', accept: acceptDataJob }), []);
});

test('loadReusableJobs fails open to an empty array for a corrupt feed file, never throws', () => {
  const dir = mkdtempSync(join(process.env.SCOUTGRID_TEST_TMP || tmpdir(), 'hc-reuse-corrupt-'));
  try {
    const feedPath = join(dir, 'broken.json');
    writeFileSync(feedPath, 'not json{{{');
    assert.deepEqual(loadReusableJobs({ feedPath, accept: acceptDataJob }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadReusableJobs returns every job unfiltered when no accept predicate is given', () => {
  const dir = mkdtempSync(join(process.env.SCOUTGRID_TEST_TMP || tmpdir(), 'hc-reuse-noaccept-'));
  try {
    const feedPath = join(dir, 'feed.json');
    writeFileSync(feedPath, JSON.stringify({ jobs: [{ title: 'A' }, { title: 'B' }] }));
    assert.equal(loadReusableJobs({ feedPath }).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadReusableJobs never mutates or adds fields to the reused job objects (feed schema preserved)', () => {
  const dir = mkdtempSync(join(process.env.SCOUTGRID_TEST_TMP || tmpdir(), 'hc-reuse-schema-'));
  try {
    const feedPath = join(dir, 'feed.json');
    const original = { title: 'Data Engineer', url: 'https://example.org/jobs/1', company: 'Acme', location: 'Remote' };
    writeFileSync(feedPath, JSON.stringify({ jobs: [original] }));
    const [job] = loadReusableJobs({ feedPath, accept: acceptDataJob });
    assert.deepEqual(Object.keys(job).sort(), Object.keys(original).sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const keyOf = (j) => j.url;

test('restoreReuseDiscoveredAt fixes a reused job that is brand-new to this track: true discoveredAt wins over "now"', () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
  const sourceJob = { title: 'Data Engineer', url: 'https://example.org/jobs/1', postedAt: Date.parse(twoDaysAgo), discoveredAt: twoDaysAgo, lastSeenAt: twoDaysAgo };
  const merged = mergeDiscoveredJobs([], [sourceJob], { keyOf, keepHours: 96 });
  // Without the fix, mergeDiscoveredJobs stamps discoveredAt as "now" here
  // because this track has never seen the job before.
  assert.notEqual(merged[0].discoveredAt, twoDaysAgo, 'sanity: reproduces the bug before the fix is applied');
  restoreReuseDiscoveredAt(merged, { reusedJobs: [sourceJob], previousJobs: [], keyOf });
  assert.equal(merged[0].discoveredAt, twoDaysAgo);
  // lastSeenAt must stay untouched — this track's own cycle really did
  // just reconfirm the posting is live, so it should be "now", not the
  // stale value carried on the reused source object.
  assert.notEqual(merged[0].lastSeenAt, twoDaysAgo);
});

test('restoreReuseDiscoveredAt leaves a job this track already knew about untouched — its own history wins', () => {
  const sourceDiscoveredAt = new Date(Date.now() - 5 * 86400000).toISOString();
  const ownDiscoveredAt = new Date(Date.now() - 10 * 86400000).toISOString();
  const previous = [{ title: 'Data Engineer', url: 'https://example.org/jobs/1', discoveredAt: ownDiscoveredAt, lastSeenAt: ownDiscoveredAt }];
  const sourceJob = { title: 'Data Engineer', url: 'https://example.org/jobs/1', discoveredAt: sourceDiscoveredAt };
  const merged = mergeDiscoveredJobs(previous, [sourceJob], { keyOf, keepHours: 24 * 30 });
  assert.equal(merged[0].discoveredAt, ownDiscoveredAt, 'mergeDiscoveredJobs should already preserve this track\'s own earlier record');
  restoreReuseDiscoveredAt(merged, { reusedJobs: [sourceJob], previousJobs: previous, keyOf });
  assert.equal(merged[0].discoveredAt, ownDiscoveredAt, 'restoreReuseDiscoveredAt must not override an already-correct, pre-existing record');
});

test('restoreReuseDiscoveredAt never touches a live-fetched (non-reused) job, even if it is new to this track', () => {
  const liveJob = { title: 'Data Analyst', url: 'https://example.org/jobs/2', discoveredAt: '' };
  const merged = mergeDiscoveredJobs([], [liveJob], { keyOf, keepHours: 96 });
  const before = merged[0].discoveredAt;
  // reusedJobs is empty — liveJob was never part of the reuse source.
  restoreReuseDiscoveredAt(merged, { reusedJobs: [], previousJobs: [], keyOf });
  assert.equal(merged[0].discoveredAt, before, 'a live-fetched job must never be touched by reuse timestamp restoration');
});

test('restoreReuseDiscoveredAt tolerates a reused job with a missing/invalid discoveredAt — leaves mergeDiscoveredJobs\'s own value alone', () => {
  const sourceJob = { title: 'Machine Learning Engineer', url: 'https://example.org/jobs/3', discoveredAt: 'not-a-date' };
  const merged = mergeDiscoveredJobs([], [sourceJob], { keyOf, keepHours: 96 });
  const before = merged[0].discoveredAt;
  restoreReuseDiscoveredAt(merged, { reusedJobs: [sourceJob], previousJobs: [], keyOf });
  assert.equal(merged[0].discoveredAt, before);
});

test('restoreReuseDiscoveredAt is a no-op (and does not throw) when nothing was reused', () => {
  const merged = mergeDiscoveredJobs([], [{ title: 'X', url: 'https://example.org/jobs/4' }], { keyOf, keepHours: 96 });
  assert.doesNotThrow(() => restoreReuseDiscoveredAt(merged, { reusedJobs: [], previousJobs: [], keyOf }));
});

test('restoreReuseDiscoveredAt requires a keyOf function', () => {
  assert.throws(() => restoreReuseDiscoveredAt([], { reusedJobs: [], previousJobs: [] }), TypeError);
});
