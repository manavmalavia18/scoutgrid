import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'hc-local.sh');

// Every test gets its own fully isolated HC_LOCAL_DIR / LaunchAgents dir /
// launchctl stub — never touches the real ~/.scoutgrid-local,
// ~/Library/LaunchAgents, or the real launchd session.
function harness() {
  const base = mkdtempSync(join(process.env.SCOUTGRID_TEST_TMP || tmpdir(), 'hc-local-cli-'));
  const localDir = join(base, 'local');
  const plistDir = join(base, 'LaunchAgents');
  const fakeCtlDir = join(base, 'bin');
  const fakeCtlLog = join(base, 'launchctl.log');
  const fakeCtlLoaded = join(base, 'launchctl.loaded');
  mkdirSync(fakeCtlDir, { recursive: true });
  const fakeCtlPath = join(fakeCtlDir, 'launchctl');
  writeFileSync(fakeCtlPath, `#!/usr/bin/env bash
echo "$@" >> "${fakeCtlLog}"
if [ "$1" = "list" ]; then
  cat "${fakeCtlLoaded}" 2>/dev/null || true
  exit 0
fi
if [ "$1" = "bootstrap" ]; then
  basename "$3" .plist >> "${fakeCtlLoaded}"
  exit 0
fi
if [ "$1" = "bootout" ]; then
  : > "${fakeCtlLoaded}"
  exit 0
fi
exit 0
`);
  execFileSync('chmod', ['+x', fakeCtlPath]);

  function run(args, opts = {}) {
    return execFileSync(SCRIPT, args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        HC_LOCAL_DIR: localDir,
        HC_LOCAL_LAUNCH_AGENTS_DIR: plistDir,
        HC_LOCAL_LAUNCHCTL: fakeCtlPath,
        // Skip real venv/Chromium provisioning in tests — any existing
        // interpreter works since these tests never actually invoke
        // scrape-hiringcafe.py (run-once is only exercised against the
        // overlapping-scan-skip path, which exits before touching Python).
        HC_LOCAL_PYTHON: process.env.HC_LOCAL_TEST_PYTHON || '/usr/bin/python3',
      },
      ...opts,
    });
  }

  return { base, localDir, plistDir, fakeCtlLog, fakeCtlLoaded, run };
}

function cleanup(h) {
  rmSync(h.base, { recursive: true, force: true });
}

test('status on a never-run track reports clean idle state without creating any scan artifacts', () => {
  const h = harness();
  try {
    const out = h.run(['status', 'both']);
    assert.match(out, /software:.*disabled/);
    assert.match(out, /data:.*disabled/);
    assert.match(out, /lock:\s+not held \(idle\)/);
    assert.match(out, /heartbeat: none yet/);
    assert.match(out, /feed:\s+no feed file yet/);
    // setup() runs implicitly but must never create a feed/heartbeat file.
    assert.ok(!existsSync(join(h.localDir, 'software', 'hiringcafe-feed.json')));
    assert.ok(!existsSync(join(h.localDir, 'data', 'hiringcafe-feed-data.json')));
  } finally {
    cleanup(h);
  }
});

test('setup creates isolated venv dirs and per-track profile directories, never touching the git repo', () => {
  const h = harness();
  try {
    h.run(['setup']);
    assert.ok(existsSync(join(h.localDir, 'software', 'hiringcafe-profile')));
    assert.ok(existsSync(join(h.localDir, 'data', 'hiringcafe-profile-data')));
    assert.ok(existsSync(join(h.plistDir, 'com.scoutgrid.hc-local.software.plist')));
    assert.ok(existsSync(join(h.plistDir, 'com.scoutgrid.hc-local.data.plist')));
  } finally {
    cleanup(h);
  }
});

test('launchd plists are written but never auto-loaded: start/stop are the only load/unload path', () => {
  const h = harness();
  try {
    h.run(['setup']);
    assert.ok(!existsSync(h.fakeCtlLog), 'setup alone must never invoke launchctl');
  } finally {
    cleanup(h);
  }
});

test('start loads and enables the plist via launchctl bootstrap/enable; stop boots it out', () => {
  const h = harness();
  try {
    h.run(['start', 'software']);
    const log = readFileSync(h.fakeCtlLog, 'utf8');
    assert.match(log, /bootstrap .*com\.scoutgrid\.hc-local\.software\.plist/);
    assert.match(log, /enable .*com\.scoutgrid\.hc-local\.software/);

    const statusAfterStart = h.run(['status', 'software']);
    assert.match(statusAfterStart, /software:.*ENABLED/);

    h.run(['stop', 'software']);
    const statusAfterStop = h.run(['status', 'software']);
    assert.match(statusAfterStop, /software:.*disabled/);
  } finally {
    cleanup(h);
  }
});

test('start/stop on one track never touches the other track\'s schedule', () => {
  const h = harness();
  try {
    h.run(['start', 'software']);
    const status = h.run(['status', 'both']);
    assert.match(status, /software:.*ENABLED/);
    assert.match(status, /data:.*disabled/);
  } finally {
    cleanup(h);
  }
});

test('overlapping scan prevention: a live-held lock makes run-once skip immediately without touching the feed', () => {
  const h = harness();
  try {
    h.run(['setup']);
    mkdirSync(join(h.localDir, 'software'), { recursive: true });
    const feedPath = join(h.localDir, 'software', 'hiringcafe-feed.json');
    const originalFeed = JSON.stringify({ fetchedAt: '2026-01-01T00:00:00Z', jobs: [{ title: 'Preexisting Job' }] });
    writeFileSync(feedPath, originalFeed);
    // process.pid (this test runner) is guaranteed alive for the duration of this test.
    writeFileSync(join(h.localDir, 'software', 'hc-feed.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

    const out = h.run(['run-once', 'software']);
    assert.match(out, /skip — HC feed already running/);
    assert.equal(readFileSync(feedPath, 'utf8'), originalFeed, 'a skipped run must never touch the existing feed');
  } finally {
    cleanup(h);
  }
});

test('status classifies a dead-pid lock as stale, distinct from a live-held one', () => {
  const h = harness();
  try {
    h.run(['setup']);
    mkdirSync(join(h.localDir, 'software'), { recursive: true });
    // PIDs this large are never actually assigned on a real system.
    writeFileSync(join(h.localDir, 'software', 'hc-feed.lock'), JSON.stringify({ pid: 999999999, at: '2026-01-01T00:00:00.000Z' }));
    const out = h.run(['status', 'software']);
    assert.match(out, /lock:\s+stale/);
    assert.doesNotMatch(out, /lock:\s+HELD/);
  } finally {
    cleanup(h);
  }
});

test('status surfaces a preserved failure heartbeat (including a blocked-response diagnostic) without touching the last-good feed', () => {
  const h = harness();
  try {
    h.run(['setup']);
    const swDir = join(h.localDir, 'software');
    mkdirSync(swDir, { recursive: true });
    const feedPath = join(swDir, 'hiringcafe-feed.json');
    const preservedFeed = JSON.stringify({ fetchedAt: '2026-11-05T22:25:09Z', jobs: [{ title: 'Last Good Job' }], count: 1 });
    writeFileSync(feedPath, preservedFeed);
    writeFileSync(join(swDir, 'scan-hc-heartbeat.json'), JSON.stringify({
      at: '2026-11-13T17:15:28Z',
      exitCode: 1,
      reason: 'all_queries_failed',
      queriesTotal: 16,
      queriesSkipped: 16,
      pagesFetched: 0,
      newMatches: 0,
      firstBlockedResponse: {
        status: 403,
        classification: 'cloudflare_managed_challenge',
        headers: { 'cf-ray': 'a59f6ae25b182d6c-BOS', server: 'cloudflare' },
      },
    }));

    const out = h.run(['status', 'software']);
    assert.match(out, /heartbeat: FAILED/);
    assert.match(out, /reason=all_queries_failed/);
    assert.match(out, /HTTP 403, classification=cloudflare_managed_challenge/);
    assert.match(out, /cf-ray=a59f6ae25b182d6c-BOS/);
    // The whole point of last-good-feed protection: status must report the
    // failure WITHOUT the CLI itself ever touching the preserved feed.
    assert.equal(readFileSync(feedPath, 'utf8'), preservedFeed);
    assert.match(out, /feed:\s+1 job\(s\)/);
  } finally {
    cleanup(h);
  }
});

test('an unknown track argument fails fast with a clear error, for every subcommand', () => {
  const h = harness();
  try {
    assert.throws(() => h.run(['status', 'nonsense']));
    assert.throws(() => h.run(['run-once', 'nonsense']));
  } finally {
    cleanup(h);
  }
});

test('the Data track\'s computed live query list never includes a query reused from Software', () => {
  const out = execFileSync('node', [join(ROOT, 'scripts', 'hc-local-data-queries.mjs')], { encoding: 'utf8' }).trim();
  const list = out.split('|');
  assert.ok(!list.includes('data engineer'));
  assert.ok(!list.includes('machine learning engineer'));
  assert.ok(list.includes('data analyst'));
});
