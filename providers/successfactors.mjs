// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// SAP SuccessFactors (Career Site Builder / "RMK") provider — reads the
// public sitemap + job-page HTML on an employer's OWN domain
// (jobs.{company}.com, careers.{company}.com) rather than a SuccessFactors-
// owned one. Confirmed live against a real tenant (jobs.hydro.com).
//
// Deliberately NOT auto-detected by hostname (unlike pinpoint/rippling):
// there is no distinguishing subdomain pattern the way there is for
// *.pinpointhq.com — a SuccessFactors career site lives on the EMPLOYER's
// own domain and looks, from the URL alone, like any other company
// careers page. detect() always returns null; this provider only runs via
// an explicit `provider: successfactors` in portals.yml, after a human (or
// discover-boards.mjs) has confirmed the site actually has the signature
// (rmkcdn.successfactors.com assets, /job/{slug}/{id}/ sitemap URLs).
//
// Explicitly excludes SAP's OWN hosted `career{N}.successfactors.com`
// pages — confirmed live via robots.txt (`Disallow: /` / `Disallow:
// /*company`), i.e. SAP itself has asked crawlers to stay off those. A
// tenant that only has that kind of URL cannot be scraped by this
// provider at all — same "don't fight an explicit block" policy applied
// to Getro and, below, the career*.successfactors.com host check.
//
// No official JSON API found for the public career site (only an
// authenticated OData API requiring the employer's own credentials) — this
// reads the SAME sitemap + HTML the career site itself renders for a
// browser, same technique class as providers/icims.mjs's search pages.
//
// No postedAt: date markup varies per Career Site Builder template (some
// have schema.org `datePosted` microdata, many don't, and the sitemap's
// `lastmod` is a last-MODIFIED date, not a posting date) — every job is
// undated, same convention as bamboohr/pinpoint/rippling.
import { BROWSER_LIKE_USER_AGENT } from './_http.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { decodeEntities } from './_html-entities.mjs';

const BLOCKED_HOST_RE = /^career\d*\.successfactors\.(com|eu)$/i;
const JOB_URL_RE = /\/job\/[^/]+\/[\w-]+\/?$/i;
// Sitemaps on large SuccessFactors tenants can run into the thousands
// (one real tenant's ran ~14,900 URLs including locale duplicates) — this
// is a per-job-page-fetch provider, so a cap keeps one huge board from
// turning a single scan into thousands of HTTP requests. 150 is well
// above a typical mid-size tracked company.
const MAX_JOBS = 150;
const INTER_REQUEST_DELAY_MS = 150;

const HEADERS = { accept: 'text/html', 'user-agent': BROWSER_LIKE_USER_AGENT };

function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveOrigin(entry) {
  for (const raw of [entry.api, entry.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try { parsed = new URL(raw); } catch { continue; }
    if (parsed.protocol !== 'https:') continue;
    if (BLOCKED_HOST_RE.test(parsed.hostname)) continue;
    return parsed.origin;
  }
  return null;
}

/** @param {string} xml @param {string} origin */
function extractJobUrls(xml, origin) {
  const urls = [];
  for (const m of String(xml).matchAll(/<loc>([^<]+)<\/loc>/gi)) {
    const loc = decodeEntities(m[1].trim());
    let parsed;
    try { parsed = new URL(loc); } catch { continue; }
    if (parsed.origin !== origin) continue;
    if (!JOB_URL_RE.test(parsed.pathname)) continue;
    urls.push(parsed.href);
  }
  return urls;
}

/** @param {string} html */
function extractTitle(html) {
  const microdata = html.match(/itemprop=["']title["'][^>]*>\s*([^<]+)/i);
  if (microdata && microdata[1].trim()) return decodeEntities(microdata[1].trim());
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og && og[1].trim()) return decodeEntities(og[1].trim());
  const title = html.match(/<title>\s*([^<]+?)\s*(?:\|[^<]*)?<\/title>/i);
  return title ? decodeEntities(title[1].trim()) : '';
}

/** @param {string} html */
function extractDescription(html) {
  // Some templates print `itemprop="description"` several times with the
  // first occurrence empty and the real text split across the rest, and
  // some nest a sub-heading inside the same attribute (confirmed live:
  // one real tenant's section heading appeared twice) — join every
  // non-empty match but collapse immediate repeats rather than trying to
  // fully model every template's markup.
  const parts = [];
  for (const m of html.matchAll(/itemprop=["']description["'][^>]*>([\s\S]*?)<\/[a-z0-9]+>/gi)) {
    const text = htmlToText(m[1]);
    if (text && text !== parts[parts.length - 1]) parts.push(text);
  }
  return parts.join('\n\n');
}

/** @param {string} html */
function extractLocation(html) {
  // Prefer schema.org jobLocation microdata when the template has it.
  const country = html.match(/itemprop=["']addressCountry["'][^>]*content=["']([^"']+)["']/i);
  const region = html.match(/itemprop=["']addressRegion["'][^>]*content=["']([^"']+)["']/i);
  const locality = html.match(/itemprop=["']addressLocality["'][^>]*content=["']([^"']+)["']/i);
  const microParts = [locality?.[1], region?.[1], country?.[1]].filter((v) => v && v.trim());
  if (microParts.length) return microParts.map((v) => decodeEntities(v.trim())).join(', ');

  // Fall back to the plain-text location span most Career Site Builder
  // templates render even without microdata (confirmed live).
  for (const cls of ['jobGeoLocation', 'job-location']) {
    const m = html.match(new RegExp(`class=["'][^"']*${cls}[^"']*["'][^>]*>([^<]+)`, 'i'));
    if (m && m[1].trim()) return decodeEntities(m[1].replace(/\s+/g, ' ').trim());
  }
  return '';
}

/** @type {Provider} */
export default {
  id: 'successfactors',

  // Always null — see header comment. Routed only via explicit
  // `provider: successfactors` in portals.yml.
  detect() {
    return null;
  },

  async fetch(entry, ctx) {
    const origin = resolveOrigin(entry);
    if (!origin) throw new Error(`successfactors: cannot derive a usable origin for ${entry.name} (blocked SAP-hosted career*.successfactors.com host, or no https careers_url)`);

    const xml = await ctx.fetchText(`${origin}/sitemap.xml`, { headers: HEADERS, redirect: 'error' });
    const jobUrls = extractJobUrls(xml, origin).slice(0, MAX_JOBS);

    const jobs = [];
    for (let i = 0; i < jobUrls.length; i += 1) {
      if (i > 0) await sleep(INTER_REQUEST_DELAY_MS, ctx);
      let html;
      try {
        html = await ctx.fetchText(jobUrls[i], { headers: HEADERS, redirect: 'error' });
      } catch (err) {
        console.error(`successfactors ${entry.name} ${jobUrls[i]}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      const title = extractTitle(html);
      if (!title) continue;
      jobs.push({
        title,
        url: jobUrls[i],
        company: entry.name,
        location: extractLocation(html),
        description: extractDescription(html),
        postedAt: undefined,
      });
    }
    return jobs;
  },
};
