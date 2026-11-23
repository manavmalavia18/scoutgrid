#!/usr/bin/env node
/**
 * liftoffjobs.com VC-portfolio board-discovery leads — covers 8 target VCs
 * (Sequoia, Accel, Benchmark, Index Ventures, General Catalyst, Thrive
 * Capital, Founders Fund, Bessemer Venture Partners) through ONE public
 * aggregator instead of 8 separate VC-site scrapers.
 *
 * Why this over scraping each VC's own site directly: 5 of those 8 VCs
 * (Sequoia, Accel, General Catalyst, Bessemer, Thrive) run their own
 * portfolio job board on Getro, a third-party platform that actively
 * blocks plain HTTP requests and tells you to buy its paid API instead
 * (confirmed live: a bare curl to jobs.accel.com returns "We'd be happy to
 * provide all job data to you through our API services... contact us at
 * api@getro.com"). Fighting that would be exactly the kind of anti-bot
 * contest this codebase's standing policy avoids. Index Ventures and
 * Founders Fund/Benchmark don't have a clean equivalent either (client-
 * rendered or no aggregator at all).
 *
 * liftoffjobs.com's own robots.txt explicitly invites exactly this instead
 * of HTML scraping (confirmed live):
 *   Allow: /api/public/
 *   Allow: /api/openapi.json
 *   # The public read API is open and unauthenticated — crawl it instead
 *   # of the HTML if you want structured data.
 * The endpoint is public, keyless, paginated, and already resolves each
 * job to its real first-party ATS URL (Greenhouse/Ashby/Lever/Workday/etc
 * — exactly what lib/official-board-registry.mjs's extractOfficialBoardCandidate
 * already knows how to recognize), so unlike fetch-a16z-feed.mjs this
 * script never needs to visit a per-company page to resolve the apply link.
 *
 *   node fetch-liftoff-feed.mjs
 *   node fetch-liftoff-feed.mjs --limit 50   # quick local test (per investor)
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(ROOT, 'data/liftoff-feed.json');
const HEARTBEAT = resolve(ROOT, 'data/scan-liftoff-heartbeat.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const API_BASE = 'https://liftoffjobs.com/api/public/jobs';
const PAGE_SIZE = 100;
// Safety cap per investor — well above any single VC's real open-role count
// (confirmed live: Sequoia alone was ~2100 US roles), so a misbehaving
// cursor can't drive this into unbounded pagination.
const MAX_PAGES_PER_INVESTOR = 50;
// Courtesy delay between paginated requests to the same public endpoint.
const INTER_REQUEST_DELAY_MS = 200;

// Investor facet slugs — confirmed live against the real /api/public/jobs
// facets.investor list (153 entries total; these 8 are the user-approved
// target list). Values are the aggregator's own slugs, not guessed.
const TARGET_INVESTORS = [
  'sequoia-capital',
  'accel',
  'benchmark',
  'index-ventures',
  'general-catalyst',
  'thrive-capital',
  'founders-fund',
  'bessemer-venture-partners',
];

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}
const LIMIT = Number(argVal('--limit', '0')) || 0; // 0 = no limit, per investor

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${url}`), { status: res.status });
  return res.json();
}

async function fetchInvestorJobs(investorSlug) {
  const jobs = [];
  let cursor = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ investor: investorSlug, country: 'us', limit: String(PAGE_SIZE) });
    if (cursor) params.set('cursor', cursor);
    const json = await fetchJson(`${API_BASE}?${params.toString()}`);
    const items = Array.isArray(json?.items) ? json.items : [];
    for (const item of items) {
      if (!item?.url || !item?.title) continue;
      jobs.push({ url: item.url, company: item.company_name || '', title: item.title });
    }
    cursor = json?.next_cursor || null;
    pages += 1;
    if (LIMIT > 0 && jobs.length >= LIMIT) break;
    if (items.length === 0) break;
    if (cursor) await sleep(INTER_REQUEST_DELAY_MS);
  } while (cursor && pages < MAX_PAGES_PER_INVESTOR);
  return LIMIT > 0 ? jobs.slice(0, LIMIT) : jobs;
}

async function runOnce() {
  const started = Date.now();
  let allJobs = [];
  let investorsFetched = 0;
  let investorsFailed = 0;
  const perInvestorCounts = {};

  for (let i = 0; i < TARGET_INVESTORS.length; i += 1) {
    const slug = TARGET_INVESTORS[i];
    if (i > 0) await sleep(INTER_REQUEST_DELAY_MS);
    try {
      const jobs = await fetchInvestorJobs(slug);
      perInvestorCounts[slug] = jobs.length;
      allJobs = allJobs.concat(jobs);
      investorsFetched += 1;
    } catch (err) {
      perInvestorCounts[slug] = 0;
      investorsFailed += 1;
      console.error(`liftoff ${slug}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Same company can show up under multiple target investors (co-investment)
  // — dedupe on the apply URL, same as fetch-a16z-feed.mjs's `seen` set.
  const seen = new Set();
  const dedupedJobs = [];
  for (const job of allJobs) {
    if (seen.has(job.url)) continue;
    seen.add(job.url);
    dedupedJobs.push(job);
  }

  const nowIso = new Date().toISOString();
  if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ fetchedAt: nowIso, jobs: dedupedJobs }, null, 2));
  writeFileSync(HEARTBEAT, JSON.stringify({
    at: nowIso,
    investorsTargeted: TARGET_INVESTORS.length,
    investorsFetched,
    investorsFailed,
    perInvestorCounts,
    rawLeads: allJobs.length,
    dedupedLeads: dedupedJobs.length,
    elapsedSec: Math.round((Date.now() - started) / 1000),
  }, null, 2));

  console.log(`[${nowIso}] liftoff: ${investorsFetched}/${TARGET_INVESTORS.length} investors fetched (${investorsFailed} failed) -> ${dedupedJobs.length} deduped leads`);
}

runOnce().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
