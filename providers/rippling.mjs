// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Rippling ATS provider — hits the public, keyless JSON API that
// ats.rippling.com career pages use client-side. Undocumented by Rippling
// itself, but the same risk/maturity tier as providers/workday.mjs's CXS
// API: a stable, unauthenticated JSON endpoint serving exactly what the
// public career page shows, confirmed against multiple independent real
// tenants (e.g. a 864-board directory snapshot, all live).
//
// Auto-detects from careers_url pattern
// `https://ats.[region.]rippling.com/<slug>/jobs`.
//
// No postedAt: the v2 list endpoint carries no date field at all. Rippling's
// v1 per-job detail endpoint does (createdOn), but fetching it per-job for a
// large board risks exactly the kind of unbounded-request-burst pattern
// other providers here have had to retrofit retry/backoff for (ashby,
// workday) — deliberately kept out of scope for v1. Every job is undated,
// same convention as providers/bamboohr.mjs and providers/pinpoint.mjs.
import { BROWSER_LIKE_USER_AGENT } from './_http.mjs';

const RIPPLING_URL_RE = /^https:\/\/ats\.(?:[\w-]+\.)?rippling\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)\/jobs/;
const PAGE_SIZE = 100;
// Safety cap, same spirit as workday's MAX_PAGES_CAP — a misbehaving API
// response can't drive this into unbounded pagination. 100 pages * 100/page
// = 10,000 jobs, comfortably above any real Rippling tenant.
const MAX_PAGES_CAP = 100;

/** @param {import('./_types.js').PortalEntry} entry */
function resolveSlug(entry) {
  for (const url of [entry.api, entry.careers_url]) {
    if (typeof url !== 'string' || !url) continue;
    const m = url.match(RIPPLING_URL_RE);
    if (m) return m[1];
  }
  return null;
}

/** @param {any[]} locs */
function formatLocation(locs) {
  const parts = [];
  for (const loc of Array.isArray(locs) ? locs : []) {
    if (!loc || typeof loc !== 'object') continue;
    if (typeof loc.name === 'string' && loc.name.trim()) parts.push(loc.name.trim());
    const wt = typeof loc.workplaceType === 'string' ? loc.workplaceType.toLowerCase() : '';
    if (wt === 'remote' && !parts.some((p) => /remote/i.test(p))) parts.push('Remote');
  }
  return [...new Set(parts)].join(' · ');
}

/** @type {Provider} */
export default {
  id: 'rippling',

  detect(entry) {
    const slug = resolveSlug(entry);
    if (!slug) return null;
    return { url: `https://api.rippling.com/platform/api/ats/v2/board/${slug}/jobs?page=0&pageSize=${PAGE_SIZE}` };
  },

  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`rippling: cannot derive board slug for ${entry.name}`);
    const base = `https://api.rippling.com/platform/api/ats/v2/board/${slug}/jobs`;
    const headers = { accept: 'application/json', 'user-agent': BROWSER_LIKE_USER_AGENT };

    // Multi-location jobs repeat once per location, same id (confirmed
    // live) — merge locations into the first occurrence instead of
    // emitting duplicate job rows.
    /** @type {Map<string, any>} */
    const byId = new Map();
    let page = 0;
    let totalPages = 1;
    while (page < totalPages && page < MAX_PAGES_CAP) {
      const json = /** @type {any} */ (await ctx.fetchJson(
        `${base}?page=${page}&pageSize=${PAGE_SIZE}`,
        { headers, redirect: 'error' },
      ));
      const items = Array.isArray(json?.items) ? json.items : [];
      totalPages = Number.isInteger(json?.totalPages) && json.totalPages > 0 ? json.totalPages : 1;
      for (const item of items) {
        if (!item?.id || typeof item.name !== 'string' || !item.name.trim()) continue;
        const existing = byId.get(item.id);
        const locs = Array.isArray(item.locations) ? item.locations : [];
        if (existing) existing._locs.push(...locs);
        else byId.set(item.id, { ...item, _locs: [...locs] });
      }
      if (items.length === 0) break;
      page += 1;
    }

    return [...byId.values()]
      .map((item) => ({
        title: item.name,
        url: typeof item.url === 'string' ? item.url : '',
        company: entry.name,
        location: formatLocation(item._locs),
        postedAt: undefined,
      }))
      .filter((j) => j.title && j.url);
  },
};
