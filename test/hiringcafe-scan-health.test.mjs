import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessHiringCafeScan, recordFailedHiringCafeScan } from '../lib/hiringcafe-scan-health.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the fetcher checks health before changing its feed file', () => {
  const source = readFileSync(join(root, 'fetch-hiringcafe-feed.mjs'), 'utf8');
  const check = source.indexOf('assessHiringCafeScan({');
  const write = source.indexOf('writeFileSync(OUT,');
  assert.ok(check > 0 && write > check, 'health guard must precede feed write');
  assert.match(source, /recordFailedHiringCafeScan\(\{/);
});

for (const name of ['hc', 'hc-data']) {
  test(`${name} publishes a failure heartbeat but ends failed`, () => {
    const source = readFileSync(join(root, `.github/workflows/${name}.yml`), 'utf8');
    assert.match(source, /continue-on-error: true/);
    assert.match(source, /if: always\(\)/);
    assert.match(source, /steps\.scrape\.outcome == 'failure'/);
  });
}

test('a cycle where every query fails is unavailable, not an empty healthy feed', () => {
  assert.deepEqual(assessHiringCafeScan({ pagesFetched: 0, incomingCount: 0, queryCount: 16, failedQueries: 16 }), {
    publish: false, reason: 'all_queries_failed',
  });
});

test('zero returned jobs cannot silently erase a previously nonempty feed', () => {
  assert.deepEqual(assessHiringCafeScan({ pagesFetched: 1, incomingCount: 0, queryCount: 1, failedQueries: 0, previousCount: 4 }), {
    publish: false, reason: 'zero_jobs_after_successful_page',
  });
});

test('a partial scan with real jobs can publish while tracking skipped queries', () => {
  assert.deepEqual(assessHiringCafeScan({ pagesFetched: 2, incomingCount: 3, queryCount: 4, failedQueries: 2 }), {
    publish: true, reason: 'partial_success',
  });
});

test('failed scan leaves prior feed bytes and fetchedAt unchanged, but writes a nonzero heartbeat', () => {
  const dir = mkdtempSync(join(process.env.SCOUTGRID_TEST_TMP || tmpdir(), 'hc-failure-'));
  try {
    const feedPath = join(dir, 'feed.json');
    const heartbeatPath = join(dir, 'heartbeat.json');
    const prior = JSON.stringify({ fetchedAt: '2026-11-10T00:00:00Z', jobs: [{ url: 'https://example.org/job/1' }] });
    writeFileSync(feedPath, prior);
    recordFailedHiringCafeScan({ heartbeatPath, reason: 'all_queries_failed', queryCount: 16, failedQueries: 16, pagesFetched: 0 });
    assert.equal(readFileSync(feedPath, 'utf8'), prior);
    const heartbeat = JSON.parse(readFileSync(heartbeatPath, 'utf8'));
    assert.equal(heartbeat.exitCode, 1);
    assert.equal(heartbeat.reason, 'all_queries_failed');
    assert.equal(heartbeat.queriesSkipped, 16);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a captured blocked-response diagnostic is included in the failure heartbeat, additively', () => {
  const dir = mkdtempSync(join(process.env.SCOUTGRID_TEST_TMP || tmpdir(), 'hc-failure-diag-'));
  try {
    const heartbeatPath = join(dir, 'heartbeat.json');
    const diagnostic = { at: '2026-11-13T00:00:00.000Z', status: 403, classification: 'cloudflare_managed_challenge', workflowRunId: '123', headers: { server: 'cloudflare' } };
    recordFailedHiringCafeScan({ heartbeatPath, reason: 'all_queries_failed', queryCount: 16, failedQueries: 16, pagesFetched: 0, diagnostic });
    const heartbeat = JSON.parse(readFileSync(heartbeatPath, 'utf8'));
    assert.deepEqual(heartbeat.firstBlockedResponse, diagnostic);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('omitting a diagnostic keeps the heartbeat shape exactly as before (no empty/null field added)', () => {
  const dir = mkdtempSync(join(process.env.SCOUTGRID_TEST_TMP || tmpdir(), 'hc-failure-nodiag-'));
  try {
    const heartbeatPath = join(dir, 'heartbeat.json');
    recordFailedHiringCafeScan({ heartbeatPath, reason: 'all_queries_failed', queryCount: 16, failedQueries: 16, pagesFetched: 0 });
    const heartbeat = JSON.parse(readFileSync(heartbeatPath, 'utf8'));
    assert.ok(!('firstBlockedResponse' in heartbeat));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
