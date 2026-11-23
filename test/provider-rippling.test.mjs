import test from 'node:test';
import assert from 'node:assert/strict';

import rippling from '../providers/rippling.mjs';

test('detects an ats.rippling.com careers_url and derives the v2 board API URL', () => {
  const hit = rippling.detect({ careers_url: 'https://ats.rippling.com/acme-careers/jobs' });
  assert.ok(hit);
  assert.equal(hit.url, 'https://api.rippling.com/platform/api/ats/v2/board/acme-careers/jobs?page=0&pageSize=100');
});

test('detects a regional ats.<region>.rippling.com host and a locale-prefixed path', () => {
  assert.ok(rippling.detect({ careers_url: 'https://ats.us1.rippling.com/acme-careers/jobs' }));
  assert.ok(rippling.detect({ careers_url: 'https://ats.rippling.com/de-DE/acme-careers/jobs' }));
});

test('detect() returns null for non-rippling hosts', () => {
  assert.equal(rippling.detect({ careers_url: 'https://example.com/jobs' }), null);
  assert.equal(rippling.detect({}), null);
});

// Fixture shapes from Rippling's real v2 board API (list) and deduplication
// behaviour per the documented "multi-location jobs repeat per location" gotcha.
test('fetch() normalizes items into {title,url,company,location}, undated, single page', async () => {
  const ctx = {
    async fetchJson(url) {
      assert.equal(url, 'https://api.rippling.com/platform/api/ats/v2/board/acme-careers/jobs?page=0&pageSize=100');
      return {
        items: [
          {
            id: '84d388b6-7656-434c-8862-0312eb6b97ac',
            name: 'Business Operations Manager',
            url: 'https://ats.rippling.com/acme-careers/jobs/84d388b6-7656-434c-8862-0312eb6b97ac',
            locations: [{ name: 'San Francisco, CA', workplaceType: 'ON_SITE' }],
          },
        ],
        page: 0,
        pageSize: 100,
        totalItems: 1,
        totalPages: 1,
      };
    },
  };
  const jobs = await rippling.fetch({ name: 'Acme', careers_url: 'https://ats.rippling.com/acme-careers/jobs' }, ctx);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Business Operations Manager');
  assert.equal(jobs[0].url, 'https://ats.rippling.com/acme-careers/jobs/84d388b6-7656-434c-8862-0312eb6b97ac');
  assert.equal(jobs[0].company, 'Acme');
  assert.equal(jobs[0].location, 'San Francisco, CA');
  assert.equal(jobs[0].postedAt, undefined);
});

test('fetch() merges repeated rows for the same job id across multiple locations', async () => {
  const ctx = {
    async fetchJson() {
      return {
        items: [
          { id: 'j1', name: 'Engineer', url: 'https://ats.rippling.com/acme/jobs/j1', locations: [{ name: 'Austin, TX' }] },
          { id: 'j1', name: 'Engineer', url: 'https://ats.rippling.com/acme/jobs/j1', locations: [{ name: 'Remote', workplaceType: 'REMOTE' }] },
        ],
        totalPages: 1,
      };
    },
  };
  const jobs = await rippling.fetch({ name: 'Acme', careers_url: 'https://ats.rippling.com/acme/jobs' }, ctx);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].location, 'Austin, TX · Remote');
});

test('fetch() paginates across totalPages and stops at the last one', async () => {
  let calls = 0;
  const ctx = {
    async fetchJson(url) {
      calls += 1;
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 0) {
        return { items: [{ id: 'a', name: 'Job A', url: 'https://ats.rippling.com/acme/jobs/a', locations: [] }], totalPages: 2 };
      }
      return { items: [{ id: 'b', name: 'Job B', url: 'https://ats.rippling.com/acme/jobs/b', locations: [] }], totalPages: 2 };
    },
  };
  const jobs = await rippling.fetch({ name: 'Acme', careers_url: 'https://ats.rippling.com/acme/jobs' }, ctx);
  assert.equal(calls, 2);
  assert.equal(jobs.length, 2);
});

test('fetch() drops items missing an id or a non-empty name', async () => {
  const ctx = {
    async fetchJson() {
      return { items: [{ id: '', name: 'No id' }, { id: 'x', name: '' }, { id: 'y' }], totalPages: 1 };
    },
  };
  const jobs = await rippling.fetch({ name: 'Acme', careers_url: 'https://ats.rippling.com/acme/jobs' }, ctx);
  assert.equal(jobs.length, 0);
});

test('fetch() throws clearly when the entry has no derivable slug', async () => {
  await assert.rejects(
    () => rippling.fetch({ name: 'Bad', careers_url: 'https://example.com/jobs' }, { fetchJson: async () => ({}) }),
    /rippling/,
  );
});
