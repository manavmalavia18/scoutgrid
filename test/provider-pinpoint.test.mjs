import test from 'node:test';
import assert from 'node:assert/strict';

import pinpoint from '../providers/pinpoint.mjs';

test('detects a *.pinpointhq.com careers_url and derives the postings.json URL', () => {
  const hit = pinpoint.detect({ careers_url: 'https://workwithus.pinpointhq.com/en' });
  assert.ok(hit);
  assert.equal(hit.url, 'https://workwithus.pinpointhq.com/postings.json');
});

test('detect() returns null for non-pinpoint hosts and for pinpoint-owned reserved subdomains', () => {
  assert.equal(pinpoint.detect({ careers_url: 'https://example.com/careers' }), null);
  assert.equal(pinpoint.detect({ careers_url: 'https://developers.pinpointhq.com/docs' }), null);
  assert.equal(pinpoint.detect({ careers_url: 'https://www.pinpointhq.com' }), null);
  assert.equal(pinpoint.detect({}), null);
});

test('api: takes precedence over careers_url', () => {
  const hit = pinpoint.detect({
    careers_url: 'https://acme.com/careers',
    api: 'https://acme.pinpointhq.com/en',
  });
  assert.equal(hit.url, 'https://acme.pinpointhq.com/postings.json');
});

// Fixture shape confirmed against a real tenant's live postings.json response.
test('fetch() normalizes postings into {title,url,company,location,description}, undated', async () => {
  const ctx = {
    async fetchJson(url) {
      assert.equal(url, 'https://workwithus.pinpointhq.com/postings.json');
      return {
        data: [
          {
            id: '591998',
            title: 'Staff Product Designer',
            url: 'https://workwithus.pinpointhq.com/en/postings/fa79e602',
            path: '/en/postings/fa79e602',
            workplace_type: 'remote',
            workplace_type_text: 'Fully remote',
            key_responsibilities: '<ul><li>Own design end to end</li></ul>',
            location: { id: '283', city: 'London', name: 'Remote', province: 'London' },
          },
        ],
      };
    },
  };
  const jobs = await pinpoint.fetch({ name: 'Pinpoint', careers_url: 'https://workwithus.pinpointhq.com/en' }, ctx);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Staff Product Designer');
  assert.equal(jobs[0].url, 'https://workwithus.pinpointhq.com/en/postings/fa79e602');
  assert.equal(jobs[0].company, 'Pinpoint');
  assert.equal(jobs[0].location, 'London, Remote');
  assert.equal(jobs[0].description, 'Own design end to end');
  assert.equal(jobs[0].postedAt, undefined);
});

test('fetch() falls back to workplace_type when location has no city/remote label', async () => {
  const ctx = {
    async fetchJson() {
      return {
        data: [{ id: '1', title: 'Remote Engineer', url: 'https://x.pinpointhq.com/en/postings/1', workplace_type: 'remote', location: {} }],
      };
    },
  };
  const jobs = await pinpoint.fetch({ name: 'X', careers_url: 'https://x.pinpointhq.com' }, ctx);
  assert.equal(jobs[0].location, 'Remote');
});

test('fetch() drops postings missing a title or url', async () => {
  const ctx = {
    async fetchJson() {
      return { data: [{ id: '1', title: '', url: 'https://x.pinpointhq.com/en/postings/1' }, { id: '2', title: 'Has no URL', url: '' }] };
    },
  };
  const jobs = await pinpoint.fetch({ name: 'X', careers_url: 'https://x.pinpointhq.com' }, ctx);
  assert.equal(jobs.length, 0);
});

test('fetch() throws clearly when the entry has no derivable subdomain', async () => {
  await assert.rejects(
    () => pinpoint.fetch({ name: 'Bad', careers_url: 'https://example.com/careers' }, { fetchJson: async () => ({}) }),
    /pinpoint/,
  );
});
