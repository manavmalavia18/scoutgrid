// Pure, testable logic for grounding a Workday offer's cheap list-level
// postedAt badge against the real per-job detail-page date before it's
// written to scan-history. The actual network fetch is injected so this
// can be unit tested without hitting Workday's API.
//
// Why this exists: providers/workday.mjs's own comments already explain
// the underlying problem — Workday's list API only exposes a relative
// "postedOn" label ("Posted Today", "Posted 5 Days Ago") that RESETS on
// every re-crawl, and sometimes isn't present at all. The real date lives
// on the job-detail page (startDate) and providers/workday.mjs already
// exports fetchWorkdayJobPostedAt() to fetch it — it was just never wired
// into the main tracked-boards scan, only into the much smaller JobRight-
// lead-promotion path (lib/jr-board-leads.mjs). Confirmed live 2026-10-30:
// a genuinely 15-day-old Zoom posting (per Zoom's own job-detail page)
// showed as "just now" on the dashboard because the list API returned no
// postedOn label at all for it, leaving posted_at empty and the UI falling
// back to first_seen (today, since it was scoutgrid's first time seeing
// that URL).
//
// Scoped to brand-new ("added") offers only, not every Workday job on
// every scan cycle — that would be one extra HTTP request per Workday
// posting in the ENTIRE tracked-company universe, every 15 minutes. New
// offers per cycle is a much smaller, bounded number.

const WORKDAY_HOST_RE = /\.myworkdayjobs\.com$/i;

export function isWorkdayOffer(offer) {
  if (!offer || typeof offer.url !== 'string') return false;
  if (offer.source === 'workday-api') return true;
  try {
    return WORKDAY_HOST_RE.test(new URL(offer.url).hostname);
  } catch {
    return false;
  }
}

/**
 * Mutates and returns `offers`: for each Workday offer, replaces its
 * list-level postedAt with the real job-detail date when the fetch
 * succeeds. Fails OPEN per-job — a failed/timed-out detail fetch leaves
 * that offer's existing postedAt (possibly already undefined) untouched
 * rather than losing date info the list API did manage to provide.
 *
 * @param {Array<object>} offers
 * @param {(url: string) => Promise<number|undefined>} fetchDetailPostedAt
 * @param {{ concurrency?: number }} [opts]
 * @returns {Promise<{ offers: Array<object>, grounded: number, attempted: number }>}
 */
export async function groundWorkdayPostedDates(offers, fetchDetailPostedAt, { concurrency = 5 } = {}) {
  const targets = offers.filter(isWorkdayOffer);
  let grounded = 0;
  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const offer = targets[i];
      i += 1;
      try {
        const detailMs = await fetchDetailPostedAt(offer.url);
        if (typeof detailMs === 'number' && Number.isFinite(detailMs)) {
          offer.postedAt = detailMs;
          grounded += 1;
        }
      } catch {
        // fail open — keep whatever postedAt (if any) the list API gave this offer
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, targets.length));
  await Promise.all(Array.from({ length: n }, worker));
  return { offers, grounded, attempted: targets.length };
}
