import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../browser-lab/adapter.mjs';

/**
 * Phase 3 compatibility check: does a CloakBrowser-launched page expose the
 * same method surface browser_runtime.py's BrowserSession ABC requires
 * (goto/content/title/wait_for_selector/close), against the EXACT page
 * shape scrape-hiringcafe.py parses (the same __NEXT_DATA__/apply_url
 * fixture used by test/fixtures/hc_local_server.py and the real-browser
 * Patchright smoke tests) — never hiringcafe.com itself.
 *
 * This proves JS-side API compatibility only. It does NOT attempt, and
 * cannot stand in for, a cross-language bridge into the Python
 * BrowserRuntime/BrowserSession interface — see the Phase 3 readiness
 * report in browser-lab/README.md for why that gap is still open.
 */
const fixtureServer = fileURLToPath(new URL('./fixtures/hc_local_server.py', import.meta.url));
const licenseKey = process.env.CLOAKBROWSER_LICENSE_KEY || '';
const skip = licenseKey ? false : 'CLOAKBROWSER_LICENSE_KEY not set — see browser-lab/README.md';

async function withFixtureServer(fn) {
  const server = spawn('python3', [fixtureServer, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/^(\d+)/);
      if (m) { server.stdout.off('data', onData); resolve(Number(m[1])); }
    };
    server.stdout.on('data', onData);
    server.once('error', reject);
    setTimeout(() => reject(new Error('fixture server did not report a port in time')), 5000);
  });
  try {
    return await fn(port);
  } finally {
    server.kill();
  }
}

/** Exactly the extraction scrape-hiringcafe.py's props_from_html() does,
 * mirrored here in JS so the comparison is apples-to-apples. */
function extractHits(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s.exec(html);
  if (!m) return null;
  const parsed = JSON.parse(m[1]);
  return parsed.props.pageProps.ssrHits;
}

for (const runtime of ['playwright', 'cloakbrowser']) {
  test(`${runtime}: a launched page satisfies BrowserSession's method surface against an HC-shaped fixture`, { skip: runtime === 'cloakbrowser' ? skip : false }, async () => {
    await withFixtureServer(async (port) => {
      const browser = await launchBrowser({ runtime, licenseKey });
      try {
        const page = await browser.newPage();
        // goto() -> status
        const response = await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
        assert.equal(response.status(), 200);
        // wait_for_selector() equivalent
        await page.waitForSelector('#__NEXT_DATA__', { state: 'attached', timeout: 10000 });
        // title()
        assert.equal(await page.title(), 'Fixture Jobs');
        // content() -> the exact production parsing path
        const html = await page.content();
        const hits = extractHits(html);
        assert.equal(Array.isArray(hits), true);
        assert.equal(hits.length, 2);
        assert.deepEqual(
          hits.map((h) => h.apply_url).sort(),
          ['https://fixture.test/jobs/1', 'https://fixture.test/jobs/2'],
        );
        // close() equivalent (via the page's own context; adapter.mjs's
        // Browser-level close() is exercised in the finally block below)
        await page.close();
      } finally {
        await browser.close();
      }
    });
  });
}

test('environment note: whether the CloakBrowser compatibility check actually ran', () => {
  if (skip) {
    console.log(`[hc-shaped-fixture-compat] CloakBrowser case SKIPPED — ${skip}`);
  } else {
    console.log('[hc-shaped-fixture-compat] CloakBrowser case RAN against a real licensed binary');
  }
  assert.ok(true);
});
