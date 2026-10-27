import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// fetch-hiringcafe-feed.mjs calls main() unconditionally at module load
// (a real network scrape), so it can't be imported directly in a test —
// same constraint as lib/hiringcafe-http-blocked.mjs's extraction. This
// asserts the actual source text directly instead.
test('patchright per-query spawnSync timeout stays well under hc.yml/hc-data.yml\'s 25min job timeout', () => {
  const src = readFileSync(new URL('../fetch-hiringcafe-feed.mjs', import.meta.url), 'utf8');
  const m = src.match(/timeout:\s*(\d+)_?(\d*),\s*\n\s*\}\);\s*\n\s*if \(r\.stderr\)/);
  assert.ok(m, 'could not find the patchright spawnSync timeout value in fetch-hiringcafe-feed.mjs — check this test still matches the source shape');
  const timeoutMs = Number(m[1] + m[2]);
  // Confirmed live 2026-10-27: a 300_000 (5min) per-query ceiling, times
  // DEFAULT_HIRINGCAFE_QUERIES' 16 entries, let one slow cycle blow well
  // past hc.yml's 25min job timeout and lose the whole run (job-timeout
  // kills aren't a catchable JS error, unlike the per-query try/catch).
  // Even in the worst case where every query hits this ceiling, the total
  // must stay comfortably under 25 minutes.
  const MAX_QUERIES = 16;
  const worstCaseMinutes = (timeoutMs * MAX_QUERIES) / 60_000;
  assert.ok(
    worstCaseMinutes < 20,
    `per-query timeout ${timeoutMs}ms × ${MAX_QUERIES} queries = ${worstCaseMinutes.toFixed(1)} min worst case — too close to the 25min job timeout`,
  );
});
