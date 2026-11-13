// Sanitized diagnostic capture for the first blocked HiringCafe response in
// a scan cycle. Never includes cookies, auth/session/license material, or
// raw page content — only a small header allowlist, HTTP status, a
// best-effort classification, a timestamp, and the GitHub Actions run ID.
//
// Classification distinguishes a Cloudflare managed challenge, a classic
// JS challenge, and a plain static 403 ONLY when the in-memory evidence
// (status + sanitized headers + a short marker string such as a page
// title) actually supports it — anything else reports 'unknown' rather
// than guessing. This module never attempts to solve, bypass, or evade any
// challenge; it only describes what was already observed.

const ALLOWED_HEADER_NAMES = Object.freeze([
  'server',
  'cf-ray',
  'cf-mitigated',
  'cf-cache-status',
  'content-type',
  'date',
  'via',
  'retry-after',
]);

// Defense in depth: even if ALLOWED_HEADER_NAMES were ever extended by
// mistake to include something sensitive, this denylist still blocks it.
const FORBIDDEN_HEADER_PATTERN = /cookie|auth|token|session|secret|license|credential/i;

const MAX_HEADER_VALUE_LEN = 200;

/** Picks only allowlisted, non-secret headers from a Headers-like object,
 * a plain object, or an iterable of [key, value] pairs. Every value is
 * length-capped so a hostile/oversized header can't balloon the stored
 * diagnostic. */
export function sanitizeHeaders(headersLike) {
  const out = {};
  if (!headersLike) return out;
  const entries = typeof headersLike.entries === 'function'
    ? Array.from(headersLike.entries())
    : Object.entries(headersLike);
  for (const [rawKey, rawVal] of entries) {
    const key = String(rawKey).toLowerCase();
    if (FORBIDDEN_HEADER_PATTERN.test(key)) continue;
    if (!ALLOWED_HEADER_NAMES.includes(key)) continue;
    out[key] = String(rawVal).slice(0, MAX_HEADER_VALUE_LEN);
  }
  return out;
}

/**
 * Classify a blocked response from already-in-memory, non-secret evidence
 * only: HTTP status, sanitized headers, and a short marker string (e.g. a
 * page title — never the full response body). Returns one of
 * 'cloudflare_managed_challenge', 'cloudflare_js_challenge',
 * 'cloudflare_static_403', 'http_403_unspecified', or 'unknown'. Falls
 * back to 'unknown' whenever the evidence doesn't clearly support a finer
 * label — this function must never guess.
 */
export function classifyBlockedResponse({ status, headers = {}, markerText = '' } = {}) {
  const marker = String(markerText || '').toLowerCase();
  const serverIsCloudflare = /cloudflare/i.test(headers.server || '') || Boolean(headers['cf-ray']);

  const looksLikeJsChallenge = /jschl|__cf_chl_jschl|cf_chl_jschl_tk/i.test(marker);
  const looksLikeManagedChallenge = /just a moment|cf-chl-widget|challenge-platform|managed challenge/i.test(marker)
    || String(headers['cf-mitigated'] || '').toLowerCase() === 'challenge';

  if (status === 403 && serverIsCloudflare && looksLikeJsChallenge) return 'cloudflare_js_challenge';
  if (status === 403 && serverIsCloudflare && looksLikeManagedChallenge) return 'cloudflare_managed_challenge';
  if (status === 403 && serverIsCloudflare) return 'cloudflare_static_403';
  if (status === 403) return 'http_403_unspecified';
  return 'unknown';
}

/**
 * Builds the full sanitized diagnostic object to persist in the heartbeat.
 * `markerText` is used only to compute `classification` — it is never
 * itself included in the returned object, satisfying "never log
 * unnecessary page content".
 */
export function buildBlockedDiagnostic({
  status,
  headers,
  markerText,
  at = new Date().toISOString(),
  workflowRunId = process.env.GITHUB_RUN_ID || null,
} = {}) {
  const sanitizedHeaders = sanitizeHeaders(headers);
  return {
    at,
    status: typeof status === 'number' ? status : null,
    classification: classifyBlockedResponse({ status, headers: sanitizedHeaders, markerText }),
    workflowRunId,
    headers: sanitizedHeaders,
  };
}
