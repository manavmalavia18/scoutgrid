import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugCandidates, companyKeyOf, shouldProbe, jobCountFromAtsBody,
  atsCandidateUrls, boardToTrackedCompanyYaml, insertTrackedCompanies,
} from '../lib/company-board-probe.mjs';

test('slugCandidates strips legal suffixes and generates plausible variants', () => {
  const c = slugCandidates('ClickHouse, Inc');
  assert.ok(c.includes('clickhouse'));
});

test('slugCandidates handles multi-word names with hyphen and no-sep variants', () => {
  const c = slugCandidates('General Motors');
  assert.ok(c.includes('generalmotors'));
  assert.ok(c.includes('general-motors'));
});

test('slugCandidates drops candidates shorter than 2 chars', () => {
  const c = slugCandidates('A');
  assert.ok(c.every((s) => s.length >= 2));
});

test('slugCandidates returns empty array for blank input, never throws', () => {
  assert.deepEqual(slugCandidates(''), []);
  assert.deepEqual(slugCandidates(null), []);
  assert.deepEqual(slugCandidates(undefined), []);
});

test('companyKeyOf normalizes case/whitespace for stable map keys', () => {
  assert.equal(companyKeyOf('  Acme Corp  '), 'acme corp');
  assert.equal(companyKeyOf('ACME CORP'), 'acme corp');
});

test('shouldProbe skips a company already tracked by name', () => {
  const ok = shouldProbe('Acme', { trackedNames: new Set(['acme']), state: {} });
  assert.equal(ok, false);
});

test('shouldProbe skips a company already resolved by a prior probe run', () => {
  const ok = shouldProbe('Acme', { trackedNames: new Set(), state: { acme: { status: 'resolved' } } });
  assert.equal(ok, false);
});

test('shouldProbe skips a company exhausted within the cooldown window', () => {
  const now = Date.parse('2026-10-28T00:00:00Z');
  const state = { acme: { status: 'exhausted', probedAt: '2026-10-20T00:00:00Z' } };
  const ok = shouldProbe('Acme', { trackedNames: new Set(), state, now, cooldownMs: 30 * 24 * 60 * 60 * 1000 });
  assert.equal(ok, false, 'only 8 days since last probe, inside the 30-day cooldown');
});

test('shouldProbe retries a company exhausted OUTSIDE the cooldown window', () => {
  const now = Date.parse('2026-10-28T00:00:00Z');
  const state = { acme: { status: 'exhausted', probedAt: '2026-08-01T00:00:00Z' } };
  const ok = shouldProbe('Acme', { trackedNames: new Set(), state, now, cooldownMs: 30 * 24 * 60 * 60 * 1000 });
  assert.equal(ok, true, 'a company might have registered a real board since the last failed probe');
});

test('shouldProbe allows a never-before-seen company', () => {
  const ok = shouldProbe('Brand New Co', { trackedNames: new Set(), state: {} });
  assert.equal(ok, true);
});

test('shouldProbe handles a blank company name safely', () => {
  assert.equal(shouldProbe('', { trackedNames: new Set(), state: {} }), false);
});

test('jobCountFromAtsBody counts Greenhouse/Ashby-shaped {jobs:[...]} responses', () => {
  assert.equal(jobCountFromAtsBody({ jobs: [{}, {}, {}] }), 3);
});

test('jobCountFromAtsBody counts Lever-shaped bare-array responses', () => {
  assert.equal(jobCountFromAtsBody([{}, {}]), 2);
});

test('jobCountFromAtsBody treats an empty/placeholder board as zero, not a match', () => {
  assert.equal(jobCountFromAtsBody({ jobs: [] }), 0);
  assert.equal(jobCountFromAtsBody([]), 0);
});

test('jobCountFromAtsBody handles null/malformed bodies safely', () => {
  assert.equal(jobCountFromAtsBody(null), 0);
  assert.equal(jobCountFromAtsBody(undefined), 0);
  assert.equal(jobCountFromAtsBody({}), 0);
});

test('atsCandidateUrls generates the exact three known public API patterns', () => {
  const urls = atsCandidateUrls('acme');
  assert.deepEqual(urls.map((u) => u.ats), ['greenhouse', 'ashby', 'lever']);
  assert.equal(urls[0].apiUrl, 'https://boards-api.greenhouse.io/v1/boards/acme/jobs');
  assert.equal(urls[1].apiUrl, 'https://api.ashbyhq.com/posting-api/job-board/acme');
  assert.equal(urls[2].apiUrl, 'https://api.lever.co/v0/postings/acme?mode=json');
});

test('boardToTrackedCompanyYaml produces a valid tracked_companies entry', () => {
  const yaml = boardToTrackedCompanyYaml('ClickHouse', { ats: 'ashby', boardUrl: 'https://jobs.ashbyhq.com/clickhouse', jobCount: 12 });
  assert.match(yaml, /name: "ClickHouse"/);
  assert.match(yaml, /careers_url: https:\/\/jobs\.ashbyhq\.com\/clickhouse/);
  assert.match(yaml, /provider: ashby/);
  assert.match(yaml, /enabled: true/);
  assert.match(yaml, /12 live jobs confirmed/);
});

test('insertTrackedCompanies inserts before the next top-level key, not at EOF', () => {
  const portals = 'tracked_companies:\n  - name: Existing\n    careers_url: https://x\njob_boards:\n  - name: Agg\n';
  const result = insertTrackedCompanies(portals, ['  - name: "New Co"\n    careers_url: https://y']);
  assert.ok(result.indexOf('New Co') < result.indexOf('job_boards:'), 'new entry must land before job_boards:, not after');
});

test('insertTrackedCompanies is a no-op for an empty block list', () => {
  const portals = 'tracked_companies:\n  - name: Existing\n';
  assert.equal(insertTrackedCompanies(portals, []), portals);
});
