/**
 * Classifies errors from the HTTP-first HiringCafe fetch (providers/hiringcafe.mjs
 * via providers/_http.mjs's fetchWithTimeout) as "treat like a Cloudflare block,
 * fall back to patchright headed Chrome" vs. "real bug, let it crash the run".
 *
 * Split out from fetch-hiringcafe-feed.mjs (which calls `main()` unconditionally
 * at module load, so it can't be imported in a test) so this classification logic
 * is independently unit-testable.
 */

/**
 * A fetch that times out/aborts must be treated the same as an explicit
 * Cloudflare block, not rethrown. Confirmed live (2026-10-24 .. 2026-10-26):
 * routing through the Tailscale residential exit node occasionally stalls the
 * plain HTTP request well past providers/_http.mjs's 10s default timeout, which
 * surfaces as `DOMException [AbortError]: This operation was aborted` — not an
 * HTTP 403 and not any Cloudflare challenge string. Before this fix that error
 * didn't match httpLooksBlocked() at all, so it was rethrown and crashed the
 * whole hc.yml/hc-data.yml run instead of falling back to the headed-browser
 * path (which doesn't share the same 10s ceiling and generally succeeds).
 */
export function httpLooksBlocked(err) {
  const blob = `${err?.status || ''} ${err?.message || ''} ${err?.body || ''}`;
  const causeBlob = `${err?.cause?.message || ''} ${err?.cause?.code || ''}`;
  return err?.status === 403
    || err?.name === 'AbortError'
    || /just a moment|cf-chl|challenge-platform|attention required|unexpected redirect|fetch failed/i.test(blob)
    // Generic "timeout" wording is only trusted off err.cause (actual network
    // error codes like ETIMEDOUT/ECONNABORTED/ECONNRESET), never off a bare
    // err.message/err.body match — an unrelated application error ("database
    // query timeout", some upstream API's error text) could otherwise contain
    // "timeout" and get silently misclassified as a transient block.
    || /timed? ?out|ETIMEDOUT|ECONNABORTED|ECONNRESET/i.test(causeBlob);
}
