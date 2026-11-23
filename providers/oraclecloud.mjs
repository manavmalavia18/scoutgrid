// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Oracle Recruiting Cloud (Fusion HCM "Candidate Experience") provider.
// Confirmed live and via multiple independent sources against many real
// employers (Marriott, Kroger, JPMorgan Chase, Ford, Macy's, Mayo Clinic,
// KPMG, University of Chicago Medicine — a wide, unrelated spread of
// industries, not a coincidence specific to one tenant): every Oracle
// Candidate Experience career site loads its jobs from the SAME public,
// keyless REST resource on its own tenant host, no login and no API key.
//
// Unlike Workday's derivable `*.myworkdayjobs.com` subdomain pattern, an
// Oracle tenant's host (e.g. ejwl.fa.us2.oraclecloud.com) is an opaque pod
// identifier with no relationship to the company name — it can only be
// pulled out of a real careers_url a human already found, never guessed.
// That is a portals.yml curation cost, not a code-feasibility problem.
//
// careers_url shape: https://{host}/hcmUI/CandidateExperience/{lang}/sites/{siteNumber}[/requisitions...]
import { BROWSER_LIKE_USER_AGENT } from './_http.mjs';

const ORACLE_CX_URL_RE = /^https:\/\/([\w.-]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/([\w-]+)\/sites\/([\w-]+)/i;
const PAGE_SIZE = 200;
// Oracle's own list endpoint stops returning new rows past offset ~9,800
// (documented live gotcha: Marriott's 13,423-job board lost a quarter of
// its jobs walking straight past that point) — this cap exists so a huge
// board degrades to "first ~10,000 jobs" instead of looping forever, not
// so it silently drops jobs for the common case of a board well under it.
const MAX_OFFSET = 9800;

/** @param {import('./_types.js').PortalEntry} entry */
function resolveSite(entry) {
  for (const url of [entry.api, entry.careers_url]) {
    if (typeof url !== 'string' || !url) continue;
    const m = url.match(ORACLE_CX_URL_RE);
    if (m) return { host: m[1], lang: m[2], siteNumber: m[3] };
  }
  return null;
}

function finder(siteNumber, offset) {
  return `findReqs;siteNumber=${siteNumber},limit=${PAGE_SIZE},offset=${offset},sortBy=POSTING_DATES_DESC`;
}

/** @param {any} req */
function formatLocation(req) {
  if (typeof req.PrimaryLocation === 'string' && req.PrimaryLocation.trim()) return req.PrimaryLocation.trim();
  return typeof req.PrimaryLocationCountry === 'string' ? req.PrimaryLocationCountry : '';
}

/** @param {any} req */
function postedAtMs(req) {
  const ms = Date.parse(req?.PostedDate || '');
  return Number.isFinite(ms) ? ms : undefined;
}

/** @type {Provider} */
export default {
  id: 'oraclecloud',

  detect(entry) {
    const site = resolveSite(entry);
    if (!site) return null;
    return {
      url: `https://${site.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=${encodeURIComponent(finder(site.siteNumber, 0))}`,
    };
  },

  async fetch(entry, ctx) {
    const site = resolveSite(entry);
    if (!site) throw new Error(`oraclecloud: cannot derive host/site for ${entry.name}`);
    const api = `https://${site.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`;
    const headers = { accept: 'application/json', 'user-agent': BROWSER_LIKE_USER_AGENT };
    const detailBase = `https://${site.host}/hcmUI/CandidateExperience/${site.lang}/sites/${site.siteNumber}/requisitions/preview`;

    /** @type {Map<string, any>} */
    const byId = new Map();
    let offset = 0;
    let totalJobsCount = Infinity;
    while (offset < totalJobsCount && offset <= MAX_OFFSET) {
      const params = new URLSearchParams({
        onlyData: 'true',
        expand: 'requisitionList.secondaryLocations',
        finder: finder(site.siteNumber, offset),
      });
      const json = /** @type {any} */ (await ctx.fetchJson(`${api}?${params.toString()}`, { headers, redirect: 'error' }));
      const result = Array.isArray(json?.items) ? json.items[0] : null;
      const reqs = Array.isArray(result?.requisitionList) ? result.requisitionList : [];
      totalJobsCount = Number.isFinite(result?.TotalJobsCount) ? result.TotalJobsCount : reqs.length;
      for (const req of reqs) {
        if (!req?.Id || typeof req.Title !== 'string' || !req.Title.trim()) continue;
        byId.set(req.Id, req);
      }
      if (reqs.length === 0) break;
      offset += PAGE_SIZE;
    }

    return [...byId.values()]
      .map((req) => ({
        title: req.Title,
        url: `${detailBase}/${req.Id}`,
        company: entry.name,
        location: formatLocation(req),
        postedAt: postedAtMs(req),
      }))
      .filter((j) => j.title && j.url);
  },
};
