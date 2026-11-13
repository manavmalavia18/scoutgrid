import test from 'node:test';
import assert from 'node:assert/strict';
import { launchCdpBridge, CdpBridgeError, pickEphemeralPort, waitForCdpReady } from '../browser-lab/cdp-bridge.mjs';

function fakeDeps({ launchImpl, buildLaunchOptionsImpl } = {}) {
  const closeCalls = [];
  const fakeBrowser = { close: async () => { closeCalls.push(true); } };
  return {
    closeCalls,
    fakeBrowser,
    cloakBrowser: {
      buildLaunchOptions: buildLaunchOptionsImpl || (async (options) => ({ ...options, executablePath: '/fake/chrome', args: ['--fake-stealth-flag'] })),
    },
    playwrightCore: {
      chromium: {
        launch: launchImpl || (async () => fakeBrowser),
      },
    },
  };
}

test('fails before any launch attempt when no license key is present', async () => {
  let launchCalled = false;
  const { cloakBrowser, playwrightCore } = fakeDeps({ launchImpl: async () => { launchCalled = true; return {}; } });
  await assert.rejects(
    () => launchCdpBridge({ licenseKey: '', cloakBrowser, playwrightCore }),
    CdpBridgeError,
  );
  assert.equal(launchCalled, false);
});

test('merges a loopback-only --remote-debugging-port/address into the launch args, on the picked ephemeral port', async () => {
  let seenOptions;
  const { cloakBrowser, playwrightCore } = fakeDeps({
    launchImpl: async (options) => { seenOptions = options; return { close: async () => {} }; },
  });
  const bridge = await launchCdpBridge({
    licenseKey: 'test-key',
    cloakBrowser,
    playwrightCore,
    pickPort: async () => 54321,
    waitForReady: async () => true,
  });
  assert.equal(bridge.port, 54321);
  assert.equal(bridge.cdpUrl, 'http://127.0.0.1:54321');
  assert.ok(seenOptions.args.includes('--remote-debugging-port=54321'));
  assert.ok(seenOptions.args.includes('--remote-debugging-address=127.0.0.1'));
  // The vendor's own stealth arg must survive unchanged alongside the new ones.
  assert.ok(seenOptions.args.includes('--fake-stealth-flag'));
  await bridge.close();
});

test('close() is idempotent — the underlying browser.close() runs exactly once', async () => {
  const { cloakBrowser, playwrightCore, closeCalls } = fakeDeps();
  const bridge = await launchCdpBridge({
    licenseKey: 'test-key', cloakBrowser, playwrightCore,
    pickPort: async () => 1, waitForReady: async () => true,
  });
  await bridge.close();
  await bridge.close();
  await bridge.close();
  assert.equal(closeCalls.length, 1);
});

test('a launch failure surfaces as CdpBridgeError with a sanitized message (no license key echoed)', async () => {
  const { cloakBrowser, playwrightCore } = fakeDeps({
    launchImpl: async () => { throw new Error('spawn ENOENT: /fake/chrome'); },
  });
  await assert.rejects(
    () => launchCdpBridge({ licenseKey: 'super-secret-key', cloakBrowser, playwrightCore, pickPort: async () => 1 }),
    (err) => {
      assert.ok(err instanceof CdpBridgeError);
      assert.doesNotMatch(err.message, /super-secret-key/);
      assert.match(err.message, /spawn ENOENT/);
      return true;
    },
  );
});

test('a CDP endpoint that never becomes ready (e.g. a port conflict) closes the browser before rethrowing', async () => {
  const { cloakBrowser, playwrightCore, closeCalls } = fakeDeps();
  await assert.rejects(
    () => launchCdpBridge({
      licenseKey: 'test-key', cloakBrowser, playwrightCore,
      pickPort: async () => 9999,
      waitForReady: async () => { throw new CdpBridgeError('CDP endpoint on 127.0.0.1:9999 never became ready: port already in use'); },
    }),
    CdpBridgeError,
  );
  assert.equal(closeCalls.length, 1, 'the browser launched before the readiness check must still be closed on failure');
});

test('waitForCdpReady resolves once a fake endpoint answers 200, and times out cleanly otherwise', async () => {
  let callCount = 0;
  const okAfterTwoTries = async () => {
    callCount += 1;
    if (callCount < 2) throw new Error('ECONNREFUSED');
    return { ok: true };
  };
  await waitForCdpReady(12345, { fetchImpl: okAfterTwoTries, intervalMs: 1 });
  assert.equal(callCount, 2);

  await assert.rejects(
    () => waitForCdpReady(12346, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, timeoutMs: 50, intervalMs: 10 }),
    CdpBridgeError,
  );
});

test('pickEphemeralPort returns a real, currently-free loopback port', async () => {
  const port = await pickEphemeralPort();
  assert.equal(typeof port, 'number');
  assert.ok(port > 0 && port < 65536);
});
