// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// UKG Pro Recruiting (formerly UltiPro) provider — hits the public, keyless
// JSON endpoint the hosted recruiting.ultipro.com career board uses
// client-side. Confirmed against multiple independent real tenants: no
// cookie, token, or prior page load is required for the list call.
//
// Auto-detects from careers_url pattern
// `https://recruiting[0-9]?.ultipro.(com|ca)/<tenant>/JobBoard/<boardId>`.
// Host is preserved as-is rather than normalized — public boards live on
// recruiting.ultipro.com, recruiting.ultipro.ca, and numbered variants
// (recruiting2/recruiting3), and the wrong host 404s.
import { BROWSER_LIKE_USER_AGENT } from './_http.mjs';

const ULTIPRO_URL_RE = /^https:\/\/(recruiting\d*\.ultipro\.(?:com|ca))\/([\w-]+)\/JobBoard\/([\w-]+)/i;

/** @param {import('./_types.js').PortalEntry} entry */
function resolveBoard(entry) {
  for (const url of [entry.api, entry.careers_url]) {
    if (typeof url !== 'string' || !url) continue;
    const m = url.match(ULTIPRO_URL_RE);
    if (m) return { host: m[1], tenant: m[2], boardId: m[3] };
  }
  return null;
}

/** @param {any} opp */
function formatLocation(opp) {
  // The list's Locations can be [null] on some boards (confirmed) — find
  // the first real entry rather than trusting index 0.
  const loc = Array.isArray(opp.Locations) ? opp.Locations.find((l) => l) : null;
  if (!loc) return '';
  if (typeof loc.LocalizedDescription === 'string' && loc.LocalizedDescription.trim()) {
    return loc.LocalizedDescription.trim();
  }
  const addr = loc.Address || {};
  const parts = [addr.City, addr.State, addr.Country?.Name].filter(
    (v) => typeof v === 'string' && v.trim(),
  );
  return parts.join(', ');
}

/** @param {any} opp */
function postedAtMs(opp) {
  const ms = Date.parse(opp?.PostedDate || '');
  return Number.isFinite(ms) ? ms : undefined;
}

/** @type {Provider} */
export default {
  id: 'ultipro',

  detect(entry) {
    const board = resolveBoard(entry);
    if (!board) return null;
    return { url: `https://${board.host}/${board.tenant}/JobBoard/${board.boardId}/JobBoardView/LoadSearchResults` };
  },

  async fetch(entry, ctx) {
    const board = resolveBoard(entry);
    if (!board) throw new Error(`ultipro: cannot derive tenant/board for ${entry.name}`);
    const api = `https://${board.host}/${board.tenant}/JobBoard/${board.boardId}/JobBoardView/LoadSearchResults`;
    const detailBase = `https://${board.host}/${board.tenant}/JobBoard/${board.boardId}/OpportunityDetail`;
    const body = JSON.stringify({
      opportunitySearch: {
        // Confirmed uncapped against real boards (a 254-job board and a
        // 388-job board both returned their full set in one request,
        // set-identical to the paged union) — no pagination loop needed,
        // unlike workday's fixed PAGE_SIZE.
        Top: 2000,
        Skip: 0,
        QueryString: '',
        OrderBy: [{ Value: 'postedDateDesc', PropertyName: 'PostedDate', Ascending: false }],
      },
    });
    const json = /** @type {any} */ (await ctx.fetchJson(api, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': BROWSER_LIKE_USER_AGENT,
      },
      body,
    }));
    const opportunities = Array.isArray(json?.opportunities) ? json.opportunities : [];
    return opportunities
      .map((opp) => ({
        title: typeof opp.Title === 'string' ? opp.Title : '',
        url: opp.Id ? `${detailBase}?opportunityId=${opp.Id}` : '',
        company: entry.name,
        location: formatLocation(opp),
        postedAt: postedAtMs(opp),
      }))
      .filter((j) => j.title && j.url);
  },
};
