import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflows = [
  '.github/workflows/hc.yml',
  '.github/workflows/hc-data.yml',
  '.github/workflows/jobright.yml',
];

for (const path of workflows) {
  test(`${path} pins a Patchright-compatible runner`, () => {
    const yaml = readFileSync(path, 'utf8');
    assert.match(yaml, /runs-on:\s*ubuntu-24\.04/);
  });

  test(`${path} disconnects the exit node before publishing to GitHub`, () => {
    const yaml = readFileSync(path, 'utf8');
    const disconnectAt = yaml.indexOf('name: Disconnect from Tailscale exit node');
    const commitAt = yaml.indexOf('name: Commit results');
    assert.ok(disconnectAt >= 0, 'missing Tailscale disconnect step');
    assert.ok(commitAt > disconnectAt, 'Tailscale must disconnect before git pull/push');
    assert.match(yaml.slice(disconnectAt, commitAt), /tailscale down/);
  });

  test(`${path} allows enough time for a full scrape`, () => {
    const yaml = readFileSync(path, 'utf8');
    const timeout = Number(yaml.match(/timeout-minutes:\s*(\d+)/)?.[1] || 0);
    assert.ok(timeout >= 20, `expected timeout >= 20 minutes, got ${timeout}`);
  });
}

test('jobright.yml pins scrapling below the version that removed capture_xhr', () => {
  // scrapling 0.5 (2026-10-27) removed the capture_xhr fetch param that
  // scrape-jobright.py depends on, raising "capture_xhr was removed; use
  // record_requests=True and session.network." on every fetch and stalling
  // the whole JobRight feed. An unbounded `>=0.4.13` install floats to
  // whatever is newest on PyPI at install time, so this must stay pinned
  // below 0.5 until scrape-jobright.py is migrated to the new
  // NetworkRecorder API.
  const yaml = readFileSync('.github/workflows/jobright.yml', 'utf8');
  const m = yaml.match(/pip install 'scrapling\[fetchers\]([^']*)'/);
  assert.ok(m, 'could not find the scrapling pip install line in jobright.yml');
  assert.match(m[1], /<\s*0\.5/, `scrapling install spec "${m[1]}" has no upper bound below 0.5`);
});
