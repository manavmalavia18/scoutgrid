import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real-browser smoke test: exercises the actual `patchright` package and a
// real Chrome/Chromium binary against a loopback-only local HTTP fixture
// (test/fixtures/hc_local_server.py) — never hiringcafe.com, never any
// production feed/scan-history file. If patchright (or a usable browser
// channel) isn't installed in this environment, every test in this file
// is SKIPPED with an explicit reason, never silently treated as passing —
// same convention browser-lab's CloakBrowser-license check uses.
const script = fileURLToPath(new URL('../scrape-hiringcafe.py', import.meta.url));
const fixtureServer = fileURLToPath(new URL('./fixtures/hc_local_server.py', import.meta.url));
const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

function pythonAvailability() {
  const probe = spawnSync('python3', ['-c', 'import patchright.sync_api; print("ok")'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    return { ok: false, reason: `patchright not importable: ${(probe.stderr || '').trim().slice(-300)}` };
  }
  return { ok: true, reason: '' };
}

const avail = pythonAvailability();
const skip = avail.ok ? false : `real-browser smoke skipped — ${avail.reason}`;

// Only check the specific files scrape()/fetch-hiringcafe-feed.mjs could
// plausibly write — NOT the whole data/ directory. This repo has several
// independent GitHub Actions bots on short cron cycles that legitimately
// touch OTHER files in data/ (board-discovery, nextplay, workday, ...; see
// the scoutgrid skill's "stale local clone" notes) and a local checkout
// here was observed fast-forwarding via periodic `git pull --ff-only` from
// an external mechanism outside this test's control — asserting the whole
// directory is byte-identical produces false failures unrelated to this
// test's own behavior. scrape() itself never writes to disk at all (only
// fetch-hiringcafe-feed.mjs's fetchFeed() does, which this test never
// calls), so every one of these should genuinely be untouched.
const HC_OWNED_FILES = [
  'hiringcafe-feed.json',
  'hiringcafe-feed-data.json',
  'scan-hc-heartbeat.json',
  'scan-hc-heartbeat-data.json',
  'hc-hits.tmp.json',
  'hc-feed.lock',
];

function hcOwnedSnapshot() {
  return HC_OWNED_FILES.map((name) => {
    try {
      const s = statSync(join(DATA_DIR, name));
      return `${name}:${s.mtimeMs}:${s.size}`;
    } catch {
      return `${name}:absent`;
    }
  });
}

async function withFixtureServer(fn) {
  const server = spawn('python3', [fixtureServer, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/^(\d+)/);
      if (m) {
        server.stdout.off('data', onData);
        resolve(Number(m[1]));
      }
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

function pyRun(code, { timeout = 30000 } = {}) {
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)), timeout });
  return result;
}

test('real browser: PatchrightRuntime lifecycle (goto, title, content, minimize, close) against a local fixture', { skip }, async () => {
  await withFixtureServer(async (port) => {
    const code = `
import browser_runtime as br, tempfile, json
from pathlib import Path
rt = br.get_runtime('patchright')
with tempfile.TemporaryDirectory() as tmp:
    session = rt.open(Path(tmp))
    try:
        status = session.goto('http://127.0.0.1:${port}/', timeout_ms=15000)
        session.minimize_window()
        session.wait_for_selector('#__NEXT_DATA__', timeout_ms=10000)
        title = session.title()
        content = session.content()
        print(json.dumps({'status': status, 'title': title, 'has_next_data': '__NEXT_DATA__' in content}))
    finally:
        session.close()
`;
    const result = pyRun(code);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.equal(out.status, 200);
    assert.equal(out.title, 'Fixture Jobs');
    assert.equal(out.has_next_data, true);
  });
});

test('real browser: full scrape() through the fixture collects and dedupes the real hits unchanged', { skip }, async () => {
  const before = hcOwnedSnapshot();
  await withFixtureServer(async (port) => {
    const code = `
import importlib.util, json, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('hc', ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.url_for = lambda state, page: f'http://127.0.0.1:${port}/?page={page}'
with tempfile.TemporaryDirectory() as tmp:
    payload = m.scrape(5, 2, 'software engineer', 0.1, Path(tmp), engine='patchright')
print(json.dumps({
    'ok': payload['ok'], 'engine': payload['engine'], 'count': payload['count'],
    'pagesFetched': payload['pagesFetched'], 'truncated': payload['truncated'],
    'totalCount': payload['totalCount'],
    'urls': sorted(h['apply_url'] for h in payload['hits']),
}))
`;
    const result = pyRun(code);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.deepEqual(out, {
      ok: true,
      engine: 'patchright',
      count: 2,
      pagesFetched: 1,
      truncated: false,
      totalCount: 2,
      urls: ['https://fixture.test/jobs/1', 'https://fixture.test/jobs/2'],
    });
  });
  assert.deepEqual(hcOwnedSnapshot(), before, 'HC-owned output files must be untouched — scrape() never writes to disk');
});

test('real browser: missing __NEXT_DATA__ on a real page surfaces as missing_job_data, not a crash', { skip }, async () => {
  await withFixtureServer(async (port) => {
    const code = `
import importlib.util, json, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('hc', ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.url_for = lambda state, page: 'http://127.0.0.1:${port}/no-next-data'
with tempfile.TemporaryDirectory() as tmp:
    try:
        m.scrape(2, 2, 'q', 0.1, Path(tmp), engine='patchright')
        print(json.dumps(['no_error']))
    except RuntimeError as e:
        print(json.dumps(['raised', str(e).startswith('missing_job_data:')]))
`;
    // A real page with no __NEXT_DATA__ element doesn't raise immediately —
    // scrape() only short-circuits on a cloudflare_challenge/http_403
    // diagnosis; "missing_job_data" instead falls through to the real
    // page.wait_for_selector(..., timeout_ms=45_000) (unchanged from the
    // pre-refactor inline code), which only then times out and gets
    // re-diagnosed. Give the subprocess real headroom for that.
    const result = pyRun(code, { timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.deepEqual(out, ['raised', true]);
  });
});

test('real browser: launching a second session on the same locked profile raises BrowserInitError', { skip }, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'hc-profile-lock-'));
  try {
    const holder = spawn('python3', ['-c', `
import browser_runtime as br, time
from pathlib import Path
rt = br.get_runtime('patchright')
session = rt.open(Path(${JSON.stringify(profile)}))
print('held', flush=True)
time.sleep(8)
session.close()
`], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let buf = '';
      holder.stdout.on('data', (c) => {
        buf += c.toString();
        if (buf.includes('held')) resolve();
      });
      holder.once('error', reject);
      setTimeout(() => reject(new Error('holder did not report ready in time')), 10000);
    });
    try {
      const code = `
import browser_runtime as br, json
from pathlib import Path
rt = br.get_runtime('patchright')
try:
    s = rt.open(Path(${JSON.stringify(profile)}))
    s.close()
    print(json.dumps(['no_error']))
except br.BrowserInitError as e:
    print(json.dumps(['raised', 'profile' in str(e).lower() or 'existing' in str(e).lower()]))
`;
      const result = pyRun(code);
      assert.equal(result.status, 0, result.stderr);
      const out = JSON.parse(result.stdout.trim().split('\n').pop());
      assert.deepEqual(out, ['raised', true]);
    } finally {
      holder.kill();
      // Chrome's own helper/renderer processes can take a moment to fully
      // exit after SIGTERM even once the main `python3` process is gone —
      // a user_data_dir with a still-exiting Chrome holding files open
      // makes a synchronous rmSync throw ENOTEMPTY intermittently. Wait for
      // the holder's exit event, then retry the removal with backoff
      // rather than letting that race fail the whole test.
      await new Promise((resolve) => holder.once('exit', resolve));
    }
  } finally {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt === 5) throw err;
        await new Promise((r) => setTimeout(r, attempt * 300));
      }
    }
  }
});

test('real browser: a navigation that never completes raises NavigationError, and the session still closes cleanly', { skip }, async () => {
  await withFixtureServer(async (port) => {
    const code = `
import browser_runtime as br, tempfile, json
from pathlib import Path
rt = br.get_runtime('patchright')
with tempfile.TemporaryDirectory() as tmp:
    session = rt.open(Path(tmp))
    nav_raised = False
    try:
        session.goto('http://127.0.0.1:${port}/slow', timeout_ms=1200)
    except br.NavigationError:
        nav_raised = True
    closed_ok = True
    try:
        session.close()
    except br.CleanupError:
        closed_ok = False
    print(json.dumps({'nav_raised': nav_raised, 'closed_ok': closed_ok}))
`;
    const result = pyRun(code);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.deepEqual(out, { nav_raised: true, closed_ok: true });
  });
});

test('real browser: an interrupted navigation inside scrape() surfaces as navigation_error without touching data/', { skip }, async () => {
  const before = hcOwnedSnapshot();
  await withFixtureServer(async (port) => {
    const code = `
import importlib.util, json, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('hc', ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.url_for = lambda state, page: 'http://127.0.0.1:${port}/slow'
with tempfile.TemporaryDirectory() as tmp:
    try:
        m.scrape(2, 2, 'q', 0.1, Path(tmp), engine='patchright')
        print(json.dumps(['no_error']))
    except RuntimeError as e:
        print(json.dumps(['raised', str(e).startswith('navigation_error:')]))
`;
    // scrape()'s own goto call uses a fixed 60s timeout (unchanged from the
    // pre-refactor inline code, not something this test should shorten) —
    // the fixture now never responds on /slow at all, so this genuinely
    // waits out that full 60s before PatchrightSession.goto() raises.
    const result = pyRun(code, { timeout: 75000 });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.deepEqual(out, ['raised', true]);
  });
  assert.deepEqual(hcOwnedSnapshot(), before, 'HC-owned output files must be untouched — scrape() never writes to disk');
});

test('environment note: whether this run actually exercised a real browser', () => {
  if (skip) {
    console.log(`[hc-real-browser-smoke] SKIPPED — ${avail.reason}`);
  } else {
    console.log('[hc-real-browser-smoke] RAN against a real patchright + Chrome install');
  }
  assert.ok(true);
});
