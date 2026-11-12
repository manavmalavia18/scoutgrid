import test from 'node:test';
import assert from 'node:assert/strict';
import { runLocalSmoke } from '../browser-lab/smoke.mjs';

test('browser lab visits only its own loopback fixture and parses job data', async () => {
  let visited = '';
  let closed = false;
  const launchBrowserFn = async () => ({
    newPage: async () => {
      let html, status;
      return {
        goto: async (url) => { visited = url; const response = await fetch(url); status = response.status; html = await response.text(); return { status: () => status }; },
        title: async () => html.match(/<title>(.*?)<\/title>/)?.[1] || '',
        content: async () => html,
        locator: () => ({ count: async () => 1, textContent: async () => html.match(/<div id="job-data">(.*?)<\/div>/)?.[1] }),
      };
    },
    close: async () => { closed = true; },
  });
  const result = await runLocalSmoke({ runtime: 'playwright', launchBrowserFn });
  assert.match(visited, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.deepEqual(result, { runtime: 'playwright', status: 200, classification: 'ok', count: 1, title: 'Local browser lab' });
  assert.equal(closed, true);
});
