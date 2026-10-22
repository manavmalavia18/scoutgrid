#!/usr/bin/env node
/**
 * a16z portfolio board-discovery leads — jobs.a16z.com lists ~700+ portfolio
 * companies' job postings. The company-level listing pages
 * (jobs.a16z.com/jobs/<slug>) are plain server-rendered HTML with the real
 * "Apply" hrefs inline (confirmed live: no JS execution needed, unlike the
 * site's own /jobs aggregate search which is client-rendered). Those apply
 * hrefs are sometimes the company's own branded careers domain hiding the
 * real ATS behind a query param (e.g. okta.com/...?gh_jid=...) — those are
 * NOT resolvable without visiting the branded page itself, so this script
 * only keeps hrefs that are ALREADY a direct, canonical ATS host
 * (Greenhouse/Ashby/Lever/Workday — the same four discover-boards.mjs's
 * extractOfficialBoardCandidate recognizes). Everything else is silently
 * skipped, same policy as every other feed.
 *
 * Company slugs come from jobs.a16z.com/sitemap.xml (one request, ~700
 * slugs) rather than crawling the paginated/client-rendered /companies
 * directory.
 *
 *   node fetch-a16z-feed.mjs
 *   node fetch-a16z-feed.mjs --limit 50   # quick local test
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(ROOT, 'data/a16z-feed.json');
const HEARTBEAT = resolve(ROOT, 'data/scan-a16z-heartbeat.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// Courtesy delay between company page requests — 673 companies at 250ms is
// ~3 minutes, well inside a normal CI timeout, and gentle on a16z's server.
const INTER_REQUEST_DELAY_MS = 250;

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}
const LIMIT = Number(argVal('--limit', '0')) || 0; // 0 = no limit

// Mirrors lib/official-board-registry.mjs's host checks exactly — an apply
// href only counts here if discover-boards.mjs would also recognize it.
const KNOWN_ATS_HOST_RE = /^(job-boards(?:\.eu)?\.greenhouse\.io|boards\.greenhouse\.io|jobs\.ashbyhq\.com|jobs(?:\.eu)?\.lever\.co)$/i;
function isKnownAtsHost(host) {
  return KNOWN_ATS_HOST_RE.test(host) || /\.myworkdayjobs\.com$/i.test(host);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${url}`), { status: res.status });
  return res.text();
}

async function getCompanySlugs() {
  const xml = await fetchText('https://jobs.a16z.com/sitemap.xml');
  const slugs = new Set();
  for (const m of xml.matchAll(/<loc>https:\/\/jobs\.a16z\.com\/jobs\/([a-z0-9-]+)<\/loc>/gi)) {
    slugs.add(m[1]);
  }
  return [...slugs].sort();
}

function companyNameFromHtml(html, fallbackSlug) {
  const m = html.match(/<title>\s*Careers at (.+?) - a16z Jobs/i);
  if (m && m[1].trim()) return m[1].trim();
  return fallbackSlug
    .split('-')
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(' ');
}

function extractAtsLinks(html, companyName) {
  const jobs = [];
  const seen = new Set();
  // Plain href scan (no DOM parser dependency, consistent with the rest of
  // scoutgrid's regex-based HTML scrapers — e.g. providers/icims.mjs).
  for (const m of html.matchAll(/href="(https:\/\/[^"]+)"/gi)) {
    let url;
    try { url = new URL(m[1]); } catch { continue; }
    if (!isKnownAtsHost(url.hostname)) continue;
    const key = `${url.hostname}${url.pathname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({ url: m[1], company: companyName, title: '' });
  }
  return jobs;
}

async function runOnce() {
  const started = Date.now();
  let slugs = await getCompanySlugs();
  if (LIMIT > 0) slugs = slugs.slice(0, LIMIT);

  let allJobs = [];
  let pagesFetched = 0;
  let pagesFailed = 0;
  for (let i = 0; i < slugs.length; i += 1) {
    const slug = slugs[i];
    if (i > 0) await sleep(INTER_REQUEST_DELAY_MS);
    try {
      const html = await fetchText(`https://jobs.a16z.com/jobs/${slug}`);
      const companyName = companyNameFromHtml(html, slug);
      allJobs = allJobs.concat(extractAtsLinks(html, companyName));
      pagesFetched += 1;
    } catch (err) {
      pagesFailed += 1;
      console.error(`a16z ${slug}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const nowIso = new Date().toISOString();
  if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ fetchedAt: nowIso, jobs: allJobs }, null, 2));
  writeFileSync(HEARTBEAT, JSON.stringify({
    at: nowIso,
    companiesInSitemap: slugs.length,
    pagesFetched,
    pagesFailed,
    directlyResolvedLeads: allJobs.length,
    elapsedSec: Math.round((Date.now() - started) / 1000),
  }, null, 2));

  console.log(`[${nowIso}] a16z: ${pagesFetched}/${slugs.length} company pages fetched (${pagesFailed} failed) -> ${allJobs.length} direct ATS leads`);
}

runOnce().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
