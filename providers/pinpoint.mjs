// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Pinpoint provider — hits the officially-documented public postings.json
// feed every Pinpoint-hosted careers site exposes for external embedding.
// Auto-detects from careers_url pattern `https://<subdomain>.pinpointhq.com`.
//
// Confirmed via Pinpoint's own docs (developers.pinpointhq.com/docs/
// jobs-json-endpoint, help.pinpoint.support/.../how-to-list-pinpoint-jobs-
// on-any-website) and against a real tenant: this is a public, keyless,
// CORS-open endpoint Pinpoint itself tells customers to use for listing
// their jobs on a third-party site — not an undocumented/reverse-engineered
// one, unlike several other ATS providers in this directory.
//
// No postedAt: the feed carries no publish/created timestamp field at all
// (confirmed against a real tenant's live response) — every job is undated,
// same convention as providers/bamboohr.mjs.
import { htmlToText } from './_html-to-text.mjs';

const PINPOINT_HOST_RE = /^([\w-]+)\.pinpointhq\.com$/;
// Pinpoint's own docs/support/app subdomains — never a tenant's job board.
const RESERVED_SUBDOMAINS = new Set(['www', 'developers', 'help', 'api', 'app']);

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  // Explicit api: wins — lets an entry keep a human-facing corporate
  // careers_url while still pinning the Pinpoint subdomain (mirrors
  // greenhouse/ashby precedence).
  for (const url of [entry.api, entry.careers_url]) {
    if (typeof url !== 'string' || !url) continue;
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    const m = parsed.hostname.toLowerCase().match(PINPOINT_HOST_RE);
    if (!m || RESERVED_SUBDOMAINS.has(m[1])) continue;
    return `https://${m[1]}.pinpointhq.com/postings.json`;
  }
  return null;
}

/** @param {any} loc */
function formatLocation(loc) {
  if (!loc || typeof loc !== 'object') return '';
  const parts = [];
  if (typeof loc.city === 'string' && loc.city.trim()) parts.push(loc.city.trim());
  if (typeof loc.province === 'string' && loc.province.trim() && loc.province.trim() !== loc.city) {
    parts.push(loc.province.trim());
  }
  // location.name carries a remote/region label distinct from the city
  // (confirmed live: {city: "London", name: "Remote"} on a fully-remote
  // posting whose office is nominally in London) — fold it in as "Remote"
  // rather than let it overwrite the real city.
  const isRemote = typeof loc.name === 'string' && /remote/i.test(loc.name);
  if (isRemote && !parts.some((p) => /remote/i.test(p))) parts.push('Remote');
  return [...new Set(parts)].join(', ');
}

/** @type {Provider} */
export default {
  id: 'pinpoint',

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`pinpoint: cannot derive postings.json URL for ${entry.name}`);
    const json = /** @type {any} */ (await ctx.fetchJson(apiUrl, { redirect: 'error' }));
    const postings = Array.isArray(json?.data) ? json.data : [];
    return postings
      .map(/** @param {any} p */ (p) => ({
        title: typeof p.title === 'string' ? p.title : '',
        url: typeof p.url === 'string' ? p.url : '',
        company: entry.name,
        location: formatLocation(p.location) || (/remote/i.test(p.workplace_type || '') ? 'Remote' : ''),
        description: htmlToText(p.key_responsibilities || p.skills_knowledge_expertise || ''),
        postedAt: undefined,
      }))
      .filter(/** @param {any} j */ (j) => j.title && j.url);
  },
};
