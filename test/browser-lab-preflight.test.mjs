import test from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight, isPreflightFailure } from '../browser-lab/preflight.mjs';

test('license_missing when no key is present — no install or launch is attempted', async () => {
  let ensureBinaryCalled = false;
  let launchCalled = false;
  const result = await runPreflight({
    licenseKey: '',
    cloakBrowser: {
      ensureBinary: async () => { ensureBinaryCalled = true; return '/fake'; },
      binaryInfo: () => ({ version: null }),
      buildLaunchOptions: async () => ({}),
    },
    playwrightCore: { chromium: { launch: async () => { launchCalled = true; return { close: async () => {} }; } } },
  });
  assert.equal(result.status, 'license_missing');
  assert.equal(result.licensePresent, false);
  assert.equal(ensureBinaryCalled, false, 'install must never be attempted without a license');
  assert.equal(launchCalled, false, 'launch must never be attempted without a license');
  assert.equal(isPreflightFailure(result.status), false);
});

test('install_failed when ensureBinary throws — launch is never attempted', async () => {
  let launchCalled = false;
  const result = await runPreflight({
    licenseKey: 'test-key',
    cloakBrowser: {
      ensureBinary: async () => { throw new Error('network unreachable'); },
      binaryInfo: () => ({ version: null }),
      buildLaunchOptions: async () => ({}),
    },
    playwrightCore: { chromium: { launch: async () => { launchCalled = true; return { close: async () => {} }; } } },
  });
  assert.equal(result.status, 'install_failed');
  assert.equal(result.installAttempted, true);
  assert.equal(result.installOk, false);
  assert.match(result.installError, /network unreachable/);
  assert.equal(launchCalled, false, 'launch must never be attempted after a failed install');
  assert.equal(isPreflightFailure(result.status), true);
});

test('binary_missing when install reports success but the binary still is not on disk', async () => {
  let launchCalled = false;
  const result = await runPreflight({
    licenseKey: 'test-key',
    cloakBrowser: {
      ensureBinary: async () => '/fake/path',
      binaryInfo: () => ({ version: null }),
      buildLaunchOptions: async () => ({}),
    },
    playwrightCore: { chromium: { launch: async () => { launchCalled = true; return { close: async () => {} }; } } },
  });
  assert.equal(result.status, 'binary_missing');
  assert.equal(result.installOk, true);
  assert.equal(result.binaryPresentAfter, false);
  assert.equal(launchCalled, false, 'launch must never be attempted when the binary is still missing');
  assert.equal(isPreflightFailure(result.status), true);
});

test('launch_failed when the binary is installed but chromium.launch() throws', async () => {
  const result = await runPreflight({
    licenseKey: 'test-key',
    cloakBrowser: {
      ensureBinary: async () => '/fake/path',
      binaryInfo: () => ({ version: '1.2.3' }),
      buildLaunchOptions: async (options) => ({ ...options, executablePath: '/fake/chrome' }),
    },
    playwrightCore: { chromium: { launch: async () => { throw new Error('target closed unexpectedly'); } } },
  });
  assert.equal(result.status, 'launch_failed');
  assert.equal(result.launchAttempted, true);
  assert.equal(result.launchOk, false);
  assert.match(result.launchError, /target closed unexpectedly/);
  assert.equal(isPreflightFailure(result.status), true);
});

test('ok end to end — license present, binary installs, browser launches and closes', async () => {
  let closed = false;
  let installed = false;
  const result = await runPreflight({
    licenseKey: 'test-key',
    cloakBrowser: {
      ensureBinary: async () => { installed = true; return '/fake/path'; },
      binaryInfo: () => ({ version: installed ? '1.2.3' : null }),
      buildLaunchOptions: async (options) => {
        assert.deepEqual(options, { headless: true, licenseKey: 'test-key' });
        return { executablePath: '/fake/chrome', headless: true };
      },
    },
    playwrightCore: {
      chromium: {
        launch: async () => ({ close: async () => { closed = true; } }),
      },
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.binaryPresentBefore, false);
  assert.equal(result.binaryPresentAfter, true);
  assert.equal(result.launchOk, true);
  assert.equal(closed, true, 'the launched browser must be closed, never left running');
  assert.equal(isPreflightFailure(result.status), false);
});

test('a launched browser is closed even when binaryInfo() throws on the pre-install check', async () => {
  // binaryInfo() can throw on a cold cache dir — must not crash the
  // preflight or skip the install attempt.
  let closed = false;
  const result = await runPreflight({
    licenseKey: 'test-key',
    cloakBrowser: {
      ensureBinary: async () => '/fake/path',
      binaryInfo: () => { throw new Error('no cache dir yet'); },
      buildLaunchOptions: async () => ({}),
    },
    playwrightCore: { chromium: { launch: async () => ({ close: async () => { closed = true; } }) } },
  });
  // binaryInfo() throwing both before AND after install means
  // binaryPresentAfter resolves false -> binary_missing, not a crash.
  assert.equal(result.status, 'binary_missing');
  assert.equal(result.binaryPresentBefore, false);
  assert.equal(closed, false, 'launch is never reached once binary_missing is determined');
});

test('a browser is still closed even if close() itself throws', async () => {
  const result = await runPreflight({
    licenseKey: 'test-key',
    cloakBrowser: {
      ensureBinary: async () => '/fake/path',
      binaryInfo: () => ({ version: '1.2.3' }),
      buildLaunchOptions: async () => ({}),
    },
    playwrightCore: {
      chromium: {
        launch: async () => ({ close: async () => { throw new Error('already closed'); } }),
      },
    },
  });
  // The close() failure must not surface as the preflight's own status —
  // the launch itself succeeded.
  assert.equal(result.status, 'ok');
});
