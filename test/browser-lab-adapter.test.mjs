import test from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from '../browser-lab/adapter.mjs';

const fakeBrowser = { close() {} };

test('standard runtime launches Playwright Chromium with ordinary options', async () => {
  const calls = [];
  const browser = await launchBrowser({ runtime: 'playwright', playwrightCore: { chromium: { launch: async (options) => { calls.push(options); return fakeBrowser; } } } });
  assert.equal(browser, fakeBrowser);
  assert.deepEqual(calls, [{ headless: true }]);
});

test('CloakBrowser runtime passes its complete launch options to Playwright without HC integration', async () => {
  const calls = [];
  const cloakOptions = { executablePath: '/fixture/chromium', args: ['--fixture'], ignoreDefaultArgs: ['--fixture-default'], env: { FIXTURE: '1' }, headless: true };
  const browser = await launchBrowser({
    runtime: 'cloakbrowser', licenseKey: 'test-only',
    cloakBrowser: { buildLaunchOptions: async (options) => { assert.deepEqual(options, { headless: true, licenseKey: 'test-only' }); return cloakOptions; } },
    playwrightCore: { chromium: { launch: async (options) => { calls.push(options); return fakeBrowser; } } },
  });
  assert.equal(browser, fakeBrowser);
  assert.deepEqual(calls, [cloakOptions]);
});

test('CloakBrowser fails before download when license is unavailable', async () => {
  await assert.rejects(() => launchBrowser({ runtime: 'cloakbrowser', licenseKey: '' }), /CLOAKBROWSER_LICENSE_KEY/);
});

test('unknown runtimes fail closed', async () => {
  await assert.rejects(() => launchBrowser({ runtime: 'unexpected' }), /Unsupported browser runtime/);
});
