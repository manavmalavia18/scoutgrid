/**
 * Generic Node-to-Python CDP interop experiment — isolated to browser-lab/.
 *
 * Launches the licensed CloakBrowser runtime (via its own documented
 * `buildLaunchOptions`, same as adapter.mjs's launchBrowser()) with a real
 * Chrome DevTools Protocol endpoint exposed, restricted to loopback, on an
 * ephemeral port this module picks itself. Node keeps the launched
 * `Browser` handle and is the ONLY thing that ever closes/kills the actual
 * browser process — an external CDP client (browser-lab/cdp_client.py,
 * via Python Playwright's `connect_over_cdp`) can attach, drive pages, and
 * disconnect without owning the process lifecycle at all.
 *
 * Hardening in this version: detection of an unexpected browser
 * crash/disconnect versus a deliberate close(); and a
 * graceful-close-then-forced-kill sequence so a hung `browser.close()`
 * can't leave the real Chromium process running forever.
 *
 * Note on profile directories: an earlier version of this module passed
 * an explicit `--user-data-dir` so it could track and remove its own temp
 * profile. A real run in GitHub Actions caught this immediately —
 * Playwright's `chromium.launch()` actively rejects a `--user-data-dir`
 * argument (`browserType.launch: Pass userDataDir parameter to
 * 'browserType.launchPersistentContext(userDataDir, options)' instead of
 * specifying '--user-data-dir' argument`). Profile management is left to
 * Playwright's own internal temp directory, which it removes itself on a
 * clean `browser.close()`. The one residual gap this leaves (documented,
 * not silently ignored): if `close()` ever has to escalate to a forced
 * `SIGKILL` of the browser process, Playwright's own cleanup code never
 * runs either, so that internal temp directory's on-disk files can be
 * left behind — no running process survives, only inert temp files.
 *
 * No production import, no Tailscale route, no request to HiringCafe or
 * any other real target — this module only ever navigates the loopback
 * fixture server under test/fixtures/.
 */
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export class CdpBridgeError extends Error {}

/** Bind to port 0 to let the OS assign a free loopback port, then release
 * it immediately so Chrome can bind the same number. A real ephemeral
 * port, not a hardcoded one — satisfies "use an ephemeral port". */
export async function pickEphemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Poll the CDP HTTP endpoint's /json/version until it answers, or give up.
 * A busy/unbound port, a crashed launch, or a binary that never opens the
 * debug port all surface here as the same CdpBridgeError. */
export async function waitForCdpReady(port, { timeoutMs = 10000, intervalMs = 100, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return true;
    } catch (err) {
      lastErr = err;
    }
    await delay(intervalMs);
  }
  throw new CdpBridgeError(`CDP endpoint on 127.0.0.1:${port} never became ready: ${lastErr?.message || 'timeout'}`);
}

/**
 * Launch CloakBrowser with a loopback-only CDP endpoint. Returns
 * `{ port, cdpUrl, close, crashed }`:
 *   - `close({ killTimeoutMs })` is idempotent: tries `browser.close()`
 *     gracefully, and if that doesn't resolve within `killTimeoutMs`
 *     (default 5000), force-kills the real OS process via
 *     `browser.process().kill('SIGKILL')` so a hung close() can never
 *     leave an orphaned Chromium behind.
 *   - `crashed` is a Promise that resolves `true` the moment the browser
 *     disconnects WITHOUT `close()` having been called first (a real
 *     crash/unexpected exit) — never resolves on a deliberate close. A
 *     caller (e.g. the CLI block below) can race this against a shutdown
 *     signal to detect "the browser died on its own", not just "someone
 *     told me to stop".
 *
 * A CDP client disconnecting (Python's `browser.close()` on a
 * `connect_over_cdp()` handle) never reaches any of this — that is a pure
 * client-side disconnect, by Playwright's own CDP-connect semantics, and
 * is covered by test/browser-lab-cdp-interop.test.mjs.
 */
export async function launchCdpBridge({
  licenseKey = process.env.CLOAKBROWSER_LICENSE_KEY || '',
  cloakBrowser,
  playwrightCore,
  pickPort = pickEphemeralPort,
  waitForReady = waitForCdpReady,
} = {}) {
  if (!licenseKey) {
    throw new CdpBridgeError('CLOAKBROWSER_LICENSE_KEY is required for the CDP bridge experiment');
  }

  const { buildLaunchOptions } = cloakBrowser || await import('cloakbrowser');
  const { chromium } = playwrightCore || await import('playwright-core');

  const port = await pickPort();
  const base = await buildLaunchOptions({ headless: true, licenseKey });
  const args = [
    ...(base.args || []),
    `--remote-debugging-port=${port}`,
    // Explicit loopback restriction — never 0.0.0.0, never a public bind.
    '--remote-debugging-address=127.0.0.1',
  ];

  let browser;
  try {
    browser = await chromium.launch({ ...base, args });
  } catch (err) {
    // Never log licenseKey, base.env, or args here — only a sanitized message.
    throw new CdpBridgeError(`failed to launch CloakBrowser for the CDP bridge: ${err.message}`);
  }

  let closedByUs = false;
  let crashResolve;
  const crashed = new Promise((resolve) => { crashResolve = resolve; });
  browser.on('disconnected', () => {
    if (!closedByUs) crashResolve(true);
  });

  try {
    await waitForReady(port);
  } catch (err) {
    closedByUs = true;
    await browser.close().catch(() => {});
    throw err;
  }

  let closed = false;
  async function close({ killTimeoutMs = 5000 } = {}) {
    if (closed) return;
    closed = true;
    closedByUs = true;
    const graceful = browser.close().then(() => true).catch(() => true);
    const finishedGracefully = await Promise.race([
      graceful,
      delay(killTimeoutMs).then(() => false),
    ]);
    if (!finishedGracefully) {
      // browser.close() didn't resolve in time — force-kill the real OS
      // process so it can never linger as an orphan.
      try {
        browser.process()?.kill('SIGKILL');
      } catch {
        // Best-effort only.
      }
    }
  }

  return { port, cdpUrl: `http://127.0.0.1:${port}`, close, crashed, _browser: browser };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let bridge;
  try {
    bridge = await launchCdpBridge();
  } catch (err) {
    // Sanitized: never the license key, never raw launch args/env.
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exitCode = 1;
    process.exit();
  }
  console.log(JSON.stringify({ ok: true, port: bridge.port }));
  let shuttingDown = false;
  const shutdown = async (exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await bridge.close();
    process.exit(exitCode);
  };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  // An unexpected browser crash must not leave this process hanging
  // forever waiting for a signal nobody will send — exit non-zero so a
  // parent/test harness can distinguish "crashed" from "told to stop".
  bridge.crashed.then(() => shutdown(1));
  // Keep the event loop alive until a signal arrives or the browser dies.
  await new Promise(() => {});
}
