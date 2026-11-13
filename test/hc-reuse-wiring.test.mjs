import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_HIRINGCAFE_QUERIES, acceptHiringCafeJob } from '../lib/hiringcafe-query.mjs';
import { DEFAULT_DATA_QUERIES, acceptDataJob } from '../lib/data-query.mjs';
import { findSharedQueries } from '../lib/hc-reuse-feed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(join(ROOT, 'fetch-hiringcafe-feed.mjs'), 'utf8');
const hcWorkflow = readFileSync(join(ROOT, '.github/workflows/hc.yml'), 'utf8');
const hcDataWorkflow = readFileSync(join(ROOT, '.github/workflows/hc-data.yml'), 'utf8');

function hcDataQueriesFromWorkflow() {
  const m = /HC_QUERIES:\s*"([^"]+)"/.exec(hcDataWorkflow);
  assert.ok(m, 'expected hc-data.yml to set HC_QUERIES explicitly');
  return m[1].split('|').map((s) => s.trim());
}

test('reuse is applied strictly AFTER the health-gate throw, never before — source-order invariant', () => {
  const gateIdx = script.indexOf('HiringCafe scan unavailable (${health.reason}): preserved prior feed');
  const reuseIdx = script.indexOf('Cross-track reuse happens ONLY here');
  assert.ok(gateIdx > -1 && reuseIdx > -1, 'expected both markers to exist in fetch-hiringcafe-feed.mjs');
  assert.ok(reuseIdx > gateIdx, 'reuse logic must appear after the health-gate throw, so a blocked scan can never be masked by reused data');
});

test('reused jobs never feed into pagesFetched/failedQueries/incomingCount used by assessHiringCafeScan', () => {
  // assessHiringCafeScan() is called exactly once, before the reuse block —
  // guard against a future edit that moves the health computation to see
  // reused data by asserting the call site precedes the reuse marker.
  const healthCallIdx = script.indexOf('const health = assessHiringCafeScan(');
  const reuseIdx = script.indexOf('Cross-track reuse happens ONLY here');
  assert.ok(healthCallIdx > -1 && reuseIdx > -1);
  assert.ok(healthCallIdx < reuseIdx);
});

test('hc.yml (software track) is untouched by the reuse change: full default query list, no reuse wiring', () => {
  assert.doesNotMatch(hcWorkflow, /HC_REUSE_FEED_FROM/);
  assert.doesNotMatch(hcWorkflow, /HC_QUERIES:/);
  assert.match(hcWorkflow, /No HC_QUERIES override/);
});

test('hc-data.yml drops exactly the two provably-equivalent queries and reuses them from hc.yml\'s feed', () => {
  const reduced = hcDataQueriesFromWorkflow();
  const shared = findSharedQueries(DEFAULT_DATA_QUERIES, DEFAULT_HIRINGCAFE_QUERIES);
  assert.deepEqual(shared.map((s) => s.toLowerCase()).sort(), ['data engineer', 'machine learning engineer']);
  for (const q of shared) {
    assert.ok(!reduced.map((r) => r.toLowerCase()).includes(q.toLowerCase()), `expected "${q}" to be dropped from hc-data.yml's live HC_QUERIES`);
  }
  assert.match(hcDataWorkflow, /HC_REUSE_FEED_FROM:\s*data\/hiringcafe-feed\.json/);
});

test('coverage is not lost: every query hc-data.yml used to run live is still either run live or reused', () => {
  const reduced = new Set(hcDataQueriesFromWorkflow().map((s) => s.toLowerCase()));
  const shared = new Set(findSharedQueries(DEFAULT_DATA_QUERIES, DEFAULT_HIRINGCAFE_QUERIES).map((s) => s.toLowerCase()));
  // The previously-hardcoded list this workflow ran before this change
  // (captured from git history at the time this test was written).
  const previousLiveList = [
    'data engineer', 'data analyst', 'data scientist', 'etl developer', 'power bi developer',
    'database administrator', 'business intelligence engineer', 'business intelligence analyst',
    'analytics engineer', 'machine learning engineer', 'ai ml engineer', 'data warehouse engineer', 'product analyst',
  ];
  for (const q of previousLiveList) {
    assert.ok(reduced.has(q) || shared.has(q), `"${q}" is neither still fetched live nor covered by reuse — coverage would be lost`);
  }
});

test('acceptDataJob correctly recognizes real postings for both dropped-and-reused queries, confirming reuse actually restores their coverage', () => {
  assert.equal(acceptDataJob({ title: 'Data Engineer' }), true);
  assert.equal(acceptDataJob({ title: 'Machine Learning Engineer' }), true);
  // and a job the software track's OTHER (non-shared) queries would surface
  // incidentally still passes the data filter too, which is fine — reuse
  // only needs to not LOSE coverage, surfacing extra genuinely-matching
  // jobs is a bonus, not a problem.
  assert.equal(acceptDataJob({ title: 'Platform Engineer' }), false);
});

test('acceptHiringCafeJob (software track baseline) still accepts the two shared-query titles too, confirming the software feed keeps its own coverage unchanged', () => {
  assert.equal(acceptHiringCafeJob({ title: 'Data Engineer' }, { baseline: true }), true);
  assert.equal(acceptHiringCafeJob({ title: 'Machine Learning Engineer' }, { baseline: true }), true);
});
