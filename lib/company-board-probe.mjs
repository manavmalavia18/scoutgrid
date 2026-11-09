// Pure, testable logic for probe-company-boards.mjs — company-name →
// candidate-slug generation, cooldown/skip decisions, and ATS-response
// parsing. The actual network fetching stays in the thin orchestration
// script so this file can be unit tested without hitting real APIs.
//
// Design note (why this exists): fetch-linkedin-feed.py's own job_url is
// always a linkedin.com page — it can never resolve to a known ATS board
// no matter what. job_url_direct (the employer's real apply link) turned
// out to be a dead end at the jobspy-library level (confirmed live
// 2026-10-28, speedyapply/JobSpy#370 still open). This is the alternative:
// take the COMPANY NAME LinkedIn gave us, mechanically derive a few
// plausible ATS slugs, and ask Greenhouse/Ashby/Lever's own public APIs
// directly whether that slug is real — never fabricate/trust a guess
// blind, only keep a slug the API itself confirms with a real, non-empty
// job list. Confirmed live against real companies 2026-10-28: resolves a
// genuine minority (ClickHouse -> Ashby, a16z -> Greenhouse) — mostly
// startups/mid-size companies on these 3 platforms. Large enterprises
// (Atlassian, Humana, Citi, Deloitte, GM) are usually on Workday or a
// custom system this can't guess, and correctly stay unresolved rather
// than risk a wrong match.

const LEGAL_SUFFIX_RE = /\b(inc|llc|corp|corporation|co|ltd|group|technologies|technology|holdings)\b\.?/gi;

/** Mechanically derived slug candidates — no hand-picked abbreviations. */
export function slugCandidates(name) {
  const base = String(name || '').replace(LEGAL_SUFFIX_RE, '').trim();
  if (!base) return [];
  const noSep = base.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const hyphen = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const firstWord = (base.split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return [...new Set([noSep, hyphen, firstWord].filter((s) => s.length >= 2))];
}

export function companyKeyOf(name) {
  return String(name || '').trim().toLowerCase();
}

/**
 * True when this company is worth spending a live probe on this run.
 * Skips anything already tracked some other way, already resolved by a
 * prior probe run, or exhausted (tried, found nothing) within the cooldown
 * window — exhausted companies DO get retried eventually since a company
 * might register a real board later.
 */
export function shouldProbe(companyName, { trackedNames, state, now = Date.now(), cooldownMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const key = companyKeyOf(companyName);
  if (!key) return false;
  if (trackedNames?.has(key)) return false;
  const prior = state?.[key];
  if (!prior) return true;
  if (prior.status === 'resolved') return false;
  if (prior.status === 'exhausted') {
    const probedAt = Date.parse(prior.probedAt || '');
    if (!Number.isFinite(probedAt)) return true;
    return now - probedAt >= cooldownMs;
  }
  return true;
}

/**
 * Greenhouse/Ashby return {jobs:[...]}; Lever returns a bare array.
 * Require a REAL non-empty list before trusting a slug — some ATS hosts
 * 200 an empty/placeholder board for any slug, which would otherwise look
 * like a false-positive match.
 */
export function jobCountFromAtsBody(body) {
  if (!body) return 0;
  if (Array.isArray(body)) return body.length;
  if (Array.isArray(body.jobs)) return body.jobs.length;
  return 0;
}

export function atsCandidateUrls(slug) {
  return [
    { ats: 'greenhouse', apiUrl: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, boardUrl: `https://job-boards.greenhouse.io/${slug}` },
    { ats: 'ashby', apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${slug}`, boardUrl: `https://jobs.ashbyhq.com/${slug}` },
    { ats: 'lever', apiUrl: `https://api.lever.co/v0/postings/${slug}?mode=json`, boardUrl: `https://jobs.lever.co/${slug}` },
  ];
}

export function boardToTrackedCompanyYaml(name, match) {
  return [
    `  - name: ${JSON.stringify(name)}`,
    `    careers_url: ${match.boardUrl}`,
    `    provider: ${match.ats}`,
    `    enabled: true`,
    `    notes: auto-discovered via company-name board probe (LinkedIn lead, ${match.jobCount} live jobs confirmed)`,
  ].join('\n');
}

/**
 * Same insert-before-next-top-level-key logic as discover-boards.mjs —
 * duplicated rather than imported so this unrelated script change can
 * never regress that already-tested file.
 */
export function insertTrackedCompanies(portalsText, blocks) {
  if (!blocks.length) return portalsText;
  const block = `${blocks.join('\n')}\n`;
  const headerMatch = portalsText.match(/^tracked_companies:\s*$/m);
  if (!headerMatch) throw new Error('tracked_companies: key not found in portals.yml');
  const afterHeader = headerMatch.index + headerMatch[0].length;
  const nextKeyMatch = portalsText.slice(afterHeader).match(/\n[A-Za-z_][\w-]*:/);
  const insertAt = nextKeyMatch ? afterHeader + nextKeyMatch.index + 1 : portalsText.length;
  const before = portalsText.slice(0, insertAt);
  const after = portalsText.slice(insertAt);
  const sep = before.endsWith('\n') ? '' : '\n';
  return `${before}${sep}${block}${after}`;
}
