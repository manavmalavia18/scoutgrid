import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStale, ageMinutesOf, fetchedAtFromFeedJson, WATCHED_FEEDS } from '../lib/feed-staleness.mjs';

test('isStale is false for a feed well within its threshold', () => {
  const now = Date.parse('2026-10-30T14:00:00Z');
  const fetchedAt = '2026-10-30T13:50:00Z'; // 10 min ago
  assert.equal(isStale(fetchedAt, 60, now), false);
});

test('isStale is true once age exceeds the threshold', () => {
  const now = Date.parse('2026-10-30T14:00:00Z');
  const fetchedAt = '2026-10-30T12:00:00Z'; // 120 min ago
  assert.equal(isStale(fetchedAt, 60, now), true);
});

test('isStale is false exactly AT the threshold boundary (strictly greater-than, not >=)', () => {
  const now = Date.parse('2026-10-30T14:00:00Z');
  const fetchedAt = '2026-10-30T13:00:00Z'; // exactly 60 min ago
  assert.equal(isStale(fetchedAt, 60, now), false);
});

test('isStale treats a missing/unparseable fetchedAt as stale (fail safe, not fail silent)', () => {
  assert.equal(isStale(null, 60), true);
  assert.equal(isStale(undefined, 60), true);
  assert.equal(isStale('not a date', 60), true);
  assert.equal(isStale('', 60), true);
});

test('ageMinutesOf computes the correct rounded age', () => {
  const now = Date.parse('2026-10-30T14:00:00Z');
  assert.equal(ageMinutesOf('2026-10-30T13:30:00Z', now), 30);
});

test('ageMinutesOf returns Infinity for an unparseable timestamp (never looks accidentally fresh)', () => {
  assert.equal(ageMinutesOf('garbage'), Infinity);
  assert.equal(ageMinutesOf(null), Infinity);
});

test('fetchedAtFromFeedJson extracts the standard fetchedAt field', () => {
  assert.equal(fetchedAtFromFeedJson({ fetchedAt: '2026-10-30T00:00:00Z', jobs: [] }), '2026-10-30T00:00:00Z');
});

test('fetchedAtFromFeedJson handles missing/malformed input safely', () => {
  assert.equal(fetchedAtFromFeedJson(null), null);
  assert.equal(fetchedAtFromFeedJson(undefined), null);
  assert.equal(fetchedAtFromFeedJson({}), null);
  assert.equal(fetchedAtFromFeedJson('not an object'), null);
});

test('WATCHED_FEEDS covers every Tailscale-dependent workflow, no duplicates', () => {
  const workflows = WATCHED_FEEDS.map((f) => f.workflow);
  assert.equal(new Set(workflows).size, workflows.length, 'no workflow should be watched twice');
  for (const expected of ['hc.yml', 'hc-data.yml', 'jobright.yml', 'nextplay.yml', 'linkedin.yml']) {
    assert.ok(workflows.includes(expected), `${expected} must be watched`);
  }
});

test('WATCHED_FEEDS thresholds are all meaningfully larger than a single missed cron cycle', () => {
  // hc/hc-data/jobright/nextplay run every 15min, linkedin every 2h (120min)
  // -- every threshold here should be at least 2x its own cadence so one
  // slow/contended cycle never false-triggers a retry storm.
  for (const f of WATCHED_FEEDS) {
    assert.ok(f.thresholdMinutes >= 30, `${f.workflow}'s threshold (${f.thresholdMinutes}min) looks too tight`);
  }
  const linkedin = WATCHED_FEEDS.find((f) => f.workflow === 'linkedin.yml');
  assert.ok(linkedin.thresholdMinutes >= 120, 'linkedin threshold must be well above its 2h cadence');
});
