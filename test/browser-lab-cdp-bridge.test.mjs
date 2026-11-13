import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { launchCdpBridge, CdpBridgeError, pickEphemeralPort, waitForCdpReady } from '../browser-lab/cdp-bridge.mjs';

function fakeBrowserFactory({ closeImpl, killImpl } = {}) {
  const emitter = new EventEmitter();
  const killCalls = [];
  const closeCalls = [];
  const fakeProcess = {
    kill: (signal) => { killCalls.push(signal); if (killImpl) killImpl(signal); },
  };
  const browser = Object.assign(emitter, {
    close: async () => { closeCalls.push(true); if (closeImpl) return closeImpl(); },
    process: () => fakeProcess,
  });
  return { browser, killCalls, closeCalls };
}

function fakeDeps({ launchImpl, buildLaunchOptionsImpl } = {}) {
  const { browser: fakeBrowser, killCalls, closeCalls } = fakeBrowserFactory();
  return {
    closeCalls,
    killCalls,
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

test('merges a loopback-only --remote-debugging-port/address into the launch args, never --user-data-dir (Playwright rejects it — caught by a real CI run)', async () => {
  let seenOptions;
  const deps = fakeDeps({
    launchImpl: async (options) => { seenOptions = options; return deps.fakeBrowser; },
  });
  const bridge = await launchCdpBridge({
    licenseKey: 'test-key',
    ...deps,
    pickPort: async () => 54321,
    waitForReady: async () => true,
  });
  assert.equal(bridge.port, 54321);
  assert.equal(bridge.cdpUrl, 'http://127.0.0.1:54321');
  assert.ok(seenOptions.args.includes('--remote-debugging-port=54321'));
  assert.ok(seenOptions.args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(!seenOptions.args.some((a) => a.startsWith('--user-data-dir=')));
  // The vendor's own stealth arg must survive unchanged alongside the new ones.
  assert.ok(seenOptions.args.includes('--fake-stealth-flag'));
  await bridge.close();
});

test('close() is idempotent — the underlying browser.close() runs exactly once', async () => {
  const deps = fakeDeps();
  const bridge = await launchCdpBridge({
    licenseKey: 'test-key', ...deps,
    pickPort: async () => 1, waitForReady: async () => true,
  });
  await bridge.close();
  await bridge.close();
  await bridge.close();
  assert.equal(deps.closeCalls.length, 1);
});

test('close() force-kills the underlying process via SIGKILL if browser.close() hangs past the timeout', async () => {
  const { browser, killCalls } = fakeBrowserFactory({
    closeImpl: () => new Promise(() => {}), // never resolves — simulates a hung close()
  });
  const deps = fakeDeps({ launchImpl: async () => browser });
  const bridge = await launchCdpBridge({
    licenseKey: 'test-key', ...deps,
    pickPort: async () => 1, waitForReady: async () => true,
  });
  await bridge.close({ killTimeoutMs: 20 });
  assert.deepEqual(killCalls, ['SIGKILL']);
});

test('a launch failure surfaces as CdpBridgeError with a sanitized message (no license key echoed)', async () => {
  const deps = fakeDeps({
    launchImpl: async () => { throw new Error('spawn ENOENT: /fake/chrome'); },
  });
  await assert.rejects(
    () => launchCdpBridge({ licenseKey: 'super-secret-key', ...deps, pickPort: async () => 1 }),
    (err) => {
      assert.ok(err instanceof CdpBridgeError);
      assert.doesNotMatch(err.message, /super-secret-key/);
      assert.match(err.message, /spawn ENOENT/);
      return true;
    },
  );
});

test('a CDP endpoint that never becomes ready (e.g. a port conflict) closes the browser before rethrowing', async () => {
  const deps = fakeDeps();
  await assert.rejects(
    () => launchCdpBridge({
      licenseKey: 'test-key', ...deps,
      pickPort: async () => 9999,
      waitForReady: async () => { throw new CdpBridgeError('CDP endpoint on 127.0.0.1:9999 never became ready: port already in use'); },
    }),
    CdpBridgeError,
  );
  assert.equal(deps.closeCalls.length, 1, 'the browser launched before the readiness check must still be closed on failure');
});

test('`crashed` resolves when the browser disconnects unexpectedly, but never fires for a deliberate close()', async () => {
  const { browser } = fakeBrowserFactory();
  const deps = fakeDeps({ launchImpl: async () => browser });
  const bridge = await launchCdpBridge({
    licenseKey: 'test-key', ...deps,
    pickPort: async () => 1, waitForReady: async () => true,
  });

  let crashFired = false;
  bridge.crashed.then(() => { crashFired = true; });

  // A deliberate close() must not count as a crash.
  await bridge.close();
  await new Promise((r) => setTimeout(r, 10));
  browser.emit('disconnected'); // some fakes/real playwright also emit this on close()
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(crashFired, false);
});

test('`crashed` resolves true for a browser that disconnects without close() ever being called', async () => {
  const { browser } = fakeBrowserFactory();
  const deps = fakeDeps({ launchImpl: async () => browser });
  const bridge = await launchCdpBridge({
    licenseKey: 'test-key', ...deps,
    pickPort: async () => 1, waitForReady: async () => true,
  });
  const crashedPromise = bridge.crashed;
  browser.emit('disconnected'); // simulates the real Chromium process dying on its own
  const result = await crashedPromise;
  assert.equal(result, true);
});

test('five sequential launch/close cycles each launch and close cleanly, in order, with no leaked state', async () => {
  const deps = fakeDeps();
  for (let i = 0; i < 5; i += 1) {
    const bridge = await launchCdpBridge({
      licenseKey: 'test-key', ...deps,
      pickPort: async () => 1000 + i, waitForReady: async () => true,
    });
    assert.equal(bridge.port, 1000 + i);
    await bridge.close();
  }
  assert.equal(deps.closeCalls.length, 5);
});

test('a launch failure mid-cycle does not block the next cycle from succeeding cleanly', async () => {
  let attempt = 0;
  const deps = fakeDeps({
    launchImpl: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('simulated transient launch failure');
      return fakeBrowserFactory().browser;
    },
  });
  await assert.rejects(
    () => launchCdpBridge({ licenseKey: 'test-key', ...deps, pickPort: async () => 1 }),
    CdpBridgeError,
  );
  const bridge = await launchCdpBridge({
    licenseKey: 'test-key', ...deps,
    pickPort: async () => 2, waitForReady: async () => true,
  });
  assert.equal(bridge.port, 2);
  await bridge.close();
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
