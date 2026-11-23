import test from 'node:test';
import assert from 'node:assert/strict';

import ultipro from '../providers/ultipro.mjs';

test('detects a recruiting.ultipro.com careers_url and derives the LoadSearchResults URL', () => {
  const hit = ultipro.detect({
    careers_url: 'https://recruiting.ultipro.com/ACM1000ACME/JobBoard/9b2f0c1e-0000-0000-0000-000000000000/',
  });
  assert.ok(hit);
  assert.equal(
    hit.url,
    'https://recruiting.ultipro.com/ACM1000ACME/JobBoard/9b2f0c1e-0000-0000-0000-000000000000/JobBoardView/LoadSearchResults',
  );
});

test('accepts numbered/regional hosts (recruiting2, .ca) without normalizing them', () => {
  assert.ok(ultipro.detect({ careers_url: 'https://recruiting2.ultipro.com/WES1004/JobBoard/abc/' }));
  assert.ok(ultipro.detect({ careers_url: 'https://recruiting.ultipro.ca/ACM/JobBoard/abc/' }));
});

test('detect() returns null for non-ultipro hosts', () => {
  assert.equal(ultipro.detect({ careers_url: 'https://example.com/jobs' }), null);
  assert.equal(ultipro.detect({}), null);
});

// Fixture shape confirmed against real UKG Pro Recruiting boards: list
// returns opportunities[]/totalCount, PostedDate is the only date, and
// Locations can legitimately contain [null] entries.
test('fetch() normalizes opportunities into {title,url,company,location,postedAt}', async () => {
  const ctx = {
    async fetchJson(url, opts) {
      assert.equal(url, 'https://recruiting.ultipro.com/ACM/JobBoard/b1/JobBoardView/LoadSearchResults');
      assert.equal(opts.method, 'POST');
      const body = JSON.parse(opts.body);
      assert.equal(body.opportunitySearch.Top, 2000);
      return {
        opportunities: [
          {
            Id: '37c081ee-0000-0000-0000-000000000000',
            Title: 'Program Coordinator',
            PostedDate: '2026-10-30T17:50:17.099Z',
            Locations: [{ LocalizedDescription: 'Benin/Cotonou', Address: { City: 'Cotonou, Littoral', Country: { Name: 'Benin' } } }],
          },
        ],
        totalCount: 1,
      };
    },
  };
  const jobs = await ultipro.fetch({ name: 'Acme', careers_url: 'https://recruiting.ultipro.com/ACM/JobBoard/b1/' }, ctx);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Program Coordinator');
  assert.equal(jobs[0].url, 'https://recruiting.ultipro.com/ACM/JobBoard/b1/OpportunityDetail?opportunityId=37c081ee-0000-0000-0000-000000000000');
  assert.equal(jobs[0].company, 'Acme');
  assert.equal(jobs[0].location, 'Benin/Cotonou');
  assert.equal(jobs[0].postedAt, Date.parse('2026-10-30T17:50:17.099Z'));
});

test('fetch() falls back to Address fields and skips a leading null Locations entry', async () => {
  const ctx = {
    async fetchJson() {
      return {
        opportunities: [{
          Id: 'x1',
          Title: 'Installer',
          Locations: [null, { Address: { City: 'Portland', State: 'OR', Country: { Name: 'United States' } } }],
        }],
      };
    },
  };
  const jobs = await ultipro.fetch({ name: 'Acme', careers_url: 'https://recruiting.ultipro.com/ACM/JobBoard/b1/' }, ctx);
  assert.equal(jobs[0].location, 'Portland, OR, United States');
});

test('fetch() drops opportunities missing a Title or Id', async () => {
  const ctx = {
    async fetchJson() {
      return { opportunities: [{ Id: 'x', Title: '' }, { Title: 'No id' }] };
    },
  };
  const jobs = await ultipro.fetch({ name: 'Acme', careers_url: 'https://recruiting.ultipro.com/ACM/JobBoard/b1/' }, ctx);
  assert.equal(jobs.length, 0);
});

test('fetch() throws clearly when the entry has no derivable tenant/board', async () => {
  await assert.rejects(
    () => ultipro.fetch({ name: 'Bad', careers_url: 'https://example.com/jobs' }, { fetchJson: async () => ({}) }),
    /ultipro/,
  );
});
