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
 * `{ port, cdpUrl, close }` — `close()` is idempotent and is the only
 * sanctioned way to end the browser process; a CDP client disconnecting
 * (Python's `browser.close()` on a `connect_over_cdp()` handle) never
 * kills the process, by Playwright's own CDP-connect semantics.
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

  try {
    await waitForReady(port);
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await browser.close().catch(() => {});
  }

  return { port, cdpUrl: `http://127.0.0.1:${port}`, close, _browser: browser };
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
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // Keep the event loop alive until a signal arrives.
  await new Promise(() => {});
}
