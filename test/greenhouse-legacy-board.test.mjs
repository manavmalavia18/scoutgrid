import test from 'node:test';
import assert from 'node:assert/strict';
import greenhouse from '../providers/greenhouse.mjs';

test('Greenhouse rejects lookalike, HTTP, and ambiguous embed board URLs', () => {
  for (const url of [
    'https://boards.greenhouse.io.evil.example/acme',
    'https://boards.greenhouse.io@evil.example/acme',
    'http://boards.greenhouse.io/acme',
    'https://boards.greenhouse.io/embed',
  ]) {
    assert.equal(greenhouse.detect({ name: 'Acme', careers_url: url }), null, url);
  }
  for (const api of [
    'http://boards-api.greenhouse.io/v1/boards/acme/jobs',
    'https://boards-api.greenhouse.io.evil.example/v1/boards/acme/jobs',
  ]) {
    const entry = { name: 'Acme', api };
    assert.equal(greenhouse.detect(entry), null);
    assert.rejects(greenhouse.fetch(entry, { fetchJson: async () => { throw new Error('must not fetch'); } }), /HTTPS|untrusted hostname/);
  }
});

for (const host of ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io']) {
  test(`Greenhouse resolves official ${host} boards and retains employer canonical URL/date`, async () => {
    const entry = { name: 'Example Employer', provider: 'greenhouse', careers_url: `https://${host}/example/jobs/123` };
    const expected = 'https://boards-api.greenhouse.io/v1/boards/example/jobs';
    assert.deepEqual(greenhouse.detect(entry), { url: expected });
    const jobs = await greenhouse.fetch(entry, { fetchJson: async (url, options) => {
      assert.equal(url, `${expected}?content=true`);
      assert.equal(options.redirect, 'error');
      return { jobs: [{ id: 123, title: 'Software Engineer', absolute_url: `https://${host}/example/jobs/123`, first_published: '2026-11-12T15:00:00Z', location: { name: 'New York' } }] };
    }});
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].url, `https://${host}/example/jobs/123`);
    assert.equal(jobs[0].company, 'Example Employer');
    assert.equal(jobs[0].postedAt, Date.parse('2026-11-12T15:00:00Z'));
  });
}
