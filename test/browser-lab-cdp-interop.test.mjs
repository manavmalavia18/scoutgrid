import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnCdpBridgeProcess, terminateCdpBridgeProcess, CdpProcessError } from '../browser-lab/cdp-process.mjs';

/**
 * Real integration test: spawns the actual browser-lab/cdp-bridge.mjs
 * (real CloakBrowser, real CDP endpoint on loopback) through the hardened
 * browser-lab/cdp-process.mjs lifecycle helpers, and drives it from a
 * real Python Playwright client via connect_over_cdp — against the local
 * HC-shaped fixture only, never hiringcafe.com or any other real target.
 * SKIPPED (not silently passed) without CLOAKBROWSER_LICENSE_KEY or a
 * working Python `playwright` install, same convention as the rest of
 * browser-lab.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const clientModule = fileURLToPath(new URL('../browser-lab/cdp_client.py', import.meta.url));
const fixtureServer = fileURLToPath(new URL('./fixtures/hc_local_server.py', import.meta.url));

function pythonAvailability() {
  const probe = spawnSync('python3', ['-c', 'from playwright.sync_api import sync_playwright; print("ok")'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    return { ok: false, reason: `python playwright not importable: ${(probe.stderr || '').trim().slice(-300)}` };
  }
  return { ok: true, reason: '' };
}

const pyAvail = pythonAvailability();
const licenseKey = process.env.CLOAKBROWSER_LICENSE_KEY || '';
const skip = !licenseKey
  ? 'CLOAKBROWSER_LICENSE_KEY not set — see browser-lab/README.md'
  : !pyAvail.ok
    ? pyAvail.reason
    : false;
// The connection-failure case below never launches CloakBrowser at all —
// it only needs the Python playwright client to exist, not a license.
const pythonOnlySkip = pyAvail.ok ? false : pyAvail.reason;

function pyRun(code, { timeout = 20000 } = {}) {
  return spawnSync('python3', ['-c', code], { encoding: 'utf8', cwd: repoRoot, timeout });
}

function listChromeProcesses() {
  // macOS/Linux-portable enough for this lab's CI runner: list PIDs of any
  // process whose command line mentions our own profile-dir prefix, which
  // only ever appears in --user-data-dir=<prefix>NNN for bridges WE
  // launched in this test file.
  const res = spawnSync('ps', ['-eo', 'pid,command']);
  return (res.stdout || Buffer.from('')).toString();
}

async function withFixtureServer(fn) {
  const server = spawn('python3', [fixtureServer, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/^(\d+)/);
      if (m) { server.stdout.off('data', onData); resolve(Number(m[1])); }
    };
    server.stdout.on('data', onData);
    server.once('error', reject);
    setTimeout(() => reject(new Error('fixture server did not report a port in time')), 5000);
  });
  try {
    return await fn(port);
  } finally {
    server.kill();
  }
}

async function withBridge(fn, spawnOpts = {}) {
  const { port: cdpPort, child } = await spawnCdpBridgeProcess({ env: process.env, ...spawnOpts });
  try {
    return await fn(cdpPort, child);
  } finally {
    await terminateCdpBridgeProcess(child, { gracefulTimeoutMs: 5000 });
  }
}

test('real interop: Python connect_over_cdp drives the real CloakBrowser against the HC-shaped fixture', { skip }, async () => {
  await withFixtureServer(async (fixturePort) => {
    await withBridge(async (cdpPort) => {
      const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('cdp_client', ${JSON.stringify(clientModule)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
result = m.probe('http://127.0.0.1:${cdpPort}', 'http://127.0.0.1:${fixturePort}/')
print(json.dumps(result))
`;
      const result = pyRun(code);
      assert.equal(result.status, 0, result.stderr);
      const out = JSON.parse(result.stdout.trim().split('\n').pop());
      assert.deepEqual(out, { ok: true, status: 200, title: 'Fixture Jobs', hitCount: 2 });
    });
  });
});

test('real interop: Python disconnecting does not kill the browser — only the bridge\'s own shutdown does', { skip }, async () => {
  await withBridge(async (cdpPort, child) => {
    const probeAlive = (expected) => {
      const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('cdp_client', ${JSON.stringify(clientModule)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(json.dumps(m.is_browser_reachable('http://127.0.0.1:${cdpPort}')))
`;
      const result = pyRun(code);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout.trim().split('\n').pop()), expected);
    };

    // A full connect+disconnect cycle (via probe() against nothing — just
    // is_browser_reachable()) must leave the browser alive afterward,
    // because Python never owns this process.
    probeAlive(true);
    probeAlive(true);

    // Only the bridge's own graceful SIGTERM-triggered close() actually ends it.
    await terminateCdpBridgeProcess(child, { gracefulTimeoutMs: 5000 });
    assert.equal(child.exitCode !== null || child.signalCode !== null, true, 'the bridge process should have exited');
    probeAlive(false);
  });
});

test('real interop: connecting to a port nothing is listening on fails as CdpClientError, not a crash', { skip: pythonOnlySkip }, async () => {
  const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('cdp_client', ${JSON.stringify(clientModule)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
try:
    m.probe('http://127.0.0.1:1', 'http://127.0.0.1:1/')
    print(json.dumps(['no_error']))
except m.CdpClientError as e:
    print(json.dumps(['raised', str(e).startswith('connect_over_cdp failed:')]))
`;
  const result = pyRun(code, { timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').pop()), ['raised', true]);
});

test('real hardening: a startup timeout kills the whole process group — no orphaned Chromium left behind', { skip }, async () => {
  // An intentionally impossible readiness deadline: the real CloakBrowser
  // launch takes well over 20ms, so spawnCdpBridgeProcess must time out,
  // SIGKILL the bridge's process group (not just the Node wrapper), and
  // leave nothing running that a `ps` sweep a moment later can still see.
  await assert.rejects(
    () => spawnCdpBridgeProcess({ env: process.env, readyTimeoutMs: 20 }),
    (err) => {
      assert.ok(err instanceof CdpProcessError);
      assert.match(err.message, /did not become ready within 20ms/);
      return true;
    },
  );
  // Give the OS a brief moment to finish reaping, then confirm no leftover
  // cdp-bridge.mjs/cloakbrowser-profile process is still listed.
  await new Promise((r) => setTimeout(r, 1500));
  const ps = listChromeProcesses();
  assert.doesNotMatch(ps, /cdp-bridge-profile-/, 'a profile-dir-tagged Chromium process must not survive a readiness-timeout kill');
});

test('real hardening: repeated real launch/terminate cycles leave no leftover bridge or Chromium processes', { skip }, async () => {
  for (let i = 0; i < 2; i += 1) {
    await withBridge(async (cdpPort) => {
      // A minimal liveness probe is enough — the point of this test is
      // the lifecycle (two full real launch+terminate cycles), not a
      // second full fixture drive (already covered above).
      const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('cdp_client', ${JSON.stringify(clientModule)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(json.dumps(m.is_browser_reachable('http://127.0.0.1:${cdpPort}')))
`;
      const result = pyRun(code);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout.trim().split('\n').pop()), true);
    });
  }
  await new Promise((r) => setTimeout(r, 1000));
  const ps = listChromeProcesses();
  assert.doesNotMatch(ps, /cdp-bridge-profile-/, 'no profile-dir-tagged Chromium process should survive two full launch/terminate cycles');
});

test('environment note: whether the real CDP interop/hardening experiment actually ran', () => {
  if (skip) {
    console.log(`[cdp-interop] SKIPPED — ${skip}`);
  } else {
    console.log('[cdp-interop] RAN against a real licensed CloakBrowser instance over CDP');
  }
  assert.ok(true);
});
