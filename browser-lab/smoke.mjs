import { createServer } from 'node:http';
import { once } from 'node:events';
import { launchBrowser } from './adapter.mjs';
import { classifyBrowserPage } from './diagnostics.mjs';

/** A single local-only probe: no external URL input or production scraper import. */
export async function runLocalSmoke({ runtime = process.env.BROWSER_LAB_RUNTIME || 'playwright', launchBrowserFn = launchBrowser } = {}) {
  const server = createServer((_req, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Local browser lab</title><div id="job-data">{"jobs":[{"id":"fixture"}]}</div>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let browser;
  try {
    const launchStarted = performance.now();
    browser = await launchBrowserFn({ runtime });
    const startupMs = performance.now() - launchStarted;
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
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await runLocalSmoke();
  console.log(JSON.stringify(result));
  if (result.classification !== 'ok' || result.count !== 1) process.exitCode = 1;
}
