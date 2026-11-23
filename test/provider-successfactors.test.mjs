import test from 'node:test';
import assert from 'node:assert/strict';

import successfactors from '../providers/successfactors.mjs';

test('detect() always returns null — routed only via explicit provider: field', () => {
  assert.equal(successfactors.detect({ careers_url: 'https://jobs.hydro.com' }), null);
  assert.equal(successfactors.detect({}), null);
});

test('fetch() throws clearly for a blocked career*.successfactors.com host', async () => {
  await assert.rejects(
    () => successfactors.fetch({ name: 'Bad', careers_url: 'https://career5.successfactors.com/career?company=acme' }, { fetchText: async () => '' }),
    /successfactors/,
  );
  await assert.rejects(
    () => successfactors.fetch({ name: 'Bad', careers_url: 'https://career012.successfactors.eu/career?company=acme' }, { fetchText: async () => '' }),
    /successfactors/,
  );
});

test('fetch() throws clearly when there is no derivable https origin', async () => {
  await assert.rejects(
    () => successfactors.fetch({ name: 'Bad' }, { fetchText: async () => '' }),
    /successfactors/,
  );
});

// Sitemap fixture mirrors jobs.hydro.com's real sitemap.xml shape.
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.google.com/schemas/sitemap/0.9">
<url><loc>https://jobs.hydro.com/Hydro-Operator/job/Rockledge-CTL-Lead-FL-32955/1454287333/</loc><lastmod>2026-11-21</lastmod></url>
<url><loc>https://jobs.hydro.com/view/xsl/sitemapssl.xsl</loc></url>
<url><loc>https://jobs.hydro.com/talentcommunity/subscribe/</loc></url>
</urlset>`;

// Job-page fixture mirrors the real template fields confirmed live:
// itemprop="title"/"description" microdata, no jobLocation microdata, a
// class="jobGeoLocation" span for the plain-text location.
const JOB_HTML = `<html><head><title>CTL Lead Job Details | Hydro</title></head><body>
<h1 itemprop="title">CTL Lead</h1>
<p><span class="jobGeoLocation">Rockledge, FL, US, 32955</span></p>
<div itemprop="description">Operate the continuous casting line.</div>
</body></html>`;

test('fetch() reads the sitemap, keeps only /job/.../id/ URLs, and scrapes each job page', async () => {
  const calls = [];
  const ctx = {
    async fetchText(url) {
      calls.push(url);
      if (url.endsWith('/sitemap.xml')) return SITEMAP;
      return JOB_HTML;
    },
  };
  const jobs = await successfactors.fetch({ name: 'Hydro', careers_url: 'https://jobs.hydro.com' }, ctx);
  assert.equal(calls.length, 2, 'should fetch the sitemap once and exactly 1 real job page (xsl/talentcommunity URLs excluded)');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'CTL Lead');
  assert.equal(jobs[0].url, 'https://jobs.hydro.com/Hydro-Operator/job/Rockledge-CTL-Lead-FL-32955/1454287333/');
  assert.equal(jobs[0].company, 'Hydro');
  assert.equal(jobs[0].location, 'Rockledge, FL, US, 32955');
  assert.equal(jobs[0].description, 'Operate the continuous casting line.');
  assert.equal(jobs[0].postedAt, undefined);
});

test('fetch() prefers schema.org jobLocation microdata over the plain-text span when both are present', async () => {
  const withMicrodata = JOB_HTML.replace(
    '<div itemprop="description">',
    '<div itemprop="jobLocation"><span itemprop="addressLocality" content="Austin"></span><span itemprop="addressRegion" content="TX"></span><span itemprop="addressCountry" content="US"></span></div><div itemprop="description">',
  );
  const ctx = {
    async fetchText(url) {
      if (url.endsWith('/sitemap.xml')) return SITEMAP;
      return withMicrodata;
    },
  };
  const jobs = await successfactors.fetch({ name: 'Hydro', careers_url: 'https://jobs.hydro.com' }, ctx);
  assert.equal(jobs[0].location, 'Austin, TX, US');
});

test('fetch() caps the number of job pages fetched at MAX_JOBS', async () => {
  const manyUrls = Array.from({ length: 200 }, (_, i) =>
    `<url><loc>https://jobs.hydro.com/Hydro-Operator/job/role-${i}/${1000 + i}/</loc></url>`).join('\n');
  const sitemap = `<?xml version="1.0"?><urlset>${manyUrls}</urlset>`;
  let jobPageFetches = 0;
  const ctx = {
    sleep: async () => {},
    async fetchText(url) {
      if (url.endsWith('/sitemap.xml')) return sitemap;
      jobPageFetches += 1;
      return JOB_HTML;
    },
  };
  await successfactors.fetch({ name: 'Hydro', careers_url: 'https://jobs.hydro.com' }, ctx);
  assert.equal(jobPageFetches, 150);
});

test('fetch() skips a job page that fails to load instead of aborting the whole scan', async () => {
  const manyUrls = [
    '<url><loc>https://jobs.hydro.com/Hydro-Operator/job/role-a/1001/</loc></url>',
    '<url><loc>https://jobs.hydro.com/Hydro-Operator/job/role-b/1002/</loc></url>',
  ].join('\n');
  const sitemap = `<?xml version="1.0"?><urlset>${manyUrls}</urlset>`;
  const ctx = {
    async fetchText(url) {
      if (url.endsWith('/sitemap.xml')) return sitemap;
      if (url.includes('role-a')) throw new Error('500 boom');
      return JOB_HTML;
    },
  };
  const jobs = await successfactors.fetch({ name: 'Hydro', careers_url: 'https://jobs.hydro.com' }, ctx);
  assert.equal(jobs.length, 1);
});
