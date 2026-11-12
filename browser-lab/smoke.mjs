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
    browser = await launchBrowserFn({ runtime });
    const page = await browser.newPage();
    const response = await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
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
    return { runtime, status, classification, count: data?.jobs?.length ?? 0, title };
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
