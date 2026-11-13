import { createServer } from 'node:http';
import { once } from 'node:events';
import { launchBrowser } from './adapter.mjs';
import { classifyBrowserPage } from './diagnostics.mjs';

/**
 * Optional, env-gated resource snapshot (process count, aggregate Chromium
 * RSS, approximate open-fd count, /tmp disk usage) — only emitted when
 * BROWSER_LAB_RESOURCE_PROFILE=1, so default smoke-test behavior and every
 * existing caller/test are unaffected. Added purely to gather real data for
 * a production-readiness review of the ~4-5-launches-per-job CI ceiling;
 * it reuses the single launch this script already does, adding zero new
 * browser launches.
 */
async function captureResourceSnapshot(label) {
  if (process.env.BROWSER_LAB_RESOURCE_PROFILE !== '1') return null;
  const { execSync } = await import('node:child_process');
  const run = (cmd) => {
    try { return execSync(cmd, { encoding: 'utf8', shell: '/bin/sh' }).trim(); }
    catch (err) { return `<error: ${err.message}>`; }
  };
  const snapshot = {
    label,
    processCount: run('ps -e | wc -l'),
    memFreeMb: run("free -m 2>/dev/null | awk '/Mem:/{print $4}' || echo n/a"),
    chromiumRssKb: run("ps -eo rss,comm | grep -i -E 'chrom|headless_shell' | awk '{sum+=$1} END {print sum+0}'"),
    openFdsApprox: run('(ls /proc/*/fd 2>/dev/null | wc -l) || echo n/a'),
    tmpDiskMb: run("du -sm /tmp 2>/dev/null | awk '{print $1}' || echo n/a"),
  };
  console.error(`[resource-profile] ${JSON.stringify(snapshot)}`);
  return snapshot;
}

/** A single local-only probe: no external URL input or production scraper import. */
export async function runLocalSmoke({ runtime = process.env.BROWSER_LAB_RUNTIME || 'playwright', launchBrowserFn = launchBrowser } = {}) {
  const server = createServer((_req, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Local browser lab</title><div id="job-data">{"jobs":[{"id":"fixture"}]}</div>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let browser;
  await captureResourceSnapshot('before_launch');
  try {
    const launchStarted = performance.now();
    browser = await launchBrowserFn({ runtime });
    const startupMs = performance.now() - launchStarted;
    await captureResourceSnapshot('after_launch');
    const page = await browser.newPage();
    const navigationStarted = performance.now();
    const response = await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
    const navigationMs = performance.now() - navigationStarted;
    const parsingStarted = performance.now();
    const status = response?.status() ?? null;
    const title = await page.title();
    const html = await page.content();
    const element = page.locator('#job-data');
    const dataPresent = await element.count() > 0;
    let data, parseError;
    if (dataPresent) {
      try { data = JSON.parse(await element.textContent()); }
      catch (error) { parseError = error; }
    }
    const classification = classifyBrowserPage({ status, title, html, dataPresent, dataValid: Array.isArray(data?.jobs), parseError });
    const domParseMs = performance.now() - parsingStarted;
    return { runtime, status, classification, count: data?.jobs?.length ?? 0, title,
      startupMs: Number(startupMs.toFixed(2)), navigationMs: Number(navigationMs.toFixed(2)), domParseMs: Number(domParseMs.toFixed(2)) };
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await new Promise((r) => setTimeout(r, 500)); // let the OS finish reaping before the "after_close" sample
    await captureResourceSnapshot('after_close');
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await runLocalSmoke();
  console.log(JSON.stringify(result));
  if (result.classification !== 'ok' || result.count !== 1) process.exitCode = 1;
}
