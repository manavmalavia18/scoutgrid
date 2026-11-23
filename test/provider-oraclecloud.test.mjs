import test from 'node:test';
import assert from 'node:assert/strict';

import oraclecloud from '../providers/oraclecloud.mjs';

test('detects an Oracle Candidate Experience careers_url and derives the list URL', () => {
  const hit = oraclecloud.detect({
    careers_url: 'https://ejwl.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX',
  });
  assert.ok(hit);
  assert.match(hit.url, /^https:\/\/ejwl\.fa\.us2\.oraclecloud\.com\/hcmRestApi\/resources\/latest\/recruitingCEJobRequisitions\?/);
  assert.match(hit.url, /siteNumber%3DCX/);
});

test('detect() returns null for non-Oracle-CX hosts and malformed paths', () => {
  assert.equal(oraclecloud.detect({ careers_url: 'https://example.com/careers' }), null);
  assert.equal(oraclecloud.detect({ careers_url: 'https://ejwl.fa.us2.oraclecloud.com/some/other/path' }), null);
  assert.equal(oraclecloud.detect({}), null);
});

// Fixture shape confirmed against Marriott's real public board response.
test('fetch() normalizes requisitions into {title,url,company,location,postedAt}, single page', async () => {
  const ctx = {
    async fetchJson(url) {
      assert.match(url, /recruitingCEJobRequisitions\?onlyData=true&expand=requisitionList\.secondaryLocations&finder=/);
      return {
        items: [{
          TotalJobsCount: 1,
          SiteNumber: 'CX',
          requisitionList: [{
            Id: '26052255',
            Title: 'Executive Chef',
            PostedDate: '2026-11-23',
            PrimaryLocation: 'Makassar, Sulawesi Selatan, Indonesia',
            PrimaryLocationCountry: 'ID',
          }],
        }],
      };
    },
  };
  const jobs = await oraclecloud.fetch(
    { name: 'Marriott', careers_url: 'https://ejwl.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX' },
    ctx,
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Executive Chef');
  assert.equal(jobs[0].url, 'https://ejwl.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/requisitions/preview/26052255');
  assert.equal(jobs[0].company, 'Marriott');
  assert.equal(jobs[0].location, 'Makassar, Sulawesi Selatan, Indonesia');
  assert.equal(jobs[0].postedAt, Date.parse('2026-11-23'));
});

test('fetch() falls back to PrimaryLocationCountry when PrimaryLocation is blank', async () => {
  const ctx = {
    async fetchJson() {
      return { items: [{ TotalJobsCount: 1, requisitionList: [{ Id: '1', Title: 'Remote Role', PrimaryLocation: null, PrimaryLocationCountry: 'US' }] }] };
    },
  };
  const jobs = await oraclecloud.fetch({ name: 'X', careers_url: 'https://x.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX' }, ctx);
  assert.equal(jobs[0].location, 'US');
});

test('fetch() paginates across TotalJobsCount and stops once exhausted', async () => {
  let calls = 0;
  const ctx = {
    async fetchJson(url) {
      calls += 1;
      const offset = Number(decodeURIComponent(url).match(/offset=(\d+)/)?.[1] || 0);
      if (offset === 0) {
        return { items: [{ TotalJobsCount: 250, requisitionList: Array.from({ length: 200 }, (_, i) => ({ Id: `a${i}`, Title: `Job A${i}` })) }] };
      }
      return { items: [{ TotalJobsCount: 250, requisitionList: Array.from({ length: 50 }, (_, i) => ({ Id: `b${i}`, Title: `Job B${i}` })) }] };
    },
  };
  const jobs = await oraclecloud.fetch({ name: 'X', careers_url: 'https://x.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX' }, ctx);
  assert.equal(calls, 2);
  assert.equal(jobs.length, 250);
});

test('fetch() drops requisitions missing an Id or a non-empty Title', async () => {
  const ctx = {
    async fetchJson() {
      return { items: [{ TotalJobsCount: 2, requisitionList: [{ Id: '', Title: 'No id' }, { Id: 'x', Title: '' }] }] };
    },
  };
  const jobs = await oraclecloud.fetch({ name: 'X', careers_url: 'https://x.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX' }, ctx);
  assert.equal(jobs.length, 0);
});

test('fetch() throws clearly when the entry has no derivable host/site', async () => {
  await assert.rejects(
    () => oraclecloud.fetch({ name: 'Bad', careers_url: 'https://example.com/careers' }, { fetchJson: async () => ({}) }),
    /oraclecloud/,
  );
});
